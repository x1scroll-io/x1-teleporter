/**
 * playwright.config.js — the lean browser-verification harness config
 * (Tool 2 — the baseline the routing-engine migration will be verified
 * against).
 *
 * The harness drives the CURRENT forward leg (ETH → X1) of the STABLE v2
 * build UP TO THE SIGNATURE — never signs, never sends — and asserts the
 * UI flow, the fee lines (Teleporter 1% + Warp $1 flat — exact amounts for
 * the fixture input), the To-address line, the buttons, and advancement to
 * the sign step. See e2e/forward-leg.spec.js.
 *
 * TARGETS
 *   Local (default):   E2E_BASE_URL unset → http://127.0.0.1:4173
 *                      (the compiled local build served by `vite preview`
 *                      — run e2e/run-harness.mjs which builds + previews)
 *   Deployed (once):   E2E_BASE_URL=https://x1teleporter-git-v2-x1scroll-ios-projects.vercel.app
 *                      (the stable git-v2 alias — always the latest v2 merge;
 *                      the ONLY browser check against a deployed URL)
 *
 * The same spec + the same route mocks run against both targets: the quote
 * and tools endpoints are INTERCEPTED (page.route) and fulfilled with the
 * frozen fixtures, so the harness is deterministic offline and on the
 * deployed URL — no live LiFi calls, no wallet extension, no money moved.
 *
 * The build banner assertion is target-aware: vite.config.js arms
 * WARP_LIVE_SEND only for Vercel builds of the `v2` branch (allowlist pin),
 * so the LOCAL build must say "live sends OFF" and the deployed git-v2
 * alias must say "live sends ON" (#45). The spec derives the expectation
 * from the base URL; override with EXPECTED_LIVE_PHRASE if ever needed.
 */
import { defineConfig } from "@playwright/test";

const baseURL =
  process.env.E2E_BASE_URL || "http://127.0.0.1:4173";

export default defineConfig({
  testDir: ".",
  testMatch: /forward-leg\.spec\.js/,
  // The harness drives one wallet journey per test with strict ordering —
  // never parallelize the sign-boundary flow.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL,
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
    // Deterministic viewport for the state screenshots.
    viewport: { width: 520, height: 900 },
    // The fake wallet is injected before ANY app script runs.
    launchOptions: {
      args: ["--no-sandbox"],
    },
  },
  reporter: [["list"]],
  outputDir: "test-results",
});
