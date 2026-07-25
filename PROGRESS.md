# Progress

This file is the source of truth for project status. Update it at the end of every phase.
Future sessions should start with "continue from PROGRESS.md" instead of a master prompt.

## Phase Roadmap

- **Phase 0: Synopsis** — DONE
- **Phase 1: Create GitHub repo + push full documentation** (README, PROGRESS.md,
  ARCHITECTURE.md, .gitignore, folder skeleton) — DONE
- **Phase 2: Signaling Server** (Node.js, Express, Socket.io) — IN PROGRESS (code written, untested — Node.js not yet installed on dev machine)
- **Phase 3: WebRTC Peer Connection Layer** — PENDING
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
  - **Not yet run or tested** — Node.js/npm are not installed on the dev machine used for
    this session. Install Node, run `npm install` then `npm run dev` in `/server` to verify
    before considering Phase 2 complete.
