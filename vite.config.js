import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // @solana/web3.js references Buffer/global as browser globals. We polyfill
  // Buffer at the entry (src/main.jsx) and map `global` -> globalThis here.
  // Expose both VITE_ and NEXT_PUBLIC_ vars to the client bundle so the
  // legacy NEXT_PUBLIC_FLAG_* names set in Vercel keep working (src/lib/flags.ts).
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
  define: {
    global: "globalThis",
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
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
