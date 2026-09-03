/**
 * console-leg.spec.js — the Teleport Console browser-verification harness
 * (the console phase's ruler — ADDITIVE, mirrors the frozen forward-leg
 * harness patterns).
 *
 * What it proves (against the REAL console UI — BridgeCard variant="console",
 * mounted on the local console build via VITE_FLAG_CONSOLE_UI=true):
 *   1. the console renders as the app's front door: the hardware housing
 *      (data-testid="teleport-console"), the header readout strip
 *      (TELEPORT CONSOLE / STATUS), the route coordinates (FROM chain →
 *      TO chain), token + amount + MAX, the quote-status strip, and the one
 *      big TELEPORT fire control; the CLASSIC teleport form is NOT mounted.
 *   2. the console drives the REAL engine quote path: /api/lifi/quote is
 *      route-mocked with the SAME frozen fixture the golden oracle captured
 *      from; the quote renders the exact fee lines (Teleporter 0.5% max
 *      $250 + Warp $1 flat — and the PER-ASSET 0.25% line when landing
 *      wSOL.X), the honest net ("you receive"), the To-address line, and
 *      the step chips — same values the frozen summary pins.
 *   3. the forward flow ADVANCES to the sign step and STOPS at the wallet
 *      signature (the wallet is asked to sign the EXACT golden approval —
 *      byte-for-byte vs step1-approval.json) — never auto-signs, never
 *      sends; declining surfaces the honest rejection.
 *   4. RESPONSIVE: the wide landscape console reflows to a VERTICAL stack on
 *      a phone portrait viewport, and mobile renders the astronaut POSTER
 *      still instead of the ambient video (design doc). Screenshots of each
 *      state on both viewports.
 *
 * WHAT IS MOCKED vs ASSERTED (same contract as forward-leg):
 *   - Wallets:  EVM = the EIP-6963 fake (fakeEthereum.js — CANNOT sign);
 *               Solana = the app's OWN dev-mock fallback (Starport row).
 *   - Network:  /api/lifi/quote + /api/lifi/tools = the frozen fixtures;
 *               the Solana/X1 balance RPCs = deterministic 503s (fail-soft
 *               balance reads — the console shows "BAL —").
 *   - Asserted real: the console UI, the connect journey through the real
 *     ConnectModal, the auto-quote over the mocked-but-real query path, the
 *     fee lines, the To-address line, the phase advancement, and the exact
 *     payload the wallet was asked to sign. NOTHING is signed or broadcast.
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

const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:4176";
const DEPLOYED = baseURL.includes("vercel.app");
const EXPECTED_LIVE_PHRASE = process.env.EXPECTED_LIVE_PHRASE || (DEPLOYED ? "live sends ON" : "live sends OFF");
const EXPECTED_FLAG = EXPECTED_LIVE_PHRASE === "live sends ON" ? "WARP_LIVE_SEND=true" : "WARP_LIVE_SEND=false";

const SHOTS = join(here, "screenshots", process.env.SCREENSHOT_SUBDIR || "console-local");

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
  // Freeze the balance RPCs (Solana + X1 ladders): deterministic 503s → the
  // console's balance reads fail soft ("BAL —") — hermetic, no live RPC.
  const rpcFail = (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "mock: rpc offline" } }),
    });
  await page.route(/helius-rpc\.com|rpc\.mainnet\.x1\.xyz|api\.mainnet\.x1\.xyz/, rpcFail);
});

/** Collect console messages (the build banner + any page noise). */
function attachConsole(page, log) {
  page.on("console", (msg) => {
    log.push({ type: msg.type(), text: msg.text() });
  });
}

/** The full connect journey through the CONSOLE's connect overlay: EVM (fake
 *  injected wallet) + Solana (dev mock). The console stays mounted — the
 *  classic form must NOT appear. */
async function connectWallets(page) {
  // The console is the front door — no classic card anywhere.
  await expect(page.locator('[data-testid="teleport-console"]')).toBeVisible();
  await expect(page.locator('[data-testid="teleport-form"]')).toHaveCount(0);

  // EVM family via the console's connect overlay (the real ConnectModal).
  await page.locator('[data-testid="connect-open"]').click();
  await expect(page.locator('[data-testid="connect-modal"]')).toBeVisible();
  await page.locator('button[data-family="evm"]').click();
  const evmRow = page.locator('li[data-wallet-id="com.playwright.testwallet"]');
  await expect(evmRow).toBeVisible();
  await evmRow.locator("button.connect-btn").click();
  await expect(page.locator('[data-testid="wallet-chip-evm"]')).toBeVisible();
  await expect(page.locator('[data-testid="connect-modal"]')).toHaveCount(0); // auto-close

  // Solana family → Starport (pinned) → dev-mock fallback.
  await page.locator('[data-testid="connect-open"]').click();
  await expect(page.locator('[data-testid="connect-modal"]')).toBeVisible();
  await page.locator('button[data-family="solana"]').click();
  const starport = page.locator('li[data-wallet-id="starport"]');
  await expect(starport).toBeVisible();
  await starport.locator("button.connect-btn").click();
  await expect(page.locator('[data-testid="wallet-chip-solana"]')).toBeVisible();
}

/** Fill the fixture amount and wait for the console's auto-quote to land. */
async function getForwardQuote(page) {
  await expect(page.locator('[data-testid="from-chain"]')).toHaveValue("eth");
  await expect(page.locator('[data-testid="token"]')).toHaveValue("USDC");
  await page.locator('[data-testid="amount"]').fill("25.65");
  // Auto-quote fires after the debounce — the quote box lands on its own.
  await expect(page.locator('[data-testid="quote-box"]')).toBeVisible({ timeout: 20_000 });
}

test("console: renders as the front door + the forward quote renders the exact fee lines (0.5%/cap + per-asset Warp), net, To-address, and ARMS", async ({ page }) => {
  const log = [];
  attachConsole(page, log);

  // The screenshot journeys run under reduced-motion emulation: the design
  // doc renders the astronaut POSTER still for reduced-motion (and mobile)
  // users, so the screenshots are deterministic (the video layer itself is
  // asserted in its own test below). Reduced motion also makes the readout
  // ticker jump instantly — stable text for the exact-match assertions.
  // Set BEFORE goto so the app mounts with the preference already applied.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  // ── The console hardware + header strip (no wallets yet) ──
  const shell = page.locator('[data-testid="teleport-console"]');
  await expect(shell).toBeVisible();
  await expect(page.locator('[data-testid="console-header"]')).toContainText("TELEPORT CONSOLE");
  await expect(page.locator('[data-testid="console-subheader"]')).toContainText("set your journey coordinates");
  await expect(page.locator('[data-testid="console-status"]')).toContainText("STATUS: READY");
  // Route coordinates: FROM eth → TO x1 (forward default) + token + amount + MAX
  await expect(page.locator('[data-testid="from-chain"]')).toHaveValue("eth");
  await expect(page.locator('[data-testid="to-chain"]')).toHaveValue("x1");
  await expect(page.locator('[data-testid="token"]')).toHaveValue("USDC");
  await expect(page.locator('[data-testid="x1-token"]')).toHaveValue("USDC.x");
  await expect(page.locator('[data-testid="amount"]')).toBeVisible();
  await expect(page.locator('[data-testid="max-button"]')).toBeVisible();
  await expect(page.locator('[data-testid="quote-strip"]')).toBeVisible();
  const fire = page.locator('[data-testid="teleport-now"]');
  await expect(fire).toBeVisible();
  await expect(fire).toContainText("TELEPORT");
  // Reduced-motion renders the astronaut POSTER still.
  await expect(page.locator('[data-testid="console-poster"]')).toBeVisible();
  await expect(page.locator('[data-testid="console-video"]')).toHaveCount(0);
  await page.screenshot({ path: join(SHOTS, "1-console-idle-desktop.png"), fullPage: true });

  // ── The build banner reads the real compiled WARP_LIVE_SEND flag. ──
  await expect
    .poll(() => log.find((m) => m.text.includes("[Teleporter] BUILD"))?.text, { timeout: 15_000 })
    .toContain(EXPECTED_LIVE_PHRASE);
  const banner = log.find((m) => m.text.includes("[Teleporter] BUILD"))?.text;
  expect(banner).toContain("[Teleporter] BUILD");
  expect(banner).toContain(EXPECTED_FLAG, `banner should read ${EXPECTED_FLAG}, got: ${banner}`);

  // ── Connect wallets through the console's overlay ──
  await connectWallets(page);
  await expect(page.locator('[data-testid="console-status"]')).toContainText("STATUS: READY");
  await page.screenshot({ path: join(SHOTS, "2-console-connected-desktop.png"), fullPage: true });

  // ── Quote box: exact fee lines for 25.65 USDC ETH→X1 (fixture amount) ──
  await getForwardQuote(page);
  const qb = SUMMARY.quoteBox;

  // Fee lines — labels + EXACT amounts (Teleporter 0.5% max $250 + Warp $1 flat).
  const skim = page.locator('[data-testid="fee-line-warp-skim"]');
  await expect(skim).toContainText("Teleporter fee (0.5%, max $250)");
  await expect(skim).toContainText(qb.feeLines[0].display); // $0.13
  const flat = page.locator('[data-testid="fee-line-warp-flat"]');
  await expect(flat).toContainText("Warp bridge fee ($1 flat)");
  await expect(flat).toContainText(qb.feeLines[1].display); // $1.00
  // You receive (net of both fees — the golden summary's real-code string)
  await expect(page.locator('[data-testid="you-receive"]')).toHaveText(qb.youReceive);
  // Steps chips (LiFi Solana + Warp Bridge X1)
  for (const step of qb.steps) {
    await expect(page.locator('[data-testid="quote-box"]')).toContainText(step);
  }
  // To-address destination line: the connected Solana session is the X1
  // recipient (bridge-to-self). Full address in the title.
  const dest = page.locator('[data-testid="dest-address-forward"]');
  await expect(dest).toBeVisible();
  await expect(dest.locator("span[title]")).toHaveAttribute("title", MOCK_SOL_ADDRESS);
  // The fire control is ARMED (quote landed) + the status readout flips.
  await expect(fire).toContainText("TELEPORT");
  await expect(page.locator('[data-testid="console-status"]')).toContainText("ARMED");
  await page.screenshot({ path: join(SHOTS, "3-console-quote-fees-desktop.png"), fullPage: true });
});

test("console: the ambient astronaut VIDEO layer renders on desktop (webm + mp4 fallback)", async ({ page }) => {
  // No reduced-motion emulation here: desktop users with default motion get
  // the ambient video (the poster is the reduced-motion/mobile still).
  await page.goto("/");
  const video = page.locator('[data-testid="console-video"]');
  await expect(video).toBeVisible();
  const sources = await video.locator("source").evaluateAll((els) => els.map((s) => s.getAttribute("src")));
  expect(sources).toEqual(["/assets/teleporter-astronaut.webm", "/assets/teleporter-astronaut.mp4"]);
  await expect(video).toHaveAttribute("poster", "/assets/teleporter-astronaut-poster.jpg");
  await expect(video).toHaveJSProperty("autoplay", true);
  await expect(video).toHaveJSProperty("muted", true);
  await expect(video).toHaveJSProperty("playsInline", true);
  await expect(page.locator('[data-testid="console-poster"]')).toHaveCount(0);
});

test("console: per-asset Warp fee — landing wSOL.X swaps the fee line to 0.25% (no $1 flat)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await connectWallets(page);
  await getForwardQuote(page);
  await expect(page.locator('[data-testid="fee-line-warp-flat"]')).toBeVisible();

  // Switch the X1 destination token → the quote re-runs → the Warp fee line
  // becomes the per-asset 0.25% pct line (never the flat $1).
  await page.locator('[data-testid="x1-token"]').selectOption("wSOL.X");
  await expect(page.locator('[data-testid="fee-line-warp-pct"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="fee-line-warp-pct"]')).toContainText("Warp bridge fee (0.25%)");
  await expect(page.locator('[data-testid="fee-line-warp-flat"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="you-receive"]')).toContainText("wSOL.X");
  await page.screenshot({ path: join(SHOTS, "3b-console-quote-wsolx-desktop.png"), fullPage: true });
});

test("console: forward flow advances to the SIGN step and STOPS at the wallet signature (the EXACT golden approval, byte-for-byte)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await connectWallets(page);
  await getForwardQuote(page);

  // Arm the fake wallet to HANG at the signature = the wallet prompt is open.
  await page.evaluate(() => window.__x1TeleporterHarness.setMode("hang"));

  await page.locator('[data-testid="teleport-now"]').click();

  // The flow advanced INTO the bridge: the console shows the in-flight state
  // while the wallet prompt is open.
  await expect(page.locator('[data-testid="bridging"]')).toBeVisible();
  await expect(page.locator('[data-testid="console-status"]')).toContainText("IN FLIGHT");

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
  // The payload is the exact-amount approval — never MaxUint256.
  expect(req.data.startsWith("0x095ea7b3")).toBe(true);
  expect(req.data.endsWith("f".repeat(64))).toBe(false);

  // And the request was NOT resolved: the harness is still at the prompt.
  const stillHanging = await page.evaluate(() => window.__x1TeleporterHarness.mode === "hang");
  expect(stillHanging).toBe(true);
  const sends = await page.evaluate(() => window.__x1TeleporterHarness.signingRequests.length);
  expect(sends).toBe(1); // exactly one request — the approval; nothing broadcast

  await page.screenshot({ path: join(SHOTS, "4-console-sign-ready-desktop.png"), fullPage: true });
});

test("console: declining the signature surfaces the honest rejection and sends nothing", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await connectWallets(page);
  await getForwardQuote(page);

  await page.evaluate(() => window.__x1TeleporterHarness.setMode("reject"));

  await page.locator('[data-testid="teleport-now"]').click();

  // The wallet declined → the console surfaces the honest rejection...
  await expect(page.locator('[data-testid="form-error"]')).toBeVisible();
  await expect(page.locator('[data-testid="form-error"]')).toContainText("Transaction rejected by wallet");
  // ...and returns to the armed quoted state (retry available; nothing sent).
  await expect(page.locator('[data-testid="teleport-now"]')).toBeEnabled();

  const sends = await page.evaluate(() => window.__x1TeleporterHarness.signingRequests.length);
  expect(sends).toBe(1);
  await page.screenshot({ path: join(SHOTS, "5-console-sign-declined-desktop.png"), fullPage: true });
});

test("console: MOBILE PORTRAIT — the console reflows to a VERTICAL stack and renders the poster still (not the video)", async ({ page }) => {
  // Phone portrait — the make-or-break layout (most users are on phones).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const shell = page.locator('[data-testid="teleport-console"]');
  await expect(shell).toBeVisible();
  await expect(page.locator('[data-testid="console-header"]')).toContainText("TELEPORT CONSOLE");

  // Mobile renders the astronaut POSTER still instead of the ambient video.
  await expect(page.locator('[data-testid="console-poster"]')).toBeVisible();
  await expect(page.locator('[data-testid="console-video"]')).toHaveCount(0);

  // The housing fits the phone width.
  const box = await shell.boundingBox();
  expect(box.width).toBeLessThanOrEqual(390);
  expect(box.width).toBeGreaterThan(300);

  // VERTICAL stack: FROM slot above the TO slot (the arrow rotates down),
  // and the amount below — NOT a shrunken landscape mess.
  const fromSlot = await page.locator('[data-testid="from-slot"]').boundingBox();
  const toSlot = await page.locator('[data-testid="to-slot"]').boundingBox();
  const amountSlot = await page.locator('[data-testid="amount-slot"]').boundingBox();
  expect(fromSlot.y).toBeLessThan(toSlot.y);
  expect(toSlot.y).toBeLessThan(amountSlot.y);
  // The slots span the console width (full-bleed rows on mobile).
  expect(fromSlot.width).toBeGreaterThan(300);

  await page.screenshot({ path: join(SHOTS, "6-console-mobile-idle.png"), fullPage: true });

  // The full journey fits + works on the phone viewport: connect → quote.
  await connectWallets(page);
  await getForwardQuote(page);
  await expect(page.locator('[data-testid="fee-line-warp-skim"]')).toContainText(SUMMARY.quoteBox.feeLines[0].display);
  await expect(page.locator('[data-testid="you-receive"]')).toHaveText(SUMMARY.quoteBox.youReceive);
  await page.screenshot({ path: join(SHOTS, "7-console-mobile-quote.png"), fullPage: true });

  // And the TELEPORT control is a full-width, thumb-sized target.
  const fire = await page.locator('[data-testid="teleport-now"]').boundingBox();
  expect(fire.width).toBeGreaterThan(300);
  expect(fire.height).toBeGreaterThanOrEqual(44);
});
