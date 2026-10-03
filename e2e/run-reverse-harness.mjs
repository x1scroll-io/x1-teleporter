/**
 * run-reverse-harness.mjs — run the REVERSE browser-verification harness
 * against the LOCAL engine build (Phase 2). Builds with the WARP_LIVE_SEND
 * arming env (VERCEL_GIT_COMMIT_REF=v2 — the vite.config.js allowlist pin;
 * the reverse burn's SIGN step is gated by WARP_LIVE_SEND, so the local
 * reverse harness needs the armed bundle — sends are still impossible: the
 * fake wallets never sign and the X1 RPC is intercepted), serves the compiled
 * bundle with `vite preview` on port 4174, runs the reverse spec against it,
 * then tears the server down.
 *
 * Usage:  node e2e/run-reverse-harness.mjs
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const PORT = 4174;
const BASE = `http://127.0.0.1:${PORT}`;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: repo, stdio: "inherit", ...opts });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on("error", reject);
  });
}

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true; // server answers
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`preview server did not answer at ${url}`);
}

// 1. Build the local bundle with the WARP_LIVE_SEND arming env (the v2
//    branch allowlist — see vite.config.js). The forward harness builds the
//    disarmed bundle; the reverse sign step needs the armed one.
if (!process.env.SKIP_BUILD) {
  console.log("── [reverse harness] npm run build (VERCEL_GIT_COMMIT_REF=v2 → armed bundle) ──");
  await run("npm", ["run", "build"], { env: { ...process.env, VERCEL_GIT_COMMIT_REF: "v2" } });
}

// 2. Serve it.
console.log(`── [reverse harness] vite preview on ${BASE} ──`);
const preview = spawn(
  "npx",
  ["vite", "preview", "--port", String(PORT), "--strictPort"],
  { cwd: repo, stdio: "ignore" },
);
let exitCode = 1;
try {
  await waitForServer(BASE);
  // 3. Run the reverse spec against the armed local build.
  console.log("── [reverse harness] playwright reverse spec (local, armed) ──");
  await run(
    "npx",
    ["playwright", "test", "--config", "e2e/playwright.reverse.config.js"],
    { env: { ...process.env, E2E_BASE_URL: BASE } },
  );
  exitCode = 0;
} finally {
  preview.kill("SIGTERM");
}
process.exit(exitCode);
