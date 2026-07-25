// Load test for the signaling server: 50 concurrent socket connections joining
// 25 different rooms (2 peers/room, filling every room exactly) at the same
// time, exchanging mock offer/answer/ICE signaling messages, then all
// disconnecting after 5 seconds. Repeats for several rounds against the same
// long-lived server process so memory-flatness and leak-freedom (rooms and
// sockets returning to zero) can be checked across repeated load, not just
// a single before/after snapshot.
// Run with: node test-load.js

const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const { io } = require("socket.io-client");

const SERVER_ENTRY = path.join(__dirname, "src", "server.js");
const PORT = 4200;
const URL = `http://localhost:${PORT}`;

const ROOMS_PER_ROUND = 25;
const PEERS_PER_ROOM = 2;
const SOCKETS_PER_ROUND = ROOMS_PER_ROUND * PEERS_PER_ROOM; // 50
const ROUNDS = 3;
const HOLD_MS = 5000;
const RSS_GROWTH_THRESHOLD_PCT = 20; // flag as a possible leak above this

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
      const stats = await httpGetJson(`${URL}/health`);
      if (stats && stats.status === "ok") return true;
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

function fmtMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2) + "MB";
}

// Wires up a mock WebRTC-style handshake on a socket: whichever of the two
// room peers was already present sends an "offer" once notified of the
// newcomer (peer-joined); the newcomer answers; the offerer follows up with
// an ICE candidate. Attached identically to both peers so it works regardless
// of which one happens to join the room first under concurrent load.
function attachMockSignaling(socket, roomId) {
  socket.on("peer-joined", () => {
    socket.emit("signal", { roomId, data: { type: "offer", sdp: "mock-offer-sdp" } });
  });
  socket.on("signal", (payload) => {
    if (!payload || !payload.data) return;
    if (payload.data.type === "offer") {
      socket.emit("signal", { roomId, data: { type: "answer", sdp: "mock-answer-sdp" } });
    } else if (payload.data.type === "answer") {
      socket.emit("signal", { roomId, data: { type: "ice-candidate", candidate: "mock-ice-1" } });
    }
  });
}

// Creates SOCKETS_PER_ROUND clients across ROOMS_PER_ROUND rooms, all joining
// at the same time, exchanges mock signaling, holds the connections open for
// HOLD_MS, then disconnects everything and gives the server a moment to clean
// up before returning.
async function runRound(roundIndex) {
  const clients = [];
  const joinPromises = [];

  for (let i = 0; i < ROOMS_PER_ROUND; i++) {
    const roomId = `load-r${roundIndex}-room${i}-${Date.now()}`;
    const a = newClient();
    const b = newClient();
    clients.push(a, b);

    attachMockSignaling(a, roomId);
    attachMockSignaling(b, roomId);

    for (const sock of [a, b]) {
      joinPromises.push(
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`round ${roundIndex} room ${roomId}: join timeout`)),
            8000
          );
          sock.on("connect", () => sock.emit("join-room", roomId));
          sock.on("joined-room", () => {
            clearTimeout(timer);
            resolve();
          });
          sock.on("connect_error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
        })
      );
    }
  }

  // "at the exact same time" — every socket's connect() has already fired
  // above; this just waits for all 50 join-room round-trips to settle.
  await Promise.all(joinPromises);

  await wait(HOLD_MS);

  clients.forEach((c) => c.disconnect());

  // let the server process all 50 disconnects / room cleanups
  await wait(500);

  return clients.length;
}

async function main() {
  console.log(`Spawning signaling server (PORT=${PORT}) for load test...\n`);

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(PORT), CLIENT_URL: "http://localhost:5051" },
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

  const baseline = await httpGetJson(`${URL}/debug/stats`);
  check(
    "Baseline: no rooms/sockets before load test begins",
    baseline.roomCount === 0 && baseline.connectedSockets === 0,
    JSON.stringify(baseline)
  );
  console.log(
    `Baseline memory: rss=${fmtMB(baseline.memoryUsage.rss)} heapUsed=${fmtMB(baseline.memoryUsage.heapUsed)}\n`
  );

  const rssSnapshots = [baseline.memoryUsage.rss];

  for (let round = 1; round <= ROUNDS; round++) {
    console.log(`--- Round ${round}/${ROUNDS}: ${SOCKETS_PER_ROUND} sockets across ${ROOMS_PER_ROUND} rooms ---`);
    const t0 = Date.now();
    try {
      const count = await runRound(round);
      const elapsed = Date.now() - t0;
      console.log(`Round ${round}: ${count} sockets joined, signaled, held ${HOLD_MS}ms, disconnected — took ${elapsed}ms total`);
    } catch (err) {
      check(`Round ${round}: all 50 sockets joined their rooms without error`, false, String(err));
    }

    const stats = await httpGetJson(`${URL}/debug/stats`);
    rssSnapshots.push(stats.memoryUsage.rss);
    check(`Round ${round}: no leaked rooms after cleanup (roomCount should be 0)`, stats.roomCount === 0, JSON.stringify(stats));
    check(
      `Round ${round}: no leaked sockets after cleanup (connectedSockets should be 0)`,
      stats.connectedSockets === 0,
      JSON.stringify(stats)
    );
    console.log(`Round ${round} memory: rss=${fmtMB(stats.memoryUsage.rss)} heapUsed=${fmtMB(stats.memoryUsage.heapUsed)}\n`);
  }

  // Compare RSS right after round 1 (JIT/buffers already warmed up) against
  // the final round — a real leak shows up as steady growth across rounds,
  // not just first-run warmup noise.
  const rssAfterRound1 = rssSnapshots[1];
  const rssAfterFinalRound = rssSnapshots[ROUNDS];
  const growthBytes = rssAfterFinalRound - rssAfterRound1;
  const growthPct = (growthBytes / rssAfterRound1) * 100;
  check(
    `Memory stayed flat across ${ROUNDS - 1} repeated rounds of load (RSS ${fmtMB(rssAfterRound1)} -> ${fmtMB(
      rssAfterFinalRound
    )}, ${growthPct.toFixed(1)}% growth, threshold ${RSS_GROWTH_THRESHOLD_PCT}%)`,
    growthPct < RSS_GROWTH_THRESHOLD_PCT
  );

  const finalHealth = await waitForHealth(5);
  check(
    "Server process still alive and responsive after full load test",
    finalHealth && !serverExited,
    serverExited ? exitInfo : undefined
  );

  console.log(`\n${passed} passed, ${failed} failed`);

  if (!serverExited) child.kill();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Load test runner itself crashed:", err);
  process.exit(1);
});
