/**
 * run-console-harness.mjs — run the Teleport Console browser harness
 * against the LOCAL build. Builds with VITE_FLAG_CONSOLE_UI=true (the
 * console mounts when the flag is armed — uiVariant.js; on the x1scroll
 * Vercel preview hosts it mounts with NO flag), serves the compiled bundle
 * with `vite preview` on port 4176, runs the console-leg Playwright spec
 * against it, then tears the server down.
 *
 * Usage:  node e2e/run-console-harness.mjs
 *
 * The harness is hermetic: /api/lifi/quote + tools are intercepted and
 * fulfilled with the frozen golden fixtures, the balance RPCs return
 * deterministic 503s, the fake wallets never sign — no live LiFi, no live
 * chain, no money moved. The local console build is DISARMED
 * (WARP_LIVE_SEND=false — no VERCEL_GIT_COMMIT_REF), so the build banner
 * reads "live sends OFF" and stage 2 can never broadcast.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const PORT = 4176;
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

// 1. Build the local bundle with the CONSOLE flag ARMED (the console mounts
//    only behind it on localhost — uiVariant.js: env unset + non-preview
//    host → classic; this env forces the console). No VERCEL_GIT_COMMIT_REF
//    → WARP_LIVE_SEND stays false: the local console build is DISARMED.
if (!process.env.SKIP_BUILD) {
  console.log("── [console harness] npm run build (VITE_FLAG_CONSOLE_UI=true, disarmed) ──");
  await run("npm", ["run", "build"], { env: { ...process.env, VITE_FLAG_CONSOLE_UI: "true" } });
}

// 2. Serve it.
console.log(`── [console harness] vite preview on ${BASE} ──`);
const preview = spawn(
  "npx",
  ["vite", "preview", "--port", String(PORT), "--strictPort"],
  { cwd: repo, stdio: "ignore" },
);
let exitCode = 1;
try {
  await waitForServer(BASE);
  // 3. Run the spec against the local build.
  console.log("── [console harness] playwright spec (local baseline) ──");
  await run(
    "npx",
    ["playwright", "test", "--config", "e2e/playwright.console.config.js"],
    { env: { ...process.env, E2E_BASE_URL: BASE } },
  );
  exitCode = 0;
} finally {
  preview.kill("SIGTERM");
}
process.exit(exitCode);
