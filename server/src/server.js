require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { registerSignalingHandlers } = require("./signaling");
const { getStats } = require("./roomManager");
const { connectToDatabase } = require("./db");
const gemini = require("./gemini");

const PORT = process.env.PORT || 4000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

// Not awaited: the signaling server must start and accept connections
// immediately regardless of whether MongoDB is configured, reachable, or
// slow to respond — metrics persistence is a strictly additive feature.
connectToDatabase();

const app = express();
app.use(cors({ origin: CLIENT_URL }));
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Phase 6 (Gemini): both routes only ever receive metadata/status strings,
// never file content. Gemini being unconfigured, slow, or erroring never
// throws — gemini.js resolves to null and these routes report that as
// { summary: null } / { message: null } rather than a 5xx, so the client
// can silently fall back to showing nothing extra.
app.post("/gemini/summarize-file", async (req, res) => {
  const { fileName, fileSizeBytes, mimeType } = req.body || {};
  if (typeof fileName !== "string" || !fileName || typeof fileSizeBytes !== "number" || !Number.isFinite(fileSizeBytes) || fileSizeBytes < 0) {
    return res.status(400).json({ error: "fileName (string) and fileSizeBytes (non-negative number) are required" });
  }
  const summary = await gemini.summarizeFileMetadata({ fileName, fileSizeBytes, mimeType });
  res.json({ summary });
});

app.post("/gemini/connection-status", async (req, res) => {
  const { statusSnippet } = req.body || {};
  if (typeof statusSnippet !== "string" || !statusSnippet) {
    return res.status(400).json({ error: "statusSnippet (string) is required" });
  }
  const message = await gemini.explainConnectionIssue({ statusSnippet });
  res.json({ message });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_URL },
});

io.on("connection", (socket) => {
  registerSignalingHandlers(socket);
});

// Debug/metrics endpoint — never exposes room IDs or signaling payloads, just
// counts and process memory, for load-testing and ops visibility.
app.get("/debug/stats", (req, res) => {
  res.json({
    ...getStats(),
    connectedSockets: io.engine.clientsCount,
    memoryUsage: process.memoryUsage(),
    uptime: process.uptime(),
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
