// run-tests.mjs — run the repo's node:test suite with capped concurrency (guardrail 1)
// Usage: node run-tests.mjs [--concurrency=N] [--files="a,b,c"]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
// the test script is a single string of files — split it
const script = pkg.scripts.test;
const m = script.match(/--test(.*)$/);
const files = m[1].trim().split(/\s+/).filter(Boolean);

const argFiles = process.argv.find(a => a.startsWith('--files='));
const selected = argFiles ? argFiles.split('=')[1].split(',') : files;
const conc = process.argv.find(a => a.startsWith('--concurrency='));
const concurrency = conc ? conc.split('=')[1] : '4';

console.log(`Running ${selected.length} test files, concurrency=${concurrency}`);
const r = spawnSync('node', ['--import', './tools/jsx-loader.mjs', '--test', `--test-concurrency=${concurrency}`, ...selected], {
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
});
process.exit(r.status ?? 1);
