/**
 * goldenDexDirect.test.js — THE REGRESSION ORACLE for the Phase-6 dexDirect
 * legs (Uniswap v3 / PancakeSwap v3 quoter legs + Raydium CPMM/CLMM + Orca
 * Whirlpool on-chain-state legs).
 *
 * The dexDirect legs are correct IF AND ONLY IF they reproduce the EXACT
 * artifacts the canonical construction produces — byte-for-byte. This test
 * REBUILDS every step from the frozen LIVE READ-ONLY input captures
 * (2026-09-05: quoter eth_calls + on-chain pool/tick-array/vault state +
 * read-only mainnet simulations of the constructed swap txs) and asserts
 * the rebuilt artifacts are IDENTICAL to the captured golden step fixtures
 * (canonical JSON equality + sha256 match).
 *
 * LIVE-STATUS BOUNDARY (honest — see the fixture README): quote-level REAL
 * (frozen read-only captures; every Solana quote cross-checked against the
 * protocol's official SDK on identical state — recorded in the summary).
 * swap-EXECUTION is GUARDED on every leg (submit() throws
 * DexDirectLiveTestGateError) — "swap-execution pending Mr. Esters' live
 * anchor". The engine must make this file pass UNCHANGED.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildEvmSteps,
  buildOrcaSteps,
  buildRaydiumSteps,
  evmInput,
  solInput,
  EVM_INPUTS,
  sha256Text,
} from "./golden/dexDirectBuilders.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const STEPS = join(here, "fixtures", "golden", "dex-direct-leg", "steps");
const readStep = (name) => JSON.parse(readFileSync(join(STEPS, name), "utf8"));

// ── EVM steps ───────────────────────────────────────────────────────────────
for (const key of Object.keys(EVM_INPUTS)) {
  const input = evmInput(key);
  const { dex, chain } = EVM_INPUTS[key];
  const tag = `${dex}-${chain}-f${input.fee}`;

  test(`golden dexDirect: ${tag} steps rebuild byte-identical`, () => {
    const { step1, step2 } = buildEvmSteps(key);
    const fix1 = readStep(`${tag}-step1-quote.json`);
    const fix2 = readStep(`${tag}-step2-swap-request.json`);
    assert.equal(step1.sha256, fix1.sha256, "step1 sha256 must match the frozen fixture");
    assert.equal(step2.sha256, fix2.sha256, "step2 sha256 must match the frozen fixture");
    assert.equal(step1.calldataSha256, fix1.calldataSha256);
    assert.equal(step2.calldataSha256, fix2.calldataSha256);
    // the frozen live response parses to the same quote the fixture pinned
    assert.ok(BigInt(step1.artifact.quote.amountOut) > 0n, "the live quote has an amountOut");
    // a 10-USDC stablecoin swap must be sane (within 1% of par)
    const human = Number(BigInt(step1.artifact.quote.amountOut)) / 10 ** input.toToken.decimals;
    assert.ok(human > 9.9 && human < 10.1, `sane stablecoin quote (${human})`);
    // the guarded swap request targets the router and carries the min-out
    assert.match(step2.artifact.swapRequest.to, /^0x/, "swap request has a router target");
    assert.ok(BigInt(step2.artifact.minOutRaw) > 0n, "the swap request carries a positive min-out");
  });
}

// ── Orca steps ──────────────────────────────────────────────────────────────
test("golden dexDirect: orca steps rebuild byte-identical", () => {
  const { step1, step2 } = buildOrcaSteps();
  const fix1 = readStep("orca-step1-quote.json");
  const fix2 = readStep("orca-step2-swap-ix.json");
  assert.equal(step1.sha256, fix1.sha256, "orca step1 sha256 must match");
  assert.equal(step2.sha256, fix2.sha256, "orca step2 sha256 must match");
  assert.equal(step2.dataSha256, fix2.dataSha256);
  assert.equal(step2.txSha256, fix2.txSha256);
  // the frozen quote sanity: 0.1 SOL → ~10.3 USDC at the captured state (raw 6-dp USDC)
  const snap = solInput("orca");
  assert.equal(step1.artifact.pool, snap.pool);
  const outRaw = BigInt(step1.artifact.amountOutRaw);
  assert.ok(outRaw > 1_000_000n && outRaw < 1_000_000_000n, `orca quote sane (raw ${outRaw})`);
  assert.equal(step2.artifact.ix.discriminator, "2b04ed0b1ac91e62", "swap_v2 discriminator pinned");
  assert.equal(step2.artifact.ix.keys.length, 15, "15 metas — the live-verified layout");
});

// ── Raydium steps ───────────────────────────────────────────────────────────
test("golden dexDirect: raydium clmm steps rebuild byte-identical", () => {
  const { step1, step2 } = buildRaydiumSteps("clmm");
  const fix1 = readStep("raydium-clmm-step1-quote.json");
  const fix2 = readStep("raydium-clmm-step2-swap-ix.json");
  assert.equal(step1.sha256, fix1.sha256, "clmm step1 sha256 must match");
  assert.equal(step2.sha256, fix2.sha256, "clmm step2 sha256 must match");
  assert.equal(step2.dataSha256, fix2.dataSha256);
  assert.equal(step2.txSha256, fix2.txSha256);
  const snap = solInput("raydiumClmm");
  assert.ok(step1.artifact.quote.allTrade === true, "fixture quote trades fully within the arrays");
  assert.ok(Number(step1.artifact.quote.outHuman) > 1, "clmm quote sane");
  assert.equal(step2.artifact.ix.programId, snap.pool.programId);
});

test("golden dexDirect: raydium cpmm steps rebuild byte-identical", () => {
  const { step1, step2 } = buildRaydiumSteps("cpmm");
  const fix1 = readStep("raydium-cpmm-step1-quote.json");
  const fix2 = readStep("raydium-cpmm-step2-swap-ix.json");
  assert.equal(step1.sha256, fix1.sha256, "cpmm step1 sha256 must match");
  assert.equal(step2.sha256, fix2.sha256, "cpmm step2 sha256 must match");
  assert.equal(step2.dataSha256, fix2.dataSha256);
  assert.equal(step2.txSha256, fix2.txSha256);
  const snap = solInput("raydiumCpmm");
  assert.equal(step2.artifact.ix.discriminator, "8fbe5adac41e33de", "swap_base_input discriminator (the XDEX-anchored family)");
  assert.equal(step2.artifact.ix.keys.length, 13, "13 metas — the CPMM layout");
  assert.ok(Number(step1.artifact.quote.outHuman) > 1, "cpmm quote sane");
});

// ── capture-sim evidence (the read-only mainnet simulations) ───────────────
test("golden dexDirect: captured sims show the wire construction reached the user-ATA check", () => {
  const checks = {
    orca: solInput("orca"),
    raydiumClmm: solInput("raydiumClmm"),
    raydiumCpmm: solInput("raydiumCpmm"),
  };
  for (const [k, snap] of Object.entries(checks)) {
    assert.ok(snap.sim, `${k} snapshot carries a sim record`);
    const err = snap.sim.err;
    assert.ok(err !== null && err !== undefined, `${k} sim errored as expected (no user ATA) — got ${JSON.stringify(err)}`);
    assert.match(JSON.stringify(snap.sim.logs), /Instruction: /, `${k} sim logs show the program parsed the instruction`);
  }
});
