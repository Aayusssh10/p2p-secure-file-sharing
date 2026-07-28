// Resilience / edge-case stress test for the signaling server.
// Spawns src/server.js as a real child process (so a crash is observable as an
// exit), then runs 4 adversarial scenarios concurrently against it:
//   1. Sudden disconnect mid-handshake
//   2. Duplicate / malformed signal packets
//   3. Room cap enforcement under 5 simultaneous joiners
//   4. Graceful leave while signaling messages are still in flight
// Run with: node test-stress.js

const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const { io } = require("socket.io-client");

const SERVER_ENTRY = path.join(__dirname, "src", "server.js");
const PORT = 4100;
const URL = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    console.log(`PASS: ${name}`);
    passed++;
  } else {
    console.log(`FAIL: ${name}${extra ? " — " + extra : ""}`);
    failed++;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

async function waitForHealth(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await httpGet(`${URL}/health`);
      if (res.status === 200) return true;
    } catch {
      // server not up yet
    }
    await wait(200);
  }
  return false;
}

function newClient() {
  return io(URL, { reconnection: false, forceNew: true, timeout: 3000 });
}

function uniqueRoom(label) {
  return `stress-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------- Scenario 1: sudden disconnect mid-handshake ----------
async function scenarioSuddenDisconnect() {
  const room = uniqueRoom("disconnect");
  const a = newClient();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("scenario 1 setup timeout")), 5000);
    a.on("connect", () => a.emit("join-room", room));
    a.on("joined-room", () => {
      // A sends an offer, then gets killed before B ever answers
      a.emit("signal", { roomId: room, data: { type: "offer", sdp: "fake-offer" } });
      a.disconnect();
      clearTimeout(timer);
      resolve();
    });
    a.on("connect_error", reject);
  });

  await wait(300); // let the server process the disconnect cleanup

  const verifier = newClient();
  const rejoin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("scenario 1 verify timeout")), 5000);
    verifier.on("connect", () => verifier.emit("join-room", room));
    verifier.on("joined-room", (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
    verifier.on("room-full", () => {
      clearTimeout(timer);
      resolve({ roomFull: true });
    });
  });
  verifier.disconnect();

  check(
    "Scenario 1: room cleaned up after mid-handshake disconnect (no lingering peer)",
    !!(rejoin && rejoin.peers && rejoin.peers.length === 0)
  );
}

// ---------- Scenario 2: duplicate / malformed signal packets ----------
async function scenarioMalformedPackets() {
  const room = uniqueRoom("malformed");
  const roomB = uniqueRoom("malformed-b");
  const client = newClient();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("scenario 2 connect timeout")), 5000);
    client.on("connect", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  // Barrage of malformed/duplicate/out-of-order events. None of these should
  // throw server-side or crash the process.
  client.emit("signal", null);
  client.emit("signal", undefined);
  client.emit("signal", "not-an-object");
  client.emit("signal", 12345);
  client.emit("signal", []);
  client.emit("signal", {});
  client.emit("signal", { roomId: room }); // missing data
  client.emit("signal", { data: { type: "offer" } }); // missing roomId
  client.emit("join-room", null);
  client.emit("join-room", 42);
  client.emit("join-room", {});
  client.emit("join-room", "");
  client.emit("leave-room", null);
  client.emit("leave-room", "room-that-does-not-exist");

  // duplicate join-room into the SAME room (should be idempotent)
  client.emit("join-room", room);
  client.emit("join-room", room);

  // join a SECOND, different room without ever leaving the first — this must
  // not leave a ghost membership behind in room A once the socket disconnects
  client.emit("join-room", roomB);

  const joinedB = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("scenario 2 timeout waiting for joined-room")), 5000);
    client.on("joined-room", (payload) => {
      if (payload.roomId === roomB) {
        clearTimeout(timer);
        resolve(payload);
      }
    });
  });

  check("Scenario 2: server survived the malformed-packet barrage without crashing", true);
  check("Scenario 2: still processed a valid join-room after the barrage", joinedB.roomId === roomB);

  client.disconnect();
  await wait(300);

  // Verify room A doesn't have a permanent ghost occupant from the earlier
  // join that was never explicitly left (2-peer cap should still be reachable).
  const c1 = newClient();
  const c2 = newClient();
  const outcomes = await Promise.all(
    [c1, c2].map(
      (c) =>
        new Promise((resolve) => {
          c.on("connect", () => c.emit("join-room", room));
          c.on("joined-room", () => resolve("joined"));
          c.on("room-full", () => resolve("room-full"));
          setTimeout(() => resolve("timeout"), 3000);
        })
    )
  );
  c1.disconnect();
  c2.disconnect();

  check(
    "Scenario 2: room A has no ghost occupant leaked from the multi-room join (2 fresh peers both admitted)",
    outcomes.filter((o) => o === "joined").length === 2,
    `outcomes=${JSON.stringify(outcomes)}`
  );
}

// ---------- Scenario 3: room cap enforcement under 7 simultaneous joiners ----------
// Room cap is 4 (multi-peer mesh, bumped up from the original 2-peer cap) —
// 7 simultaneous joiners keeps the same "+3 over capacity" margin the
// original 5-joiners-against-a-cap-of-2 test used.
async function scenarioRoomCapEnforcement() {
  const room = uniqueRoom("cap");
  const clients = Array.from({ length: 7 }, () => newClient());

  const outcomes = await Promise.all(
    clients.map(
      (c) =>
        new Promise((resolve) => {
          c.on("connect", () => c.emit("join-room", room));
          c.on("joined-room", () => resolve("joined"));
          c.on("room-full", () => resolve("room-full"));
          setTimeout(() => resolve("timeout"), 5000);
        })
    )
  );

  clients.forEach((c) => c.disconnect());

  const joinedCount = outcomes.filter((o) => o === "joined").length;
  const fullCount = outcomes.filter((o) => o === "room-full").length;

  check(
    "Scenario 3: exactly 4 of 7 simultaneous joiners admitted, remaining 3 rejected with room-full",
    joinedCount === 4 && fullCount === 3,
    `outcomes=${JSON.stringify(outcomes)}`
  );
}

// ---------- Scenario 4: graceful leave while signaling is in flight ----------
async function scenarioGracefulLeaveDuringHandshake() {
  const room = uniqueRoom("leave");
  const a = newClient();
  const b = newClient();

  let bSawSignal = false;
  let bSawPeerLeft = false;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("scenario 4 timeout")), 5000);

    a.on("connect", () => a.emit("join-room", room));
    a.on("joined-room", () => b.emit("join-room", room));

    // peer-joined fires on the *existing* room member (A) when B joins, not on B.
    a.on("peer-joined", () => {
      // A sends an offer, immediately leaves, then fires a stray ICE candidate
      // that arrives after leaving — should be a harmless no-op, not a crash.
      a.emit("signal", { roomId: room, data: { type: "offer", sdp: "fake-offer" } });
      a.emit("leave-room", room);
      a.emit("signal", { roomId: room, data: { type: "ice-candidate", candidate: "stray-after-leave" } });
    });

    b.on("signal", () => {
      bSawSignal = true;
    });

    b.on("peer-left", () => {
      bSawPeerLeft = true;
      clearTimeout(timer);
      resolve();
    });
  });

  await wait(200);
  a.disconnect();
  b.disconnect();

  check("Scenario 4: peer B received the in-flight signal before A left", bSawSignal);
  check("Scenario 4: peer B was notified of peer-left after graceful leave-room", bSawPeerLeft);
}

// ---------- main ----------
async function main() {
  console.log(`Spawning signaling server (PORT=${PORT}) for stress test...\n`);

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(PORT), CLIENT_URL: "http://localhost:5050" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverExited = false;
  let exitInfo = "";
  child.on("exit", (code, signal) => {
    serverExited = true;
    exitInfo = `exit code=${code} signal=${signal}`;
  });
  child.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[server:stderr] ${d}`));

  const up = await waitForHealth();
  check("Server started and /health responded", up);
  if (!up) {
    console.log(`\n${passed} passed, ${failed} failed`);
    child.kill();
    process.exit(1);
  }

  console.log("\nRunning 4 stress scenarios concurrently...\n");

  const results = await Promise.allSettled([
    scenarioSuddenDisconnect(),
    scenarioMalformedPackets(),
    scenarioRoomCapEnforcement(),
    scenarioGracefulLeaveDuringHandshake(),
  ]);

  const scenarioNames = [
    "Sudden Disconnect Mid-Handshake",
    "Duplicate/Malformed Signal Packets",
    "Room Cap Enforcement & Rapid Connections",
    "Graceful Peer Leaving during Active Connection",
  ];
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      check(`Scenario ${i + 1} (${scenarioNames[i]}) completed without throwing`, false, String(r.reason));
    }
  });

  await wait(300);
  const finalHealth = await waitForHealth(5);
  check(
    "Server process still alive and responsive after all 4 scenarios",
    finalHealth && !serverExited,
    serverExited ? exitInfo : undefined
  );

  console.log(`\n${passed} passed, ${failed} failed`);

  if (!serverExited) child.kill();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Stress test runner itself crashed:", err);
  process.exit(1);
});
