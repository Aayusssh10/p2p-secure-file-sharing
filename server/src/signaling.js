const { joinRoom, leaveRoom, findRoomBySocket } = require("./roomManager");

const DEFAULT_DISPLAY_NAME = "Anonymous Peer";
const MAX_NAME_LENGTH = 20;

// Small, non-exhaustive blocklist — enough to demonstrate basic profanity
// filtering without trying to be a comprehensive moderation system. Mirrors
// client/src/utils/displayName.js; this copy is authoritative since it's
// what actually gets broadcast to the other peer.
const BLOCKED_WORDS = ["fuck", "shit", "bitch", "asshole", "bastard", "dick", "cunt"];

// Trims, strips angle brackets (belt-and-suspenders — clients already render
// this as plain text, never HTML), caps length, and falls back to a safe
// default for empty or blocklisted input. A malicious/modified client could
// send anything here, so this is the enforcement point that matters.
function normalizeDisplayName(name) {
  if (typeof name !== "string") return DEFAULT_DISPLAY_NAME;

  const cleaned = name.replace(/[<>]/g, "").trim().slice(0, MAX_NAME_LENGTH);
  if (!cleaned) return DEFAULT_DISPLAY_NAME;

  const lower = cleaned.toLowerCase();
  if (BLOCKED_WORDS.some((word) => lower.includes(word))) return DEFAULT_DISPLAY_NAME;

  return cleaned;
}

function registerSignalingHandlers(socket) {
  // join-room accepts either a bare roomId string (older/test clients) or
  // { roomId, displayName } — both forms are relayed the same way.
  socket.on("join-room", (payload) => {
    const isObj = payload && typeof payload === "object";
    const roomId = isObj ? payload.roomId : payload;
    const displayName = normalizeDisplayName(isObj ? payload.displayName : undefined);

    if (!roomId || typeof roomId !== "string") {
      socket.emit("error-message", "Invalid room ID");
      return;
    }

    // A socket that's already in a different room (e.g. a misbehaving client
    // firing join-room twice without leaving) must not keep a ghost
    // membership behind in the old room once it eventually disconnects.
    const existingRoom = findRoomBySocket(socket.id);
    if (existingRoom && existingRoom !== roomId) {
      handleLeave(socket, existingRoom);
    }

    const result = joinRoom(roomId, socket.id);
    if (!result.ok) {
      socket.emit("room-full", roomId);
      return;
    }

    socket.data.displayName = displayName;
    socket.join(roomId);

    const otherPeers = result.peers.filter((id) => id !== socket.id);
    // Tell the joiner who's already here (name included) — "peer-joined"
    // below only reaches sockets already in the room, so without this the
    // second peer into a room would never learn the first peer's name.
    const otherPeerNames = otherPeers.map((id) => {
      const existingSocket = socket.nsp.sockets.get(id);
      return { peerId: id, displayName: (existingSocket && existingSocket.data.displayName) || DEFAULT_DISPLAY_NAME };
    });
    socket.emit("joined-room", { roomId, peers: otherPeers, peerNames: otherPeerNames });
    socket.to(roomId).emit("peer-joined", { peerId: socket.id, displayName });
  });

  // data carries the SDP offer/answer or ICE candidate — server relays it untouched.
  // payload may be null/a primitive/anything from a misbehaving client, so guard
  // the destructure instead of trusting it's an object (a bare `= {}` default only
  // covers `undefined`, not `null` or other non-object values).
  //
  // targetPeerId routes the message to exactly one socket. With only 2 peers
  // in a room, "broadcast to everyone else" and "send to the one other peer"
  // are the same thing, but with 3+ peers a room-wide broadcast would corrupt
  // every other pairwise negotiation. Socket.io auto-joins every socket to a
  // room named after its own id, so `.to(targetPeerId)` is a plain point-to-
  // point send. Falls back to the old room-wide broadcast if targetPeerId is
  // missing (older/test clients), which is still correct for a 2-peer room.
  socket.on("signal", (payload) => {
    const { roomId, targetPeerId, data } = payload && typeof payload === "object" ? payload : {};
    if (!roomId || !data) return;
    const destination = targetPeerId || roomId;
    socket.to(destination).emit("signal", { peerId: socket.id, data });
  });

  socket.on("leave-room", (roomId) => {
    handleLeave(socket, roomId);
  });

  socket.on("disconnect", () => {
    const roomId = findRoomBySocket(socket.id);
    if (roomId) handleLeave(socket, roomId);
  });
}

function handleLeave(socket, roomId) {
  leaveRoom(roomId, socket.id);
  socket.leave(roomId);
  socket.to(roomId).emit("peer-left", {
    peerId: socket.id,
    displayName: socket.data.displayName || DEFAULT_DISPLAY_NAME,
  });
}

module.exports = { registerSignalingHandlers };
