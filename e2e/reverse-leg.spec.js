/**
 * reverse-leg.spec.js — the REVERSE browser-verification harness (Phase 2).
 *
 * BASELINE, NOT A FEATURE TEST: it drives the CURRENT reference reverse leg
 * (X1 → ETH) of the ARMED LOCAL engine build and asserts exactly what the
 * engine migration must preserve:
 *   1. the reverse quote renders with the CORRECT fee lines (the real fee
 *      code's display values for the fixture input — stored in
 *      reverse-leg-summary.json),
 *   2. the To-address destination line (#44) displays the CONNECTED EVM
 *      wallet — the address the LiFi leg delivers to (a wrong EVM address is
 *      IRREVERSIBLE),
 *   3. the flow ADVANCES to the sign step (the fake X1 wallet is asked to
 *      sign the EXACT golden burn tx — byte-for-byte vs step1-x1-burn.json)
 *      and STOPS AT THE SIGNATURE — never auto-signs, never sends,
 *   4. declining the signature surfaces the honest rejection and nothing
 *      was broadcast,
 *   5. the build banner reads the real compiled WARP_LIVE_SEND flag: this
 *      harness runs against the ARMED local build (VERCEL_GIT_COMMIT_REF=v2
 *      at build time — the reverse burn's sign step is gated by it), so the
 *      banner must say "live sends ON".
 *
 * WHAT IS MOCKED vs ASSERTED (documented, per the task):
 *   - Wallets:        mocked at the provider layer. EVM = the EIP-6963 fake
 *                     (e2e/helpers/fakeEthereum.js). Solana/X1 = a Wallet
 *                     Standard fake (e2e/helpers/fakeSolana.js — CANNOT sign:
 *                     solana:signTransaction records then hangs/declines).
 *   - Network:        /api/lifi/quote is intercepted and fulfilled with the
 *                     FROZEN golden quote (the same quote the golden reverse
 *                     fixtures were captured from) — deterministic offline.
 *                     The X1 RPC (rpc.mainnet.x1.xyz) is intercepted with a
 *                     JSON-RPC fake: fixed blockhash + fixed slot + funded
 *                     accounts + passing simulations — so the burn tx the
 *                     wallet is asked to sign is BYTE-IDENTICAL to the golden
 *                     fixture. No live LI.Fi, no live X1 chain.
 *   - Asserted real:  the actual UI flow (connect modal → connected body →
 *                     form → X1→ETH quote → Bridge), the fee lines, the
 *                     To-address line, buttons, phase advancement, the build
 *                     banner, and the exact payload the wallet was asked to
 *                     sign. NOTHING is signed or broadcast (the fake wallets
 *                     have no path that returns a signature).
 *
 * The engine passes Phase 2 iff this spec still passes UNCHANGED against a
 * build whose reverse leg is the engine.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(here, p), "utf8"));

// ── Frozen fixtures (single source of truth with the golden oracle) ──
const QUOTE = read("../test/fixtures/golden/reverse-leg/quote-wsol-usdc-eth-0.39501.json");
const SUMMARY = read("../test/fixtures/golden/reverse-leg/reverse-leg-summary.json");
const GOLDEN_STEP1 = read("../test/fixtures/golden/reverse-leg/step1-x1-burn.json");

// The deterministic golden-fixture wallet set (repo test constants).
const SOL_ADDRESS = "wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV"; // the fake sol wallet (== golden USER)
const FEE_WALLET = "TiPy76viRMRTcKsZMfNp9enh2cCfaUXg3LPdjtpmBDu"; // FEE_WALLETS.X1
const EVM_ADDRESS = "0x4634e8e0b1c2d3f4a5b6c7d8e9f0a1b2c3d4e5f6"; // the fake EVM wallet (fakeEthereum)
const FIXED_BLOCKHASH = "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx"; // the golden pin
const FIXED_SEQ_SLOT = 305_000_000; // the golden pin

// The mock X1 accounts (the deterministic Token-2022 ATAs for the golden
// wallet set — derived offline, embedded so the spec needs no solana deps).
const USER_ATA = "6vEo1dujk1XDoRUzT5QthuvuWv1mgPmoATZDZ8r29CHU"; // ATA(wSOL.X, USER)
const FEE_ATA = "8YxSUo3EjM14C3UnRw7kJqTcNwHnAtvW15vP9nCqCCmw"; // ATA(wSOL.X, FEE_WALLET) — the LIVE burn's skim destination

// ── Target-aware banner expectation: this harness ALWAYS runs the ARMED
//    local build (run-reverse-harness.mjs builds with VERCEL_GIT_COMMIT_REF=v2),
//    so the banner must read ON. ──
const EXPECTED_LIVE_PHRASE = process.env.EXPECTED_LIVE_PHRASE || "live sends ON";
const EXPECTED_FLAG = EXPECTED_LIVE_PHRASE === "live sends ON" ? "WARP_LIVE_SEND=true" : "WARP_LIVE_SEND=false";

const SHOTS = join(here, "screenshots", process.env.SCREENSHOT_SUBDIR || "local-reverse");

/** Fulfill the X1 JSON-RPC with the deterministic fake (fixed blockhash +
 *  fixed slot + funded accounts + passing simulations). */
async function x1RpcHandler(route) {
  const body = route.request().postDataJSON() || {};
  const method = body.method;
  const params = body.params || [];
  const ok = (result) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result }),
    });
  const context = { slot: FIXED_SEQ_SLOT };
  switch (method) {
    case "getLatestBlockhash":
      return ok({ context, value: { blockhash: FIXED_BLOCKHASH, lastValidBlockHeight: 99 } });
    case "getSlot":
      return ok(FIXED_SEQ_SLOT);
    case "getAccountInfo": {
      const pk = String(params[0] || "");
      const exists = pk === SOL_ADDRESS || pk === USER_ATA || pk === FEE_ATA;
      return ok({
        context,
        value: exists
          ? { lamports: 5_000_000, owner: "11111111111111111111111111111111", executable: false, rentEpoch: 0, data: ["", "base64"] }
          : null,
      });
    }
    case "getTokenAccountBalance": {
      const pk = String(params[0] || "");
      if (pk === USER_ATA) {
        return ok({ context, value: { amount: "1000000000", decimals: 9, uiAmount: 1 } });
      }
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32602, message: "mock: unexpected token account" } }),
      });
    }
    case "simulateTransaction":
      return ok({
        context,
        value: { err: null, logs: ["Program log: Instruction: BridgeOut"], unitsConsumed: 12345, accounts: [] },
      });
    case "getTokenAccountsByOwner":
      return ok({ context, value: [] }); // the balance line reads nothing
    case "sendRawTransaction":
      return ok("mock-x1-sig"); // never reached — the fake wallet never signs
    case "confirmTransaction":
      return ok({ context, value: { err: null } });
    default:
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: null }),
      });
  }
}

test.beforeEach(async ({ page }) => {
  // The fake wallets must exist before ANY app script runs (EVM first — it
  // creates the shared harness; Solana extends it).
  await page.addInitScript({ path: join(here, "helpers", "fakeEthereum.js") });
  await page.addInitScript({ path: join(here, "helpers", "fakeSolana.js") });
  // Freeze the LiFi network: the quote comes from the golden fixture.
  await page.route("**/api/lifi/quote?*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(QUOTE) }),
  );
  // Freeze the X1 chain: deterministic JSON-RPC (fixed blockhash/slot, funded
  // accounts, passing sims) — the burn the wallet signs is byte-identical to
  // the golden fixture.
  await page.route(/rpc\.mainnet\.x1\.xyz/, x1RpcHandler);
});

/** Collect console messages (the build banner + any page noise). */
function attachConsole(page, log) {
  page.on("console", (msg) => {
    log.push({ type: msg.type(), text: msg.text() });
  });
}

/** The full connect journey: EVM (fake injected wallet) + Solana (fake
 *  Wallet Standard wallet). */
async function connectWallets(page) {
  // Step 1 — the Teleport tab's connect modal (family list).
  await expect(page.locator('[data-testid="connect-modal"]')).toBeVisible();
  // EVM family → the announced Playwright Test Wallet (installed row).
  await page.locator('button[data-family="evm"]').click();
  const evmRow = page.locator('li[data-wallet-id="com.playwright.testwallet"]');
  await expect(evmRow).toBeVisible();
  await evmRow.locator("button.connect-btn").click();
  // Any connected session switches the tab to the connected body.
  await expect(page.locator('[data-testid="teleport-connected"]')).toBeVisible();
  await expect(page.locator('.connected-wallet[data-family="evm"] code')).toHaveText(new RegExp(`^${EVM_ADDRESS}$`, "i"));

  // Connect another → Solana family → the fake Wallet Standard wallet row.
  await page.locator('[data-testid="connect-another"]').click();
  await expect(page.locator('[data-testid="connect-modal"]')).toBeVisible();
  await page.locator('button[data-family="solana"]').click();
  const solRow = page.locator('li[data-wallet-id="Playwright Test Solana"]');
  await expect(solRow).toBeVisible();
  await solRow.locator("button.connect-btn").click();

  // Both sessions connected → the bridge form renders.
  await expect(page.locator('[data-testid="teleport-form"]')).toBeVisible();
  await expect(page.locator('.connected-wallet[data-family="solana"] code')).toHaveText(SOL_ADDRESS);
}

/** Switch to X1→ETH, fill the fixture amount (0.4 wSOL.X) and land the quote. */
async function getReverseQuote(page) {
  await page.locator('[data-testid="dir-reverse"]').click();
  await expect(page.locator('[data-testid="from-chain"]')).toHaveValue("x1");
  await expect(page.locator('[data-testid="to-chain"]')).toHaveValue("eth");
  // Burn 0.4 wSOL.X (the golden sample) — the reverse token select.
  await page.locator('[data-testid="token"]').selectOption("wSOL.X");
  await expect(page.locator('[data-testid="token"]')).toHaveValue("wSOL.X");
  await page.locator('[data-testid="amount"]').fill("0.4");
  await page.locator('[data-testid="get-quote"]').click();
  await expect(page.locator('[data-testid="quote-box"]')).toBeVisible();
}

test("reverse baseline: banner reads the armed WARP_LIVE_SEND flag + the X1→ETH quote renders correct fees, To-address (EVM destination), buttons", async ({ page }) => {
  const log = [];
  attachConsole(page, log);

  await page.goto("/");
  await connectWallets(page);

  // ── The armed-build banner (this harness runs the ARMED local bundle). ──
  await expect
    .poll(() => log.find((m) => m.text.includes("[Teleporter] BUILD"))?.text, { timeout: 15_000 })
    .toContain(EXPECTED_LIVE_PHRASE);
  const banner = log.find((m) => m.text.includes("[Teleporter] BUILD"))?.text;
  expect(banner).toContain("[Teleporter] BUILD");
  expect(banner).toContain(EXPECTED_FLAG, `banner should read ${EXPECTED_FLAG}, got: ${banner}`);

  // ── Quote box: exact fee lines for 0.4 wSOL.X X1→ETH (fixture amount) ──
  await getReverseQuote(page);
  await page.screenshot({ path: join(SHOTS, "1-reverse-quote.png"), fullPage: true });

  const qb = SUMMARY.quoteBox;
  // You send
  await expect(page.locator(".quote-box")).toContainText(qb.youSend);
  // Fee lines — labels + the REAL display values the fee code produces for
  // the wSOL.X sample (captured in the summary by the real code).
  const skim = page.locator('[data-testid="fee-line-warp-skim"]');
  await expect(skim).toContainText("Teleporter fee (1%)");
  await expect(skim).toContainText(qb.feeLines[0].display);
  const pct = page.locator('[data-testid="fee-line-warp-pct"]');
  await expect(pct).toContainText("Warp bridge fee (0.25%)");
  await expect(pct).toContainText(qb.feeLines[1].display);
  // You receive (the LiFi net — the golden summary's real-code string)
  await expect(page.locator('[data-testid="you-receive"]')).toHaveText(qb.youReceive);
  // Steps chips (Warp Bridge X1 + Solana, LiFi Ethereum)
  for (const step of qb.steps) {
    await expect(page.locator(".quote-box")).toContainText(step);
  }
  // ── To-address destination line (#44): the CONNECTED EVM wallet — the
  //    address the LiFi leg delivers to (same value that flows into the
  //    stage-2 toAddress). Full address in the title, truncated in the row. ──
  const dest = page.locator('[data-testid="dest-address"]');
  await expect(dest).toBeVisible();
  // wagmi/viem checksum the connected account — compare case-insensitively.
  await expect(dest.locator("span[title]")).toHaveAttribute("title", new RegExp(`^${EVM_ADDRESS}$`, "i"));
  await expect(dest).toContainText("(Ethereum)");
  // Buttons present + enabled
  const bridgeBtn = page.locator('[data-testid="bridge-now"]');
  await expect(bridgeBtn).toBeVisible();
  await expect(bridgeBtn).toBeEnabled();
  await expect(bridgeBtn).toHaveText("Bridge — Step 1 of 2");
  await page.screenshot({ path: join(SHOTS, "2-reverse-fees-dest.png"), fullPage: true });
});

test("reverse baseline: the X1→ETH flow advances to the SIGN step and STOPS at the wallet signature — the wallet is asked to sign the EXACT golden burn tx (byte-for-byte)", async ({ page }) => {
  await page.goto("/");
  await connectWallets(page);
  await getReverseQuote(page);

  // Arm the fake Solana/X1 wallet to HANG at the signature = the wallet
  // prompt is open (the "ready to sign" state). solana:signTransaction
  // records, never resolves.
  await page.evaluate(() => window.__x1TeleporterHarness.setMode("hang"));

  await page.locator('[data-testid="bridge-now"]').click();

  // The flow advanced INTO the bridge (the X1 burn leg: preflights → build →
  // sim → guarded send): the UI shows the bridging state while the wallet
  // prompt is open.
  await expect(page.locator('[data-testid="bridging"]')).toBeVisible();
  await expect(page.locator('[data-testid="bridging"]')).toContainText("Bridging…");

  // The X1 wallet was asked to sign EXACTLY ONE thing: the golden reverse
  // burn tx — byte-for-byte vs step1-x1-burn.json (the oracle fixture: same
  // wallet, same fee wallet, same amounts, same fixed blockhash + seq).
  await expect
    .poll(() => page.evaluate(() => window.__x1TeleporterHarness.solSigningRequests.length), { timeout: 20_000 })
    .toBe(1);
  const req = await page.evaluate(() => window.__x1TeleporterHarness.solSigningRequests[0].serializedBase64);
  expect(req).toBe(GOLDEN_STEP1.artifact.serializedBase64);

  // And the request was NOT resolved: the harness is still at the prompt.
  const stillHanging = await page.evaluate(() => window.__x1TeleporterHarness.mode === "hang");
  expect(stillHanging).toBe(true);

  // Nothing was sent: exactly one sign request (the burn), and the EVM
  // wallet was NEVER asked to sign anything (the reverse leg signs on X1).
  const solSends = await page.evaluate(() => window.__x1TeleporterHarness.solSigningRequests.length);
  expect(solSends).toBe(1);
  const evmSends = await page.evaluate(() => window.__x1TeleporterHarness.signingRequests.length);
  expect(evmSends).toBe(0);

  // Screenshot the sign-ready state (wallet prompt open — nothing sent).
  await page.screenshot({ path: join(SHOTS, "3-reverse-sign-ready.png"), fullPage: true });
});

test("reverse baseline: declining the signature surfaces the honest rejection and sends nothing", async ({ page }) => {
  await page.goto("/");
  await connectWallets(page);
  await getReverseQuote(page);

  // Default mode is "reject" (4001) — belt and braces: set it explicitly.
  await page.evaluate(() => window.__x1TeleporterHarness.setMode("reject"));

  await page.locator('[data-testid="bridge-now"]').click();

  // The wallet declined → the UI must surface the honest rejection (the
  // reverse stage-1 catch wraps the signer error as "Warp error: …")...
  await expect(page.locator('[data-testid="form-error"]')).toBeVisible();
  await expect(page.locator('[data-testid="form-error"]')).toContainText("Warp error");
  // ...and return to the quoted state (Bridge — Step 1 of 2 re-enabled — the
  // user can retry; nothing was broadcast).
  await expect(page.locator('[data-testid="bridge-now"]')).toBeEnabled();

  // Exactly ONE signing request (the burn) was attempted and declined; the
  // EVM wallet was never asked to sign.
  const solSends = await page.evaluate(() => window.__x1TeleporterHarness.solSigningRequests.length);
  expect(solSends).toBe(1);
  const evmSends = await page.evaluate(() => window.__x1TeleporterHarness.signingRequests.length);
  expect(evmSends).toBe(0);

  await page.screenshot({ path: join(SHOTS, "4-reverse-sign-declined.png"), fullPage: true });
});
