const mongoose = require("mongoose");
const { TRANSFER_STATUSES } = require("./transferStatuses");

// One document per pairwise transfer outcome (sender -> one receiver), not
// per sendFile() call — a single broadcast to 3 peers in a mesh room
// produces up to 3 of these, since each recipient's outcome (duration,
// whether it completed/stalled/aborted, whether the hash matched) is
// independent of the others. Reported by the *receiver* (see
// fileTransfer.js/peerClient.js) since only the receiver actually knows
// whether the hash matched or the transfer was ever interrupted — the
// sender only knows it forwarded chunks, not whether they arrived intact.
// senderId/receiverId are ephemeral Socket.io socket ids, never display
// names — anonymous by construction, not just by convention. No file name
// or content ever appears here, per the project's core privacy rule.
const transferMetricSchema = new mongoose.Schema({
  roomId: { type: String, required: true, index: true },
  senderId: { type: String, required: true },
  receiverId: { type: String, required: true },
  fileSizeBytes: { type: Number, required: true, min: 0 },
  durationMs: { type: Number, required: true, min: 0 },
  status: { type: String, required: true, enum: TRANSFER_STATUSES },
  sha256Match: { type: Boolean, required: true },
  createdAt: { type: Date, required: true, default: Date.now },
});

module.exports = mongoose.model("TransferMetric", transferMetricSchema);
