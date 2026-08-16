import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

/**
 * A dev server for exercising the real exporter in a plain browser.
 *
 * `renderToPng` is otherwise only reachable inside the Tauri webview, which
 * makes the one thing worth checking about a resize — the pixels that actually
 * come out — awkward to measure. Aliasing the single Tauri module it imports to
 * a stub that hands back a PNG lets the genuine source run untouched.
 *
 * Not part of the app build. `vite --config vite.harness.config.ts`.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: resolve(__dirname, "harness"),
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": resolve(__dirname, "src"),
      "@tauri-apps/api/core": resolve(__dirname, "harness/tauri-stub.ts"),
      "@tauri-apps/plugin-opener": resolve(__dirname, "harness/opener-stub.ts"),
      "@tauri-apps/api/event": resolve(__dirname, "harness/event-stub.ts"),
    },
  },
  server: { port: 1421, strictPort: true },
});
