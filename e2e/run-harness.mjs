/**
 * run-harness.mjs — run the browser-verification harness against the LOCAL
 * build (the fast, hermetic baseline). Builds (vite build, prebuild account
 * verify included), serves the compiled bundle with `vite preview` on port
 * 4173, runs the Playwright spec against it, then tears the server down.
 *
 * Usage:  node e2e/run-harness.mjs
 * Deployed one-off check (the ONLY browser check against a deployed URL —
 * the stable git-v2 alias, no new deploy):
 *   E2E_BASE_URL=https://x1teleporter-git-v2-x1scroll-ios-projects.vercel.app \
 *     npx playwright test --config e2e/playwright.config.js
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const PORT = 4173;
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

// 1. Build the local bundle (vite build — prebuild runs verify-accounts.mjs).
if (!process.env.SKIP_BUILD) {
  console.log("── [harness] npm run build (local, disarmed bundle) ──");
  await run("npm", ["run", "build"]);
}

// 2. Serve it.
console.log(`── [harness] vite preview on ${BASE} ──`);
const preview = spawn(
  "npx",
  ["vite", "preview", "--port", String(PORT), "--strictPort"],
  { cwd: repo, stdio: "ignore" },
);
let exitCode = 1;
try {
  await waitForServer(BASE);
  // 3. Run the spec against the local build.
  console.log("── [harness] playwright spec (local baseline) ──");
  await run(
    "npx",
    ["playwright", "test", "--config", "e2e/playwright.config.js"],
    { env: { ...process.env, E2E_BASE_URL: BASE } },
  );
  exitCode = 0;
} finally {
  preview.kill("SIGTERM");
}
process.exit(exitCode);
