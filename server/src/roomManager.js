const MAX_PEERS_PER_ROOM = 2;

const rooms = new Map(); // roomId -> Set<socketId>

function joinRoom(roomId, socketId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }

  const peers = rooms.get(roomId);
  if (peers.size >= MAX_PEERS_PER_ROOM) {
    return { ok: false, reason: "room-full" };
  }

  peers.add(socketId);
  return { ok: true, peers: [...peers] };
}

function leaveRoom(roomId, socketId) {
  const peers = rooms.get(roomId);
  if (!peers) return;

  peers.delete(socketId);
  if (peers.size === 0) {
    rooms.delete(roomId);
  }
}

function findRoomBySocket(socketId) {
  for (const [roomId, peers] of rooms.entries()) {
    if (peers.has(socketId)) return roomId;
  }
  return null;
}

function getStats() {
  let socketCount = 0;
  for (const peers of rooms.values()) socketCount += peers.size;
  return { roomCount: rooms.size, socketCount };
}

module.exports = { joinRoom, leaveRoom, findRoomBySocket, MAX_PEERS_PER_ROOM, getStats };
