import { useEffect, useRef, useState } from "react";
import { connect } from "../webrtc/peerClient.js";
import { sanitizeDisplayName } from "../utils/displayName.js";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

const STATUS_INFO = {
  idle: { text: "Connecting to signaling server…", tone: "neutral" },
  "waiting-for-peer": { text: "Waiting for a peer to join…", tone: "neutral" },
  new: { text: "Establishing peer-to-peer connection…", tone: "neutral" },
  connecting: { text: "Establishing peer-to-peer connection…", tone: "neutral" },
  disconnected: { text: "Connection lost", tone: "bad" },
  failed: { text: "Connection failed", tone: "bad" },
  closed: { text: "Connection closed", tone: "bad" },
  "channel-closed": { text: "Data channel closed", tone: "bad" },
  "channel-error": { text: "Data channel error", tone: "bad" },
  "room-full": { text: "Room is full (max 4 peers)", tone: "bad" },
};

function namesList(peers) {
  return Object.values(peers).join(", ");
}

// "peer-joined" / "connected" get the room's peer names mixed in (there can
// be more than one now), so they can't live in the static lookup above.
function statusInfo(status, peers) {
  if (status && status.startsWith("error:")) return { text: status, tone: "bad" };
  if (status && status.startsWith("stalled:")) {
    const rest = status.slice("stalled:".length);
    const sep = rest.indexOf(":");
    const reason = sep === -1 ? rest : rest.slice(0, sep);
    const who = (sep === -1 ? "" : rest.slice(sep + 1)) || "a peer";
    const hint =
      reason === "no-turn-configured"
        ? "no TURN relay is configured — this happens behind strict corporate/university firewalls that STUN alone can't get through"
        : "the configured TURN relay couldn't find a route either";
    return { text: `Still connecting to ${who} after 10s — ${hint}.`, tone: "bad" };
  }
  const names = namesList(peers);
  switch (status) {
    case "peer-joined":
      return { text: `${names || "A peer"} joined — negotiating connection…`, tone: "neutral" };
    case "connected":
      return {
        text: names ? `Connected with ${names} — ready to transfer files` : "Connected — ready to transfer files",
        tone: "good",
      };
    default:
      return STATUS_INFO[status] || { text: status || "Connecting…", tone: "neutral" };
  }
}

// Statuses meaning no data channel is usable at all — any transfer in
// flight has been abandoned and its progress UI must not stay stuck showing
// stale percentages forever. One peer leaving a multi-peer room is *not*
// terminal on its own (others may still be connected) — peerClient.js
// already re-derives "connected" vs "waiting-for-peer" after any single
// peer-left, so that's handled per-peer in onPeerLeft below, not this set.
const TERMINAL_STATUSES = new Set([
  "disconnected",
  "failed",
  "closed",
  "channel-closed",
  "channel-error",
  "room-full",
]);

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function Room({ roomId, displayName, onLeave }) {
  const myName = sanitizeDisplayName(displayName);

  const [status, setStatus] = useState("idle");
  const [peers, setPeers] = useState({}); // peerId -> display name, for everyone currently in the room
  const [selectedFile, setSelectedFile] = useState(null);
  const [sendProgress, setSendProgress] = useState(null);
  // Keyed by `${peerId}:${fileId}` so two peers sending concurrently (or one
  // peer's file overlapping briefly with a stale/abandoned prior one) each
  // get their own row instead of one shared "last update wins" indicator —
  // fileTransfer.js's per-peer-channel + per-file isolation is what makes
  // this safe to track this granularly in the first place.
  const [incomingTransfers, setIncomingTransfers] = useState({});
  const [transfers, setTransfers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  const clientRef = useRef(null);

  useEffect(() => {
    const client = connect({
      serverUrl: SERVER_URL,
      roomId,
      displayName: myName,
      onStatus: (s) => {
        setStatus(s);
        if (TERMINAL_STATUSES.has(s)) {
          setIncomingTransfers({});
          setSendProgress(null);
        }
      },
      onPeerName: (name, peerId) => setPeers((prev) => ({ ...prev, [peerId]: name || "Peer" })),
      onPeerJoined: (name, peerId) => {
        const joinedName = name || "Peer";
        setPeers((prev) => ({ ...prev, [peerId]: joinedName }));
        setMessages((prev) => [...prev, { from: "system", text: `${joinedName} joined the room`, time: Date.now() }]);
      },
      onPeerLeft: (name, peerId) => {
        const leftName = name || "A peer";
        setPeers((prev) => {
          const next = { ...prev };
          delete next[peerId];
          return next;
        });
        // Any file this specific peer was mid-sending us will never get a
        // file-end — clear only their row(s), leaving transfers from other,
        // still-connected peers untouched (each peer's receive state is
        // fully independent — see fileTransfer.js).
        setIncomingTransfers((prev) => {
          const next = {};
          for (const [key, entry] of Object.entries(prev)) {
            if (entry.peerId !== peerId) next[key] = entry;
          }
          return next;
        });
        setMessages((prev) => [...prev, { from: "system", text: `${leftName} left the room`, time: Date.now() }]);
      },
      // Each concurrent sender gets its own row, keyed by peer + file id —
      // see the incomingTransfers state comment above.
      onProgress: (p, peerId, fileId) => {
        const key = `${peerId}:${fileId}`;
        setIncomingTransfers((prev) => ({ ...prev, [key]: { peerId, fileId, progress: p } }));
      },
      onFileReceived: (blob, meta, peerId) => {
        const key = `${peerId}:${meta.fileId}`;
        setIncomingTransfers((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        setTransfers((prev) => [
          {
            direction: "received",
            name: meta.name,
            size: meta.size,
            sha256: meta.actualHash,
            integrityOk: meta.integrityOk,
            url: URL.createObjectURL(blob),
            fromPeerId: peerId,
            time: Date.now(),
          },
          ...prev,
        ]);
      },
      // The sender gave up on this specific transfer (e.g. this peer's
      // connection was too backed up for too long) without disconnecting —
      // clear just that row instead of leaving it frozen at a stale
      // percentage with no explanation.
      onFileAborted: (peerId, _fileId, peerName) => {
        setIncomingTransfers((prev) => {
          const next = {};
          for (const [key, entry] of Object.entries(prev)) {
            if (entry.peerId !== peerId) next[key] = entry;
          }
          return next;
        });
        setMessages((prev) => [
          ...prev,
          { from: "system", text: `Transfer from ${peerName || "a peer"} was interrupted`, time: Date.now() },
        ]);
      },
      onText: (text, name) => {
        setMessages((prev) => [...prev, { from: "peer", name: name || "Anonymous Peer", text, time: Date.now() }]);
      },
    });
    clientRef.current = client;

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
  const info = statusInfo(status, peers);
  const connected = status === "connected";
  const incomingList = Object.values(incomingTransfers);

  const handleFiles = (files) => {
    const file = files && files[0];
    if (file) {
      setSelectedFile(file);
      setError(null);
    }
  };

  const handleSend = async () => {
    if (!selectedFile || !clientRef.current) return;
    setError(null);
    setSendProgress(0);
    try {
      const sha256 = await clientRef.current.sendFile(selectedFile, {
        onProgress: setSendProgress,
      });
      setTransfers((prev) => [
        {
          direction: "sent",
          name: selectedFile.name,
          size: selectedFile.size,
          sha256,
          time: Date.now(),
        },
        ...prev,
      ]);
      setSelectedFile(null);
    } catch (err) {
      setError(err.message || "Failed to send file");
    } finally {
      setSendProgress(null);
    }
  };

  const handleSendText = (e) => {
    e.preventDefault();
    const text = chatInput.trim();
    if (!text || !clientRef.current) return;
    try {
      clientRef.current.sendText(text);
      setMessages((prev) => [...prev, { from: "me", name: myName, text, time: Date.now() }]);
      setChatInput("");
    } catch (err) {
      setError(err.message || "Failed to send message");
    }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn't copy link — copy it manually");
    }
  };

  const handleLeave = () => {
    if (clientRef.current) clientRef.current.disconnect();
    onLeave();
  };

  return (
    <div className="page">
      <div className="room-header">
        <div>
          <div className="room-label">Room</div>
          <div className="room-code">{roomId}</div>
        </div>
        <div className="room-header-actions">
          <button className="btn btn-small" onClick={handleCopyLink}>
            {copied ? "Copied!" : "Copy invite link"}
          </button>
          <button className="btn btn-small btn-danger" onClick={handleLeave}>
            Leave
          </button>
        </div>
      </div>

      <div className={`status-pill tone-${info.tone}`}>
        <span className="status-dot" />
        {info.text}
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      <div className="card">
        <h2>Send a file</h2>
        <div
          className={`dropzone ${isDragging ? "dragging" : ""} ${!connected ? "disabled" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (connected) setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            if (connected) handleFiles(e.dataTransfer.files);
          }}
          onClick={() => connected && document.getElementById("file-input").click()}
        >
          <input
            id="file-input"
            type="file"
            hidden
            disabled={!connected}
            onChange={(e) => handleFiles(e.target.files)}
          />
          {selectedFile ? (
            <div>
              <strong>{selectedFile.name}</strong>
              <div className="muted">{formatBytes(selectedFile.size)}</div>
            </div>
          ) : (
            <div className="muted">
              {connected ? "Drop a file here, or click to choose one" : "Waiting for connection…"}
            </div>
          )}
        </div>

        {sendProgress !== null && (
          <div className="progress-row">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${Math.round(sendProgress * 100)}%` }} />
            </div>
            <span className="muted">{Math.round(sendProgress * 100)}%</span>
          </div>
        )}

        <button
          className="btn btn-primary"
          disabled={!connected || !selectedFile || sendProgress !== null}
          onClick={handleSend}
        >
          {sendProgress !== null ? "Sending…" : "Send File"}
        </button>
      </div>

      {incomingList.length > 0 && (
        <div className="card">
          <h2>Receiving…</h2>
          {incomingList.map((t) => (
            <div key={`${t.peerId}:${t.fileId}`} className="progress-row">
              <span className="muted">{peers[t.peerId] || "Peer"}:</span>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${Math.round(t.progress * 100)}%` }} />
              </div>
              <span className="muted">{Math.round(t.progress * 100)}%</span>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Transfers</h2>
        {transfers.length === 0 ? (
          <p className="muted">No files sent or received yet.</p>
        ) : (
          <ul className="transfer-list">
            {transfers.map((t, i) => (
              <li key={i} className="transfer-item">
                <span className={`badge badge-${t.direction}`}>
                  {t.direction === "sent" ? "Sent" : "Received"}
                </span>
                <div className="transfer-info">
                  <div>
                    <strong>{t.name}</strong> <span className="muted">({formatBytes(t.size)})</span>
                    {t.direction === "received" && (
                      <span className="muted"> — from {peers[t.fromPeerId] || "Peer"}</span>
                    )}
                  </div>
                  <div className="muted transfer-hash">
                    sha256: {t.sha256 ? t.sha256.slice(0, 16) + "…" : "n/a"}
                    {t.direction === "received" && (
                      <span className={t.integrityOk ? "ok" : "bad"}>
                        {t.integrityOk ? " ✓ verified" : " ✗ integrity mismatch"}
                      </span>
                    )}
                  </div>
                </div>
                {t.direction === "received" && (
                  <a className="btn btn-small" href={t.url} download={t.name}>
                    Download
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2>Chat</h2>
        <div className="chat-log">
          {messages.length === 0 && <p className="muted">No messages yet.</p>}
          {messages.map((m, i) =>
            m.from === "system" ? (
              <div key={i} className="chat-system">{m.text}</div>
            ) : (
              <div key={i} className={`chat-msg chat-${m.from}`}>
                <span className="chat-from" title={m.from === "me" ? `${m.name} (You)` : m.name}>
                  {m.from === "me" ? `${m.name} (You)` : m.name}:
                </span>{" "}
                {m.text}
              </div>
            )
          )}
        </div>
        <form className="join-form" onSubmit={handleSendText}>
          <input
            className="input"
            type="text"
            placeholder="Type a message"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            disabled={!connected}
          />
          <button className="btn" type="submit" disabled={!connected || !chatInput.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
