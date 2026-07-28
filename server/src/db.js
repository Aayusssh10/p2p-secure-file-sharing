const mongoose = require("mongoose");

// Metrics persistence is strictly additive to this app's actual job
// (signaling). MONGO_URI missing, MongoDB unreachable, or MongoDB dropping
// mid-session must never stop rooms from being created or files from being
// transferred — so connection failures are logged, not thrown, and every
// write elsewhere in the app checks isConnected() first rather than firing
// blindly into a dead connection.
async function connectToDatabase() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.warn("MONGO_URI not set — room/transfer metrics will not be persisted.");
    return;
  }

  mongoose.connection.on("error", (err) => {
    console.error("MongoDB connection error:", err.message);
  });
  mongoose.connection.on("disconnected", () => {
    console.warn("MongoDB disconnected — metrics persistence paused until it reconnects.");
  });
  mongoose.connection.on("reconnected", () => {
    console.log("MongoDB reconnected — resuming metrics persistence.");
  });

  try {
    await mongoose.connect(uri);
    console.log("Connected to MongoDB.");
  } catch (err) {
    console.error("MongoDB connection failed — continuing without metrics persistence:", err.message);
  }
}

// readyState 1 === "connected". Checked synchronously (no I/O) before every
// write attempt in metricsPersistence.js so a down/reconnecting database is
// skipped immediately instead of buffering writes or waiting on a timeout.
function isConnected() {
  return mongoose.connection.readyState === 1;
}

module.exports = { connectToDatabase, isConnected };
