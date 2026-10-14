/**
 * playwright.thorchain.config.js — the THORChain browser-verification
 * harness config (Phase 3 — the deposit-address lane's baseline the engine
 * migration is verified against).
 *
 * The THORChain tab renders ONLY behind the THORCHAIN flag (VITE_FLAG_
 * THORCHAIN at build time — flags.ts reads it at module load, so the env
 * must be baked into the bundle). e2e/run-thorchain-harness.mjs builds the
 * local bundle with VITE_FLAG_THORCHAIN=true. Sends are still impossible:
 * the deposit-address lane never signs or broadcasts in-app (the deposit is
 * sent from the user's external wallet), the fake wallets never sign, and
 * every network the deposit stage touches is intercepted — see
 * e2e/thorchain-leg.spec.js.
 *
 * The spec drives the THORChain deposit stage (BTC/DOGE/LTC/XRP → SOL.SOL)
 * of the engine build UP TO THE DEPOSIT-ADDRESS STEP — the lane's honest
 * sign boundary — never submits, never signs — and asserts the quote
 * summary, the three fee lines, and that the deposit card shows the EXACT
 * golden payload (vault address + memo byte-for-byte vs
 * test/fixtures/golden/thorchain-leg/*.json).
 */
import { defineConfig } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:4175";

export default defineConfig({
  testDir: ".",
  testMatch: /thorchain-leg\.spec\.js/,
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
