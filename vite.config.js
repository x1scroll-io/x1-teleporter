import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
// MEV_CAPTURE_ENABLED build pin — same allowlist discipline as WARP_LIVE_SEND.
//
// The MEV/price-gap capture engine (src/lib/mev/) reads VITE_MEV_CAPTURE_ENABLED
// (flags.ts). Like WARP_LIVE_SEND, the value is PINNED here at build time,
// keyed off the PROVEN deployment fact (VERCEL_GIT_COMMIT_REF), so a Vercel
// env-injection quirk can never silently arm it and no random branch preview
// can ever compile it true.
//
// SAFETY BOUNDARY (non-negotiable): arming is DELIBERATE. Only the branches
// in MEV_ARMED_BRANCHES may compile MEV_CAPTURE_ENABLED:true — currently just
// `v2` (mirror of WARP_ARMED_BRANCHES). `main` (production) and every other
// branch compile it false. AND EVEN WHEN ARMED the capture path is
// wallet-sign-only by STRUCTURE, not just by flag: the capture leg COMPOSES
// the repo's existing swap legs (dexDirect / aggregator), every one of which
// throws DexDirectLiveTestGateError on submit() — no autonomous broadcast
// exists at any flag value. The gate only ever turns DETECTION REPORTING into
// "the engine may build a signable capture artifact for Mr. Esters' wallet".
// ─────────────────────────────────────────────────────────────────────────────
const MEV_ARMED_BRANCHES = new Set(["v2"]);
const mevCaptureEnabled =
  gitRef !== undefined && MEV_ARMED_BRANCHES.has(gitRef) ? "true" : "false";

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