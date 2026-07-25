import React from "react";
import ReactDOM from "react-dom/client";
import { io } from "socket.io-client";
import App from "./App.jsx";
import "./index.css";

// peerClient.js (Phase 3) calls window.io(...) so it works unmodified both here
// (bundled via npm) and in manual-test.html (loaded from the socket.io CDN script).
window.io = io;

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
