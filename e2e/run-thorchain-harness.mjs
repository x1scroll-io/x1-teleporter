/**
 * run-thorchain-harness.mjs — run the THORChain browser-verification
 * harness against the LOCAL build. Builds with VITE_FLAG_THORCHAIN=true
 * (the THORChain tab renders only behind the flag — flags.ts reads it at
 * build time), serves the compiled bundle with `vite preview` on port 4175,
 * runs the Playwright spec against it, then tears the server down.
 *
 * Usage:  node e2e/run-thorchain-harness.mjs
 *
 * The harness is hermetic: the vault-address refresh + the quote proxy are
 * intercepted (page.route) and fulfilled with the frozen fixtures — no live
 * THORNode calls, no wallet extension, no money moved. The deposit-address
 * lane has no in-app send path by construction (the deposit is sent from
 * the user's external wallet); the fake wallets never sign.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const PORT = 4175;
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

// 1. Build the local bundle with the THORChain flag ARMED (the tab renders
//    only behind it). vite bakes the env at build — no config change.
if (!process.env.SKIP_BUILD) {
  console.log("── [thorchain harness] npm run build (VITE_FLAG_THORCHAIN=true) ──");
  await run("npm", ["run", "build"], { env: { ...process.env, VITE_FLAG_THORCHAIN: "true" } });
}

// 2. Serve it.
console.log(`── [thorchain harness] vite preview on ${BASE} ──`);
const preview = spawn(
  "npx",
  ["vite", "preview", "--port", String(PORT), "--strictPort"],
  { cwd: repo, stdio: "ignore" },
);
let exitCode = 1;
try {
  await waitForServer(BASE);
  // 3. Run the spec against the local build.
  console.log("── [thorchain harness] playwright spec (local baseline) ──");
  await run(
    "npx",
    ["playwright", "test", "--config", "e2e/playwright.thorchain.config.js"],
    { env: { ...process.env, E2E_BASE_URL: BASE } },
  );
  exitCode = 0;
} finally {
  preview.kill("SIGTERM");
}
process.exit(exitCode);
