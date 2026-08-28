/**
 * Grep/lint test (Step 2.2): NO src/ code may read the injected wallet
 * globals directly. The runbook and docs/BRIEF.md (Cross-cutting — Wallet
 * layer) are explicit:
 *
 *   "There must be no code that reads the injected EVM, Solana, Bitcoin,
 *    or Tron wallet globals directly — add a lint rule or grep test that
 *    fails if any of them appears."
 *
 * This test scans every source file under src/ and fails the build if any of
 * the four patterns appears. It is self-testing: the fixture at
 * test/fixtures/banned-window-fixture.js (OUTSIDE src/) contains all four
 * patterns, and a dedicated test proves the scanner flags it.
 *
 * Legacy allowlist (documented, do NOT extend):
 *   - src/Teleporter.jsx — the pre-v2 bridge UI reads the injected EVM and
 *     Solana globals. It is slated for removal in the Phase 3 UI swap and is
 *     explicitly OUT of scope for Step 2.2 (no Teleporter.jsx refactor).
 *   - src/warpBridge.js — legacy warp helpers, same removal path.
 *
 * Everything else in src/ — including the new discovery layer — must never
 * touch those globals. wagmi (EIP-6963), the Wallet Standard registry, and
 * the THORChain/Bitcoin/Tron adapters (later steps) are the replacements.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of src/. */
export const SRC_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The banned injected-global access patterns. Built from pieces so the
 * regex SOURCE in this file never contains a self-matching run — a naive
 * literal regex would flag this very file.
 */
const BANNED_GLOBAL_NAMES = ["ethereum", "solana", "BitcoinProvider", "tronLink"];
export const BANNED_PATTERNS = BANNED_GLOBAL_NAMES.map(
  (name) => new RegExp(`window\\${"."}${name}`),
);

/**
 * Legacy files allowed to keep reading the injected globals until the
 * Phase 3 refactor removes them. Do NOT add entries here — the whole point
 * of the rule is that new code never touches these globals.
 */
export const LEGACY_ALLOWLIST = new Set(["Teleporter.jsx", "warpBridge.js"]);

const SOURCE_EXTENSIONS = /\.(js|jsx|ts|tsx|mjs|cjs)$/;

/**
 * Scan a directory tree for files containing any banned pattern.
 *
 * @param {string} rootDir directory to scan recursively
 * @param {{patterns?: RegExp[], allowlist?: Set<string>}} [options]
 *   allowlist entries are matched against the path relative to rootDir.
 * @returns {string[]} offending file paths, relative to rootDir
 */
export function findBannedWindowAccess(rootDir, { patterns = BANNED_PATTERNS, allowlist = LEGACY_ALLOWLIST } = {}) {
  const offenders = [];

  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!SOURCE_EXTENSIONS.test(name)) continue;
      const rel = relative(rootDir, full);
      if (allowlist.has(rel)) continue;
      const source = readFileSync(full, "utf8");
      if (patterns.some((re) => re.test(source))) offenders.push(rel);
    }
  }

  walk(rootDir);
  return offenders.sort();
}

test("live scan: no src/ file (outside the documented legacy allowlist) reads any injected wallet global", () => {
  const offenders = findBannedWindowAccess(SRC_ROOT);
  assert.deepEqual(
    offenders,
    [],
    "banned injected-global access found in src/ — remove the patterns; do NOT extend LEGACY_ALLOWLIST",
  );
});

test("scanner self-test: a fixture containing the banned patterns MUST be flagged", () => {
  const fixturesDir = fileURLToPath(new URL("../../../test/fixtures/", import.meta.url));
  const offenders = findBannedWindowAccess(fixturesDir);
  assert.deepEqual(
    offenders,
    ["banned-window-fixture.js"],
    "the scanner must catch the fixture — if this fails the rule is toothless",
  );
});

test("scanner self-test: the allowlist is honored (and not blanket)", () => {
  const fixturesDir = fileURLToPath(new URL("../../../test/fixtures/", import.meta.url));
  const fixtureRel = "banned-window-fixture.js";

  // Allowlisting the fixture suppresses it…
  const allowed = findBannedWindowAccess(fixturesDir, { allowlist: new Set([fixtureRel]) });
  assert.deepEqual(allowed, []);

  // …but a DIFFERENT allowlist entry does not (allowlist is exact-match).
  const notAllowed = findBannedWindowAccess(fixturesDir, { allowlist: new Set(["some-other-file.js"]) });
  assert.deepEqual(notAllowed, [fixtureRel]);
});
