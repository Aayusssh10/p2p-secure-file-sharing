# Secure Serverless File Sharing

A WebRTC and Socket.io based peer-to-peer file transfer utility. Files move directly
between browsers over an encrypted WebRTC Data Channel — the server only handles
signaling (room creation, SDP/ICE relay) and never sees file content.

## Team

- Kritika Kumrawat (1272251096)
- Aayush Singh (1272251104)
- SY MCA, Div E, MIT-WPU
- Guide: Mr. Kaustubh Keer

## Tech Stack

- **Frontend:** React.js
- **Backend / Signaling:** Node.js, Express.js, Socket.io
- **Data Transfer:** WebRTC (RTCPeerConnection, RTCDataChannel)
- **Database:** MongoDB (session/room metadata only — never file content)
- **NAT Traversal:** STUN (Google public), TURN fallback (coturn, self-hosted or managed)
- **Auxiliary (optional):** Gemini API — metadata-only proxy endpoint for post-transfer insights

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module breakdown and core design rules,
and [PROGRESS.md](PROGRESS.md) for the phase roadmap and current status.

## How to Run

### Server (Node/Express/Socket.io)

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

Runs on `http://localhost:4000` by default.

### Client (React + Vite)

```bash
cd client
npm install
cp .env.example .env
npm run dev
```

Runs on `http://localhost:3000` (matches the server's default `CLIENT_URL` for CORS).
Open it in two browser tabs/windows — one creates a room, the other joins with the
same room code — to see a peer-to-peer transfer.
