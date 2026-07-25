# Architecture

## Core Privacy Rule (non-negotiable)

**No file content ever touches the server or database.** The server's only job is
signaling — room creation, and relaying SDP/ICE messages between peers. Once signaling
completes, files move peer-to-peer only, over the WebRTC Data Channel. MongoDB stores
session/room metadata only, never file content.

## Modules

1. **Room and Signaling Module** — room creation/join, Socket.io event handling, SDP/ICE
   relay between peers.
2. **Peer Connection and Data Transfer Module** — RTCPeerConnection setup, RTCDataChannel
   file chunking/reassembly, STUN/TURN configuration.
3. **Frontend UI Module** — React app: room creation/join UI, file picker, transfer
   progress, connection status.
4. **Metadata and Persistence Module** — MongoDB models for session/room metadata only.
5. **Auxiliary Intelligence Module (optional)** — Gemini API proxy endpoint operating on
   transfer metadata only (e.g. file name, size, type), never file content.

## Decided vs Pending

### Decided

- Full tech stack: React.js, Node.js/Express.js/Socket.io, WebRTC (RTCPeerConnection,
  RTCDataChannel), MongoDB, STUN (Google public) with TURN fallback.
- 5-module structure above.
- Core privacy architecture: file content never touches the server or database.
- Phase roadmap (see [PROGRESS.md](PROGRESS.md)).

### Pending (not yet settled — do not hardcode)

- **Gemini model version.** `gemini-2.0-flash` is deprecated. Team is choosing between
  `gemini-2.5-flash-lite` and `gemini-3.1-flash-lite`. Decide before building Phase 6.
- **TURN server provider.** Self-hosted coturn vs. a managed service. Decide when Phase 3
  is reached.
