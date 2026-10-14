/**
 * journeyReadout.test.js — the pure journey-readout model.
 *
 * Pins the itinerary to the ENGINE's route/leg contract: the hops a route
 * renders ARE the engine's travel legs (the leg ids come from
 * routePlanner.js FORWARD_LEG_IDS / REVERSE_LEG_IDS), the fee lines land on
 * the leg that charges them, and a liquidity-gate refusal flags the exact
 * blocked leg with the gate's reason. Pure — no DOM, no wallet, no fetch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildJourney,
  coordCode,
  makeStation,
  hopsMatchEngineLegs,
  JOURNEY_FORWARD_LEGS,
  JOURNEY_REVERSE_LEGS,
} from "./journeyReadout.js";
import { checkRouteLiquidity } from "./liquidityGate.js";

/** The fee lines the form's quote picture carries (fees.ts ids). */
const FEE_LINES = [
  { id: "warp-skim", label: "Teleporter fee (0.5%, max $250)", amountUsd: 0.5 },
  { id: "warp-flat", label: "Warp bridge fee ($1 flat)", amountUsd: 1 },
];
const QUOTE = { feeLines: FEE_LINES };

test("forward journey: the hops ARE the engine's travel legs, in engine order", () => {
  const j = buildJourney({ direction: "forward", from: "eth", token: "USDC", destToken: "USDC.x", amount: 100, quote: QUOTE });
  assert.deepEqual(j.legIds, ["lifi-evm-bridge", "warp-lock"]);
  assert.ok(hopsMatchEngineLegs(j), "every hop maps to a real forward leg id");
  assert.ok(j.legIds.every((id) => JOURNEY_FORWARD_LEGS.includes(id)), "leg ids are the engine contract");
  // source + destination coordinate stations
  assert.equal(j.source.name, "Ethereum");
  assert.equal(j.source.token, "USDC");
  assert.equal(j.dest.name, "X1");
  assert.equal(j.dest.token, "USDC.X");
});

test("forward USDC (the hub) is a bridge hop; the Warp leg carries the 0.5% skim + Warp fee", () => {
  const j = buildJourney({ direction: "forward", from: "eth", token: "USDC", destToken: "USDC.x", amount: 100, quote: QUOTE });
  const [lifi, warp] = j.hops;
  assert.equal(lifi.kind, "bridge", "USDC → USDC is a straight bridge (no DEX swap)");
  assert.equal(lifi.tool, "LiFi");
  assert.equal(warp.kind, "bridge");
  assert.equal(warp.tool, "Warp Bridge");
  assert.equal(warp.legId, "warp-lock");
  // The skim + Warp pass-through sit on the Warp leg — nowhere else.
  assert.deepEqual(warp.fees.map((f) => f.id), ["warp-skim", "warp-flat"]);
  assert.equal(lifi.fees.length, 0, "no fee on the LiFi leg (x1-class policy)");
});

test("forward a non-hub source is a SWAP hop (LiFi swap + bridge), distinct from the Warp bridge hop", () => {
  const j = buildJourney({ direction: "forward", from: "eth", token: "DAI", destToken: "USDC.x", amount: 100, quote: QUOTE });
  const [lifi] = j.hops;
  assert.equal(lifi.kind, "swap", "DAI is DEX-swapped into the bridgeable asset");
  assert.equal(lifi.action, "LiFi swap + bridge");
  assert.equal(lifi.from.token, "DAI");
  assert.equal(lifi.to.token, "USDC", "the LiFi leg lands the Warp twin on Solana");
  assert.equal(j.hops[1].kind, "bridge");
});

test("forward land-as wSOL.X drives the Solana landing token (WSOL)", () => {
  const j = buildJourney({ direction: "forward", from: "eth", token: "USDC", destToken: "wSOL.X", amount: 1, quote: QUOTE });
  assert.equal(j.hops[0].to.token, "WSOL", "USDC vs WSOL landing ⇒ a swap + bridge");
  assert.equal(j.hops[0].kind, "swap");
  assert.equal(j.dest.token, "WSOL.X");
});

test("reverse journey: burn → release → LiFi out, the engine's three legs in order", () => {
  const j = buildJourney({ direction: "reverse", to: "eth", token: "USDC", reverseToken: "USDC.x", amount: 100, quote: QUOTE });
  assert.deepEqual(j.legIds, ["x1-reverse-burn", "warp-release-wait", "lifi-solana-out"]);
  assert.ok(j.legIds.every((id) => JOURNEY_REVERSE_LEGS.includes(id)));
  assert.equal(j.hops[0].kind, "bridge");
  assert.equal(j.hops[0].tool, "Warp Bridge");
  assert.equal(j.hops[1].kind, "release", "the guardians release is its own automatic hop");
  assert.equal(j.hops[2].tool, "LiFi");
  // The skim + Warp fee land on the X1 BURN leg.
  assert.deepEqual(j.hops[0].fees.map((f) => f.id), ["warp-skim", "warp-flat"]);
  assert.equal(j.hops[2].fees.length, 0);
  assert.equal(j.source.name, "X1");
  assert.equal(j.dest.name, "Ethereum");
});

test("reverse to a non-hub stable (USDT) makes the LiFi-out leg a swap; USDC makes it a bridge", () => {
  const swap = buildJourney({ direction: "reverse", to: "eth", token: "USDT", reverseToken: "USDC.x", amount: 100, quote: QUOTE });
  assert.equal(swap.hops[2].kind, "swap", "released USDC → destination USDT needs a DEX swap");
  const bridge = buildJourney({ direction: "reverse", to: "eth", token: "USDC", reverseToken: "USDC.x", amount: 100, quote: QUOTE });
  assert.equal(bridge.hops[2].kind, "bridge");
});

test("liquidity gate: a thin SOURCE token blocks the swap leg with the gate's reason", () => {
  const liquidity = checkRouteLiquidity({ from: "sonic", to: "x1", srcToken: "USDT", dstToken: "USDC.x" });
  assert.equal(liquidity.ok, false, "sonic:USDT is refused by the real gate");
  const j = buildJourney({ direction: "forward", from: "sonic", token: "USDT", destToken: "USDC.x", amount: 100, quote: QUOTE, liquidity });
  assert.equal(j.blocked, true);
  const blocked = j.hops.find((h) => h.blocked);
  assert.ok(blocked, "the source leg's hop is flagged BLOCKED");
  assert.equal(blocked.legId, "lifi-evm-bridge", "the leg the gate refused");
  assert.match(blocked.blockedReason, /insufficient liquidity/i);
  assert.equal(j.source.blocked, true, "the source coordinate station is flagged too");
  assert.match(j.blockedReason, /insufficient liquidity/i);
});

test("liquidity gate: a thin DESTINATION token blocks the reverse LiFi-out leg", () => {
  const liquidity = checkRouteLiquidity({ from: "x1", to: "sonic", srcToken: "USDC.x", dstToken: "USDT" });
  assert.equal(liquidity.ok, false);
  const j = buildJourney({ direction: "reverse", to: "sonic", token: "USDT", reverseToken: "USDC.x", amount: 100, quote: QUOTE, liquidity });
  assert.equal(j.blocked, true);
  const blocked = j.hops.find((h) => h.blocked);
  assert.equal(blocked.legId, "lifi-solana-out");
  assert.equal(j.dest.blocked, true);
});

test("hub USDC is never blocked (the reliable path) — the gate clears", () => {
  const liquidity = checkRouteLiquidity({ from: "eth", to: "x1", srcToken: "USDC", dstToken: "USDC.x" });
  assert.equal(liquidity.ok, true);
  const j = buildJourney({ direction: "forward", from: "eth", token: "USDC", destToken: "USDC.x", amount: 100, quote: QUOTE, liquidity });
  assert.equal(j.blocked, false);
  assert.equal(j.hops.every((h) => !h.blocked), true);
});

test("no quote yet: the hops still compute from the selection (fees empty, live-rebuild ready)", () => {
  const j = buildJourney({ direction: "forward", from: "arb", token: "USDC", destToken: "USDC.x" });
  assert.equal(j.hops.length, 2);
  assert.equal(j.hops[1].fees.length, 0, "no quote ⇒ no fee badges");
  assert.equal(j.amount, null);
});

test("coordinates are deterministic grid stamps (stable across calls)", () => {
  assert.equal(coordCode("eth", "USDC"), coordCode("eth", "USDC"));
  assert.notEqual(coordCode("eth", "USDC"), coordCode("bsc", "USDC"));
  const s = makeStation("x1", "USDC.x");
  assert.equal(s.name, "X1");
  assert.match(s.coord, /·[0-9A-F]{4}$/);
});
