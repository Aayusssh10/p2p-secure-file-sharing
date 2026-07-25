import { useCallback, useState } from "react";
import Home from "./pages/Home.jsx";
import Room from "./pages/Room.jsx";

function roomIdFromUrl() {
  return new URLSearchParams(window.location.search).get("room");
}

export default function App() {
  const [roomId, setRoomId] = useState(roomIdFromUrl);

  const enterRoom = useCallback((id) => {
    const url = new URL(window.location.href);
    url.searchParams.set("room", id);
    window.history.pushState({}, "", url);
    setRoomId(id);
  }, []);

  const leaveRoom = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.pushState({}, "", url);
    setRoomId(null);
  }, []);

  return roomId ? (
    <Room roomId={roomId} onLeave={leaveRoom} />
  ) : (
    <Home onEnterRoom={enterRoom} />
  );
}
