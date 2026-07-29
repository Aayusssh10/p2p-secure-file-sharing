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
- **Phase 5: MongoDB Integration** — DONE
- **Phase 6: Gemini API Auxiliary Module** — PENDING
- **Phase 7: Testing, Polish, Deployment** — PENDING
- **Multi-Peer Mesh Support** (3-4 peers per room) — DONE, on the `multi-peer` branch
  (not yet merged to `main`). Originally scoped to Future Scope only; reversed after
  discussion with the guide, who approved building it now.

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
- **Phase 4 hardening pass.** Ran four adversarial tests against the real signaling +
  Vite dev servers before allowing a push:
  1. **Large file + back-to-back transfers through the UI.** Drag-dropped a 110MB
     random file (well past the 100MB bar) between two tabs — sent and received in
     under 10s, sha256 matched, UI reset cleanly. Immediately followed with 3 more
     files (15MB, 20MB, 10MB) sent back-to-back with no pause — all 4 transfers landed
     correctly in order on the receiver's history list, sender's dropzone/progress UI
     reset after each one, no memory/state freeze, zero console errors either side.
  2. **3rd peer room-full rejection.** With 2 peers already connected, opened a 3rd tab
     on the same room code. Server correctly rejected it (room cap enforced in
     `roomManager.js` from Phase 2); the 3rd tab's status pill showed "Room is full
     (max 2 peers)" with no crash, and the two existing peers stayed connected and
     unaffected.
  3. **Mid-transfer disconnect.** Started a 200MB send, then abruptly killed the
     sender's tab (not a graceful "Leave" click) while the receiver was mid-stream at
     1-9% received. **Found and fixed a real bug:** the receiver's "Receiving…" progress
     card had no listener on connection-terminal states, so it froze at its last
     percentage forever instead of clearing — misleadingly implying a transfer was
     still in progress. Fixed in `Room.jsx` by adding a `TERMINAL_STATUSES` set
     (`disconnected`, `failed`, `closed`, `channel-closed`, `channel-error`,
     `peer-left`, `room-full`) that clears `receiveProgress`/`receiveMeta`/`sendProgress`
     whenever `onStatus` reports one. Re-tested after the fix with a fresh 200MB
     mid-stream kill: status correctly flipped to "Data channel closed" and the
     progress card cleared immediately, no unhandled exceptions in the console either
     time (before or after the fix — the crash risk was a stuck UI, not a JS throw).
  4. **Production build.** `npm run build` (via `vite build`, run directly since `npm`
     has the same `node`-not-on-`PATH` issue noted above) completed cleanly in ~1s:
     65 modules transformed, `dist/index.html` + hashed CSS/JS assets emitted, no
     JSX/bundling errors. No Tailwind in this project, so nothing to check there.
  All four checks pass. `client/dist/` stays gitignored as before; the only source
  change from this pass is the `Room.jsx` terminal-status fix above.
- **Phase 4 → Phase 2 follow-up: signaling server load test.** Pushed the Phase 4 work
  to `origin/main`, then added `server/test-load.js` to check the signaling server
  under concurrent load rather than just the adversarial edge cases `test-stress.js`
  already covers:
  - Added a small `GET /debug/stats` endpoint to `server.js` (backed by a new
    `roomManager.getStats()`) returning `{ roomCount, socketCount, connectedSockets,
    memoryUsage, uptime }` — counts and process memory only, never room IDs or
    signaling payloads — so an external test script can verify no leaks without
    reaching into the spawned child process.
  - `test-load.js` spawns the real server as a child process, then runs 3 back-to-back
    rounds of: 50 concurrent socket connections joining 25 different rooms (2 peers
    each, filling every room) all at the same time, a mock offer/answer/ICE-candidate
    signaling exchange per room (symmetric on both peers so it works regardless of
    which one the server happens to admit first under concurrency), a 5-second hold,
    then all 50 disconnecting together.
  - **All 10 checks passed.** 150 total connections across 75 room-instances over the
    3 rounds; `roomCount` and `connectedSockets` returned to exactly 0 after every
    round's cleanup (no leaked rooms, no leaked sockets); RSS after round 1 (67.68MB)
    vs. after round 3 (63.84MB) was a **-5.7%** change — i.e. memory did not grow
    across repeated load, well inside the 20% flatness threshold; the server process
    stayed alive and `/health`-responsive throughout.
- **Phase 4 polish: display names.** Added a "Your Name" field so peers aren't just
  anonymous "Peer"s to each other:
  - `Home.jsx` — a name input (used for both Create and Join). Invite links (`?room=`)
    now land on Home with the code pre-filled instead of skipping straight into the
    room, so a link-joiner still gets asked for their name — fixed after first testing
    showed direct invite links bypassed name entry entirely.
  - Signaling protocol: `join-room` now carries `{ roomId, displayName }` (still
    tolerates a bare roomId string, so `test-stress.js`/`test-load.js` needed no
    changes); `peer-joined`/`peer-left` broadcast the name; `joined-room` now also
    returns the *already-present* peer's name to a new joiner (`peerNames`) — without
    this, the second peer into a room never learned the first peer's name, since
    `peer-joined` only fires for sockets already in the room.
  - Status pill and chat now use real names ("Connected with Aayush…", "Aayush joined
    the room", "Aayush: hello") instead of generic "Peer" text, symmetric on both
    sides. Blank name defaults to "Anonymous Peer" at every layer (Home, Room.jsx,
    peerClient.js, and the server) as a defense-in-depth default, not just one point.
  - **Hardening pass after manual edge-case testing** (client `utils/displayName.js` +
    mirrored server-side in `signaling.js`, since the server is the authoritative
    enforcement point — a malicious/modified client could bypass the browser UI
    entirely): trims and strips `<`/`>` from names (React already escapes text nodes,
    so no live XSS existed, but explicit stripping added anyway), a small basic
    profanity blocklist that falls back to "Anonymous Peer" on a match, length capped
    at 20 chars (down from an initial 40) with CSS `text-overflow: ellipsis`
    truncation on the chat name label, and a "(You)" suffix on the local user's own
    chat messages so two peers with the same name can still tell messages apart.
    Verified in-browser: a `<script>BadName1234567890</script>` name arrived on the
    peer's side as the correctly stripped-and-truncated `scriptBadName1234567`, and a
    profane name arrived as `Anonymous Peer`, both with no console errors. Re-ran
    `test-stress.js` (9/9) and `test-load.js` (10/10) after the signaling protocol
    change — no regressions — and `vite build` stayed clean.
- **Multi-peer mesh support (branch: `multi-peer`).** Extended rooms from a fixed
  2-peer cap to up to 4 peers, using a full mesh topology (every peer holds an
  independent `RTCPeerConnection`/`RTCDataChannel` to every other peer) — chosen over
  an SFU specifically because an SFU would mean a server actively relaying/decrypting
  data, breaking the project's core "no file content ever touches the server"
  guarantee; mesh keeps that guarantee structurally intact at the cost of not scaling
  past a handful of peers (the sender's upload bandwidth multiplies by N-1).
  - `roomManager.js`: `MAX_PEERS_PER_ROOM` raised from 2 to 4 — the join/leave logic
    was already peer-count-agnostic (`Set` + size check), no other change needed.
  - `signaling.js`: the `signal` relay was the one real correctness bug for mesh — it
    broadcast to the whole room, which is equivalent to "the other peer" at 2 peers
    but would corrupt every other pairwise SDP negotiation at 3+. Now takes a
    `targetPeerId` and relays point-to-point via `socket.to(targetPeerId)` (Socket.io
    auto-joins every socket to a room named after its own id), falling back to the old
    room-wide broadcast if `targetPeerId` is absent — keeps `test-stress.js`/
    `test-load.js` passing unmodified.
  - `peerClient.js` rewritten around a `Map<peerId, {pc, dataChannel, displayName}>`
    instead of one global connection — initiator role is assigned deterministically
    (whoever joins later offers to every existing peer; existing peers just wait), so
    there's no offer/answer glare even when multiple people join at once.
  - `fileTransfer.js`'s `sendFile`/`sendText` now take an array of channels: the file
    is read and hashed **once** regardless of peer count, then each chunk is broadcast
    to every open channel (backpressure gated on the slowest one); a channel that dies
    mid-broadcast is dropped from the set rather than aborting the transfer for
    everyone else, and if *all* channels die mid-send the promise now rejects instead
    of silently "succeeding" with nobody having received anything.
  - `Room.jsx`: single `peerName` state replaced with a `peers` object keyed by
    peerId; status pill lists everyone connected ("Connected with Bob, Carol, Dave");
    received-file entries tagged with the sender's name.
  - **Found and fixed a real bug during manual testing**, a new variant of the
    stuck-progress-bar issue from the 2-peer hardening pass: if the peer currently
    *sending* a file disconnects mid-transfer, the overall status correctly stays
    "connected" (the other peers are still mesh-connected to each other), so the old
    terminal-status-based clearing never fired, leaving "Receiving… 22%" stuck forever
    on every other peer's screen. Fixed with a `receivingFromRef` in `Room.jsx` that
    tracks which peer the current in-flight receive is from, so `onPeerLeft` only
    clears the progress bar when the peer who left is the one who was actually
    sending it — an unrelated transfer from a still-connected peer is left alone.
  - **New test:** `server/test-multipeer-signaling.js` (17 checks, all passing) —
    4 peers joining with correct peer/name fan-out to each joiner, a 5th peer
    correctly rejected with `room-full`, the targeted-signal fix verified directly
    (a signal aimed at one peer does not reach two bystanders in the same room), and
    peer-left fan-out to the remaining 3 plus a stray post-departure signal handled
    as a no-op rather than a crash.
  - **Manual 4-tab browser verification:** all 4 tabs (Alice/Bob/Carol/Dave) reached
    full mesh, status pill correctly listed the other 3 names on every tab; an 8MB
    file sent by Alice was received and sha256-verified by all 3 others, each tagged
    "from Alice"; a chat message broadcast the same way with the correct sender name;
    a 5th tab attempting to join saw "Room is full (max 4 peers)"; killing one peer's
    tab mid-transfer (150MB) correctly notified the remaining 3, who stayed mesh-
    connected to each other with zero console errors, and (after the fix above) no
    stuck progress bar.
  - Regression-tested `test-stress.js` (9/9 — one scenario's expected numbers updated
    from "2 of 5 admitted" to "4 of 7 admitted" to match the new cap, not a behavior
    change) and `test-load.js` (10/10, unmodified) — both still pass. `vite build`
    stays clean.
  - Working on the `multi-peer` git branch, not `main` — the already-tested 2-peer
    version stays safe and gradable until this is deliberately merged.
- **Phase 5: MongoDB integration, verified against a real Atlas cluster.** The
  models/persistence code (`db.js`, `metricsPersistence.js`, `metricsTracker.js`,
  `models/RoomSession.js`, `models/TransferMetric.js`) had been written but never
  run against a reachable database. Set up a free MongoDB Atlas M0 cluster and
  verified it end-to-end:
  - **Found and fixed two real environment bugs**, neither in the Mongo logic
    itself: (1) Node's own DNS client (c-ares) failed to resolve the
    `mongodb+srv://` SRV record on this machine with `querySrv ECONNREFUSED`,
    even though the OS resolver (`nslookup`) resolved it fine — fixed by pointing
    Node's resolver at a public DNS server (`dns.setServers(["8.8.8.8",
    "8.8.4.4"])`) at the top of `db.js`, before `mongoose.connect()` runs.
    (2) `dotenv.config()` in `server.js` only found `server/.env` when the process
    was launched with cwd already inside `server/` (e.g. `npm --prefix server
    start`) — launching it from the repo root (as `.claude/launch.json` does)
    silently loaded no env file at all, so `MONGO_URI` read as undefined. Fixed
    by resolving the `.env` path explicitly relative to `server.js` itself
    (`path.join(__dirname, "..", ".env")`) instead of relying on process cwd.
  - **Verified with a live two-tab browser transfer**, not just a connection
    check: created a room, joined a second tab, sent a 64KB file (drag-drop via
    a synthetic `DataTransfer`, same headless-browser workaround as earlier
    phases), confirmed sha256 verified on the receiving side, then had both tabs
    leave the room. Queried the Atlas cluster directly afterward and confirmed
    both a `TransferMetric` document (`fileSizeBytes: 65536, status: "completed",
    sha256Match: true`) and a `RoomSession` document (`peakPeersCount: 2,
    totalTransfersCompleted: 1, totalTransfersFailed: 0`) were written with the
    correct room ID and timestamps — the metrics pipeline persists real data
    end-to-end, not just to a local/mocked connection.
  - `MONGO_URI` lives only in the git-ignored `server/.env`, never committed.
