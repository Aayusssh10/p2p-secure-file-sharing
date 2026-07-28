const mongoose = require("mongoose");

// One document per room's full lifecycle, written once when the room
// actually closes (its last peer leaves) — not a live-updated document, so
// there's no partial/in-progress row to reconcile if the process restarts
// mid-room. Room/session metadata only, per the project's core privacy
// rule — no display names, no chat, no file names or content.
const roomSessionSchema = new mongoose.Schema({
  roomId: { type: String, required: true, index: true },
  createdAt: { type: Date, required: true },
  closedAt: { type: Date, required: true },
  totalDurationMs: { type: Number, required: true, min: 0 },
  peakPeersCount: { type: Number, required: true, min: 0 },
  totalTransfersCompleted: { type: Number, required: true, min: 0, default: 0 },
  totalTransfersFailed: { type: Number, required: true, min: 0, default: 0 },
});

module.exports = mongoose.model("RoomSession", roomSessionSchema);
