// Telemetry payload sanitization test — the telemetry:transfer_result
// listener in signaling.js trusts client-reported data (the server never
// sees the file itself, so it can't independently verify most of this
// payload — see the comment above that handler). This test spawns the real
// server as a child process (like test-stress.js) and connects a raw
// socket.io-client directly, bypassing the UI entirely, to fire malformed /
// adversarial payloads straight at the listener and confirm:
//   1. The server process never crashes.
//   2. Nothing malformed is ever persisted to MongoDB.
//   3. A well-formed payload sent afterward still persists correctly (proof
//      the listener/connection wasn't left in a broken state).
//
// Run with: node test-telemetry-sanitization.js
// Requires a real, reachable MONGO_URI in server/.env.

const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const { io } = require("socket.io-client");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
const mongoose = require("mongoose");
const TransferMetric = require("./src/models/TransferMetric");

const SERVER_ENTRY = path.join(__dirname, "src", "server.js");
const PORT = 4103;
const URL = `http://localhost:${PORT}`;
const ROOM_ID = "sanitization-test-" + Date.now();

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
    http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

async function waitForHealth(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await httpGet(`${URL}/health`);
      if (res.status === 200) return true;
    } catch {}
    await wait(200);
  }
  return false;
}

// Malicious/malformed payloads. Each entry is sent as the raw
// telemetry:transfer_result payload from a directly-connected socket.
const ATTACK_PAYLOADS = [
  { name: "completely missing roomId", payload: { senderId: "x", fileSizeBytes: 100, durationMs: 5, status: "completed", sha256Match: true } },
  { name: "completely missing senderId", payload: { roomId: ROOM_ID, fileSizeBytes: 100, durationMs: 5, status: "completed", sha256Match: true } },
  { name: "fileSizeBytes as a string", payload: { roomId: ROOM_ID, senderId: "x", fileSizeBytes: "1000", durationMs: 5, status: "completed", sha256Match: true } },
  { name: "fileSizeBytes negative", payload: { roomId: ROOM_ID, senderId: "x", fileSizeBytes: -500, durationMs: 5, status: "completed", sha256Match: true } },
  { name: "fileSizeBytes Infinity", payload: { roomId: ROOM_ID, senderId: "x", fileSizeBytes: Infinity, durationMs: 5, status: "completed", sha256Match: true } },
  { name: "fileSizeBytes NaN", payload: { roomId: ROOM_ID, senderId: "x", fileSizeBytes: NaN, durationMs: 5, status: "completed", sha256Match: true } },
  { name: "durationMs negative", payload: { roomId: ROOM_ID, senderId: "x", fileSizeBytes: 100, durationMs: -5, status: "completed", sha256Match: true } },
  { name: "durationMs Infinity", payload: { roomId: ROOM_ID, senderId: "x", fileSizeBytes: 100, durationMs: Infinity, status: "completed", sha256Match: true } },
  { name: "status not in enum (garbage string)", payload: { roomId: ROOM_ID, senderId: "x", fileSizeBytes: 100, durationMs: 5, status: "hacked-the-mainframe", sha256Match: true } },
  { name: "status as a NoSQL-operator-shaped object", payload: { roomId: ROOM_ID, senderId: "x", fileSizeBytes: 100, durationMs: 5, status: { $ne: null }, sha256Match: true } },
  { name: "roomId as an object (prototype-pollution shaped)", payload: { roomId: { toString: () => ROOM_ID, __proto__: { polluted: true } }, senderId: "x", fileSizeBytes: 100, durationMs: 5, status: "completed", sha256Match: true } },
  { name: "roomId as empty string", payload: { roomId: "", senderId: "x", fileSizeBytes: 100, durationMs: 5, status: "completed", sha256Match: true } },
  { name: "senderId as a number", payload: { roomId: ROOM_ID, senderId: 12345, fileSizeBytes: 100, durationMs: 5, status: "completed", sha256Match: true } },
  { name: "entirely null payload", payload: null },
  { name: "payload is a bare string, not an object", payload: "just a string" },
  { name: "payload is an array", payload: [1, 2, 3] },
];

// Not an attack — a legitimate payload with harmless extra fields (and a
// __proto__ key in the object literal) tacked on. This SHOULD be accepted:
// ignoring unknown fields is correct, secure behavior, not a vulnerability.
// Checked separately from ATTACK_PAYLOADS so it isn't scored as "must reject".
const BENIGN_EXTRA_FIELDS_PAYLOAD = {
  roomId: ROOM_ID,
  senderId: "extra-fields-sender",
  fileSizeBytes: 100,
  durationMs: 5,
  status: "completed",
  sha256Match: true,
  __proto__: { polluted: true },
  extraField: "should be ignored",
};

async function main() {
  console.log(`Spawning signaling server (PORT=${PORT}) for telemetry sanitization test...\n`);

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

  await mongoose.connect(process.env.MONGO_URI);
  const beforeCount = await TransferMetric.countDocuments({ roomId: ROOM_ID });
  check("Baseline: no TransferMetric docs exist yet for this test's roomId", beforeCount === 0, `found ${beforeCount}`);

  const socket = io(URL, { transports: ["websocket"] });
  await new Promise((resolve) => socket.on("connect", resolve));

  console.log(`\nFiring ${ATTACK_PAYLOADS.length} malformed/malicious payloads...\n`);

  for (const attack of ATTACK_PAYLOADS) {
    socket.emit("telemetry:transfer_result", attack.payload);
  }
  await wait(500);

  check(
    "Server process is still alive after all malformed payloads",
    !serverExited,
    serverExited ? exitInfo : undefined
  );
  const healthAfterAttacks = await waitForHealth(5);
  check("Server still responds to /health after all malformed payloads", healthAfterAttacks);

  const afterAttacksCount = await TransferMetric.countDocuments({ roomId: ROOM_ID });
  check(
    "No malformed payload was persisted to MongoDB",
    afterAttacksCount === beforeCount,
    `expected ${beforeCount}, found ${afterAttacksCount}`
  );
  if (afterAttacksCount !== beforeCount) {
    const leaked = await TransferMetric.find({ roomId: ROOM_ID }).lean();
    console.log("  Leaked document(s):", JSON.stringify(leaked, null, 2));
  }

  // Sanity check: the connection/listener isn't left in some broken state —
  // a legitimate payload sent right after the attack barrage should still work.
  socket.emit("telemetry:transfer_result", {
    roomId: ROOM_ID,
    senderId: "legit-sender",
    fileSizeBytes: 2048,
    durationMs: 12,
    status: "completed",
    sha256Match: true,
  });
  await wait(300);
  const afterLegitCount = await TransferMetric.countDocuments({ roomId: ROOM_ID });
  check(
    "A well-formed payload sent right after the attack barrage still persists correctly",
    afterLegitCount === beforeCount + 1,
    `expected ${beforeCount + 1}, found ${afterLegitCount}`
  );

  // A valid payload with harmless extra fields should be accepted, and the
  // extra field should NOT make it into the stored document (schema strips
  // anything not declared on TransferMetric).
  socket.emit("telemetry:transfer_result", BENIGN_EXTRA_FIELDS_PAYLOAD);
  await wait(300);
  const extraFieldsDoc = await TransferMetric.findOne({ roomId: ROOM_ID, senderId: "extra-fields-sender" }).lean();
  check(
    "A valid payload with extra unknown fields is accepted",
    !!extraFieldsDoc
  );
  check(
    "The extra unknown field is not stored on the document (schema strips it)",
    !!extraFieldsDoc && !("extraField" in extraFieldsDoc) && !("polluted" in extraFieldsDoc)
  );

  // Bonus: an implausibly huge (but technically valid per current schema)
  // fileSizeBytes is accepted with no crash — flags a possible upper-bound
  // gap rather than a false "vulnerability", since nothing here can crash.
  socket.emit("telemetry:transfer_result", {
    roomId: ROOM_ID,
    senderId: "huge-sender",
    fileSizeBytes: Number.MAX_SAFE_INTEGER,
    durationMs: 5,
    status: "completed",
    sha256Match: true,
  });
  await wait(300);
  const hugeDoc = await TransferMetric.findOne({ roomId: ROOM_ID, senderId: "huge-sender" }).lean();
  check(
    "(informational) an implausibly huge fileSizeBytes is currently accepted without an upper bound",
    !!hugeDoc,
    hugeDoc ? `stored fileSizeBytes=${hugeDoc.fileSizeBytes}` : "not stored"
  );

  socket.close();
  await TransferMetric.deleteMany({ roomId: ROOM_ID }); // clean up test data
  await mongoose.disconnect();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (!serverExited) child.kill();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner itself crashed:", err);
  process.exit(1);
});
