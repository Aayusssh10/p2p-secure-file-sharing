// Signaling-layer test for multi-peer (mesh) rooms — up to 4 peers per room.
// Covers the parts of the mesh refactor that don't need a real browser/
// RTCPeerConnection: room fan-out of peers/names, the new targeted signal
// relay (targetPeerId), room-full enforcement at the new cap, and peer-left
// notification to the remaining peers when one leaves.
// Run with: node test-multipeer-signaling.js

const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const { io } = require("socket.io-client");

const SERVER_ENTRY = path.join(__dirname, "src", "server.js");
const PORT = 4300;
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

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

async function waitForHealth(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await httpGetJson(`${URL}/health`);
      if (res && res.status === "ok") return true;
    } catch {
      // server not up yet
    }
    await wait(200);
  }
  return false;
}

function newClient() {
  return io(URL, { reconnection: false, forceNew: true, timeout: 5000 });
}

function uniqueRoom(label) {
  return `multipeer-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// All 4 clients in scenario A are created up front and start connecting
// immediately, but they're joined one at a time (awaited in sequence) so the
// test can assert on each join's response — by the time a later client's
// turn comes up, its "connect" event may have already fired. Handle both
// cases: join right away if already connected, otherwise wait for connect.
function joinAndWait(client, roomId, displayName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`join timeout for ${displayName}`)), 5000);
    const doJoin = () => client.emit("join-room", { roomId, displayName });
    if (client.connected) {
      doJoin();
    } else {
      client.on("connect", doJoin);
    }
    client.on("joined-room", (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
    client.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function namesById(peerNames) {
  const map = {};
  (peerNames || []).forEach((p) => {
    map[p.peerId] = p.displayName;
  });
  return map;
}

// ---------- Scenario A: 4 peers join one room, correct peer/name fan-out ----------
async function scenarioFourPeersJoin() {
  const room = uniqueRoom("four-join");
  const alice = newClient();
  const bob = newClient();
  const carol = newClient();
  const dave = newClient();

  // Track peer-joined events each already-present client receives, so we can
  // confirm existing peers are told about each newcomer (not just the other
  // way around).
  const peerJoinedSeenBy = { alice: [], bob: [], carol: [] };
  alice.on("peer-joined", (p) => peerJoinedSeenBy.alice.push(p.displayName));
  bob.on("peer-joined", (p) => peerJoinedSeenBy.bob.push(p.displayName));
  carol.on("peer-joined", (p) => peerJoinedSeenBy.carol.push(p.displayName));

  const aliceJoined = await joinAndWait(alice, room, "Alice");
  check("Scenario A: 1st joiner sees no existing peers", aliceJoined.peers.length === 0);

  const bobJoined = await joinAndWait(bob, room, "Bob");
  check(
    "Scenario A: 2nd joiner sees exactly Alice",
    bobJoined.peers.length === 1 && namesById(bobJoined.peerNames)[bobJoined.peers[0]] === "Alice"
  );

  const carolJoined = await joinAndWait(carol, room, "Carol");
  const carolNames = namesById(carolJoined.peerNames);
  check(
    "Scenario A: 3rd joiner sees exactly Alice + Bob",
    carolJoined.peers.length === 2 &&
      Object.values(carolNames).sort().join(",") === "Alice,Bob"
  );

  const daveJoined = await joinAndWait(dave, room, "Dave");
  const daveNames = namesById(daveJoined.peerNames);
  check(
    "Scenario A: 4th joiner sees exactly Alice + Bob + Carol",
    daveJoined.peers.length === 3 &&
      Object.values(daveNames).sort().join(",") === "Alice,Bob,Carol"
  );

  await wait(300); // let all peer-joined broadcasts settle

  check(
    "Scenario A: Alice was notified of Bob, Carol, and Dave joining (in order)",
    peerJoinedSeenBy.alice.join(",") === "Bob,Carol,Dave",
    JSON.stringify(peerJoinedSeenBy.alice)
  );
  check(
    "Scenario A: Bob was notified of Carol and Dave joining (not himself)",
    peerJoinedSeenBy.bob.join(",") === "Carol,Dave",
    JSON.stringify(peerJoinedSeenBy.bob)
  );
  check(
    "Scenario A: Carol was notified of only Dave joining",
    peerJoinedSeenBy.carol.join(",") === "Dave",
    JSON.stringify(peerJoinedSeenBy.carol)
  );

  return { room, clients: { alice, bob, carol, dave } };
}

// ---------- Scenario B: 5th peer rejected once room has 4 ----------
async function scenarioFifthPeerRejected(room) {
  const eve = newClient();
  const outcome = await new Promise((resolve) => {
    eve.on("connect", () => eve.emit("join-room", { roomId: room, displayName: "Eve" }));
    eve.on("joined-room", () => resolve("joined"));
    eve.on("room-full", () => resolve("room-full"));
    setTimeout(() => resolve("timeout"), 5000);
  });
  check("Scenario B: 5th peer into a full (4/4) room is rejected with room-full", outcome === "room-full", outcome);
  eve.disconnect();
}

// ---------- Scenario C: targeted signal reaches only the intended peer ----------
async function scenarioTargetedSignal(room, clients) {
  const { alice, bob, carol, dave } = clients;

  let bobSawSignal = null;
  let carolSawSignal = false;
  let daveSawSignal = false;
  bob.on("signal", (payload) => {
    bobSawSignal = payload;
  });
  carol.on("signal", () => {
    carolSawSignal = true;
  });
  dave.on("signal", () => {
    daveSawSignal = true;
  });

  alice.emit("signal", {
    roomId: room,
    targetPeerId: bob.id,
    data: { type: "ice-candidate", candidate: "mock-targeted-candidate" },
  });

  await wait(500);

  check(
    "Scenario C: targeted signal reached the intended peer (Bob) with the right payload",
    !!bobSawSignal && bobSawSignal.peerId === alice.id && bobSawSignal.data.candidate === "mock-targeted-candidate",
    JSON.stringify(bobSawSignal)
  );
  check("Scenario C: targeted signal did NOT reach a bystander (Carol)", !carolSawSignal);
  check("Scenario C: targeted signal did NOT reach a bystander (Dave)", !daveSawSignal);
}

// ---------- Scenario D: peer-left fan-out + late signal to a departed peer is a no-op ----------
async function scenarioPeerLeftFanoutAndLateSignal(room, clients) {
  const { alice, bob, carol, dave } = clients;

  const peerLeftSeenBy = { bob: null, carol: null, dave: null };
  bob.once("peer-left", (p) => (peerLeftSeenBy.bob = p));
  carol.once("peer-left", (p) => (peerLeftSeenBy.carol = p));
  dave.once("peer-left", (p) => (peerLeftSeenBy.dave = p));

  const aliceId = alice.id;
  alice.disconnect();
  await wait(500);

  [bob, carol, dave].forEach((c, i) => {
    const label = ["Bob", "Carol", "Dave"][i];
    const seen = peerLeftSeenBy[label.toLowerCase()];
    check(
      `Scenario D: ${label} was notified Alice left (correct peerId + name)`,
      !!seen && seen.peerId === aliceId && seen.displayName === "Alice",
      JSON.stringify(seen)
    );
  });

  // A stray signal targeting the now-disconnected peer's id must not crash
  // the server — Socket.io's socket.to(emptyRoom).emit(...) is a no-op.
  bob.emit("signal", { roomId: room, targetPeerId: aliceId, data: { type: "ice-candidate", candidate: "stray" } });
  await wait(300);

  const stats = await httpGetJson(`${URL}/debug/stats`);
  check(
    "Scenario D: room shrank to 3 peers after Alice left (no crash, no ghost membership)",
    stats.socketCount === 3 && stats.roomCount === 1,
    JSON.stringify(stats)
  );

  [bob, carol, dave].forEach((c) => c.disconnect());
}

// ---------- main ----------
async function main() {
  console.log(`Spawning signaling server (PORT=${PORT}) for multi-peer signaling test...\n`);

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(PORT), CLIENT_URL: "http://localhost:5052" },
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

  try {
    console.log("\n--- Scenario A: 4 peers join one room ---");
    const { room, clients } = await scenarioFourPeersJoin();

    console.log("\n--- Scenario B: 5th peer rejected (room-full) ---");
    await scenarioFifthPeerRejected(room);

    console.log("\n--- Scenario C: targeted signal isolation ---");
    await scenarioTargetedSignal(room, clients);

    console.log("\n--- Scenario D: peer-left fan-out + late signal no-op ---");
    await scenarioPeerLeftFanoutAndLateSignal(room, clients);
  } catch (err) {
    check("All scenarios completed without throwing", false, String(err));
  }

  await wait(300);
  const finalHealth = await waitForHealth(5);
  check(
    "Server process still alive and responsive after all scenarios",
    finalHealth && !serverExited,
    serverExited ? exitInfo : undefined
  );

  console.log(`\n${passed} passed, ${failed} failed`);

  if (!serverExited) child.kill();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Multi-peer signaling test runner itself crashed:", err);
  process.exit(1);
});
