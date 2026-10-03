// run-engine.mjs — run ONLY the engine tests (test/engine.test.js).
import { spawnSync } from "node:child_process";

const r = spawnSync(
  "node",
  ["--import", "./tools/jsx-loader.mjs", "--test", "test/engine.test.js"],
  { stdio: "inherit", env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" } },
);
process.exit(r.status ?? 1);
