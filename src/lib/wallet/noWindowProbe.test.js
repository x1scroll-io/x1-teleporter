/**
 * Grep/lint test (Step 2.2, extended 2.3 + 2.4): NO src/ code may read the
 * injected wallet globals directly. The runbook and docs/BRIEF.md
 * (Cross-cutting — Wallet layer) are explicit:
 *
 *   "There must be no code that reads the injected EVM, Solana, Bitcoin,
 *    or Tron wallet globals directly — add a lint rule or grep test that
 *    fails if any of them appears."
 *
 * This test scans every source file under src/ and fails the build if any
 * of the banned patterns appears. It is self-testing: the fixture at
 * test/fixtures/banned-window-fixture.js (OUTSIDE src/) contains all the
 * banned patterns, and a dedicated test proves the scanner flags it.
 *
 * Legacy allowlist (documented, do NOT extend):
 *   - src/Teleporter.jsx — the pre-v2 bridge UI reads the injected EVM and
 *     Solana globals. It is slated for removal in the Phase 3 UI swap and is
 *     explicitly OUT of scope for Step 2.2 (no Teleporter.jsx refactor).
 *   - src/warpBridge.js — legacy warp helpers, same removal path.
 *
 * Sanctioned allowlists (documented, do NOT extend):
 *   - BITCOIN_UNISAT_ALLOWLIST (Step 2.3): the impersonation-aware Bitcoin
 *     detection module reads the bare injected `unisat` global per the
 *     registry's three-step collision rule, and the registry data file
 *     documents the key.
 *   - TRON_ADAPTER_ALLOWLIST (Step 2.4): the Tron adapter factory module
 *     documents the ban on the bare injected `tronWeb` global — the
 *     @tronweb3/tronwallet-adapters package owns the injected globals
 *     internally and our code never reads them.
 *
 * Everything else in src/ — including the new discovery layer — must never
 * touch those globals. wagmi (EIP-6963), the Wallet Standard registry, and
 * the Tron adapters (Step 2.4) are the replacements.
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
const BANNED_GLOBAL_NAMES = ["ethereum", "solana", "BitcoinProvider", "tronLink", "unisat", "tronWeb"];
export const BANNED_PATTERNS = BANNED_GLOBAL_NAMES.map(
  (name) => new RegExp(`window\\${"."}${name}`),
);

/** The bare injected unisat-global pattern alone (Bitcoin impersonation rule). */
export const UNISAT_PATTERN = new RegExp(`window\\${"."}unisat`);

/** The bare injected tronWeb-global pattern alone (Tron adapter rule). */
export const TRONWEB_PATTERN = new RegExp(`window\\${"."}tronWeb`);

/**
 * Legacy files allowed to keep reading the injected globals until the
 * Phase 3 refactor removes them. Do NOT add entries here — the whole point
 * of the rule is that new code never touches these globals.
 */
export const LEGACY_ALLOWLIST = new Set(["Teleporter.jsx", "warpBridge.js"]);

/**
 * The SOLE sanctioned bare injected `unisat` global access: the
 * impersonation-aware Bitcoin detection module (reads the bare global per
 * the registry's three-step collision rule) + the registry data file that
 * documents the key. Do NOT extend — any other bare read is a bug.
 */
export const BITCOIN_UNISAT_ALLOWLIST = new Set([
  "lib/wallet/bitcoinDiscovery.js",
  "lib/wallet/bitcoinRegistry.js",
]);

/**
 * The SOLE sanctioned bare injected `tronWeb` global reference: the Tron
 * adapter factory module (tronAdapters.js) documents the ban in comments —
 * the @tronweb3/tronwallet-adapters package owns the injected globals
 * internally and OUR code never reads them. Same pattern as the unisat
 * allowlist (Step 2.3). Do NOT extend — any other reference is a bug.
 */
export const TRON_ADAPTER_ALLOWLIST = new Set([
  "lib/wallet/tronAdapters.js",
]);

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

test("live scan: no src/ file (outside the documented allowlists) reads any injected wallet global", () => {
  const allowlist = new Set([
    ...LEGACY_ALLOWLIST,
    ...BITCOIN_UNISAT_ALLOWLIST,
    ...TRON_ADAPTER_ALLOWLIST,
  ]);
  const offenders = findBannedWindowAccess(SRC_ROOT, { allowlist });
  assert.deepEqual(
    offenders,
    [],
    "banned injected-global access found in src/ — remove the patterns; do NOT extend the allowlists",
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

test("the bare injected unisat global appears ONLY in the impersonation-aware Bitcoin allowlist (Step 2.3)", () => {
  // The bare injected unisat global is banned everywhere except the module
  // that implements the registry's three-step impersonation rule and the
  // data file that documents the key.
  const offenders = findBannedWindowAccess(SRC_ROOT, {
    patterns: [UNISAT_PATTERN],
    allowlist: BITCOIN_UNISAT_ALLOWLIST,
  });
  assert.deepEqual(offenders, [], "the bare global outside the impersonation module is a bug");

  // And the allowlist is not dead: WITHOUT it, exactly those files are
  // flagged for the unisat pattern.
  const raw = findBannedWindowAccess(SRC_ROOT, { patterns: [UNISAT_PATTERN], allowlist: new Set() });
  assert.deepEqual(
    raw.sort(),
    [...BITCOIN_UNISAT_ALLOWLIST].sort(),
    "the impersonation allowlist must cover exactly the files that read the bare global",
  );
});

test("the bare injected tronWeb global appears ONLY in the Tron adapter allowlist (Step 2.4)", () => {
  // The bare injected tronWeb global is banned everywhere except the Tron
  // adapter factory module that documents the ban (the adapters package
  // owns the injected globals internally; our code never reads them).
  const offenders = findBannedWindowAccess(SRC_ROOT, {
    patterns: [TRONWEB_PATTERN],
    allowlist: TRON_ADAPTER_ALLOWLIST,
  });
  assert.deepEqual(offenders, [], "the bare tronWeb global outside the adapter module is a bug");

  // And the allowlist is not dead: WITHOUT it, exactly that file is
  // flagged for the tronWeb pattern.
  const raw = findBannedWindowAccess(SRC_ROOT, { patterns: [TRONWEB_PATTERN], allowlist: new Set() });
  assert.deepEqual(
    raw.sort(),
    [...TRON_ADAPTER_ALLOWLIST].sort(),
    "the Tron allowlist must cover exactly the file that documents the ban",
  );
});
