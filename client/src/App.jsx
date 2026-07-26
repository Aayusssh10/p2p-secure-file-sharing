import { useCallback, useState } from "react";
import Home from "./pages/Home.jsx";
import Room from "./pages/Room.jsx";

function roomIdFromUrl() {
  return new URLSearchParams(window.location.search).get("room");
}

export default function App() {
  // A room code in the URL (e.g. from a shared invite link) only prefills the
  // Join Room field on Home — it must not skip straight into the room, since
  // the joiner still needs to be asked for their display name.
  const [initialCode] = useState(roomIdFromUrl);
  const [roomId, setRoomId] = useState(null);
  const [displayName, setDisplayName] = useState("");

  const enterRoom = useCallback((id, name) => {
    const url = new URL(window.location.href);
    url.searchParams.set("room", id);
    window.history.pushState({}, "", url);
    setDisplayName(name || "");
    setRoomId(id);
  }, []);

  const leaveRoom = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.pushState({}, "", url);
    setRoomId(null);
  }, []);

  return roomId ? (
    <Room roomId={roomId} displayName={displayName} onLeave={leaveRoom} />
  ) : (
    <Home onEnterRoom={enterRoom} initialCode={initialCode} />
  );
}
