import {
  createPeerConnection,
  createOffer,
  createAnswer,
  acceptAnswer,
  addIceCandidate,
  supportsRestartIce,
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
// at nearly the same time. The same initiator/responder split is reused
// later for ICE restarts (see restartConnection) so a mid-call reconnect
// can't glare either.
export function connect({
  serverUrl,
  roomId,
  displayName,
  onStatus,
  onFileReceived,
  onProgress,
  onFileAborted,
  onText,
  onPeerJoined,
  onPeerLeft,
  onPeerName,
}) {
  const socket = window.io(serverUrl);
  const myName = sanitizeDisplayName(displayName);
  const peers = new Map(); // peerId -> { pc, dataChannel, displayName, iceQueue, isInitiator }

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
      onProgress: (p, fileId) => onProgress && onProgress(p, peerId, fileId),
      onComplete: (blob, meta) => onFileReceived && onFileReceived(blob, meta, peerId),
      onAbort: (fileId) => {
        const currentName = peers.get(peerId)?.displayName;
        if (onFileAborted) onFileAborted(peerId, fileId, currentName);
      },
      onText: (text, name) => onText && onText(text, name, peerId),
    });

    channel.onopen = updateConnectedStatus;
    channel.onclose = updateConnectedStatus;
    channel.onerror = () => emitStatus("channel-error");
    channel.onmessage = handleReceiverMessage;
  }

  // Creates (or returns, if one already exists) the RTCPeerConnection for a
  // given remote peer. Every pairwise link gets its own ICE/SDP negotiation,
  // completely independent of every other peer in the room. `isInitiator`
  // only matters the first time a peer is created — it's persisted on the
  // entry so restartConnection can reuse it later without re-deriving who
  // offered first.
  function getOrCreateConnection(peerId, peerDisplayName, isInitiator) {
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
      // STUN-only ICE can go quiet forever behind a strict corporate/campus
      // firewall with no error event to catch — surfaced as its own status
      // (not lumped into "connecting") so the UI can give an actual
      // diagnosis instead of spinning indefinitely.
      onStalled: (reason) => emitStatus(`stalled:${reason}:${peerDisplayName || "Peer"}`),
      onIceRestartNeeded: () => restartConnection(peerId),
    });
    // ICE candidates can legally arrive (via the "signal" handler below)
    // before setRemoteDescription has run — e.g. the answerer's candidates
    // racing the offer/answer round trip. addIceCandidate() throws in that
    // state, so incoming candidates are queued here and flushed once the
    // remote description is actually set.
    peers.set(peerId, {
      pc,
      dataChannel: null,
      displayName: peerDisplayName || "Peer",
      iceQueue: [],
      isInitiator: !!isInitiator,
    });
    return pc;
  }

  async function flushIceQueue(peerId) {
    const entry = peers.get(peerId);
    if (!entry || entry.iceQueue.length === 0) return;
    const queued = entry.iceQueue;
    entry.iceQueue = [];
    for (const candidate of queued) {
      await addIceCandidate(entry.pc, candidate).catch(() => {});
    }
  }

  // Fires when a specific peer's ICE has failed outright, or has sat at
  // "disconnected" past the grace period (see peerConnection.js). Only the
  // original initiator re-offers here — mirroring the join-time initiator
  // split so both sides can't restart at once and collide (glare). The
  // existing RTCPeerConnection/RTCDataChannel is never recreated — only the
  // ICE/SDP layer renegotiates — which is what keeps any in-flight receive
  // buffer and the transfer's progress state intact across the restart.
  async function restartConnection(peerId) {
    const entry = peers.get(peerId);
    if (!entry || !entry.isInitiator) return;
    const pc = entry.pc;
    // A renegotiation (or the initial handshake) is already in flight —
    // starting another one now would throw on setLocalDescription. Leave it
    // to finish; if the connection still hasn't recovered, the next
    // failed/disconnected-timeout tick will try again.
    if (pc.signalingState !== "stable") return;

    try {
      if (supportsRestartIce(pc)) pc.restartIce();
      const offer = await createOffer(pc, supportsRestartIce(pc) ? undefined : { iceRestart: true });
      socket.emit("signal", { roomId, targetPeerId: peerId, data: { type: "offer", sdp: offer } });
    } catch {
      // Offer creation itself failing means this connection isn't
      // recoverable from here — onConnectionStateChange will reflect that
      // once connectionState settles to "failed"/"closed", and any transfer
      // in flight on this channel will be dropped from its result set by
      // fileTransfer.js's own stall/close handling rather than hang.
    }
  }

  function closeConnection(peerId) {
    const entry = peers.get(peerId);
    if (!entry) return;
    if (entry.dataChannel) {
      entry.dataChannel.onopen = null;
      entry.dataChannel.onclose = null;
      entry.dataChannel.onerror = null;
      entry.dataChannel.onmessage = null;
      entry.dataChannel.close();
    }
    if (entry.pc) entry.pc.close();
    peers.delete(peerId);
  }

  socket.on("joined-room", async ({ peers: existingPeerIds, peerNames }) => {
    for (const peerId of existingPeerIds) {
      const nameEntry = (peerNames || []).find((p) => p.peerId === peerId);
      const peerDisplayName = nameEntry ? nameEntry.displayName : "Peer";
      if (onPeerName) onPeerName(peerDisplayName, peerId);

      const pc = getOrCreateConnection(peerId, peerDisplayName, true);
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
    getOrCreateConnection(peerId, peerDisplayName, false);
    emitStatus("peer-joined");
    if (onPeerJoined) onPeerJoined(peerDisplayName, peerId);
  });

  socket.on("signal", async ({ peerId, data }) => {
    const pc = getOrCreateConnection(peerId);

    if (data.type === "offer") {
      const answer = await createAnswer(pc, data.sdp);
      await flushIceQueue(peerId);
      socket.emit("signal", { roomId, targetPeerId: peerId, data: { type: "answer", sdp: answer } });
    } else if (data.type === "answer") {
      await acceptAnswer(pc, data.sdp);
      await flushIceQueue(peerId);
    } else if (data.type === "ice-candidate") {
      // Remote description not set yet (this candidate raced ahead of the
      // offer/answer) — queue it instead of letting addIceCandidate throw;
      // it gets flushed right after setRemoteDescription above.
      if (pc.remoteDescription) {
        await addIceCandidate(pc, data.candidate).catch(() => {});
      } else {
        const entry = peers.get(peerId);
        if (entry) entry.iceQueue.push(data.candidate);
      }
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
