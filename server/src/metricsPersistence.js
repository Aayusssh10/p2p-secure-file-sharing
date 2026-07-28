const RoomSession = require("./models/RoomSession");
const TransferMetric = require("./models/TransferMetric");
const { isConnected } = require("./db");

// Both exports are fire-and-forget from the caller's perspective in
// signaling.js — never awaited, and every failure is caught and logged
// right here, so a slow or unreachable MongoDB can never surface as an
// unhandled rejection or add latency to a live join/leave/signal relay.

async function persistRoomSession({ roomId, createdAt, closedAt, peakPeersCount, transfersCompleted, transfersFailed }) {
  if (!isConnected()) return;
  try {
    await RoomSession.create({
      roomId,
      createdAt,
      closedAt,
      totalDurationMs: closedAt.getTime() - createdAt.getTime(),
      peakPeersCount,
      totalTransfersCompleted: transfersCompleted,
      totalTransfersFailed: transfersFailed,
    });
  } catch (err) {
    console.error(`Failed to persist RoomSession for room ${roomId}:`, err.message);
  }
}

async function persistTransferMetric({ roomId, senderId, receiverId, fileSizeBytes, durationMs, status, sha256Match }) {
  if (!isConnected()) return;
  try {
    await TransferMetric.create({ roomId, senderId, receiverId, fileSizeBytes, durationMs, status, sha256Match });
  } catch (err) {
    console.error(`Failed to persist TransferMetric for room ${roomId}:`, err.message);
  }
}

module.exports = { persistRoomSession, persistTransferMetric };
