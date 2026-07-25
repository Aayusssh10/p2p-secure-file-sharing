# Progress

This file is the source of truth for project status. Update it at the end of every phase.
Future sessions should start with "continue from PROGRESS.md" instead of a master prompt.

## Phase Roadmap

- **Phase 0: Synopsis** — DONE
- **Phase 1: Create GitHub repo + push full documentation** (README, PROGRESS.md,
  ARCHITECTURE.md, .gitignore, folder skeleton) — DONE
- **Phase 2: Signaling Server** (Node.js, Express, Socket.io) — DONE
- **Phase 3: WebRTC Peer Connection Layer** — DONE
- **Phase 4: React Frontend** (rooms, file picker, progress UI) — PENDING
- **Phase 5: MongoDB Integration** — PENDING
- **Phase 6: Gemini API Auxiliary Module** — PENDING
- **Phase 7: Testing, Polish, Deployment** — PENDING

## Progress Log

- **Phase 0:** Synopsis complete, approved by guide (LCA 1 done).
- **Phase 1:** Repo scaffolded — `/client` and `/server` skeleton folders, README.md,
  ARCHITECTURE.md, PROGRESS.md, .gitignore. Local git repo initialized, committed, and
  pushed to [github.com/Aayusssh10/p2p-secure-file-sharing](https://github.com/Aayusssh10/p2p-secure-file-sharing)
  as `main`. This repo is now the permanent source of truth.
- **Phase 2:** Signaling server scaffolded in `/server`:
  - `src/server.js` — Express app + HTTP server + Socket.io, CORS via `CLIENT_URL` env var,
    `GET /health` check.
  - `src/roomManager.js` — in-memory `Map` of `roomId -> Set<socketId>`, capped at 2 peers
    per room (one sender, one receiver).
  - `src/signaling.js` — Socket.io event handlers: `join-room`, `signal` (relays SDP/ICE
    payloads untouched between the two peers in a room), `leave-room`, `disconnect` cleanup.
  - `package.json` (express, socket.io, cors, dotenv, nodemon) and `.env.example`
    (`PORT`, `CLIENT_URL`).
  - **Verified working.** Node.js LTS (v24.18.0) installed via winget. `npm install`
    succeeded (0 vulnerabilities). Ran the server locally and drove it with a two-client
    Socket.io test script: join-room, peer-joined notification, signal relay (SDP offer
    payload delivered untouched to the other peer), and peer-left on disconnect all passed
    (5/5 checks).
- **Phase 3:** WebRTC peer connection layer scaffolded in `/client/src/webrtc`:
  - `peerConnection.js` — `RTCPeerConnection` setup (STUN: Google public; TURN slot left
    for the pending provider decision), offer/answer/ICE-candidate helpers.
  - `fileTransfer.js` — chunked sender (16KB chunks over the data channel, with
    `bufferedAmount` backpressure so large files don't overrun the channel) and a receiver
    that reassembles chunks into a `Blob` from a `file-meta` / binary chunks / `file-end`
    protocol.
  - `peerClient.js` — orchestrator wiring Socket.io signaling (Phase 2) to the peer
    connection: whichever peer sees an existing peer on `joined-room` becomes the SDP
    offerer, the other answers; ICE candidates are relayed automatically.
  - `manual-test.html` — temporary two-peer dev harness (not the real UI; that's Phase 4)
    used to verify this module before the React frontend exists.
  - **Verified working in real browser tabs**, not just unit-style checks: ran the Phase 2
    signaling server + a static file server, opened two browser tabs into the same room,
    confirmed both reached `connected` state (RTCPeerConnection + data channel live), then
    sent a 2MB and a 500KB in-memory random file in both directions. SHA-256 hash of the
    received `Blob` matched the sender's hash exactly in both tests — zero corruption across
    chunking/reassembly. Confirmed via the network log that only small Socket.io signaling
    frames touch the server on port 4000; the multi-megabyte payloads never appear there,
    consistent with the core privacy rule (file content stays peer-to-peer).
  - Found and fixed one real bug during testing: the signaling server's CORS `CLIENT_URL`
    only allowed `http://localhost:3000`, silently blocking cross-origin Socket.io
    connections from any other origin. Not a code change (env-config only) — worth knowing
    that `CLIENT_URL` must match wherever the frontend actually runs (Phase 4 will pin this
    down once the React dev server's port is chosen).
