import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// UI build: web/ -> dist/public (served by dist/server.js).
// `npm run dev:web` proxies /api to the API server on port 3000.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL("../dist/public", import.meta.url)), emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:3000", "/paypal": "http://localhost:3000" } },
});
