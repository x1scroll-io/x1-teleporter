import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // @solana/web3.js references Buffer/global as browser globals. We polyfill
  // Buffer at the entry (src/main.jsx) and map `global` -> globalThis here.
  define: {
    global: "globalThis",
  },
  resolve: {
    alias: {
      buffer: "buffer",
    },
  },
  optimizeDeps: {
    include: ["buffer"],
  },
  server: {
    port: 5173,
  },
  build: {
    outDir: "dist",
  },
});
