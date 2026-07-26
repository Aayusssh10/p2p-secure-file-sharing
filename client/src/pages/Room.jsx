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
  "room-full": { text: "Room is full (max 2 peers)", tone: "bad" },
};

// peer-joined / connected / peer-left get the peer's display name mixed in,
// so they can't live in the static lookup above.
function statusInfo(status, peerName) {
  if (status && status.startsWith("error:")) return { text: status, tone: "bad" };
  switch (status) {
    case "peer-joined":
      return { text: `${peerName || "Peer"} joined — negotiating connection…`, tone: "neutral" };
    case "connected":
      return {
        text: peerName ? `Connected with ${peerName} — ready to transfer files` : "Connected — ready to transfer files",
        tone: "good",
      };
    case "peer-left":
      return { text: `${peerName || "Your peer"} has left the room`, tone: "warn" };
    default:
      return STATUS_INFO[status] || { text: status || "Connecting…", tone: "neutral" };
  }
}

// Statuses meaning the data channel is no longer usable — any transfer in
// flight has been abandoned and its progress UI must not stay stuck showing
// stale percentages forever.
const TERMINAL_STATUSES = new Set([
  "disconnected",
  "failed",
  "closed",
  "channel-closed",
  "channel-error",
  "peer-left",
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
  const [peerName, setPeerName] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [sendProgress, setSendProgress] = useState(null);
  const [receiveMeta, setReceiveMeta] = useState(null);
  const [receiveProgress, setReceiveProgress] = useState(null);
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
          setReceiveProgress(null);
          setReceiveMeta(null);
          setSendProgress(null);
        }
      },
      onPeerName: (name) => setPeerName(name || "Peer"),
      onPeerJoined: (name) => {
        const joinedName = name || "Peer";
        setPeerName(joinedName);
        setMessages((prev) => [...prev, { from: "system", text: `${joinedName} joined the room`, time: Date.now() }]);
      },
      onPeerLeft: (name) => {
        const leftName = name || peerName || "Your peer";
        setMessages((prev) => [...prev, { from: "system", text: `${leftName} left the room`, time: Date.now() }]);
      },
      onProgress: (p) => setReceiveProgress(p),
      onFileReceived: (blob, meta) => {
        setReceiveProgress(null);
        setReceiveMeta(null);
        setTransfers((prev) => [
          {
            direction: "received",
            name: meta.name,
            size: meta.size,
            sha256: meta.actualHash,
            integrityOk: meta.integrityOk,
            url: URL.createObjectURL(blob),
            time: Date.now(),
          },
          ...prev,
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

  // Track "receiving a file" separately from raw byte progress so the UI can
  // show a filename while a transfer is in flight (fileTransfer.js only
  // exposes the meta once file-meta arrives, before any progress ticks).
  useEffect(() => {
    if (receiveProgress !== null && receiveProgress < 1 && !receiveMeta) {
      setReceiveMeta({ name: "incoming file" });
    }
  }, [receiveProgress, receiveMeta]);

  const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
  const info = statusInfo(status, peerName);
  const connected = status === "connected";

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

      {receiveProgress !== null && receiveProgress < 1 && (
        <div className="card">
          <h2>Receiving…</h2>
          <div className="progress-row">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${Math.round(receiveProgress * 100)}%` }} />
            </div>
            <span className="muted">{Math.round(receiveProgress * 100)}%</span>
          </div>
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
