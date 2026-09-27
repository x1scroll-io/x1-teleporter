import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// DEV-ONLY: mount the Vercel serverless handlers in /api under `vite dev` so the
// console can request quotes locally. No effect on production builds.
import devApi from "./tools/vite-plugin-dev-api.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// WARP_LIVE_SEND build pin — deterministic, allowlist-gated arming.
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
// SAFETY BOUNDARY (non-negotiable): arming is DELIBERATE. Only the branches
// listed in WARP_ARMED_BRANCHES may compile WARP_LIVE_SEND:true — currently
// just `v2`, the hop-test branch. Everything else — `main` (production),
// any other feature/fix/docs branch, and local builds with no Vercel ref —
// compiles WARP_LIVE_SEND:false. Adding a branch to the allowlist is an
// explicit maintainer act, never an implicit side effect of creating a
// branch/PR: a random future branch preview CANNOT silently send real money.
// flags.ts logic and its defaults are untouched; this only pins the env
// INPUT that Vite bakes into the bundle.
// ─────────────────────────────────────────────────────────────────────────────
// Only these branches may compile with live sends armed. Everything else
// (including main) compiles WARP_LIVE_SEND:"false". Arming is DELIBERATE:
// adding a branch here is an explicit act by a maintainer.
const WARP_ARMED_BRANCHES = new Set(["v2"]);
const gitRef = process.env.VERCEL_GIT_COMMIT_REF;
const warpLiveSend =
  gitRef !== undefined && WARP_ARMED_BRANCHES.has(gitRef) ? "true" : "false";

// ─────────────────────────────────────────────────────────────────────────────
// MEV_CAPTURE_ENABLED build pin — ARMED BY DEFAULT (the capture engine is the
// revenue path; 2026-09-27 activation), with an instant env KILL SWITCH.
//
// The MEV/price-gap capture engine (src/lib/mev/) reads VITE_MEV_CAPTURE_ENABLED
// (flags.ts). The value is PINNED here at build time so a Vercel env-injection
// quirk cannot silently flip it — a real build compiles it TRUE unless an
// explicit env override disarms it.
//
// Arming is now the DEFAULT for a real build (the engine runs detection →
// records the drop-as-is intent → plans the batch sweep for revenue). It can be
// killed INSTANTLY by setting MEV_CAPTURE_ENABLED=false (or
// VITE_MEV_CAPTURE_ENABLED=false) in the build env — that override WINS.
// `node --test` still compiles to the safety default false (import.meta.env is
// undefined under the test runner — see flags.ts), so the unit suite stays
// deterministic and the sandbox/measurement fallback holds.
//
// SAFETY BOUNDARY (structural, not just flag): even ARMED the capture path is
// read-only on the user's money path and NEVER broadcasts — the capture is
// the venue SPREAD, not the user's funds; the composed legs' submit() throws
// DexDirectLiveTestGateError and every sweep plan carries executable:false.
// The gate turns capture OBSERVATION into recorded capture INTENT + a sweep
// plan; the live arm (signing a capture artifact) is Mr. Esters' alone.
// ─────────────────────────────────────────────────────────────────────────────
const MEV_DISARM = new Set(["false", "0", "off", "no"]);
const mevEnvOverride = process.env.VITE_MEV_CAPTURE_ENABLED ?? process.env.MEV_CAPTURE_ENABLED;
const mevCaptureEnabled =
  mevEnvOverride !== undefined && MEV_DISARM.has(String(mevEnvOverride).trim().toLowerCase())
    ? "false"
    : "true";

export default defineConfig({
  plugins: [react(), devApi()],
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
    // Pin the MEV capture gate at build time (see the MEV block above).
    // Default false everywhere except the MEV_ARMED_BRANCHES allowlist (v2),
    // and even armed it is wallet-sign-only (structural — no broadcast path).
    "import.meta.env.VITE_MEV_CAPTURE_ENABLED": JSON.stringify(mevCaptureEnabled),
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