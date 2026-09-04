/**
 * teleportRail.test.js — the rail-selection layer (the unified console's
 * invisible engine-path picker).
 *
 * Proves: native sources (BTC/DOGE/LTC/XRP) always route to the THORChain
 * engine path with deposit-address execution; EVM-chain stables and X1
 * tokens route to the LiFi/Warp path with wallet-connect execution; the
 * failover chain is priority-ordered and silent; and the source-asset union
 * covers every option the console offers (EVM chains + natives + X1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RAIL,
  EXECUTION,
  RAIL_LABELS,
  NATIVE_CHAINS,
  NATIVE_CHAIN_IDS,
  SOURCE_CHAINS,
  isNativeChain,
  chainName,
  chainGlyph,
  tokensOn,
  railCandidates,
  pickRail,
  executionFor,
  isReverse,
  isToX1,
} from "./teleportRail.js";

test("rail layer: native sources pick the THORChain engine path with deposit-address execution (never shown to the user)", () => {
  for (const c of NATIVE_CHAIN_IDS) {
    const r = pickRail({ fromChain: c });
    assert.equal(r.rail, RAIL.THORCHAIN, `${c} → thorchain rail`);
    assert.equal(r.execution, EXECUTION.DEPOSIT_ADDRESS, `${c} → deposit-address execution`);
    assert.equal(executionFor(r.rail), EXECUTION.DEPOSIT_ADDRESS);
    assert.equal(isReverse({ fromChain: c }), false, "native sources are forward (to X1)");
    assert.equal(isToX1({ fromChain: c }), true);
  }
});

test("rail layer: EVM-chain stables and X1 tokens pick the LiFi/Warp path with wallet-connect execution", () => {
  for (const c of ["eth", "arb", "bas", "bsc", "opt", "pol", "avax", "sonic"]) {
    const r = pickRail({ fromChain: c });
    assert.equal(r.rail, RAIL.LIFI_WARP, `${c} → lifi-warp rail`);
    assert.equal(r.execution, EXECUTION.WALLET_CONNECT, `${c} → wallet-connect execution`);
  }
  const x1 = pickRail({ fromChain: "x1" });
  assert.equal(x1.rail, RAIL.LIFI_WARP, "x1 → lifi-warp rail (the reverse off-ramp)");
  assert.equal(x1.execution, EXECUTION.WALLET_CONNECT);
  assert.equal(isReverse({ fromChain: "x1" }), true, "X1 source is the reverse off-ramp");
  assert.equal(isToX1({ fromChain: "x1" }), false);
});

test("rail layer: silent failover — an unavailable top rail falls through the priority candidates", () => {
  // Today each source has exactly one serving rail; the ordered candidate
  // list is the seam where a competing lane slots in. Marking a source's
  // only rail unavailable must yield NO rail (the caller then surfaces an
  // honest dead-end) rather than a wrong rail.
  for (const c of NATIVE_CHAIN_IDS) {
    const candidates = railCandidates({ fromChain: c });
    assert.equal(candidates.length, 1, `${c} has one candidate`);
    assert.equal(candidates[0].rail, RAIL.THORCHAIN);
    const r = pickRail({ fromChain: c, unavailableRails: new Set([RAIL.THORCHAIN]) });
    assert.equal(r.rail, null, `${c}: no serving rail when the only rail is unavailable`);
    assert.equal(r.execution, null);
  }
  const evm = pickRail({ fromChain: "eth", unavailableRails: new Set([RAIL.LIFI_WARP]) });
  assert.equal(evm.rail, null, "eth: no serving rail when lifi-warp is unavailable");
  // Unavailability of the OTHER rail never disturbs a source's serving rail.
  const btc = pickRail({ fromChain: "btc", unavailableRails: new Set([RAIL.LIFI_WARP]) });
  assert.equal(btc.rail, RAIL.THORCHAIN, "btc unaffected by lifi-warp unavailability");
});

test("rail layer: the source-asset union — EVM chains + native chains + X1, each with its token list", () => {
  assert.ok(SOURCE_CHAINS.includes("eth") && SOURCE_CHAINS.includes("x1"), "EVM + X1 present");
  for (const c of NATIVE_CHAIN_IDS) assert.ok(SOURCE_CHAINS.includes(c), `${c} in the union`);
  // Order: EVM chains first, natives in the middle, X1 last (the picker's
  // display order — stable for the harness).
  assert.equal(SOURCE_CHAINS[0], "eth");
  assert.equal(SOURCE_CHAINS[SOURCE_CHAINS.length - 1], "x1");
  // Native chains carry exactly their one asset; EVM chains their stables.
  assert.deepEqual(tokensOn("btc"), ["BTC"]);
  assert.deepEqual(tokensOn("doge"), ["DOGE"]);
  assert.deepEqual(tokensOn("ltc"), ["LTC"]);
  assert.deepEqual(tokensOn("xrp"), ["XRP"]);
  assert.ok(tokensOn("eth").includes("USDC") && tokensOn("eth").includes("USDT"));
  assert.ok(tokensOn("x1").includes("USDC.x") && tokensOn("x1").includes("wSOL.X"));
});

test("rail layer: display metadata covers every source option (names + glyphs, native included)", () => {
  for (const c of SOURCE_CHAINS) {
    const name = chainName(c);
    assert.ok(name.length > 0, `${c} has a name`);
    assert.ok(chainGlyph(c).length > 0, `${c} has a glyph`);
  }
  assert.equal(chainName("btc"), "Bitcoin");
  assert.equal(chainName("xrp"), "XRP");
  assert.equal(chainName("x1"), "X1");
  assert.equal(NATIVE_CHAINS.btc.family, "bitcoin");
  assert.equal(NATIVE_CHAINS.xrp.family, "xrp");
});

test("rail layer: internal rail labels exist for diagnostics only (never rendered)", () => {
  assert.equal(RAIL_LABELS[RAIL.THORCHAIN], "THORChain");
  assert.equal(RAIL_LABELS[RAIL.LIFI_WARP], "LiFi/Warp");
  assert.equal(isNativeChain("btc"), true);
  assert.equal(isNativeChain("eth"), false);
  assert.equal(isNativeChain("x1"), false);
});
