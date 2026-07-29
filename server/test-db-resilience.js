// MongoDB resilience test — verifies the metrics pipeline is *strictly
// additive* to the signaling server's real job. Unlike test-stress.js /
// test-load.js, this does NOT spawn the server as a child process: a
// mid-session Mongo outage can only be injected by calling mongoose.disconnect()
// directly on the live connection object, which a spawned child would hide
// from this script entirely. So this test builds the same http+Socket.io
// wiring server.js does, in-process, giving direct access to db.js's
// mongoose connection.
//
// Run with: node test-db-resilience.js
// Requires a real, reachable MONGO_URI in server/.env (read once at startup,
// then deliberately overwritten mid-run to simulate an invalid/unreachable DB).

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const http = require("http");
const { Server } = require("socket.io");
const { io } = require("socket.io-client");
const mongoose = require("mongoose");

const REAL_MONGO_URI = process.env.MONGO_URI;
const { connectToDatabase, isConnected } = require("./src/db");
const { registerSignalingHandlers } = require("./src/signaling");
const TransferMetric = require("./src/models/TransferMetric");

const PORT = 4102;
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

const unhandledRejections = [];
process.on("unhandledRejection", (err) => {
  unhandledRejections.push(err);
});

let ioServer = null;
let httpServer = null;

function startSignalingServer() {
  httpServer = http.createServer();
  ioServer = new Server(httpServer, { cors: { origin: "*" } });
  ioServer.on("connection", (socket) => registerSignalingHandlers(socket));
  return new Promise((resolve) => httpServer.listen(PORT, resolve));
}

function stopSignalingServer() {
  return new Promise((resolve) => {
    ioServer.close(() => httpServer.close(resolve));
  });
}

// Full join-room -> peer-joined -> signal -> telemetry round trip between two
// real socket.io-client connections, timed end to end.
async function runSignalingRoundTrip(roomId) {
  const t0 = Date.now();
  const a = io(URL, { transports: ["websocket"] });
  const b = io(URL, { transports: ["websocket"] });

  await new Promise((resolve) => a.on("connect", resolve));
  await new Promise((resolve) => b.on("connect", resolve));

  a.emit("join-room", { roomId, displayName: "Alice" });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const bJoinedPromise = new Promise((resolve) => b.once("joined-room", resolve));
  const aPeerJoinedPromise = new Promise((resolve) => a.once("peer-joined", resolve));
  b.emit("join-room", { roomId, displayName: "Bob" });
  await bJoinedPromise;
  await aPeerJoinedPromise;

  const bSawSignal = new Promise((resolve) => b.once("signal", resolve));
  a.emit("signal", { roomId, targetPeerId: b.id, data: { type: "offer", sdp: "fake-sdp" } });
  await bSawSignal;

  b.emit("telemetry:transfer_result", {
    roomId,
    senderId: a.id,
    fileSizeBytes: 1024,
    durationMs: 5,
    status: "completed",
    sha256Match: true,
  });
  await wait(100); // let the fire-and-forget persist attempt settle

  a.close();
  b.close();
  await wait(50);

  return Date.now() - t0;
}

async function main() {
  console.log("=== Phase A: server behavior when MONGO_URI is invalid/unreachable from the start ===\n");

  process.env.MONGO_URI = "mongodb+srv://baduser:badpass@nonexistent-cluster-abc123.mongodb.net/test?retryWrites=true&w=majority";
  await connectToDatabase();
  check("connectToDatabase() with an unreachable URI does not throw", true);
  check("isConnected() is false with unreachable URI", !isConnected());

  await startSignalingServer();
  const elapsedDbDown = await runSignalingRoundTrip("resilience-test-down");
  check(
    "Full join+signal+telemetry round trip succeeds with DB unreachable",
    true
  );
  console.log(`  (round trip took ${elapsedDbDown}ms)`);
  check(
    "No unhandled promise rejections while DB was unreachable",
    unhandledRejections.length === 0,
    unhandledRejections.map((e) => e.message).join("; ")
  );
  await stopSignalingServer();

  console.log("\n=== Phase B: mid-session outage after a real successful connection ===\n");

  if (!REAL_MONGO_URI) {
    check("REAL_MONGO_URI available from server/.env for phase B", false, "MONGO_URI not set in .env — skipping phase B");
  } else {
    process.env.MONGO_URI = REAL_MONGO_URI;
    await connectToDatabase();
    check("connectToDatabase() connects successfully with the real URI", isConnected());

    await startSignalingServer();

    const roomIdUp = "resilience-test-up-" + Date.now();
    const beforeCount = await TransferMetric.countDocuments({ roomId: roomIdUp });
    const elapsedDbUp = await runSignalingRoundTrip(roomIdUp);
    await wait(200);
    const afterCount = await TransferMetric.countDocuments({ roomId: roomIdUp });
    console.log(`  (round trip took ${elapsedDbUp}ms)`);
    check("TransferMetric persisted while DB is up and connected", afterCount === beforeCount + 1);
    check(
      "Latency with DB up is in the same ballpark as with DB down (no blocking)",
      Math.abs(elapsedDbUp - elapsedDbDown) < 500,
      `up=${elapsedDbUp}ms down=${elapsedDbDown}ms`
    );

    // Simulate an involuntary mid-session outage: same mongoose connection
    // state (readyState -> disconnected) as a real network drop would cause.
    await mongoose.disconnect();
    check("isConnected() flips to false after the connection drops", !isConnected());

    const roomIdOutage = "resilience-test-outage-" + Date.now();
    const beforeOutageCount = await TransferMetric.countDocuments({ roomId: roomIdOutage }).catch(() => -1);
    const elapsedOutage = await runSignalingRoundTrip(roomIdOutage);
    console.log(`  (round trip during outage took ${elapsedOutage}ms)`);
    check(
      "Signaling round trip still completes during a mid-session DB outage",
      true
    );
    check(
      "No unhandled promise rejections during the mid-session outage",
      unhandledRejections.length === 0,
      unhandledRejections.map((e) => e.message).join("; ")
    );

    await stopSignalingServer();

    // Reconnect to check the doc count directly (can't query while disconnected).
    await connectToDatabase();
    const afterOutageCount = await TransferMetric.countDocuments({ roomId: roomIdOutage });
    check(
      "No TransferMetric was persisted for the write attempted during the outage",
      afterOutageCount === 0,
      `found ${afterOutageCount} (before outage query returned ${beforeOutageCount})`
    );
    check("Reconnects successfully once the outage clears", isConnected());
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await mongoose.disconnect().catch(() => {});
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner itself crashed:", err);
  process.exit(1);
});
