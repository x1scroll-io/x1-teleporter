/**
 * playwright.console.config.js — the Teleport Console harness config
 * (ADDITIVE — mirrors the frozen forward/reverse/thorchain harness configs;
 * the frozen e2e/playwright*.config.js files are byte-unchanged).
 *
 * The console harness drives the REAL console UI (BridgeCard
 * variant="console") of a LOCAL build compiled with VITE_FLAG_CONSOLE_UI=true
 * (e2e/run-console-harness.mjs builds it — same pattern as the THORChain
 * harness builds VITE_FLAG_THORCHAIN=true). It asserts the console renders,
 * quotes over the real engine path (route-mocked with the frozen fixtures),
 * displays the per-asset fee model, advances to the sign step and STOPS at
 * the wallet signature — never signs, never sends. Desktop + mobile portrait
 * viewports, screenshots of every state.
 *
 * Target: local default http://127.0.0.1:4176 (run-console-harness.mjs).
 */
import { defineConfig } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:4176";

export default defineConfig({
  testDir: ".",
  testMatch: /console-leg\.spec\.js/,
  // One wallet journey per test with strict ordering — never parallelize the
  // sign-boundary flow.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL,
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
    // Wide landscape console on desktop (like the design render); the mobile
    // portrait test overrides the viewport per-test.
    viewport: { width: 1280, height: 900 },
    launchOptions: {
      args: ["--no-sandbox"],
    },
  },
  reporter: [["list"]],
  outputDir: "test-results",
});
