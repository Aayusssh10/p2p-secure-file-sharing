import {
  createPeerConnection,
  createOffer,
  createAnswer,
  acceptAnswer,
  addIceCandidate,
} from "./peerConnection.js";
import { sendFile, sendText, createFileReceiver } from "./fileTransfer.js";
import { sanitizeDisplayName } from "../utils/displayName.js";

// Orchestrates signaling (Phase 2 server) + RTCPeerConnection (Phase 3) into one
// connect(...) call that resolves a working data channel between two peers in a room.
export function connect({
  serverUrl,
  roomId,
  displayName,
  onStatus,
  onFileReceived,
  onProgress,
  onText,
  onPeerJoined,
  onPeerLeft,
  onPeerName,
}) {
  const socket = window.io(serverUrl);
  const myName = sanitizeDisplayName(displayName);
  let pc = null;
  let dataChannel = null;

  const emitStatus = (status) => {
    if (onStatus) onStatus(status);
  };

  const handleReceiverMessage = createFileReceiver({
    onProgress,
    onComplete: (blob, meta) => onFileReceived && onFileReceived(blob, meta),
    onText: (text, name) => onText && onText(text, name),
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

  socket.on("joined-room", async ({ peers, peerNames }) => {
    setupPeerConnection();
    const isInitiator = peers.length > 0;

    // Learn the already-present peer's name quietly (no "joined" chat line —
    // they didn't just join, we did) so the joiner's UI isn't left blank
    // about who they're connecting to.
    if (onPeerName && peerNames && peerNames.length > 0) {
      onPeerName(peerNames[0].displayName);
    }

    if (isInitiator) {
      const channel = pc.createDataChannel("file-transfer");
      setupDataChannel(channel);
      const offer = await createOffer(pc);
      socket.emit("signal", { roomId, data: { type: "offer", sdp: offer } });
    }

    emitStatus("waiting-for-peer");
  });

  socket.on("peer-joined", (payload) => {
    emitStatus("peer-joined");
    if (onPeerJoined) onPeerJoined(payload && payload.displayName);
  });

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

  socket.on("peer-left", (payload) => {
    emitStatus("peer-left");
    if (onPeerLeft) onPeerLeft(payload && payload.displayName);
    if (dataChannel) dataChannel.close();
    if (pc) pc.close();
  });

  socket.on("room-full", () => emitStatus("room-full"));
  socket.on("error-message", (msg) => emitStatus("error: " + msg));

  socket.emit("join-room", { roomId, displayName: myName });

  return {
    sendFile: (file, opts) => sendFile(dataChannel, file, opts),
    sendText: (text) => sendText(dataChannel, text, myName),
    disconnect: () => {
      if (dataChannel) dataChannel.close();
      if (pc) pc.close();
      socket.disconnect();
    },
  };
}
