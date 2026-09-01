import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ─────────────────────────────────────────────────────────────────────────────
// WARP_LIVE_SEND build pin — deterministic, preview-only arming.
//
// WHY: Vercel's project env (VITE_WARP_LIVE_SEND=true, Preview scope) is not
// reliably reaching `import.meta.env` in the compiled bundle (a known
// Vercel/Vite injection quirk — the deployed preview kept compiling
// WARP_LIVE_SEND:false even after dashboard Redeploys). So instead of relying
// on injection, we pin the value at build time via `define`, keyed off the
// PROVEN deployment fact: Vercel sets VERCEL_GIT_COMMIT_REF to the deployed
// branch (observed `meta.githubCommitRef === "v2"` on preview deployments;
// production deploys from `main`). Documented system env var:
// https://vercel.com/docs/environment-variables/system-environment-variables
//
// SAFETY BOUNDARY (non-negotiable): production (ref === "main") MUST compile
// WARP_LIVE_SEND:false. The rule is inverse-safe — default false, armed ONLY
// when the ref is a known non-main branch. Local builds without the Vercel
// ref also stay at the safety default. flags.ts logic and its defaults are
// untouched; this only pins the env INPUT that Vite bakes into the bundle.
// ─────────────────────────────────────────────────────────────────────────────
const gitRef = process.env.VERCEL_GIT_COMMIT_REF;
const warpLiveSend = gitRef !== undefined && gitRef !== "main" ? "true" : "false";

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
    // Pin the live-send gate at build time (see header comment). Vite's
    // `define` value takes precedence over its own import.meta.env handling,
    // so this is deterministic regardless of Vercel env injection.
    "import.meta.env.VITE_WARP_LIVE_SEND": JSON.stringify(warpLiveSend),
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
