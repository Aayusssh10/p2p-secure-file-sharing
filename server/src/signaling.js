const { joinRoom, leaveRoom, findRoomBySocket } = require("./roomManager");

function registerSignalingHandlers(socket) {
  socket.on("join-room", (roomId) => {
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

    socket.join(roomId);

    const otherPeers = result.peers.filter((id) => id !== socket.id);
    socket.emit("joined-room", { roomId, peers: otherPeers });
    socket.to(roomId).emit("peer-joined", { peerId: socket.id });
  });

  // data carries the SDP offer/answer or ICE candidate — server relays it untouched.
  // payload may be null/a primitive/anything from a misbehaving client, so guard
  // the destructure instead of trusting it's an object (a bare `= {}` default only
  // covers `undefined`, not `null` or other non-object values).
  socket.on("signal", (payload) => {
    const { roomId, data } = payload && typeof payload === "object" ? payload : {};
    if (!roomId || !data) return;
    socket.to(roomId).emit("signal", { peerId: socket.id, data });
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
  socket.to(roomId).emit("peer-left", { peerId: socket.id });
}

module.exports = { registerSignalingHandlers };
