// In-memory only — the live, authoritative source for a room's lifecycle
// stats while it's active. signaling.js reads/updates this synchronously
// (cheap, no I/O, can't add latency to the signaling path) and only hands
// the final numbers to metricsPersistence.js once, at the moment the room
// actually closes — RoomSession records final totals, not a running log, so
// a stream of per-join/leave writes isn't needed.
const activeRooms = new Map(); // roomId -> { createdAt, peakPeersCount, transfersCompleted, transfersFailed }

// currentPeerCount is the room's size *after* this join (roomManager.joinRoom
// already returns it that way), so comparing it against the running peak is
// enough to track the true peak without a peer-add/peer-remove event pair.
function recordJoin(roomId, currentPeerCount) {
  let entry = activeRooms.get(roomId);
  if (!entry) {
    entry = { createdAt: new Date(), peakPeersCount: 0, transfersCompleted: 0, transfersFailed: 0 };
    activeRooms.set(roomId, entry);
  }
  if (currentPeerCount > entry.peakPeersCount) entry.peakPeersCount = currentPeerCount;
}

// 'aborted' and 'stalled' both roll up into "failed" for RoomSession's
// summary counters — TransferMetric keeps the finer-grained distinction per
// individual transfer.
function recordTransferOutcome(roomId, status) {
  const entry = activeRooms.get(roomId);
  if (!entry) return; // telemetry for a room this tracker never saw a join for — ignore rather than fabricate a room
  if (status === "completed") entry.transfersCompleted += 1;
  else entry.transfersFailed += 1;
}

// Called once, when roomManager reports the room's peer set just emptied.
// Returns the final snapshot for persistence and stops tracking the room.
function closeRoom(roomId) {
  const entry = activeRooms.get(roomId);
  activeRooms.delete(roomId);
  return entry || null;
}

module.exports = { recordJoin, recordTransferOutcome, closeRoom };
