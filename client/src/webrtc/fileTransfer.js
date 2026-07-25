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

// Reads the whole file into memory, hashes it, then streams it out in chunks.
// The hash travels in file-meta so the receiver can self-verify integrity
// without any out-of-band comparison.
export async function sendFile(channel, file, { onProgress } = {}) {
  if (!channel || channel.readyState !== "open") {
    throw new Error("Data channel is not open");
  }

  const buffer = await file.arrayBuffer();
  const sha256 = await sha256Hex(buffer);

  channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;
  channel.send(
    JSON.stringify({ type: "file-meta", name: file.name, size: file.size, mimeType: file.type, sha256 })
  );

  return new Promise((resolve, reject) => {
    let offset = 0;

    function sendNextChunk() {
      while (offset < buffer.byteLength) {
        const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
        try {
          channel.send(chunk);
        } catch (err) {
          reject(err);
          return;
        }

        offset += chunk.byteLength;
        if (onProgress) onProgress(Math.min(offset / buffer.byteLength, 1));

        if (channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
          channel.onbufferedamountlow = () => {
            channel.onbufferedamountlow = null;
            sendNextChunk();
          };
          return; // pause here; resumes from onbufferedamountlow
        }
      }

      channel.send(JSON.stringify({ type: "file-end" }));
      resolve(sha256);
    }

    sendNextChunk();
  });
}

export function sendText(channel, text) {
  if (!channel || channel.readyState !== "open") {
    throw new Error("Data channel is not open");
  }
  channel.send(JSON.stringify({ type: "chat", text }));
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
        if (onText) onText(msg.text);
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
