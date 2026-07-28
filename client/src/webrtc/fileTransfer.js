const CHUNK_SIZE = 16 * 1024; // 16KB — safe send size across browsers
const BUFFERED_AMOUNT_LOW_THRESHOLD = CHUNK_SIZE * 4;
const MAX_BUFFERED_AMOUNT = CHUNK_SIZE * 8; // backpressure ceiling before pausing sends

function toHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(buffer) {
  return toHex(await crypto.subtle.digest("SHA-256", buffer));
}

// Reads the whole file into memory, hashes it once, then broadcasts it in
// chunks to every open channel passed in. One file read/hash regardless of
// peer count — sending the same already-computed chunk to N channels is much
// cheaper than re-reading/re-hashing per recipient. A channel that closes or
// errors mid-broadcast is simply dropped from the active set rather than
// aborting the whole transfer for everyone else.
export async function sendFile(channels, file, { onProgress } = {}) {
  let openChannels = (channels || []).filter((ch) => ch && ch.readyState === "open");
  if (openChannels.length === 0) {
    throw new Error("No open data channels");
  }

  const buffer = await file.arrayBuffer();
  const sha256 = await sha256Hex(buffer);

  const meta = JSON.stringify({ type: "file-meta", name: file.name, size: file.size, mimeType: file.type, sha256 });
  openChannels.forEach((ch) => {
    ch.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;
    ch.send(meta);
  });

  return new Promise((resolve, reject) => {
    let offset = 0;

    function sendNextChunk() {
      while (offset < buffer.byteLength) {
        openChannels = openChannels.filter((ch) => ch.readyState === "open");
        if (openChannels.length === 0) {
          reject(new Error("All peers disconnected during transfer"));
          return;
        }

        const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
        openChannels.forEach((ch) => {
          try {
            ch.send(chunk);
          } catch {
            // dropped below on the next readyState filter pass
          }
        });

        offset += chunk.byteLength;
        if (onProgress) onProgress(Math.min(offset / buffer.byteLength, 1));

        const overloaded = openChannels.filter((ch) => ch.bufferedAmount > MAX_BUFFERED_AMOUNT);
        if (overloaded.length > 0) {
          let remaining = overloaded.length;
          overloaded.forEach((ch) => {
            ch.onbufferedamountlow = () => {
              ch.onbufferedamountlow = null;
              remaining -= 1;
              if (remaining === 0) sendNextChunk();
            };
          });
          return; // pause here; resumes once every over-threshold channel drains
        }
      }

      openChannels.forEach((ch) => {
        if (ch.readyState === "open") ch.send(JSON.stringify({ type: "file-end" }));
      });
      resolve(sha256);
    }

    sendNextChunk();
  });
}

export function sendText(channels, text, name) {
  const payload = JSON.stringify({ type: "chat", text, name });
  (channels || []).forEach((ch) => {
    if (ch && ch.readyState === "open") ch.send(payload);
  });
}

export function createFileReceiver({ onProgress, onComplete, onText }) {
  let meta = null;
  let chunks = [];
  let receivedBytes = 0;

  return function handleMessage(event) {
    const { data } = event;

    if (typeof data === "string") {
      const msg = JSON.parse(data);
      if (msg.type === "file-meta") {
        meta = msg;
        chunks = [];
        receivedBytes = 0;
      } else if (msg.type === "file-end" && meta) {
        finalizeFile(meta, chunks, onComplete);
        meta = null;
        chunks = [];
      } else if (msg.type === "chat") {
        if (onText) onText(msg.text, msg.name);
      }
      return;
    }

    if (!meta) return; // stray binary message with no preceding file-meta

    chunks.push(data);
    receivedBytes += data.byteLength;
    if (onProgress) onProgress(Math.min(receivedBytes / meta.size, 1));
  };
}

async function finalizeFile(meta, chunks, onComplete) {
  const blob = new Blob(chunks, { type: meta.mimeType || "application/octet-stream" });
  const buffer = await blob.arrayBuffer();
  const actualHash = await sha256Hex(buffer);
  const integrityOk = !meta.sha256 || actualHash === meta.sha256;
  if (onComplete) onComplete(blob, { ...meta, actualHash, integrityOk });
}
