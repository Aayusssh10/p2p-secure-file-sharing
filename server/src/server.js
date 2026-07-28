require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { registerSignalingHandlers } = require("./signaling");
const { getStats } = require("./roomManager");
const { connectToDatabase } = require("./db");

const PORT = process.env.PORT || 4000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

// Not awaited: the signaling server must start and accept connections
// immediately regardless of whether MongoDB is configured, reachable, or
// slow to respond — metrics persistence is a strictly additive feature.
connectToDatabase();

const app = express();
app.use(cors({ origin: CLIENT_URL }));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
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
