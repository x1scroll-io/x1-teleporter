/**
 * App-wiring regression test (Bitcoin connect fix) — static scan of
 * src/main.jsx.
 *
 * The Step 2.3 preview bug: main.jsx built the discovery handle with
 * `createWalletDiscovery()` and NO options, so the bitcoin discovery never
 * received the LaserEyes handle. Detection worked (Unisat/Xverse/… all
 * rendered with Installed badges) but every LaserEyes-covered wallet's
 * connect() threw "…the LaserEyes handle is not wired" — the red banner in
 * the connect modal. The provider adapters were always correct
 * (bitcoinDiscovery.js); the missing piece was the app-level injection
 * (bitcoinLaserEyes + bitcoinBalanceFetcher).
 *
 * This test pins the wiring at the source so the gap cannot silently
 * return. It is deliberately STATIC (reads main.jsx text, never imports
 * it): main.jsx calls ReactDOM.createRoot().render() at module scope, and
 * @omnisat/lasereyes is browser-only — node:test never loads it.
 *
 * Pre-fix this test FAILS (main.jsx passes no options); post-fix it PASSES.
 * Behavioral coverage of the same path lives in walletDiscovery.test.js
 * (composition level) and ConnectModal.test.jsx (DOM level).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Absolute path of src/main.jsx (this file lives at src/lib/wallet/). */
const MAIN_SOURCE = readFileSync(
  fileURLToPath(new URL("../../main.jsx", import.meta.url)),
  "utf8",
);

test("main.jsx imports the Bitcoin LaserEyes handle + balance fetcher", () => {
  assert.match(
    MAIN_SOURCE,
    /import\s*\{[^}]*createLaserEyesHandle[^}]*\}\s*from\s*["']\.\/lib\/wallet\/laserEyesHandle\.js["']/,
    "main.jsx must import createLaserEyesHandle from laserEyesHandle.js",
  );
  assert.match(
    MAIN_SOURCE,
    /import\s*\{[^}]*createBtcBalanceFetcher[^}]*\}\s*from\s*["']\.\/lib\/wallet\/bitcoinBalance\.js["']/,
    "main.jsx must import createBtcBalanceFetcher from bitcoinBalance.js",
  );
});

test("main.jsx wires bitcoinLaserEyes + bitcoinBalanceFetcher into createWalletDiscovery (fails pre-fix / passes post-fix)", () => {
  assert.match(
    MAIN_SOURCE,
    /createWalletDiscovery\(\s*\{[\s\S]*?bitcoinLaserEyes:\s*createLaserEyesHandle\(\)[\s\S]*?bitcoinBalanceFetcher:\s*createBtcBalanceFetcher\(\)[\s\S]*?\}\)/,
    "createWalletDiscovery must be called with bitcoinLaserEyes: createLaserEyesHandle() and bitcoinBalanceFetcher: createBtcBalanceFetcher() — without them every LaserEyes-covered Bitcoin wallet's connect fails with the 'LaserEyes handle is not wired' banner",
  );
});
