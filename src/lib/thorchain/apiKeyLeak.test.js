/**
 * apiKeyLeak.test.js — SECURITY FIX (PR #20): the THORChain aggregator key
 * must NEVER appear in client-bundled code. A VITE_/NEXT_PUBLIC_ key var
 * compiles into the browser bundle and leaks the key to every visitor, so
 * the key-holding env names are BANNED from src/ (the client tree) — they
 * may exist ONLY server-side (api/thorchain/quote.js reads THORCHAIN_API_KEY
 * from the server env) and in tests.
 *
 * Three guarantees (same grep-test pattern as gate.test.js / noWindowProbe):
 *   1. NON-TEST src/ files contain ZERO "THORCHAIN_API_KEY" — the substring
 *      also catches the VITE_-prefixed and NEXT_PUBLIC_-prefixed variants,
 *      so no key-holding env name can exist in anything that ships.
 *   2. ALL src/ files (tests included) contain ZERO of the VITE_-prefixed /
 *      NEXT_PUBLIC_-prefixed key names (the client-exposed prefixes are banned
 *      everywhere in the client tree; plain THORCHAIN_API_KEY is allowed in
 *      test files, which never ship — see the grep standard in the PR).
 *   3. After `npm run build`, the dist/ bundle contains ZERO
 *      "THORCHAIN_API_KEY" — the definitive "ships to the browser" check.
 *
 * CARVE-OUT (documented): VITE_THORCHAIN_STATUS_URL (src/lib/thorchain/
 * statusEndpoint.js) is a PUBLIC endpoint URL override — not a credential —
 * and the status poller needs no key (audited in PR #20). It is therefore
 * NOT banned; only key-holding names are.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url)); // src/lib/thorchain/ → repo root
const SRC_DIR = join(ROOT, "src");
const DIST_DIR = join(ROOT, "dist");

/** The banned key-holding names. THORCHAIN_API_KEY is a substring of the
 *  VITE_/NEXT_PUBLIC_ variants, so one scan covers all three in non-test
 *  src/. The prefixed names are built by concatenation so THIS file's own
 *  source cannot trip its own scan. */
const KEY_NAME = "THORCHAIN" + "_API_KEY";
const PREFIXED_KEY_NAMES = ["VITE_" + KEY_NAME, "NEXT_PUBLIC_" + KEY_NAME];

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".html", ".css"]);

/** Recursively list source files under a dir. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) {
      out.push(full);
    }
  }
  return out;
}

const isTestFile = (f) => /\.test\.(js|jsx|ts|tsx)$/.test(f) || /\.spec\.(js|jsx|ts|tsx)$/.test(f);

// ─────────────────────────────────────────────────────────────────────────────
// 1 + 2 — src/ scans (fast, run on every `npm test`)
// ─────────────────────────────────────────────────────────────────────────────
test("NO key-holding env name in any NON-TEST src file (the client never holds the key)", () => {
  const offenders = [];
  for (const file of walk(SRC_DIR)) {
    if (isTestFile(file)) continue; // test files never ship (vite bundles only from the entry)
    const src = readFileSync(file, "utf8");
    if (src.includes(KEY_NAME)) {
      offenders.push(file.replace(ROOT, ""));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `THORCHAIN_API_KEY (any prefix) found in client code that ships: ${offenders.join(", ")} — ` +
      `the key is SERVER-SIDE ONLY (api/thorchain/quote.js).`,
  );
});

test("NO VITE_/NEXT_PUBLIC_ key-prefixed names ANYWHERE in src/ (tests included)", () => {
  const offenders = [];
  for (const file of walk(SRC_DIR)) {
    const src = readFileSync(file, "utf8");
    for (const name of PREFIXED_KEY_NAMES) {
      if (src.includes(name)) offenders.push(`${file.replace(ROOT, "")} (${name})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `client-exposed key prefixes found in src/: ${offenders.join(", ")} — ` +
      `a VITE_/NEXT_PUBLIC_ key var would compile into the browser bundle.`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 — built bundle scan. The CI workflow builds BEFORE the test step (see
// .github/workflows/ci.yml), so this test scans the pre-built dist/ and never
// shells out to a build of its own — a build inside the test process collided
// with rollup's module graph in CI (ModuleScope/traceVariable error). If
// dist/ is absent (e.g. a bare local checkout), the scan is skipped with a
// clear message; the CI pipeline (build-then-test) is the enforcement point
// for the built-bundle invariant.
// ─────────────────────────────────────────────────────────────────────────────
test("dist/ bundle contains no THORCHAIN_API_KEY after npm run build", { timeout: 300000 }, (t) => {
  if (!existsSync(DIST_DIR)) {
    t.skip(
      "dist/ not found — skipping the bundle scan. CI builds before tests and enforces this invariant there; run `npm run build` locally to check.",
    );
    return;
  }

  const assets = walk(DIST_DIR);
  const jsAssets = assets.filter((f) => f.endsWith(".js"));
  assert.ok(jsAssets.length > 0, "build produced JS assets in dist/");

  const offenders = [];
  for (const file of assets) {
    const src = readFileSync(file, "utf8");
    if (src.includes(KEY_NAME)) offenders.push(file.replace(ROOT, ""));
  }
  assert.deepEqual(
    offenders,
    [],
    `THORCHAIN_API_KEY found in the built bundle: ${offenders.join(", ")} — the key leaked into client code.`,
  );
});
