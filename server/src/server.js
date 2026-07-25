require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { registerSignalingHandlers } = require("./signaling");

const PORT = process.env.PORT || 4000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

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

server.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
