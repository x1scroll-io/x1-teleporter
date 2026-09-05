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
 *      a phone portrait viewport, and the ambient astronaut VIDEO plays on
 *      mobile too (autoplay muted playsinline — the poster stays only as the
 *      pre-load fallback and as the reduced-motion still). Screenshots of
 *      each state on both viewports.
 *
 *   5. MOTION + SEE-THROUGH PROOFS: on a phone viewport the video element is
 *      asserted playing (not paused, readyState >= HAVE_CURRENT_DATA, the
 *      media clock advances) with a screenshot PAIR (t0 vs t1) AND a real
 *      pixel diff proving the astronaut frame moved on screen; the
 *      see-through recipe (ZERO backdrop blur — the astronaut stays CLEAR and
 *      SHARP behind the card — with a low ~5-9% dark tint on the shell AND
 *      the inner panels, readability carried by dark text-shadows) is
 *      asserted via computed styles AND a pixel proof: the card interior
 *      with the console hidden vs shown matches the raw scene (low
 *      luminance delta + preserved edge energy — no frost, no mush).
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
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs"); // already in the tree (playwright dep)

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(here, p), "utf8"));

// ── Frozen fixtures (single source of truth with the golden oracle) ──
const QUOTE = read("../test/fixtures/golden/forward-leg/quote-eth-sol-usdc-25.65.json");
const SUMMARY = read("../test/fixtures/golden/forward-leg/forward-leg-summary.json");
const GOLDEN_STEP1 = read("../test/fixtures/golden/forward-leg/step1-approval.json");
const TOOLS = read("./fixtures/tools-chain-1.json");
// The deposit rail's frozen fixtures (the same bodies the frozen
// thorchain-leg harness measures — the unified console's native-source flow
// reproduces the same honest payload).
const INBOUND_BODY = read("../test/fixtures/golden/thorchain-leg/inbound-addresses-body.json").body;
const QUOTE_BODY = read("../test/fixtures/golden/thorchain-leg/quote-body-btc-sol.json").body;
const TC_SUMMARY = read("../test/fixtures/golden/thorchain-leg/thorchain-leg-summary.json");
const GOLDEN_MEMO = TC_SUMMARY.derived.memo; // =:SOL.SOL:wJs2CD1p…
const GOLDEN_ADDRESS = TC_SUMMARY.derived.depositAddress; // the synthetic BTC vault
const GOLDEN_FEE_LINES = TC_SUMMARY.derived.feeLines; // affiliate 1.00% / Teleporter 0.50% / Warp $1 flat

// The mock solana session address (WalletContext dev-mock fallback — what the
// Starport row connects when no real Solana wallet is installed).
const MOCK_SOL_ADDRESS = "mock:solana:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const EVM_ADDRESS = "0x4634e8e0b1c2d3f4a5b6c7d8e9f0a1b2c3d4e5f6";
// The fakeSolana helper's deterministic base58 address (the golden USER) —
// the deposit rail's memo destination must be a real base58 address.
const SOL_ADDRESS = "wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV";

const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:4176";
const DEPLOYED = baseURL.includes("vercel.app");
const EXPECTED_LIVE_PHRASE = process.env.EXPECTED_LIVE_PHRASE || (DEPLOYED ? "live sends ON" : "live sends OFF");
const EXPECTED_FLAG = EXPECTED_LIVE_PHRASE === "live sends ON" ? "WARP_LIVE_SEND=true" : "WARP_LIVE_SEND=false";

const SHOTS = join(here, "screenshots", process.env.SCREENSHOT_SUBDIR || "console-seethrough");

// ── Pixel-proof helpers (pngjs decode + luminance math) ────────────────────
const LUM = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
const readPng = (buf) => PNG.sync.read(buf);

/** % of pixels whose luminance moved more than t between two PNGs. */
function motionShare(a, b, t = 10) {
  const w = a.width, h = a.height;
  const ad = a.data, bd = b.data;
  let moved = 0, total = 0;
  for (let i = 0; i < w * h * 4; i += 4) {
    if (Math.abs(LUM(ad, i) - LUM(bd, i)) > t) moved++;
    total++;
  }
  return +(moved / total).toFixed(4);
}

test.beforeEach(async ({ page }) => {
  // The fake wallets must exist before ANY app script runs (EVM first — it
  // creates the shared harness; Solana extends it for the deposit-rail
  // tests — its base58 session is the golden memo destination).
  await page.addInitScript({ path: join(here, "helpers", "fakeEthereum.js") });
  await page.addInitScript({ path: join(here, "helpers", "fakeSolana.js") });
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
  // doc renders the astronaut POSTER still for reduced-motion users, so the
  // screenshots are deterministic (the video layer itself is asserted in its
  // own tests below). Reduced motion also makes the readout
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

test("console: the ambient astronaut VIDEO layer renders AND PLAYS on desktop (webm + mp4 fallback)", async ({ page }) => {
  // No reduced-motion emulation here: desktop users with default motion get
  // the ambient video (the poster is the reduced-motion still only).
  await page.goto("/");
  const video = page.locator('[data-testid="console-video"]');
  await expect(video).toBeVisible();
  const sources = await video.locator("source").evaluateAll((els) => els.map((s) => s.getAttribute("src")));
  expect(sources).toEqual(["/assets/teleporter-astronaut.webm", "/assets/teleporter-astronaut.mp4"]);
  await expect(video).toHaveJSProperty("autoplay", true);
  await expect(video).toHaveJSProperty("muted", true);
  await expect(video).toHaveJSProperty("playsInline", true);
  await expect(video).toHaveJSProperty("loop", true);
  await expect(page.locator('[data-testid="console-poster"]')).toHaveCount(0);
  // The astronaut DRIFTS: frames decode (readyState >= HAVE_CURRENT_DATA),
  // playback is not paused, and the media clock advances.
  await expect
    .poll(() => video.evaluate((v) => v.paused === false && v.readyState >= 2 && v.currentTime > 0), { timeout: 20_000 })
    .toBe(true);
  // The poster attribute is ONLY the pre-load placeholder: the moment the
  // first frame plays it is REMOVED from the element — a stale poster can
  // never sit on top of live video (the real-phone frozen-frame trap).
  await expect
    .poll(() => video.evaluate((v) => v.getAttribute("poster")), { timeout: 10_000 })
    .toBeNull();
  const t0 = await video.evaluate((v) => v.currentTime);
  await page.waitForTimeout(1200);
  const t1 = await video.evaluate((v) => v.currentTime);
  expect(t1 - t0).toBeGreaterThan(0.5);
  await page.screenshot({ path: join(SHOTS, "8-console-video-desktop.png"), fullPage: true });
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

test("console: SEE-THROUGH GLASS v4 — zero backdrop blur (astronaut SHARP behind the card), low ~5-9% tint, dark text-shadow readability", async ({ page }) => {
  // The transparent recipe (Mr. Esters: no frost — the astronaut must show
  // CLEAR and SHARP through the shell AND the inner panels, dimmed only
  // enough for the glyphs, whose readability rides dark text-shadows — never
  // a background block, never a blur). Structural proof here; the pixel
  // proof follows: the card interior with the console hidden vs shown must
  // match the raw scene (low luminance delta + preserved edge energy).
  const alphas = (bg) => [...bg.matchAll(/rgba?\(([^)]+)\)/g)].map((m) => Number(m[1].split(",").at(-1)));
  const readGlass = () =>
    page.evaluate(() => {
      const cs = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const s = getComputedStyle(el);
        return {
          filter: s.filter,
          backdropFilter: s.backdropFilter,
          backgroundImage: s.backgroundImage,
          textShadow: s.textShadow,
        };
      };
      return {
        wrap: cs(".tc-shell-wrap"),
        glass: cs(".tc-shell-glass"),
        slot: cs(".tc-slot"),
        strip: cs(".tc-strip"),
        label: cs(".tc-label"),
      };
    });
  const assertGlass = (g) => {
    expect(g.wrap.filter).toBe("none"); // the backdrop-root trap is gone
    for (const key of ["glass", "slot", "strip"]) {
      // NO backdrop blur anywhere on the card: the astronaut stays SHARP.
      expect(g[key].backdropFilter, `${key} must have NO backdrop blur`).toBe("none");
      // Low translucent tint: every fill alpha sits in the ~5-9% band — the
      // scene shows through, dimmed only a touch (never a background block).
      const a = alphas(g[key].backgroundImage);
      expect(a.length, `${key} tint band`).toBeGreaterThan(0);
      for (const alpha of a) {
        expect(alpha, `${key} tint alpha`).toBeGreaterThanOrEqual(0.02 - 1e-6);
        expect(alpha, `${key} tint alpha`).toBeLessThanOrEqual(0.1 + 1e-6);
      }
    }
    // Readability mechanism = dark text-shadow on the labels (over a SHARP
    // bright astronaut, not a blurred one).
    expect(g.label.textShadow).toMatch(/rgba?\(1, 4, 9/);
  };

  // ── Pixel proof ──────────────────────────────────────────────────────────
  // Same clip, console hidden vs shown (video PAUSED so both shots see the
  // SAME astronaut frame). The comparison is made ONLY on pure-glass pixels:
  // the card interior minus opaque UI (solid button, controls), minus the
  // border rings of the translucent panels, minus the glyph text boxes. What
  // remains is the glass FILL itself — the shell between the boxes AND the
  // inside of the FROM/TO/TOKEN slots — where the astronaut must show
  // through CLEAR and SHARP: low luminance delta (tint only) and preserved
  // edge energy (no frost — blur(36px) would flatten every edge it touches).
  const glassExclusions = (cardSel) =>
    page.evaluate((sel) => {
      const card = document.querySelector(sel);
      if (!card) return { rects: [] };
      const c = card.getBoundingClientRect();
      const rects = [];
      const push = (r, pad = 0) => {
        const x = r.left - c.left - pad;
        const y = r.top - c.top - pad;
        const w = r.width + pad * 2;
        const h = r.height + pad * 2;
        if (w > 0.5 && h > 0.5) rects.push({ x, y, w, h });
      };
      // Glyph text boxes (exact) + shadow bleed — text is NOT glass.
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNode(n);
        push(range.getBoundingClientRect(), 3);
      }
      for (const el of card.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width < 0.5 || r.height < 0.5) continue;
        const s = getComputedStyle(el);
        const tag = el.tagName;
        // Interactive controls are excluded whole (their value text is not a
        // light-DOM text node, so glyph masking can't cover it).
        if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") {
          push(r, 1);
          continue;
        }
        const bg = s.backgroundImage + " " + s.backgroundColor;
        const alphas = [...bg.matchAll(/rgba?\(([^)]+)\)/g)].map((m) => Number(m[1].split(",").at(-1)));
        const opaque = alphas.some((a) => a >= 0.95);
        if (opaque) {
          push(r, 1); // solid chrome (the TELEPORT button)
          continue;
        }
        const border = Math.max(
          parseFloat(s.borderTopWidth) || 0,
          parseFloat(s.borderBottomWidth) || 0,
          parseFloat(s.borderLeftWidth) || 0,
          parseFloat(s.borderRightWidth) || 0,
        );
        // Translucent panels (slots/strips): exclude only their border ring —
        // the panel FILL is glass too (the astronaut shows through the
        // FROM/TO/TOKEN boxes, not just the shell).
        if (border > 0) {
          const bw = Math.min(border, r.width / 2, r.height / 2);
          push({ left: r.left + bw, top: r.top + bw, right: r.right - bw, bottom: r.bottom - bw, width: r.width - bw * 2, height: r.height - bw * 2 });
        }
      }
      return { rects };
    }, cardSel);

  const proveSeeThrough = async (tag) => {
    const shell = page.locator('[data-testid="teleport-console"]');
    await expect(shell).toBeVisible();
    const video = page.locator('[data-testid="console-video"]');
    // Let the first frame render, then freeze the scene for the pair.
    await expect
      .poll(() => video.evaluate((v) => v.paused === false && v.readyState >= 2 && v.currentTime > 0), { timeout: 20_000 })
      .toBe(true);
    await page.waitForTimeout(400);
    await video.evaluate((v) => v.pause());
    await page.waitForTimeout(120);
    const box = await shell.boundingBox();
    const vp = page.viewportSize();
    // Clamp the clip to the visible viewport (the mobile console can be
    // taller than the phone screen — screenshots can't capture offscreen).
    const clip = {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: Math.min(box.width, vp.width - Math.max(0, box.x)),
      height: Math.min(box.height, vp.height - Math.max(0, box.y)),
    };
    const { rects } = await glassExclusions('[data-testid="teleport-console"]');
    const setHidden = (hidden) =>
      page.evaluate((h) => {
        const el = document.querySelector(".tc-scroll");
        if (el) el.style.visibility = h ? "hidden" : "";
      }, hidden);
    await setHidden(true);
    await page.waitForTimeout(120);
    const raw = readPng(await page.screenshot({ clip }));
    await setHidden(false);
    await page.waitForTimeout(120);
    const glass = readPng(await page.screenshot({ clip }));
    await video.evaluate((v) => { const p = v.play(); p?.catch(() => {}); });
    const rawPath = join(SHOTS, `${tag}-raw-scene.png`);
    const glassPath = join(SHOTS, `${tag}-glass-overlay.png`);
    writeFileSync(rawPath, PNG.sync.write(raw));
    writeFileSync(glassPath, PNG.sync.write(glass));
    // Pure-glass sample: deltas + sharpness (edge energy ratio) on the
    // pixels where the glass is the ONLY thing between camera and astronaut.
    const w = raw.width, h = raw.height;
    const lr = new Float32Array(w * h);
    const lg = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      lr[i] = LUM(raw.data, i * 4);
      lg[i] = LUM(glass.data, i * 4);
    }
    const blocked = (x, y) => rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    const deltas = [];
    let edgeNum = 0, edgeDen = 0, samples = 0;
    for (let y = 5; y < h - 5; y += 2) {
      for (let x = 5; x < w - 5; x += 2) {
        if (blocked(x, y)) continue;
        const i = y * w + x;
        deltas.push(Math.abs(lr[i] - lg[i]));
        samples++;
        const gRaw = Math.abs(lr[i + 1] - lr[i - 1]) + Math.abs(lr[i + w] - lr[i - w]);
        if (gRaw > 8) {
          const gGlass = Math.abs(lg[i + 1] - lg[i - 1]) + Math.abs(lg[i + w] - lg[i - w]);
          edgeNum += gGlass;
          edgeDen += gRaw;
        }
      }
    }
    deltas.sort((p, q) => p - q);
    const n = deltas.length;
    const median = +deltas[Math.floor(n / 2)].toFixed(3);
    const p95 = +deltas[Math.floor(n * 0.95)].toFixed(3);
    const mean = +(deltas.reduce((s, d) => s + d, 0) / n).toFixed(3);
    const shareLt24 = +(deltas.filter((d) => d <= 24).length / n).toFixed(4);
    const edgeRatio = edgeDen > 0 ? +(edgeNum / edgeDen).toFixed(3) : null;
    const metrics = {
      tag,
      clip: { width: w, height: h },
      glassPixelsSampled: n,
      luminanceDelta: { median, p95, mean, shareLt24 },
      sharpness: { glassOverRawEdgeEnergy: edgeRatio, note: "Σ|∇glass| / Σ|∇raw| on pure-glass pixels where ∇raw > 8; ~1 = sharp, →0 = frosted" },
    };
    console.log(`[SEE-THROUGH:${tag}]`, JSON.stringify(metrics));
    writeFileSync(join(SHOTS, `${tag}-metrics.json`), JSON.stringify(metrics, null, 2));
    // The glass fill ≈ the raw scene: median delta is tint-scale small, and
    // MOST pure-glass pixels sit within a hair of the raw scene.
    expect(n, `${tag} sampled pure-glass pixels`).toBeGreaterThan(1000);
    expect(median, `${tag} pure-glass median ΔL ≈ tint only`).toBeLessThan(16);
    expect(shareLt24, `${tag} pure-glass pixels ≈ raw scene`).toBeGreaterThan(0.55);
    // Edges survive at full strength: the astronaut behind the glass is
    // SHARP (a 36px frost would crush this ratio toward ~0.1-0.2).
    expect(edgeRatio, `${tag} sharp — edges preserved through the glass`).toBeGreaterThan(0.5);
    return metrics;
  };

  // Desktop, default motion — the drifting video is SHARP behind the glass.
  await page.goto("/");
  assertGlass(await readGlass());
  await page.screenshot({ path: join(SHOTS, "11-seethrough-desktop.png"), fullPage: true });
  await proveSeeThrough("13-desktop");

  // Phone portrait, default motion — same recipe on mobile.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  assertGlass(await readGlass());
  await page.screenshot({ path: join(SHOTS, "12-seethrough-mobile.png"), fullPage: true });
  await proveSeeThrough("14-mobile");
});

test("console: MOBILE PORTRAIT — the console reflows to a VERTICAL stack and the astronaut VIDEO plays (drift, not a poster)", async ({ page }) => {
  // Phone portrait — the make-or-break layout (most users are on phones).
  // Default motion: the astronaut DRIFTS on mobile too (muted autoplay +
  // playsinline are the unlock) — the poster is NOT the mobile default.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const shell = page.locator('[data-testid="teleport-console"]');
  await expect(shell).toBeVisible();
  await expect(page.locator('[data-testid="console-header"]')).toContainText("TELEPORT CONSOLE");

  // The ambient VIDEO layer renders on the phone — no poster still.
  const video = page.locator('[data-testid="console-video"]');
  await expect(video).toBeVisible();
  await expect(page.locator('[data-testid="console-poster"]')).toHaveCount(0);

  // PROOF OF MOTION on mobile: exists, not paused, frames decoded
  // (readyState >= HAVE_CURRENT_DATA = 2), media clock advancing.
  await expect
    .poll(() => video.evaluate((v) => v.paused === false && v.readyState >= 2 && v.currentTime > 0), { timeout: 20_000 })
    .toBe(true);
  // The poster attribute is DROPPED once the first frame plays on mobile too
  // — the astronaut is never a stuck poster on a phone.
  await expect
    .poll(() => video.evaluate((v) => v.getAttribute("poster")), { timeout: 10_000 })
    .toBeNull();
  const t0 = await video.evaluate((v) => v.currentTime);
  await page.screenshot({ path: join(SHOTS, "9a-console-motion-mobile-t0.png") });
  await page.waitForTimeout(1600);
  await page.screenshot({ path: join(SHOTS, "9b-console-motion-mobile-t1.png") });
  const t1 = await video.evaluate((v) => v.currentTime);
  expect(t1 - t0).toBeGreaterThan(0.8); // the astronaut frame moved on screen

  // PIXEL proof of drift: the t0/t1 screenshot pair must differ where the
  // astronaut is — real painted motion on the phone, not just a running
  // media clock (the frozen-frame trap: clock advances while the painted
  // layer never changes).
  const a = readPng(readFileSync(join(SHOTS, "9a-console-motion-mobile-t0.png")));
  const b = readPng(readFileSync(join(SHOTS, "9b-console-motion-mobile-t1.png")));
  const moved = motionShare(a, b);
  const shellBox = await shell.boundingBox();
  const vp = page.viewportSize();
  const cardClip = {
    x: Math.max(0, shellBox.x),
    y: Math.max(0, shellBox.y),
    width: Math.min(shellBox.width, vp.width - Math.max(0, shellBox.x)),
    height: Math.min(shellBox.height, vp.height - Math.max(0, shellBox.y)),
  };
  const aCard = readPng(await page.screenshot({ clip: cardClip }));
  await page.waitForTimeout(1200);
  const bCard = readPng(await page.screenshot({ clip: cardClip }));
  const movedThroughGlass = motionShare(aCard, bCard);
  const metrics = {
    mediaClockAdvancedSeconds: t1 - t0,
    paintedMotionShareWholeFrame: moved,
    paintedMotionShareThroughCard: movedThroughGlass,
    note: "shares = fraction of pixels whose luminance moved >10/255 between the two captures",
  };
  console.log("[MOBILE-MOTION]", JSON.stringify(metrics));
  writeFileSync(join(SHOTS, "motion-mobile-metrics.json"), JSON.stringify(metrics, null, 2));
  // The painted layer really moves (whole frame AND through the card).
  expect(moved).toBeGreaterThan(0.001);
  expect(movedThroughGlass).toBeGreaterThan(0.001);
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

test("console: MOBILE REDUCED-MOTION — the poster still replaces the video (a11y rule stays)", async ({ page }) => {
  // Reduced motion is the ONLY thing that swaps the poster in: phones with
  // default motion get the drifting video; phones that ask for less motion
  // get the deterministic poster still.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  await expect(page.locator('[data-testid="teleport-console"]')).toBeVisible();
  await expect(page.locator('[data-testid="console-poster"]')).toBeVisible();
  await expect(page.locator('[data-testid="console-video"]')).toHaveCount(0);
  await page.screenshot({ path: join(SHOTS, "10-console-mobile-reduced-idle.png"), fullPage: true });
});

test("console: LANDSCAPE PHONE — the console reflows HORIZONTAL (coords in a row, centered) and the astronaut shows the FULL wide shot (no portrait crop)", async ({ page }) => {
  // Rotate the phone: landscape is the enhanced cinematic view — the footage
  // IS landscape, so the horizontal crop portrait forces disappears.
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto("/");

  const shell = page.locator('[data-testid="teleport-console"]');
  await expect(shell).toBeVisible();

  // The console reflows: FROM and TO slots sit side-by-side on the same row
  // (NOT the portrait vertical stack) — the coords are readable horizontally.
  const fromSlot = await page.locator('[data-testid="from-slot"]').boundingBox();
  const toSlot = await page.locator('[data-testid="to-slot"]').boundingBox();
  expect(fromSlot.x).toBeLessThan(toSlot.x);
  expect(Math.abs(fromSlot.y - toSlot.y)).toBeLessThan(6);

  // The astronaut VIDEO plays in landscape too, and the footage — now shown
  // by WIDTH — renders its full wide composition (no side crop): the video
  // element's painted width fills the viewport at ~natural scale.
  const video = page.locator('[data-testid="console-video"]');
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((v) => v.paused === false && v.readyState >= 2 && v.currentTime > 0), { timeout: 20_000 })
    .toBe(true);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, "b1-console-landscape-cinematic.png"), fullPage: true });
});

test("console: UNIFIED FLOW — one surface, no rail tabs, no Buy; the source-asset union lists the native chains; a BTC source routes into the DEPOSIT-ADDRESS final step (vault + memo byte-identical to the golden fixtures) and STOPS — the rail is never named", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  // The deposit rail's network: vault-address refresh + our quote proxy are
  // fulfilled with the frozen THORChain fixtures (the same bodies the frozen
  // thorchain-leg harness uses). Registered AFTER the shared beforeEach
  // routes — Playwright matches the newest route first.
  await page.route("**/thorchain/inbound_addresses*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(INBOUND_BODY) }),
  );
  await page.route("**/api/thorchain/quote*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(QUOTE_BODY) }),
  );

  await page.goto("/");

  // ── 1. ONE unified surface: no rail tabs, no Buy tab, no rail name. ──
  await expect(page.locator('[data-testid="teleport-console"]')).toBeVisible();
  await expect(page.locator('[role="tab"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="buy-tab"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="thorchain-tab"]')).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("THORChain");
  await expect(page.locator("body")).not.toContainText("Buy");

  // ── 2. The source-asset union: the from-chain picker carries the native
  //    chains next to the EVM chains and X1. ──
  const fromChain = page.locator('[data-testid="from-chain"]');
  for (const v of ["eth", "btc", "doge", "ltc", "xrp", "x1"]) {
    await expect(fromChain.locator(`option[value="${v}"]`)).toHaveCount(1);
  }
  await fromChain.selectOption("btc");
  // Native route locks: single asset BTC, destination X1, USDC.x land-as.
  await expect(page.locator('[data-testid="token"]')).toHaveValue("BTC");
  await expect(page.locator('[data-testid="to-chain"]')).toHaveValue("x1");
  await expect(page.locator('[data-testid="to-slot"]')).toContainText("arrives as USDC.x on X1");
  await expect(page.locator('[data-testid="x1-token"]')).toHaveCount(0);
  await page.screenshot({ path: join(SHOTS, "c1-unified-asset-picker-btc.png"), fullPage: true });

  // ── 3. Connect ONLY the Solana/X1 wallet (the deposit destination). The
  //    fakeSolana session has the golden base58 address — the memo's dest. ──
  await page.locator('[data-testid="connect-open"]').click();
  await expect(page.locator('[data-testid="connect-modal"]')).toBeVisible();
  await page.locator('button[data-family="solana"]').click();
  const solRow = page.locator('li[data-wallet-id="Playwright Test Solana"]');
  await expect(solRow).toBeVisible();
  await solRow.locator("button.connect-btn").click();
  await expect(page.locator('[data-testid="wallet-chip-solana"]')).toBeVisible();

  // ── 4. Amount → TELEPORT → the DEPOSIT-ADDRESS final step (the rail
  //    decision happened post-pick, pre-execution, invisibly). ──
  await page.locator('[data-testid="amount"]').fill("0.01");
  await expect(page.locator('[data-testid="quote-strip"]')).toContainText("DEPOSIT ROUTE READY");
  await page.locator('[data-testid="teleport-now"]').click();
  await expect(page.locator('[data-testid="deposit-step"]')).toBeVisible();
  await expect(page.locator('[data-testid="tc-deposit"]')).toBeVisible();
  await expect(page.locator('[data-testid="console-status"]')).toContainText("DEPOSIT");
  // The console amount rode into the deposit stage; source locked; the
  // destination is the connected session (never typed).
  await expect(page.locator('[data-testid="tc-amount-input"]')).toHaveValue("0.01");
  await expect(page.locator('[data-testid="tc-source-locked"]')).toContainText("BTC");
  await expect(page.locator('[data-testid="tc-sources"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="tc-destination-input"]')).toHaveValue(SOL_ADDRESS);

  // ── 5. The QUOTE GATE: the vault address appears only after a fresh quote
  //    lands. Fees render with NEUTRAL labels (the rail is never named). ──
  await expect(page.locator('[data-testid="tc-deposit-card"]')).toHaveCount(0);
  await page.locator('[data-testid="tc-get-quote"]').click();
  await expect(page.locator('[data-testid="tc-quote-summary"]')).toContainText("0.4975 SOL");
  await expect(page.locator('[data-testid="tc-fee-line"][data-fee-id="thorchain-affiliate"]')).toContainText("Network protocol fee");
  await expect(page.locator('[data-testid="tc-fee-line"][data-fee-id="thorchain-affiliate"]')).toContainText(GOLDEN_FEE_LINES[0].display);
  await expect(page.locator('[data-testid="tc-fee-line"][data-fee-id="warp-skim"]')).toContainText(GOLDEN_FEE_LINES[1].display);
  await expect(page.locator('[data-testid="tc-fee-line"][data-fee-id="warp-flat"]')).toContainText(GOLDEN_FEE_LINES[2].display);

  // ── 6. THE DEPOSIT PAYLOAD — vault + memo byte-for-byte vs the golden
  //    fixtures (destination = the connected fakeSolana session). ──
  await expect(page.locator('[data-testid="tc-deposit-card"]')).toBeVisible();
  await expect(page.locator('[data-testid="tc-deposit-address"]')).toHaveText(GOLDEN_ADDRESS);
  await expect(page.locator('[data-testid="tc-memo"]')).toHaveText(GOLDEN_MEMO);

  // ── 7. The rail stays invisible end-to-end. ──
  await expect(page.locator("body")).not.toContainText("THORChain");
  await page.screenshot({ path: join(SHOTS, "c2-unified-deposit-address-step.png"), fullPage: true });

  // ── 8. STOP AT THE DEPOSIT BOUNDARY: the send is out-of-band — never
  //    paste a txid, never submit, nothing signed in-app. ──
  await expect(page.locator('[data-testid="tc-submit"]')).toBeDisabled();
  await expect(page.locator('[data-testid="console-wallets"]')).toBeVisible();
});

test("console: UNIFIED FLOW — the EVM rail keeps the WALLET-CONNECT final step (sign boundary) and the console never offers a Buy tab", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await connectWallets(page);
  await getForwardQuote(page);

  // The wallet-connect rail end-to-end: quote → ARMED → sign step (the fake
  // EVM wallet hangs at the prompt — never signs, never sends).
  await page.evaluate(() => window.__x1TeleporterHarness.setMode("hang"));
  await page.locator('[data-testid="teleport-now"]').click();
  await expect(page.locator('[data-testid="bridging"]')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__x1TeleporterHarness.signingRequests.length), { timeout: 20_000 })
    .toBe(1);

  // The unified surface held throughout: no tabs, no Buy, no rail name.
  await expect(page.locator('[role="tab"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="buy-tab"]')).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("THORChain");
  await page.screenshot({ path: join(SHOTS, "c3-unified-wallet-connect-step.png"), fullPage: true });
});
