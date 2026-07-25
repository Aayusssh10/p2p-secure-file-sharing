# Progress

This file is the source of truth for project status. Update it at the end of every phase.
Future sessions should start with "continue from PROGRESS.md" instead of a master prompt.

## Phase Roadmap

- **Phase 0: Synopsis** — DONE
- **Phase 1: Create GitHub repo + push full documentation** (README, PROGRESS.md,
  ARCHITECTURE.md, .gitignore, folder skeleton) — DONE
- **Phase 2: Signaling Server** (Node.js, Express, Socket.io) — DONE
- **Phase 3: WebRTC Peer Connection Layer** — DONE
- **Phase 4: React Frontend** (rooms, file picker, progress UI) — DONE
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
  - **Resilience-tested with `test-stress.js`** (spawns the server as a real child
    process so a crash is observable, runs 4 adversarial scenarios concurrently: sudden
    disconnect mid-handshake, malformed/duplicate signal packets, room-cap enforcement
    under 5 simultaneous joiners, graceful leave with signaling in flight). First run
    against the original code **crashed the entire server process** — any client
    emitting `signal` with a `null` payload threw an uncaught `TypeError` from
    destructuring `null` in `signaling.js`, taking down every other concurrent
    connection with it. Also found that a client calling `join-room` twice with two
    different room IDs (without ever leaving the first) left a permanent ghost
    occupant in the original room, since `disconnect` cleanup only ever found and
    cleaned the first room a socket was tracked in.
    **Fixed both** in `signaling.js`: the `signal` handler now guards the destructure
    against non-object payloads instead of trusting a bare `= {}` default (which only
    covers `undefined`, not `null`); `join-room` now leaves any existing room first
    before joining a new one. Re-ran `test-stress.js` twice after the fix — 9/9 checks
    passed both times, server stayed alive and responsive throughout. Re-ran the
    original Phase 2 test scripts too — no regressions (5/5 and 4/4 still passing).
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
  - **Stress-tested at 50MB.** Sent a 50MB in-memory random file in both directions
    (~3,200 chunks each way): A→B in ~2.6s, B→A in ~4.3s, SHA-256 hashes matched exactly
    both times with the exact byte count (52,428,800 bytes) preserved. Backpressure
    handling held up under the larger volume with no drops or corruption.
  - **Added self-verifying integrity + text messaging.** `fileTransfer.js` now has the
    sender read the whole file into memory, hash it (SHA-256), and embed the hash in
    `file-meta`; the receiver re-hashes the reassembled `Blob` and sets `integrityOk`
    itself — no external comparison needed. Also added `sendText()` / `onText` for
    plain chat-style messages over the same data channel.
  - **Tested at 80MB with a real PDF-format file and a two-way integrity ack.**
    `manual-test.html` now builds an actual syntactically-valid PDF (`%PDF-1.4` header,
    catalog/pages/page objects, a content stream filled with random bytes, trailer/EOF)
    rather than raw random bytes. Sent an 80MB PDF (83,886,080 bytes) A→B: hash matched,
    `integrityOk: true`, `%PDF-1.4` header verified intact on the received blob, and B
    auto-sent "pdf file is received correctly" back over the data channel — received by
    A. Repeated B→A with the same result. Both directions: correct transfer verified
    end-to-end, receiver-side integrity check plus confirmation message.
  - **Tested with real user-supplied PDFs (not synthetic) and a custom two-way ack
    exchange.** A→B: `200mb.pdf` (209,880,487 bytes, 2050 pages) in ~29s, SHA-256
    matched, `integrityOk: true`; B replied "Nice Work A" over the data channel,
    received by A. B→A: `100mb.pdf` (104,970,204 bytes, 1026 pages) in ~16s, SHA-256
    matched, `integrityOk: true`; A replied "File received from A", received by B.
    Real local files were served to the browser via a `/test-files/` route on the dev
    static server (no OS file-picker automation available) — the files themselves still
    moved peer-to-peer over the data channel exactly like any other transfer.
- **Phase 4:** React frontend scaffolded in `/client` with Vite (React 18):
  - `src/pages/Home.jsx` — landing page: "Create Room" (generates a random 6-char code)
    and "Join Room" (code input), both drive the room ID into the URL (`?room=CODE`) so
    invite links are shareable.
  - `src/pages/Room.jsx` — the transfer UI: room code header with copy-invite-link and
    leave buttons, a live status pill (waiting-for-peer / connected / peer-left / etc.,
    driven directly off `peerClient.js`'s `onStatus`), a drag-and-drop + click-to-browse
    file picker, a send-progress bar, a unified sent/received transfer history list
    (with sha256 prefix and an integrity ✓/✗ badge sourced from `fileTransfer.js`'s
    self-verification, plus a download link for received files via `URL.createObjectURL`),
    and a text chat panel wired to `sendText`/`onText`.
  - `src/App.jsx` — all the routing this needs: reads/writes the `?room=` query param
    with `history.pushState`, no router library.
  - `src/main.jsx` — imports `socket.io-client` and assigns it to `window.io` so the
    existing `peerClient.js` (which calls `window.io(serverUrl)`) works unmodified for
    both the bundled React app and the standalone `manual-test.html` (which loads
    socket.io from a CDN script tag instead) — avoided touching any Phase 3 WebRTC code.
  - Vite dev server pinned to port 3000 (`vite.config.js`) to match the signaling
    server's default `CLIENT_URL` for CORS out of the box.
  - **Verified working in real browser tabs**, driving the actual signaling server
    (port 4000) and Vite dev server (port 3000) together, not just component-level
    checks: created a room in tab A, joined the same room code in tab B, both reached
    "Connected — ready to transfer files" automatically. Drag-dropped a 2MB random file
    in tab A (via a synthetic `DataTransfer`/`drop` event, since headless browser
    automation has no OS file-picker) and sent it — tab B's transfer list showed it
    received with a matching sha256 prefix and "✓ verified". Sent a chat message from
    tab A — appeared in tab B as "Peer: ...". Clicked "Leave" in tab B — tab A's status
    correctly flipped to "Peer has left the room" while its transfer history stayed
    intact. Checked both dev server logs: no errors in either. Confirmed via the
    network log that only small Socket.io long-polling frames hit port 4000 during the
    whole test — consistent with the core privacy rule, since the file itself moves
    over the WebRTC data channel, not through any HTTP request the browser network
    panel would show.
  - One environment note (not a code bug): this machine's Node.js install isn't on the
    default `PATH` for spawned dev-server processes, so `.claude/launch.json` points
    `runtimeExecutable` directly at `C:\Program Files\nodejs\node.exe` for both the
    server and the client (`node_modules/vite/bin/vite.js`) instead of relying on
    `npm`/`npm.cmd`, which fails with `'node' is not recognized`.
