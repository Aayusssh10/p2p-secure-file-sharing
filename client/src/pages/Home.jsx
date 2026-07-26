import { useState } from "react";
import { MAX_NAME_LENGTH } from "../utils/displayName.js";

function randomRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export default function Home({ onEnterRoom, initialCode }) {
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState(initialCode || "");

  const handleJoin = (e) => {
    e.preventDefault();
    const code = joinCode.trim().toUpperCase();
    if (code) onEnterRoom(code, name);
  };

  return (
    <div className="page">
      <div className="hero">
        <h1>P2P Secure File Sharing</h1>
        <p className="tagline">
          Files move directly between browsers over an encrypted WebRTC data
          channel — they never pass through our server.
        </p>
        {initialCode && (
          <p className="muted" style={{ marginTop: 8 }}>
            You have an invite for room <strong>{initialCode}</strong> — enter your name and click Join Room below.
          </p>
        )}
      </div>

      <div className="card">
        <h2>Your Name</h2>
        <input
          className="input"
          type="text"
          placeholder="Anonymous Peer"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={MAX_NAME_LENGTH}
        />
        <p className="muted" style={{ marginTop: 8 }}>
          Shown to your peer when you join/leave and next to your chat messages. Max {MAX_NAME_LENGTH} characters.
        </p>
      </div>

      <div className="card-row">
        <div className="card">
          <h2>Create a Room</h2>
          <p>Start a new room and share the code with your peer.</p>
          <button className="btn btn-primary" onClick={() => onEnterRoom(randomRoomCode(), name)}>
            Create Room
          </button>
        </div>

        <div className="card">
          <h2>Join a Room</h2>
          <p>Enter the code your peer shared with you.</p>
          <form onSubmit={handleJoin} className="join-form">
            <input
              className="input"
              type="text"
              placeholder="ROOM CODE"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              maxLength={12}
              autoCapitalize="characters"
            />
            <button className="btn" type="submit" disabled={!joinCode.trim()}>
              Join Room
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
