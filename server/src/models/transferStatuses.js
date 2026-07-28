// Shared between TransferMetric.js (schema enum) and signaling.js (payload
// validation) so the two can't silently drift apart.
const TRANSFER_STATUSES = ["completed", "aborted", "stalled"];

module.exports = { TRANSFER_STATUSES };
