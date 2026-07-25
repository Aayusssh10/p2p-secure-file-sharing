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

Placeholder — will be filled in as the client and server are built out in later phases.

### Client (React)

```bash
cd client
npm install
npm start
```

### Server (Node/Express/Socket.io)

```bash
cd server
npm install
npm run dev
```
