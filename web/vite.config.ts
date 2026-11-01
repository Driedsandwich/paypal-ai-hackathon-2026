import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// UI build: web/ -> dist/public (served by dist/server.js).
// `npm run dev:web` proxies /api to the API server on port 3000.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  // AG Studio (Insights) is one ~5 MB chunk, loaded only when Insights opens.
  build: { outDir: fileURLToPath(new URL("../dist/public", import.meta.url)), emptyOutDir: true, chunkSizeWarningLimit: 6000 },
  server: { proxy: { "/api": "http://localhost:3000", "/paypal": "http://localhost:3000" } },
});
