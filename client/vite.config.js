import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server port matches the signaling server's default CLIENT_URL
// (server/.env.example) so CORS works out of the box.
export default defineConfig({
  plugins: [react()],
  server: { port: 3000 },
});
