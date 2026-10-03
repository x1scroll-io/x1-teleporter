/**
 * gate.test.js — THORChain UI is FLAG-GATED (Step 3.1 verification).
 *
 * The runbook is explicit: "Everything renders only when flags.THORCHAIN is
 * true." This grep test enforces that at the source level, the same way
 * noWindowProbe.test.js enforces the injected-global ban:
 *
 *   - BridgeCard (the mount point) must consult the THORCHAIN flag and mount
 *     THORChainTab only inside a conditional that tests it — an unconditional
 *     `<THORChainTab />` mount can never sneak in.
 *   - Every src/ file that references THORChainTab must consult the flag on
 *     the referencing line (or, for imports, import the flag somewhere in the
 *     file). THORChainTab.jsx itself is the definition — exempt.
 *   - THORChain lane internals (pollStatus / landingDetection / storage /
 *     autoAdvance / statusEndpoint) may only be imported from inside the lane
 *     (src/lib/thorchain/) or the two THORChain components.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const COMPONENTS_DIR = fileURLToPath(new URL("../../components/", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../../", import.meta.url));

const read = (p) => readFileSync(p, "utf8");
const grepFiles = (pattern) =>
  execSync(
    `grep -rlE ${JSON.stringify(pattern)} ${SRC_DIR} --include="*.js" --include="*.jsx" --include="*.ts"`,
  )
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);

test("BridgeCard mounts THORChainTab ONLY behind the THORCHAIN flag", () => {
  const src = read(`${COMPONENTS_DIR}BridgeCard.jsx`);

  // The flag is imported from flags.ts…
  assert.match(src, /THORCHAIN/, "BridgeCard consults the THORCHAIN flag");
  assert.match(
    src,
    /import \{[^}]*THORCHAIN[^}]*\} from ["'][^"']*flags\.ts["']/,
    "flag imported from flags.ts",
  );

  // …and the mount is conditional: every line mounting THORChainTab also
  // tests the flag (or its flag-derived local) on the same line.
  const mountLines = src.split("\n").filter((l) => l.includes("<THORChainTab"));
  assert.ok(mountLines.length >= 1, "THORChainTab is mounted somewhere");
  for (const line of mountLines) {
    assert.match(
      line,
      /THORCHAIN|thorchainEnabled/,
      `unconditional THORChainTab mount found: "${line.trim()}" — the THORChain lane must render only when flags.THORCHAIN is true`,
    );
  }
});

test("no src/ file references THORChainTab without the flag gate (definition + tests exempt)", () => {
  const files = grepFiles("THORChainTab").filter(
    (f) => !f.endsWith("THORChainTab.jsx") && !/\.test\.(js|jsx|ts)$/.test(f),
  );
  for (const file of files) {
    const src = read(file);
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.includes("THORChainTab")) continue;
      if (/^\s*import\s/.test(line)) {
        // An import line is fine as long as the FILE consults the flag
        // somewhere (the gate lives in the same file as the mount).
        assert.match(
          src,
          /THORCHAIN/,
          `${file}: imports THORChainTab but never consults the THORCHAIN flag`,
        );
        continue;
      }
      assert.match(
        line,
        /THORCHAIN|thorchainEnabled/,
        `${file}:${i + 1}: THORChainTab referenced without the flag on the line — "${line.trim()}"`,
      );
    }
  }
});

test("THORChain lane internals stay contained (no stray imports outside the lane)", () => {
  const internals = "thorchain/(pollStatus|landingDetection|storage|autoAdvance|statusEndpoint)";
  const files = grepFiles(internals);
  const allowed = (f) =>
    f.includes("src/lib/thorchain/") || // the lane's own modules + tests
    f.endsWith("components/THORChainTab.jsx") ||
    f.endsWith("components/THORChainProgress.jsx");

  for (const f of files) {
    assert.ok(allowed(f), `THORChain lane internals imported outside the lane: ${f}`);
  }
});
