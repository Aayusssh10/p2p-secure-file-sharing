import {
  createPeerConnection,
  createOffer,
  createAnswer,
  acceptAnswer,
  addIceCandidate,
} from "./peerConnection.js";
import { sendFile, sendText, createFileReceiver } from "./fileTransfer.js";
import { sanitizeDisplayName } from "../utils/displayName.js";

// Orchestrates signaling (Phase 2 server) + WebRTC into one connect(...) call
// that resolves a mesh of peer connections between everyone in a room: each
// pairwise link (this browser <-> one other peer) is an independent
// RTCPeerConnection/RTCDataChannel, tracked in a Map keyed by the remote
// peer's socket id. Initiator role is assigned deterministically — whoever
// joins later offers to everyone already in the room; existing peers just
// wait for that offer — so there's no glare even when multiple people join
// at nearly the same time.
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
  const peers = new Map(); // peerId -> { pc, dataChannel, displayName }

  const emitStatus = (status) => {
    if (onStatus) onStatus(status);
  };

  // Overall status is a simple "is at least one peer connected" signal — the
  // per-peer join/leave/name callbacks below carry the granular detail the
  // UI needs to tell peers apart.
  const updateConnectedStatus = () => {
    const anyOpen = [...peers.values()].some((p) => p.dataChannel && p.dataChannel.readyState === "open");
    emitStatus(anyOpen ? "connected" : "waiting-for-peer");
  };

  function setupDataChannel(peerId, channel) {
    channel.binaryType = "arraybuffer";
    const entry = peers.get(peerId);
    if (!entry) return;
    entry.dataChannel = channel;

    const handleReceiverMessage = createFileReceiver({
      onProgress: (p) => onProgress && onProgress(p, peerId),
      onComplete: (blob, meta) => onFileReceived && onFileReceived(blob, meta, peerId),
      onText: (text, name) => onText && onText(text, name, peerId),
    });

    channel.onopen = updateConnectedStatus;
    channel.onclose = updateConnectedStatus;
    channel.onerror = () => emitStatus("channel-error");
    channel.onmessage = handleReceiverMessage;
  }

  // Creates (or returns, if one already exists) the RTCPeerConnection for a
  // given remote peer. Every pairwise link gets its own ICE/SDP negotiation,
  // completely independent of every other peer in the room.
  function getOrCreateConnection(peerId, peerDisplayName) {
    const existing = peers.get(peerId);
    if (existing) return existing.pc;

    const pc = createPeerConnection({
      onIceCandidate: (candidate) => {
        socket.emit("signal", { roomId, targetPeerId: peerId, data: { type: "ice-candidate", candidate } });
      },
      onDataChannel: (channel) => setupDataChannel(peerId, channel),
      onConnectionStateChange: (state) => {
        if (state === "failed" || state === "closed") updateConnectedStatus();
      },
    });
    peers.set(peerId, { pc, dataChannel: null, displayName: peerDisplayName || "Peer" });
    return pc;
  }

  function closeConnection(peerId) {
    const entry = peers.get(peerId);
    if (!entry) return;
    if (entry.dataChannel) entry.dataChannel.close();
    if (entry.pc) entry.pc.close();
    peers.delete(peerId);
  }

  socket.on("joined-room", async ({ peers: existingPeerIds, peerNames }) => {
    for (const peerId of existingPeerIds) {
      const nameEntry = (peerNames || []).find((p) => p.peerId === peerId);
      const peerDisplayName = nameEntry ? nameEntry.displayName : "Peer";
      if (onPeerName) onPeerName(peerDisplayName, peerId);

      const pc = getOrCreateConnection(peerId, peerDisplayName);
      const channel = pc.createDataChannel("file-transfer");
      setupDataChannel(peerId, channel);
      const offer = await createOffer(pc);
      socket.emit("signal", { roomId, targetPeerId: peerId, data: { type: "offer", sdp: offer } });
    }

    emitStatus(existingPeerIds.length > 0 ? "connecting" : "waiting-for-peer");
  });

  socket.on("peer-joined", ({ peerId, displayName: peerDisplayName }) => {
    // Just wait here — the newcomer is the one who initiates (see
    // joined-room above), so this side only needs a connection to receive
    // their offer into once it arrives via "signal".
    getOrCreateConnection(peerId, peerDisplayName);
    emitStatus("peer-joined");
    if (onPeerJoined) onPeerJoined(peerDisplayName, peerId);
  });

  socket.on("signal", async ({ peerId, data }) => {
    const pc = getOrCreateConnection(peerId);

    if (data.type === "offer") {
      const answer = await createAnswer(pc, data.sdp);
      socket.emit("signal", { roomId, targetPeerId: peerId, data: { type: "answer", sdp: answer } });
    } else if (data.type === "answer") {
      await acceptAnswer(pc, data.sdp);
    } else if (data.type === "ice-candidate") {
      await addIceCandidate(pc, data.candidate);
    }
  });

  socket.on("peer-left", ({ peerId, displayName: peerDisplayName }) => {
    closeConnection(peerId);
    updateConnectedStatus();
    if (onPeerLeft) onPeerLeft(peerDisplayName, peerId);
  });

  socket.on("room-full", () => emitStatus("room-full"));
  socket.on("error-message", (msg) => emitStatus("error: " + msg));

  socket.emit("join-room", { roomId, displayName: myName });

  const openChannels = () =>
    [...peers.values()].map((p) => p.dataChannel).filter((ch) => ch && ch.readyState === "open");

  return {
    sendFile: (file, opts) => sendFile(openChannels(), file, opts),
    sendText: (text) => sendText(openChannels(), text, myName),
    disconnect: () => {
      [...peers.keys()].forEach(closeConnection);
      socket.disconnect();
    },
  };
}
