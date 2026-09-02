/**
 * playwright.reverse.config.js — the REVERSE browser-verification harness
 * config (Phase 2 — the reverse-leg baseline the engine migration is verified
 * against).
 *
 * The forward harness (e2e/playwright.config.js — FROZEN) drives the forward
 * leg against the DISARMED local build; the reverse harness needs the ARMED
 * local build (WARP_LIVE_SEND=true — the X1 burn's sign step is gated by it,
 * so a disarmed build can never reach the wallet signature). vite.config.js
 * arms only Vercel builds of the `v2` branch, so the local reverse harness
 * build sets VERCEL_GIT_COMMIT_REF=v2 (e2e/run-reverse-harness.mjs). Sends
 * are still impossible: the fake wallets never sign and the X1 RPC is
 * intercepted — see e2e/reverse-leg.spec.js.
 *
 * The spec drives the reverse leg (X1 → ETH) of the engine build UP TO THE
 * SIGNATURE — never signs, never sends — and asserts the UI flow, the quote
 * fee lines, the To-address line (#44: the EVM destination), and that the
 * fake X1 wallet is asked to sign the EXACT golden burn tx (byte-for-byte vs
 * test/fixtures/golden/reverse-leg/step1-x1-burn.json).
 */
import { defineConfig } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:4174";

export default defineConfig({
  testDir: ".",
  testMatch: /reverse-leg\.spec\.js/,
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
    // The fake wallets are injected before ANY app script runs.
    launchOptions: {
      args: ["--no-sandbox"],
    },
  },
  reporter: [["list"]],
  outputDir: "test-results",
});
