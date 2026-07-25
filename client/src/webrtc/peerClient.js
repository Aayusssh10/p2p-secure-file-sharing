import {
  createPeerConnection,
  createOffer,
  createAnswer,
  acceptAnswer,
  addIceCandidate,
} from "./peerConnection.js";
import { sendFile, createFileReceiver } from "./fileTransfer.js";

// Orchestrates signaling (Phase 2 server) + RTCPeerConnection (Phase 3) into one
// connect(...) call that resolves a working data channel between two peers in a room.
export function connect({ serverUrl, roomId, onStatus, onFileReceived, onProgress }) {
  const socket = window.io(serverUrl);
  let pc = null;
  let dataChannel = null;

  const emitStatus = (status) => {
    if (onStatus) onStatus(status);
  };

  const handleReceiverMessage = createFileReceiver({
    onProgress,
    onComplete: (blob, meta) => onFileReceived && onFileReceived(blob, meta),
  });

  function setupDataChannel(channel) {
    channel.binaryType = "arraybuffer";
    dataChannel = channel;
    channel.onopen = () => emitStatus("connected");
    channel.onclose = () => emitStatus("channel-closed");
    channel.onerror = () => emitStatus("channel-error");
    channel.onmessage = handleReceiverMessage;
  }

  function setupPeerConnection() {
    pc = createPeerConnection({
      onIceCandidate: (candidate) => {
        socket.emit("signal", { roomId, data: { type: "ice-candidate", candidate } });
      },
      onDataChannel: (channel) => setupDataChannel(channel),
      onConnectionStateChange: (state) => emitStatus(state),
    });
  }

  socket.on("joined-room", async ({ peers }) => {
    setupPeerConnection();
    const isInitiator = peers.length > 0;

    if (isInitiator) {
      const channel = pc.createDataChannel("file-transfer");
      setupDataChannel(channel);
      const offer = await createOffer(pc);
      socket.emit("signal", { roomId, data: { type: "offer", sdp: offer } });
    }

    emitStatus("waiting-for-peer");
  });

  socket.on("peer-joined", () => emitStatus("peer-joined"));

  socket.on("signal", async ({ data }) => {
    if (data.type === "offer") {
      const answer = await createAnswer(pc, data.sdp);
      socket.emit("signal", { roomId, data: { type: "answer", sdp: answer } });
    } else if (data.type === "answer") {
      await acceptAnswer(pc, data.sdp);
    } else if (data.type === "ice-candidate") {
      await addIceCandidate(pc, data.candidate);
    }
  });

  socket.on("peer-left", () => {
    emitStatus("peer-left");
    if (dataChannel) dataChannel.close();
    if (pc) pc.close();
  });

  socket.on("room-full", () => emitStatus("room-full"));
  socket.on("error-message", (msg) => emitStatus("error: " + msg));

  socket.emit("join-room", roomId);

  return {
    sendFile: (file, opts) => sendFile(dataChannel, file, opts),
    disconnect: () => {
      if (dataChannel) dataChannel.close();
      if (pc) pc.close();
      socket.disconnect();
    },
  };
}
