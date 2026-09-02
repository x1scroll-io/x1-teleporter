// run-selected-tests.mjs — run a subset of the node:test suite (dev loop
// helper; the canonical entry stays `npm test` / run-tests.mjs).
// Usage: node tools/run-selected-tests.mjs <file...>
import { spawnSync } from "node:child_process";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node tools/run-selected-tests.mjs <test-file...>");
  process.exit(1);
}
const r = spawnSync(
  "node",
  ["--import", "./tools/jsx-loader.mjs", "--test", "--test-concurrency=4", ...files],
  { stdio: "inherit", env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" } },
);
process.exit(r.status ?? 1);
