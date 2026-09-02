/**
 * forward-leg.spec.js — the lean browser-verification harness (Tool 2).
 *
 * BASELINE, NOT A FEATURE TEST: it drives the CURRENT reference forward leg
 * (ETH → X1) of the STABLE v2 build and asserts exactly what a routing
 * engine must preserve when it takes over the leg:
 *   1. the quote renders with the CORRECT fee lines (Teleporter 1% + Warp $1
 *      flat — exact amounts for the fixture input, computed by the real fee
 *      code and stored in forward-leg-summary.json),
 *   2. the To-address destination line displays the connected session,
 *   3. the flow ADVANCES to the sign step (the wallet is asked to sign the
 *      EXACT golden approval — byte-for-byte vs step1-approval.json) and
 *      STOPS AT THE SIGNATURE — never auto-signs, never sends,
 *   4. declining the signature surfaces the honest rejection and nothing
 *      was broadcast,
 *   5. the build banner reads the real compiled WARP_LIVE_SEND flag (#45):
 *      "live sends ON" on the deployed v2 alias, "live sends OFF" on the
 *      disarmed local build.
 *
 * WHAT IS MOCKED vs ASSERTED (documented, per the task):
 *   - Wallets:        mocked at the provider/session layer. EVM = an
 *                     EIP-6963-announcing fake EIP-1193 provider injected
 *                     pre-load (e2e/helpers/fakeEthereum.js — CANNOT sign:
 *                     eth_sendTransaction records then hangs/declines).
 *                     Solana = the app's OWN dev mock fallback (Starport
 *                     row → createMockProvider — no signing surface).
 *   - Network:        /api/lifi/quote + /api/lifi/tools are intercepted and
 *                     fulfilled with the FROZEN fixtures (the same quote the
 *                     golden fixtures were captured from) — deterministic
 *                     offline AND on the deployed URL. No live LI.Fi calls.
 *   - Asserted real:  the actual UI flow (connect modal → connected body →
 *                     form → quote → bridge), the fee lines, the To-address
 *                     line, buttons, phase advancement, the console build
 *                     banner, and the exact payload the wallet was asked to
 *                     sign. NOTHING is signed or broadcast (the fake wallet
 *                     has no path that returns a tx hash).
 *
 * The engine passes Phase 1 iff this spec still passes UNCHANGED against a
 * build whose forward leg is the engine.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(here, p), "utf8"));

// ── Frozen fixtures (single source of truth with the golden oracle) ──
const QUOTE = read("../test/fixtures/golden/forward-leg/quote-eth-sol-usdc-25.65.json");
const SUMMARY = read("../test/fixtures/golden/forward-leg/forward-leg-summary.json");
const GOLDEN_STEP1 = read("../test/fixtures/golden/forward-leg/step1-approval.json");
const TOOLS = read("./fixtures/tools-chain-1.json");

// The mock solana session address (WalletContext dev-mock fallback — what the
// Starport row connects when no real Solana wallet is installed).
const MOCK_SOL_ADDRESS = "mock:solana:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const EVM_ADDRESS = "0x4634e8e0b1c2d3f4a5b6c7d8e9f0a1b2c3d4e5f6";

// ── Target-aware banner expectation (#45): vite.config.js arms live sends
//    ONLY for Vercel builds of the v2 branch. Local builds are disarmed. ──
const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:4173";
const DEPLOYED = baseURL.includes("vercel.app");
const EXPECTED_LIVE_PHRASE = process.env.EXPECTED_LIVE_PHRASE || (DEPLOYED ? "live sends ON" : "live sends OFF");
const EXPECTED_FLAG = EXPECTED_LIVE_PHRASE === "live sends ON" ? "WARP_LIVE_SEND=true" : "WARP_LIVE_SEND=false";

const SHOTS = join(here, "screenshots", process.env.SCREENSHOT_SUBDIR || "local");

test.beforeEach(async ({ page }) => {
  // The fake EVM wallet must exist before ANY app script runs.
  await page.addInitScript({ path: join(here, "helpers", "fakeEthereum.js") });
  // Freeze the LiFi network: quote + tools come from the fixtures.
  await page.route("**/api/lifi/quote?*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(QUOTE) }),
  );
  await page.route("**/api/lifi/tools?*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(TOOLS) }),
  );
});

/** Collect console messages (the build banner + any page noise). */
function attachConsole(page, log) {
  page.on("console", (msg) => {
    log.push({ type: msg.type(), text: msg.text() });
  });
}

/** The full connect journey: EVM (fake injected wallet) + Solana (dev mock). */
async function connectWallets(page) {
  // Step 1 — the Teleport tab's connect modal (family list).
  await expect(page.locator('[data-testid="connect-modal"]')).toBeVisible();
  // EVM family → the announced Playwright Test Wallet (installed row).
  await page.locator('button[data-family="evm"]').click();
  const evmRow = page.locator('li[data-wallet-id="com.playwright.testwallet"]');
  await expect(evmRow).toBeVisible();
  await evmRow.locator("button.connect-btn").click();
  // Any connected session switches the tab to the connected body. (wagmi/
  // viem checksum the account — compare case-insensitively.)
  await expect(page.locator('[data-testid="teleport-connected"]')).toBeVisible();
  await expect(page.locator('.connected-wallet[data-family="evm"] code')).toHaveText(new RegExp(`^${EVM_ADDRESS}$`, "i"));

  // Connect another → Solana family → Starport (pinned) → dev-mock fallback.
  await page.locator('[data-testid="connect-another"]').click();
  await expect(page.locator('[data-testid="connect-modal"]')).toBeVisible();
  await page.locator('button[data-family="solana"]').click();
  const starport = page.locator('li[data-wallet-id="starport"]');
  await expect(starport).toBeVisible();
  await starport.locator("button.connect-btn").click();

  // Both sessions connected → the bridge form renders.
  await expect(page.locator('[data-testid="teleport-form"]')).toBeVisible();
  await expect(page.locator('.connected-wallet[data-family="solana"] code')).toHaveText(MOCK_SOL_ADDRESS);
}

/** Fill the form with the fixture amount and land the quote. */
async function getForwardQuote(page) {
  await expect(page.locator('[data-testid="from-chain"]')).toHaveValue("eth");
  await expect(page.locator('[data-testid="token"]')).toHaveValue("USDC");
  await page.locator('[data-testid="amount"]').fill("25.65");
  await page.locator('[data-testid="get-quote"]').click();
  await expect(page.locator('[data-testid="quote-box"]')).toBeVisible();
}

test("baseline: banner reads the real WARP_LIVE_SEND flag + forward quote renders correct fees, To-address, buttons", async ({ page }) => {
  const log = [];
  attachConsole(page, log);

  await page.goto("/");
  await connectWallets(page);

  // ── #45 build banner (console) — the deployed v2 alias must say ON. ──
  await expect
    .poll(() => log.find((m) => m.text.includes("[Teleporter] BUILD"))?.text, { timeout: 15_000 })
    .toContain(EXPECTED_LIVE_PHRASE);
  const banner = log.find((m) => m.text.includes("[Teleporter] BUILD"))?.text;
  expect(banner).toContain("[Teleporter] BUILD");
  expect(banner).toContain(EXPECTED_FLAG, `banner should read ${EXPECTED_FLAG}, got: ${banner}`);
  if (DEPLOYED) {
    // The bundle must not contain the lying "hardcoded OFF" build — the #45
    // fix made the banner read the REAL compiled flag.
    expect(banner).not.toContain("live sends OFF");
  }

  // ── Quote box: exact fee lines for 25.65 USDC ETH→X1 (fixture amount) ──
  await getForwardQuote(page);
  await page.screenshot({ path: join(SHOTS, "1-connected-form.png"), fullPage: true });

  const qb = SUMMARY.quoteBox;
  // You send
  await expect(page.locator(".quote-box")).toContainText(qb.youSend);
  // Fee lines — labels + EXACT amounts (Teleporter 1% + Warp $1 flat).
  const skim = page.locator('[data-testid="fee-line-warp-skim"]');
  await expect(skim).toContainText("Teleporter fee (1%)");
  await expect(skim).toContainText(qb.feeLines[0].display); // $0.26
  const flat = page.locator('[data-testid="fee-line-warp-flat"]');
  await expect(flat).toContainText("Warp bridge fee");
  await expect(flat).toContainText(qb.feeLines[1].display); // $1.00
  // You receive (net of both fees — reference math from the golden summary)
  await expect(page.locator('[data-testid="you-receive"]')).toHaveText(qb.youReceive);
  // Steps chips (LiFi Solana + Warp Bridge X1)
  for (const step of qb.steps) {
    await expect(page.locator(".quote-box")).toContainText(step);
  }
  // ── To-address destination line (#44): the connected Solana session —
  //    the X1 recipient the mint lands on (bridge-to-self). Full address in
  //    the title, truncated in the row. ──
  const dest = page.locator('[data-testid="dest-address-forward"]');
  await expect(dest).toBeVisible();
  await expect(dest.locator("span[title]")).toHaveAttribute("title", MOCK_SOL_ADDRESS);
  // Buttons present + enabled
  const bridgeBtn = page.locator('[data-testid="bridge-now"]');
  await expect(bridgeBtn).toBeVisible();
  await expect(bridgeBtn).toBeEnabled();
  await expect(bridgeBtn).toHaveText("Bridge — Step 1 of 2");
  await page.screenshot({ path: join(SHOTS, "2-quote-fees-dest.png"), fullPage: true });
});

test("baseline: forward flow advances to the sign step and STOPS at the wallet signature (nothing signed, nothing sent)", async ({ page }) => {
  await page.goto("/");
  await connectWallets(page);
  await getForwardQuote(page);

  // Arm the fake wallet to HANG at the signature = the wallet prompt is open
  // (the "ready to sign" state). eth_sendTransaction records, never resolves.
  await page.evaluate(() => window.__x1TeleporterHarness.setMode("hang"));

  await page.locator('[data-testid="bridge-now"]').click();

  // The flow advanced INTO the bridge: the sign step for this leg is the
  // stage-1 EVM approval — the UI shows the bridging state with the
  // "1 of 2" approve status while the wallet prompt is open.
  await expect(page.locator('[data-testid="bridging"]')).toBeVisible();
  await expect(page.locator('[data-testid="bridging"]')).toContainText("Bridging…");

  // The wallet was asked to sign EXACTLY ONE thing: the golden approval
  // (byte-for-byte vs step1-approval.json — the oracle fixture).
  await expect
    .poll(() => page.evaluate(() => window.__x1TeleporterHarness.signingRequests.length), { timeout: 20_000 })
    .toBe(1);
  const req = await page.evaluate(() => window.__x1TeleporterHarness.signingRequests[0].params);
  expect(req.from.toLowerCase()).toBe(EVM_ADDRESS);
  expect(req.to.toLowerCase()).toBe(GOLDEN_STEP1.artifact.tokenAddress); // USDC
  expect(req.value).toBe("0x0");
  expect(req.data).toBe(GOLDEN_STEP1.artifact.calldata); // EXACT-amount approve
  // And the request was NOT resolved: the harness is still at the prompt.
  const stillHanging = await page.evaluate(() => window.__x1TeleporterHarness.mode === "hang");
  expect(stillHanging).toBe(true);
  // The payload is the exact-amount approval — never MaxUint256.
  expect(req.data.startsWith("0x095ea7b3")).toBe(true);
  expect(req.data.endsWith("f".repeat(64))).toBe(false);

  // Screenshot the sign-ready state (wallet prompt open — nothing sent).
  await page.screenshot({ path: join(SHOTS, "3-sign-ready.png"), fullPage: true });

  // Nothing was sent: the fake wallet's ONLY send path records + hangs, and
  // there is exactly one request (the approval) — no bridge tx ever asked.
  const sends = await page.evaluate(() => window.__x1TeleporterHarness.signingRequests.length);
  expect(sends).toBe(1);
});

test("baseline: declining the signature surfaces the honest rejection and sends nothing", async ({ page }) => {
  await page.goto("/");
  await connectWallets(page);
  await getForwardQuote(page);

  // Default mode is "reject" (4001) — belt and braces: set it explicitly.
  await page.evaluate(() => window.__x1TeleporterHarness.setMode("reject"));

  await page.locator('[data-testid="bridge-now"]').click();

  // The wallet declined → the UI must surface the honest rejection...
  await expect(page.locator('[data-testid="form-error"]')).toBeVisible();
  await expect(page.locator('[data-testid="form-error"]')).toContainText("Transaction rejected by wallet");
  // ...and return to the quoted state (Bridge — Step 1 of 2 re-enabled —
  // the user can retry; nothing was broadcast).
  await expect(page.locator('[data-testid="bridge-now"]')).toBeEnabled();

  // Exactly ONE signing request (the approval) was attempted and declined.
  const sends = await page.evaluate(() => window.__x1TeleporterHarness.signingRequests.length);
  expect(sends).toBe(1);

  await page.screenshot({ path: join(SHOTS, "4-sign-declined.png"), fullPage: true });
});
