/**
 * thorchain-leg.spec.js — the THORChain browser-verification harness
 * (Phase 3 — the deposit-address lane's baseline the engine migration is
 * verified against).
 *
 * WHAT THIS LANE'S "SIGN STEP" IS (honest framing): the THORChain
 * deposit-address flow (v1) NEVER signs or broadcasts in-app — the user
 * sends native BTC/DOGE/LTC/XRP from their OWN external wallet to the
 * THORChain vault, attaching the memo, then pastes the inbound txid back.
 * The app-side terminal step the harness drives to is therefore the
 * DEPOSIT-ADDRESS SCREEN (the copy-the-address-and-memo state that precedes
 * the external send): the harness asserts the quote summary, the three
 * pre-send fee lines, and the EXACT deposit payload (vault address + memo,
 * byte-for-byte vs the golden fixtures) — then STOPS. It never pastes a
 * txid, never clicks "I've sent it", and asserts the fake Solana wallet was
 * NEVER asked to sign (no auto-sign exists: zero signing requests recorded).
 *
 * THE ARMED BUILD: the THORChain tab renders ONLY when flags.THORCHAIN is
 * true (VITE_FLAG_THORCHAIN at build time — e2e/run-thorchain-harness.mjs
 * builds with it). Sends are still impossible: the deposit-address lane has
 * no send path by construction, the fake wallets never sign, and every
 * network the deposit stage touches is intercepted (see below).
 *
 * WHAT IS MOCKED vs ASSERTED (documented, per the task):
 *   - Wallets:     the Solana session = the fake Wallet Standard wallet
 *                  (e2e/helpers/fakeSolana.js — deterministic address
 *                  wJs2CD1p… == the golden fixture's USER; records any
 *                  signing request, never signs). EVM not needed for the
 *                  deposit stage.
 *   - Network:     /thorchain/inbound_addresses (the vault refresh — the
 *                  real host is liquify.thorchain.org) and /api/thorchain/
 *                  quote (our same-origin proxy) are INTERCEPTED and
 *                  fulfilled with the FROZEN (synthetic — the lane is not
 *                  live yet) fixtures — deterministic offline AND on the
 *                  deployed URL. No live THORNode calls.
 *   - Asserted real: the actual UI flow (connect modal → connected → the
 *                  THORChain tab → amount → quote gate → deposit card), the
 *                  quote summary (0.4975 SOL out, 50 bps slippage), the
 *                  three fee lines (affiliate 1.00% / Teleporter 0.50% /
 *                  Warp $1 flat — the summary's display strings), and the
 *                  deposit payload byte-for-byte vs the golden fixtures.
 *                  NOTHING is signed, submitted or broadcast.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(here, p), "utf8"));

// ── Frozen fixtures (single source of truth with the golden oracle) ──
const SUMMARY = read("../test/fixtures/golden/thorchain-leg/thorchain-leg-summary.json");
const QUOTE_BODY = read("../test/fixtures/golden/thorchain-leg/quote-body-btc-sol.json").body;
const INBOUND_BODY = read("../test/fixtures/golden/thorchain-leg/inbound-addresses-body.json").body;

// The fake Solana wallet's deterministic address (== the golden USER).
const SOL_ADDRESS = "wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV";

// The golden deposit payload the deposit card must show byte-for-byte.
const GOLDEN_MEMO = SUMMARY.derived.memo; // =:SOL.SOL:wJs2CD1p…
const GOLDEN_ADDRESS = SUMMARY.derived.depositAddress; // the synthetic BTC vault
const GOLDEN_FEE_LINES = SUMMARY.derived.feeLines; // affiliate 1.00% / Teleporter 0.50% / Warp $1 flat

const SHOTS = join(here, "screenshots", process.env.SCREENSHOT_SUBDIR || "local-thorchain");

test.beforeEach(async ({ page }) => {
  // The fake wallets must exist before ANY app script runs (EVM first — it
  // creates the shared harness; Solana extends it).
  await page.addInitScript({ path: join(here, "helpers", "fakeEthereum.js") });
  await page.addInitScript({ path: join(here, "helpers", "fakeSolana.js") });
  // Freeze the THORChain network: the vault-address refresh (real host:
  // liquify.thorchain.org — intercepted) + our same-origin quote proxy are
  // fulfilled with the frozen fixtures. No live THORNode calls.
  await page.route("**/thorchain/inbound_addresses*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(INBOUND_BODY) }),
  );
  await page.route("**/api/thorchain/quote*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(QUOTE_BODY) }),
  );
});

/** Connect the fake Solana wallet via the Teleport tab's connect modal. */
async function connectSolana(page) {
  await expect(page.locator('[data-testid="connect-modal"]')).toBeVisible();
  await page.locator('button[data-family="solana"]').click();
  const solRow = page.locator('li[data-wallet-id="Playwright Test Solana"]');
  await expect(solRow).toBeVisible();
  await solRow.locator("button.connect-btn").click();
  // The session is connected — the connected body shows the fake address.
  await expect(page.locator('.connected-wallet[data-family="solana"] code')).toHaveText(SOL_ADDRESS);
}

test("thorchain leg: the deposit stage drives to the deposit-address step — quote gate, three fee lines, vault + memo byte-identical to the golden fixtures — and STOPS (nothing signed, nothing submitted)", async ({ page }) => {
  // 1. The Teleport tab is the wallet-connect host — connect the Solana
  //    session the deposit stage pins its destination to.
  await page.goto("/");
  await connectSolana(page);

  // 2. Open the THORChain tab (mounted because this harness build arms
  //    VITE_FLAG_THORCHAIN=true — the placeholder would betray a disarmed build).
  await page.locator('[data-tab="thorchain"]').click();
  await expect(page.locator('[data-testid="tc-deposit"]')).toBeVisible();

  // 3. The deposit stage: BTC source default, destination locked to the
  //    connected Solana session (never user-typed).
  await expect(page.locator('[data-testid="tc-source-BTC"]')).toHaveAttribute("data-active", "true");
  await expect(page.locator('[data-testid="tc-destination-input"]')).toHaveValue(SOL_ADDRESS);
  // readOnly + tabIndex -1 (the destination is the session pubkey — never editable)
  await expect(page.locator('[data-testid="tc-destination-input"]')).toHaveAttribute("readonly", "");

  // 4. Amount + the QUOTE GATE: the deposit address appears ONLY after a
  //    fresh quote lands. Until then no deposit card.
  await expect(page.locator('[data-testid="tc-deposit-card"]')).toHaveCount(0);
  await page.locator('[data-testid="tc-amount-input"]').fill("0.01");
  await page.locator('[data-testid="tc-get-quote"]').click();
  await expect(page.locator('[data-testid="tc-quote-summary"]')).toBeVisible();

  // 5. The quote summary: expected SOL out + slippage from the frozen body.
  await expect(page.locator('[data-testid="tc-quote-summary"]')).toContainText("0.4975 SOL");
  await expect(page.locator('[data-testid="tc-quote-summary"]')).toContainText("50 bps");

  // 6. The THREE pre-send fee lines — display strings computed by the REAL
  //    fee code and captured in the summary (the harness asserts them).
  const feeIds = ["thorchain-affiliate", "warp-skim", "warp-flat"];
  for (let i = 0; i < feeIds.length; i++) {
    const line = page.locator(`[data-testid="tc-fee-line"][data-fee-id="${feeIds[i]}"]`);
    await expect(line).toBeVisible();
    await expect(line).toContainText(GOLDEN_FEE_LINES[i].display); // 1.00% / 1.00% / $1 flat
  }

  // 7. THE DEPOSIT PAYLOAD — byte-for-byte vs the golden fixtures: the BTC
  //    vault address selected from the frozen inbound snapshot + the deposit
  //    memo `=:SOL.SOL:<solanaDest>` (destination = the connected session).
  await expect(page.locator('[data-testid="tc-deposit-card"]')).toBeVisible();
  await expect(page.locator('[data-testid="tc-deposit-address"]')).toHaveText(GOLDEN_ADDRESS);
  await expect(page.locator('[data-testid="tc-memo"]')).toHaveText(GOLDEN_MEMO);
  await expect(page.locator('[data-testid="tc-copy-address"]')).toBeVisible();
  await expect(page.locator('[data-testid="tc-copy-memo"]')).toBeVisible();

  // 8. STOP AT THE DEPOSIT-ADDRESS STEP — the deposit-address lane's sign
  //    boundary: the send happens OUT-OF-BAND in the user's external wallet.
  //    Never paste a txid, never submit — and prove no in-app signing was
  //    ever requested (the fake Solana wallet records every request).
  await expect(page.locator('[data-testid="tc-submit"]')).toBeDisabled();
  const signingRequests = await page.evaluate(
    () => (window.__x1TeleporterHarness?.solSigningRequests || []).length,
  );
  expect(signingRequests).toBe(0);

  // 9. State screenshot for the record.
  await page.screenshot({ path: join(SHOTS, "1-thorchain-deposit-ready.png"), fullPage: true });
});
