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
  RANGO_CHAIN_IDS,
  SOURCE_CHAINS,
  isNativeChain,
  isRangoChain,
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
    assert.equal(r.rail, RAIL.THORCHAIN, `${c} → thorchain rail (first candidate)`);
    assert.equal(r.execution, EXECUTION.DEPOSIT_ADDRESS, `${c} → deposit-address execution`);
    assert.equal(executionFor(r.rail), EXECUTION.DEPOSIT_ADDRESS);
    assert.equal(isReverse({ fromChain: c }), false, "native sources are forward (to X1)");
    assert.equal(isToX1({ fromChain: c }), true);
  }
});

test("rail layer: Rango-native sources (SUI/TRON) pick the Rango rail with wallet-connect execution", () => {
  for (const c of RANGO_CHAIN_IDS) {
    assert.equal(isRangoChain(c), true, `${c} is a Rango-native chain`);
    const r = pickRail({ fromChain: c });
    assert.equal(r.rail, RAIL.RANGO, `${c} → rango rail (THORChain can't serve it)`);
    assert.equal(r.execution, EXECUTION.WALLET_CONNECT, `${c} → wallet-connect execution`);
    assert.equal(executionFor(r.rail), EXECUTION.WALLET_CONNECT);
    assert.equal(isNativeChain(c), false, `${c} is not a THORChain native`);
  }
  assert.equal(chainName("sui"), "Sui");
  assert.equal(chainName("tron"), "Tron");
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

test("rail layer: silent failover — an unavailable top rail falls through the priority candidates (Phase 5: Rango is the native fallback)", () => {
  // Phase 5 (the SOL-halt lesson): the native candidates are now ordered
  // [THORChain, Rango]. Marking THORChain unavailable must fall through to
  // Rango — never to null while a serving candidate remains.
  for (const c of NATIVE_CHAIN_IDS) {
    const candidates = railCandidates({ fromChain: c });
    assert.equal(candidates.length, 2, `${c} has two candidates (thorchain + rango fallback)`);
    assert.equal(candidates[0].rail, RAIL.THORCHAIN);
    assert.equal(candidates[1].rail, RAIL.RANGO, `${c}: rango is the fallback candidate`);
    const r = pickRail({ fromChain: c, unavailableRails: new Set([RAIL.THORCHAIN]) });
    assert.equal(r.rail, RAIL.RANGO, `${c}: thorchain halt → silent failover to rango`);
    assert.equal(r.execution, EXECUTION.WALLET_CONNECT);
    // Both unavailable → the honest dead-end (caller surfaces "no route").
    const dead = pickRail({ fromChain: c, unavailableRails: new Set([RAIL.THORCHAIN, RAIL.RANGO]) });
    assert.equal(dead.rail, null, `${c}: no serving rail when both candidates are unavailable`);
    assert.equal(dead.execution, null);
  }
  const evm = pickRail({ fromChain: "eth", unavailableRails: new Set([RAIL.LIFI_WARP]) });
  assert.equal(evm.rail, null, "eth: no serving rail when lifi-warp is unavailable");
  // Unavailability of the OTHER rail never disturbs a source's serving rail.
  const btc = pickRail({ fromChain: "btc", unavailableRails: new Set([RAIL.LIFI_WARP]) });
  assert.equal(btc.rail, RAIL.THORCHAIN, "btc unaffected by lifi-warp unavailability");
  const sui = pickRail({ fromChain: "sui", unavailableRails: new Set([RAIL.THORCHAIN]) });
  assert.equal(sui.rail, RAIL.RANGO, "sui unaffected by thorchain unavailability (rango is its only rail)");
  const suiDead = pickRail({ fromChain: "sui", unavailableRails: new Set([RAIL.RANGO]) });
  assert.equal(suiDead.rail, null, "sui: no serving rail when rango is unavailable");
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
  assert.equal(RAIL_LABELS[RAIL.RANGO], "Rango");
  assert.equal(isNativeChain("btc"), true);
  assert.equal(isNativeChain("eth"), false);
  assert.equal(isNativeChain("x1"), false);
  assert.equal(isRangoChain("sui"), true);
  assert.equal(isRangoChain("btc"), false);
  assert.equal(isRangoChain("eth"), false);
});
