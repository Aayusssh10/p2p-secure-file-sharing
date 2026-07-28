// Hard 16KB (16384 byte) ceiling on every binary chunk, enforced everywhere
// a chunk is sliced. This is the safe cross-browser SCTP message size —
// Chrome/Firefox/Safari all reliably deliver messages at or below this
// without the silent fragmentation/drop behavior some browser/OS
// combinations show above it. No control message (file-meta/file-end/chat)
// ever gets prepended into this budget — those travel as separate string
// messages — so every binary chunk stays pure file bytes at exactly this
// size, with zero per-chunk framing overhead.
const CHUNK_SIZE = 16 * 1024;
if (CHUNK_SIZE > 16384) {
  throw new Error("CHUNK_SIZE exceeds the 16KB cross-browser SCTP safety limit");
}

const BUFFERED_AMOUNT_LOW_THRESHOLD = CHUNK_SIZE * 4;
const MAX_BUFFERED_AMOUNT = CHUNK_SIZE * 8; // backpressure ceiling before pausing sends
// Chunks between forced yields to the event loop. Without this, a large file
// over a link that never trips backpressure (e.g. localhost, or a fast LAN)
// runs the whole while-loop synchronously and freezes the tab — clicks,
// drags, and the progress bar itself stop updating until the file is done.
const YIELD_EVERY_CHUNKS = 64; // 64 * 16KB = 1MB between yields
// How long a channel may sit over MAX_BUFFERED_AMOUNT without draining
// before it's declared dead. RTCDataChannel is reliable/ordered (SCTP), so
// there's no application-level "retry with backoff" to perform — the
// transport already retransmits internally. What *can* happen is a peer
// that's gone quiet (packet loss, a stalled/backgrounded remote tab, a dead
// ICE path mid-restart) never firing bufferedAmountLow — this timeout is
// the backoff-equivalent for that: it bounds the wait so one bad peer can't
// hang the sender forever or leak a promise/listener that never resolves.
// 30s, not something more aggressive: measured live with 2 peers each
// broadcasting a 100MB file to a 4-peer mesh where one recipient was
// *simultaneously* sending its own 100MB to the other three — a real,
// merely-slow-not-dead peer under heavy concurrent load legitimately needs
// tens of seconds to drain, and a shorter timeout was confirmed to
// misfire and abandon that transfer outright.
const BACKPRESSURE_STALL_MS = 30000;

function toHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(buffer) {
  return toHex(await crypto.subtle.digest("SHA-256", buffer));
}

// A MessageChannel-based macrotask scheduler for the send loop's periodic
// yields. Preferred over bare setTimeout(fn, 0): browsers throttle setTimeout
// more aggressively once a tab is backgrounded (Chrome's "intensive timer
// throttling" can push a hidden tab's timers out to roughly once a minute),
// whereas postMessage-based scheduling isn't classified as a timer and keeps
// firing near-immediately even while hidden — so a transfer to a
// backgrounded tab keeps flowing at close to full speed instead of stalling.
// Falls back to setTimeout if MessageChannel is unavailable. This only paces
// *sending*; the underlying RTCDataChannel itself isn't affected by tab
// visibility either way — browsers are required to keep WebRTC transports
// running in the background.
function createYielder() {
  if (typeof MessageChannel === "undefined") {
    return () => new Promise((resolve) => setTimeout(resolve, 0));
  }
  const channel = new MessageChannel();
  const pending = [];
  channel.port1.onmessage = () => {
    const resolve = pending.shift();
    if (resolve) resolve();
  };
  return () =>
    new Promise((resolve) => {
      pending.push(resolve);
      channel.port2.postMessage(null);
    });
}
const yieldToEventLoop = createYielder();

// Resolves once `ch`'s bufferedAmount drains back under the low threshold,
// or rejects if the channel closes/errors or BACKPRESSURE_STALL_MS elapses
// first. Whichever happens, every listener it registered is torn down
// before settling — nothing is left attached to the channel afterward.
function waitForBufferedAmountLow(ch) {
  return new Promise((resolve, reject) => {
    if (ch.readyState !== "open") {
      reject(new Error("channel-closed-before-drain"));
      return;
    }
    let settled = false;
    const stallTimer = setTimeout(() => {
      finish(() => reject(new Error("backpressure-stall-timeout")));
    }, BACKPRESSURE_STALL_MS);

    function finish(action) {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      ch.onbufferedamountlow = null;
      ch.removeEventListener("close", onCloseOrError);
      ch.removeEventListener("error", onCloseOrError);
      action();
    }
    const onCloseOrError = () => finish(() => reject(new Error("channel-closed-while-buffered")));

    ch.onbufferedamountlow = () => finish(resolve);
    ch.addEventListener("close", onCloseOrError);
    ch.addEventListener("error", onCloseOrError);
  });
}

// Serializes all sends *to a given RTCDataChannel instance* — meta, every
// chunk, and file-end, as one atomic unit — regardless of which sendFile()
// call or which file it came from. Without this, two overlapping sendFile()
// calls sharing a channel (a rapid double-send, a future multi-file queue)
// could interleave two files' binary chunks on the wire with nothing to
// separate them: chunks are pure file bytes with no per-chunk header (see
// the CHUNK_SIZE note above — that's deliberate, to stay at exactly the
// 16KB cross-browser-safe size with zero framing overhead). Queuing
// per-channel gets the same safety without that added wire complexity: at
// most one file is ever "in flight" on a given channel at once, so the
// receiver can always safely attribute every binary chunk it sees to
// whichever file's file-meta most recently arrived without yet having
// ended. Keyed with a WeakMap (not a property on the channel object) so
// nothing needs manual cleanup when a channel is discarded.
const sendQueues = new WeakMap();
function enqueueOnChannel(ch, task) {
  const prior = sendQueues.get(ch) || Promise.resolve();
  // .catch(() => {}) so one file failing on this channel doesn't poison the
  // queue for the next file queued behind it.
  const next = prior.catch(() => {}).then(task);
  sendQueues.set(ch, next);
  return next;
}

async function sendFileToChannel(ch, buffer, metaJson, fileId, onChannelProgress) {
  if (ch.readyState !== "open") throw new Error("channel-not-open");
  ch.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;
  ch.send(metaJson);

  let offset = 0;
  let chunksSinceYield = 0;

  try {
    while (offset < buffer.byteLength) {
      if (ch.readyState !== "open") throw new Error("channel-closed-mid-transfer");

      const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
      ch.send(chunk);
      offset += chunk.byteLength;
      chunksSinceYield += 1;
      onChannelProgress(offset / buffer.byteLength);

      if (ch.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        // Throws if this specific peer stalls out past BACKPRESSURE_STALL_MS
        // or disconnects — it does NOT touch any other channel's loop, since
        // each channel now paces strictly off its own bufferedAmount. One
        // slow or lossy peer (packet loss, head-of-line blocking, a
        // mid-ICE-restart hiccup) can only pause its own delivery, never the
        // others'.
        await waitForBufferedAmountLow(ch);
        chunksSinceYield = 0;
      } else if (chunksSinceYield >= YIELD_EVERY_CHUNKS) {
        chunksSinceYield = 0;
        await yieldToEventLoop();
      }
    }

    if (ch.readyState !== "open") throw new Error("channel-closed-before-end");
    ch.send(JSON.stringify({ type: "file-end", fileId }));
  } catch (err) {
    // The receiver has already seen file-meta at this point and is sitting
    // there assembling chunks — if we just give up silently (channel closed,
    // backpressure-stall timeout, anything else), its UI is stuck showing a
    // stale percentage forever with no way to know the sender walked away.
    // Best-effort tell it: this is a small string message, far under the
    // backpressure threshold, so it can usually get through even when the
    // channel was too backed up to take more binary chunks. If the channel
    // is actually gone, this send throws too — swallowed, since there's
    // nothing left to notify and the channel's own close event on the
    // receiver's side (see peerClient.js) handles that case instead.
    try {
      if (ch.readyState === "open") {
        // Distinguishes "gave up because the peer couldn't drain fast
        // enough" (stalled) from every other failure mode (aborted) — see
        // BACKPRESSURE_STALL_MS above — purely for the receiver's telemetry
        // report; the receiver-side cleanup itself doesn't care which.
        const reason = err instanceof Error && err.message === "backpressure-stall-timeout" ? "stalled" : "aborted";
        ch.send(JSON.stringify({ type: "file-abort", fileId, reason }));
      }
    } catch {
      // channel is gone; nothing to notify
    }
    throw err;
  }
}

// Reads the whole file into memory, hashes it once, then streams it to every
// open channel passed in via its own independent, per-channel send loop
// (serialized per-channel through enqueueOnChannel above, but the different
// channels themselves run fully concurrently — sending to peer B never
// waits on peer C). A channel that errors, closes, or stalls past
// BACKPRESSURE_STALL_MS is dropped from the result set rather than aborting
// the whole transfer for everyone else; if every channel ends up dropped,
// the returned promise rejects instead of silently "succeeding" with nobody
// having received anything.
export async function sendFile(channels, file, { onProgress } = {}) {
  const targets = (channels || []).filter((ch) => ch && ch.readyState === "open");
  if (targets.length === 0) {
    throw new Error("No open data channels");
  }

  const buffer = await file.arrayBuffer();
  const sha256 = await sha256Hex(buffer);
  // Identifies this specific transfer across every recipient. Not needed to
  // tell different *senders* apart (each remote peer already has its own
  // RTCDataChannel and its own receiver instance — see peerClient.js/
  // createFileReceiver below) — it's what lets a receiver safely recognize
  // a file-end that doesn't match the file it's currently assembling (e.g.
  // a stray/duplicate message from a misbehaving peer) and ignore it rather
  // than corrupt the wrong buffer.
  const fileId = crypto.randomUUID();
  const metaJson = JSON.stringify({
    type: "file-meta",
    fileId,
    name: file.name,
    size: file.size,
    mimeType: file.type,
    sha256,
  });

  const progressByChannel = new Map(targets.map((ch) => [ch, 0]));
  const reportProgress = () => {
    if (!onProgress || progressByChannel.size === 0) return;
    const values = [...progressByChannel.values()];
    onProgress(values.reduce((sum, v) => sum + v, 0) / values.length);
  };

  const results = await Promise.allSettled(
    targets.map((ch) =>
      enqueueOnChannel(ch, () =>
        sendFileToChannel(ch, buffer, metaJson, fileId, (p) => {
          progressByChannel.set(ch, p);
          reportProgress();
        })
      ).catch((err) => {
        progressByChannel.delete(ch);
        reportProgress();
        throw err; // re-thrown so Promise.allSettled below still records this channel as failed
      })
    )
  );

  const succeeded = results.some((r) => r.status === "fulfilled");
  if (!succeeded) {
    throw new Error("All peers disconnected during transfer");
  }
  return sha256;
}

export function sendText(channels, text, name) {
  const payload = JSON.stringify({ type: "chat", text, name });
  (channels || []).forEach((ch) => {
    if (ch && ch.readyState === "open") ch.send(payload);
  });
}

// One receiver instance per remote peer's data channel (see peerClient.js's
// setupDataChannel) — that alone is what isolates concurrent senders from
// each other: Peer A and Peer B sending to Peer C land on two entirely
// separate RTCDataChannel objects, each with its own independent
// createFileReceiver() closure, so there is no shared state between them to
// corrupt in the first place. Within a single channel, `current` tracks at
// most the one file presently being assembled — enqueueOnChannel on the
// sender guarantees only one file is ever legitimately in flight on a given
// channel at a time, so a fresh file-meta always means either "the next
// file" (previous one ended cleanly) or "the previous file was abandoned
// mid-transfer" (sender-side channel died before reaching file-end) — either
// way it's correct to drop whatever was buffered and start fresh, which
// also bounds memory to at most one partially-received file's worth of
// chunks per channel at any moment.
//
// onTelemetry fires once per terminal outcome (completed/aborted/stalled)
// with { status, fileSizeBytes, durationMs, sha256Match, fileId } — the
// receiver reports, not the sender, since only the receiver actually knows
// whether the hash matched or the transfer was ever interrupted. This is
// Phase 5 (MongoDB) plumbing; peerClient.js is what actually emits it to
// the signaling server.
export function createFileReceiver({ onProgress, onComplete, onText, onAbort, onTelemetry }) {
  let current = null; // { meta, chunks, receivedBytes, startedAt } | null

  function reportTelemetry(status, sha256Match) {
    if (!onTelemetry || !current) return;
    onTelemetry({
      status,
      fileSizeBytes: current.meta.size,
      durationMs: Date.now() - current.startedAt,
      sha256Match,
      fileId: current.meta.fileId,
    });
  }

  function handleMessage(event) {
    const { data } = event;

    if (typeof data === "string") {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return; // malformed control message from a misbehaving/old client — ignore, don't crash
      }

      if (msg.type === "file-meta") {
        if (!msg.fileId) return; // no id to safely track this file by — drop it rather than guess
        current = { meta: msg, chunks: [], receivedBytes: 0, startedAt: Date.now() };
      } else if (msg.type === "file-end") {
        if (!current || current.meta.fileId !== msg.fileId) return; // stray/duplicate/mismatched end
        finalizeFile(current.meta, current.chunks, Date.now() - current.startedAt, onComplete, onTelemetry);
        current = null;
      } else if (msg.type === "file-abort") {
        // The sender gave up on this specific transfer (backpressure-stall
        // timeout, or its own send loop erroring out) — see the catch block
        // in sendFileToChannel above. Without this, a receiver whose sender
        // vanished mid-file would sit at some stale percentage forever with
        // no signal that nothing more is ever coming.
        if (!current || current.meta.fileId !== msg.fileId) return;
        reportTelemetry(msg.reason === "stalled" ? "stalled" : "aborted", false);
        current = null;
        if (onAbort) onAbort(msg.fileId);
      } else if (msg.type === "chat") {
        if (onText) onText(msg.text, msg.name);
      }
      return;
    }

    if (!current) return; // stray binary message with no active file-meta
    current.chunks.push(data);
    current.receivedBytes += data.byteLength;
    if (onProgress) onProgress(Math.min(current.receivedBytes / current.meta.size, 1), current.meta.fileId);
  }

  // The sender's channel can vanish without ever sending file-abort (a hard
  // disconnect — tab close, network death — never gets the chance). Called
  // by peerClient.js whenever this channel is being torn down; a no-op if
  // there's no transfer in flight, and safe to call more than once (e.g.
  // both the channel's own close event and an explicit peer-left cleanup
  // racing each other) since the second call finds `current` already null.
  function notifyChannelClosed() {
    if (!current) return;
    reportTelemetry("aborted", false);
    current = null;
  }

  return { handleMessage, notifyChannelClosed };
}

async function finalizeFile(meta, chunks, durationMs, onComplete, onTelemetry) {
  const blob = new Blob(chunks, { type: meta.mimeType || "application/octet-stream" });
  const buffer = await blob.arrayBuffer();
  const actualHash = await sha256Hex(buffer);
  const integrityOk = !meta.sha256 || actualHash === meta.sha256;
  if (onComplete) onComplete(blob, { ...meta, actualHash, integrityOk });
  if (onTelemetry) {
    onTelemetry({ status: "completed", fileSizeBytes: meta.size, durationMs, sha256Match: integrityOk, fileId: meta.fileId });
  }
}
