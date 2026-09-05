/**
 * teleportConstants.test.js — Robinhood Chain integration tests
 * (feat/robinhood-chain, 2026-09-05 — research + scaffold, NO live funds).
 *
 * Proves the scaffold is honest and complete:
 *   - CHAINS.rh is a valid EVM entry (LiFi key 'out', chainId 4663,
 *     walletType 'evm', display color/glyph) and is in EVM_CHAINS, so the
 *     console pickers (SOURCE_CHAINS in teleportRail.js) surface it;
 *   - TOKENS.rh carries ONLY the canonical stable that actually exists on
 *     Robinhood Chain — Paxos USDG (official docs + LiFi tokenlist agree).
 *     NO fake USDC/USDT/DAI entries (no Circle USDC deployment on-chain);
 *   - the rail layer routes rh → LiFi/Warp (wallet-connect execution);
 *   - the x1 quote builder (buildLifiQuoteParams) emits the correct LiFi
 *     query for a Robinhood Chain → Solana leg (fromChain=out, USDG token,
 *     lands Solana USDC — the X1 hop's leg-1 shape);
 *   - the SIMULATED quote fixtures (test/fixtures/golden/robinhood-leg) are
 *     structurally sound li.quest responses for both directions.
 *
 * Pure node:test — no DOM, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CHAINS,
  TOKENS,
  EVM_CHAINS,
  tokensFor,
} from "./teleportConstants.js";
import {
  SOURCE_CHAINS,
  chainName,
  chainGlyph,
  tokensOn,
  pickRail,
  RAIL,
  EXECUTION,
} from "./teleportRail.js";
import { buildLifiQuoteParams } from "./teleportQuote.js";

// Fixture wallet addresses (fake, never funded — same ones the quote
// evidence was captured with). Read-only quote inputs only.
const EVM_ADDR = "0x4634e8e0b1c2d3f4a5b6c7d8e9f0a1b2c3d4e5f6";
const SOL_ADDR = "wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV";
const USDG_4663 = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

const RH_LEG = new URL("../../test/fixtures/golden/robinhood-leg/", import.meta.url);

// ── CHAINS entry ────────────────────────────────────────────────────────────

test("robinhood chain: CHAINS.rh is a valid EVM entry (LiFi 'out', chainId 4663)", () => {
  const c = CHAINS.rh;
  assert.ok(c, "CHAINS.rh exists");
  assert.equal(c.id, "rh");
  assert.equal(c.name, "Robinhood Chain");
  assert.equal(c.lifiKey, "out", "LiFi key 'out' — verified via li.quest /v1/chains + live quote (2026-09-05)");
  assert.equal(c.chainId, 4663, "chainId 4663 = 0x1237 (chainid.network + live RPC eth_chainId both agree)");
  assert.equal(c.walletType, "evm", "EVM source — LiFi/Warp rail");
  assert.ok(c.color && c.glyph, "display color + glyph present");
  assert.ok(EVM_CHAINS.includes("rh"), "rh is in EVM_CHAINS → console pickers surface it");
  assert.equal(EVM_CHAINS[0], "eth", "display order stable (eth first)");
  assert.equal(EVM_CHAINS[EVM_CHAINS.length - 1], "rh", "rh appended last (stable picker order)");
});

// ── TOKENS entry (the honesty test — no fake USDC) ──────────────────────────

test("robinhood chain: TOKENS.rh is exactly { USDG } — no fake USDC/USDT/DAI", () => {
  const t = TOKENS.rh;
  assert.ok(t, "TOKENS.rh exists");
  // The ONLY canonical stable on Robinhood Chain is Paxos USDG (official
  // docs Token Contracts page + LiFi chain-4663 tokenlist, 2026-09-05).
  assert.deepEqual(Object.keys(t), ["USDG"], "no invented USDC/USDT/DAI entries");
  assert.equal(t.USDG.decimals, 6);
  assert.equal(t.USDG.address, USDG_4663);
  assert.match(t.USDG.address, /^0x[0-9a-fA-F]{40}$/, "checksum-shaped EVM address");
  assert.equal(tokensFor("rh").length, 1);
  assert.deepEqual(tokensFor("rh"), ["USDG"]);
  // Cross-check the address against the LiFi chain-4663 token list entry —
  // same contract, 6 decimals, symbol USDG (recorded in the fixture README).
  assert.equal(tokensOn("rh")[0], "USDG");
});

// ── Rail integration ────────────────────────────────────────────────────────

test("robinhood chain: rail layer routes rh → LiFi/Warp, wallet-connect execution", () => {
  assert.ok(SOURCE_CHAINS.includes("rh"), "rh in the console source union");
  const r = pickRail({ fromChain: "rh" });
  assert.equal(r.rail, RAIL.LIFI_WARP, "rh → lifi-warp rail (the EVM→X1 hop rail)");
  assert.equal(r.execution, EXECUTION.WALLET_CONNECT, "rh → wallet-connect execution");
  assert.equal(chainName("rh"), "Robinhood Chain");
  assert.ok(chainGlyph("rh").length > 0, "rh has a glyph");
});

// ── Quote builder (the X1 hop's leg 1: EVM → Solana) ────────────────────────

test("robinhood chain: buildLifiQuoteParams emits the correct LiFi query (USDG → Solana USDC)", () => {
  const built = buildLifiQuoteParams({
    from: "rh",
    token: "USDG",
    amount: 100,
    fromAddress: EVM_ADDR,
    toAddress: SOL_ADDR,
  });
  assert.ok(built, "builder accepts rh/USDG with real wallet addresses");
  assert.equal(built.decimals, 6);
  const q = built.qs;
  assert.equal(q.get("fromChain"), "out", "lifiKey 'out' goes to li.quest as fromChain");
  assert.equal(q.get("toChain"), "SOL", "leg 1 lands on Solana (the Warp hop's side)");
  assert.equal(q.get("fromToken"), USDG_4663);
  assert.equal(q.get("toToken"), "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "lands Solana USDC");
  assert.equal(q.get("fromAmount"), "100000000", "$100 USDG @ 6 dec = 100000000 base units");
  assert.equal(q.get("x1Class"), "1", "x1-class marker set (server fee policy: no integrator fee on x1-class)");
  assert.equal(q.get("allowSwitchChain"), "false");
  // no wallet → null (the no-placeholders rule — funds can never route to a
  // placeholder address, rh or not)
  assert.equal(
    buildLifiQuoteParams({ from: "rh", token: "USDG", amount: 100, fromAddress: null, toAddress: SOL_ADDR }),
    null,
  );
});

test("robinhood chain: unknown rh token → null (no invented tokens)", () => {
  assert.equal(
    buildLifiQuoteParams({
      from: "rh", token: "USDC", amount: 100, fromAddress: EVM_ADDR, toAddress: SOL_ADDR,
    }),
    null,
    "USDC is not on Robinhood Chain — the builder must refuse, not guess",
  );
});

// ── Simulated-quote fixture evidence (structure only — read-only captures) ──

test("robinhood chain: simulated-quote fixtures are structurally sound li.quest responses", () => {
  const fwd = JSON.parse(
    readFileSync(new URL("quote-usdg-4663-to-sol-usdc-100.json", RH_LEG), "utf8"),
  );
  assert.equal(fwd.type, "lifi");
  assert.equal(fwd.tool, "relaydepository", "Relay serves USDG(4663)→Solana USDC");
  assert.equal(fwd.action.fromToken.address, USDG_4663);
  assert.equal(fwd.action.fromToken.chainId, 4663);
  assert.equal(fwd.action.toToken.symbol, "USDC");
  assert.ok(Number(fwd.estimate.toAmount) > 0, "forward estimate present");
  assert.ok(fwd.estimate.toAmountMin, "forward min present");
  assert.equal(fwd.estimate.approvalAddress, "0xB477751B76CF82d00a686A1232f5fCD772414Af3", "LiFi diamond on 4663");

  const rev = JSON.parse(
    readFileSync(new URL("quote-sol-usdc-to-usdg-4663-100.json", RH_LEG), "utf8"),
  );
  assert.equal(rev.type, "lifi");
  assert.equal(rev.action.fromToken.symbol, "USDC");
  assert.equal(rev.action.toToken.address, USDG_4663);
  assert.equal(rev.action.toToken.chainId, 4663);
  assert.ok(Number(rev.estimate.toAmount) > 0, "reverse estimate present");

  // Honesty guard: fixture dir carries a README that labels these SIMULATED
  // (read-only quotes, no live tx). If the label ever disappears, fail loud.
  const readme = readFileSync(new URL("README.md", RH_LEG), "utf8");
  assert.match(readme, /SIMULATED/i, "fixture README keeps the synthetic label");
  assert.match(readme, /NO LIVE TRANSACTION/i);
});
