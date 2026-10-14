#!/usr/bin/env node
/**
 * run-sdk-smoke.mjs — run JUST the grabbed-SDK smoke tests
 * (src/lib/sdk/*.test.js) under the same node:test invocation as `npm test`
 * (jsx loader + capped concurrency). Self-contained (no argv).
 * Usage: node tools/run-sdk-smoke.mjs
 * (The repo's `npm test` runs the full suite incl. these files; this script
 * exists for fast iteration on the sdk area only.)
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sdkDir = join(here, "..", "src", "lib", "sdk");
const files = readdirSync(sdkDir)
  .filter((f) => f.endsWith(".test.js"))
  .sort()
  .map((f) => join(sdkDir, f));

const r = spawnSync(
  "node",
  ["--import", "./tools/jsx-loader.mjs", "--test", "--test-concurrency=4", ...files],
  { stdio: "inherit", env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" } },
);
process.exit(r.status ?? 1);
