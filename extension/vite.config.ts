import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

// Shared pure-logic modules (types, csv, filters) live in the sibling Next app's
// src/lib and are the single source of truth until that app is retired (Phase 5).
const core = fileURLToPath(new URL("../src/lib", import.meta.url));
const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: [
      { find: /^@core\//, replacement: `${core}/` },
      { find: /^@flk\//, replacement: `${src}/` },
    ],
  },
  server: {
    // Allow importing the shared libs from outside the extension root during dev.
    fs: { allow: [".."] },
  },
  build: {
    rollupOptions: {
      // The dashboard opens in its own extension tab; CRXJS builds manifest-declared
      // entries, so the standalone page is registered here explicitly.
      input: { ui: fileURLToPath(new URL("./src/ui/index.html", import.meta.url)) },
    },
  },
  test: {
    environment: "node",
    globals: true,
  },
});
