const CHUNK_SIZE = 16 * 1024; // 16KB — safe send size across browsers
const BUFFERED_AMOUNT_LOW_THRESHOLD = CHUNK_SIZE * 4;
const MAX_BUFFERED_AMOUNT = CHUNK_SIZE * 8; // backpressure ceiling before pausing sends

export function sendFile(channel, file, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (!channel || channel.readyState !== "open") {
      reject(new Error("Data channel is not open"));
      return;
    }

    channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;
    channel.send(
      JSON.stringify({ type: "file-meta", name: file.name, size: file.size, mimeType: file.type })
    );

    const reader = new FileReader();
    let offset = 0;

    function sendNextChunk() {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    }

    reader.onload = () => {
      try {
        channel.send(reader.result);
      } catch (err) {
        reject(err);
        return;
      }

      offset += reader.result.byteLength;
      if (onProgress) onProgress(Math.min(offset / file.size, 1));

      if (offset < file.size) {
        if (channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
          channel.onbufferedamountlow = () => {
            channel.onbufferedamountlow = null;
            sendNextChunk();
          };
        } else {
          sendNextChunk();
        }
      } else {
        channel.send(JSON.stringify({ type: "file-end" }));
        resolve();
      }
    };

    reader.onerror = () => reject(reader.error);

    sendNextChunk();
  });
}

export function createFileReceiver({ onProgress, onComplete }) {
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
        const blob = new Blob(chunks, { type: meta.mimeType || "application/octet-stream" });
        onComplete(blob, meta);
        meta = null;
        chunks = [];
      }
      return;
    }

    if (!meta) return; // stray binary message with no preceding file-meta

    chunks.push(data);
    receivedBytes += data.byteLength;
    if (onProgress) onProgress(Math.min(receivedBytes / meta.size, 1));
  };
}
