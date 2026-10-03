/**
 * engineDex.test.js — engine-side coverage for the Phase-4 DEX swap legs
 * (additive — the golden oracle test/goldenDex.test.js stays the ruler;
 * this file covers the ENGINE mechanics the oracle doesn't: leg factories,
 * planner shape + the swap-then-bridge composition primitive, the runLeg
 * lifecycle over each dex leg, SignerResolver family mapping, and a
 * byte-identity pass that runs the LEGS' own build() against the golden
 * fixtures (same sha256s the oracle asserts via the shared builders).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RoutePlanner,
  planJupiterSwap,
  planXdexSwap,
  planLifiEvmSwap,
  composeRoute,
  legById,
  legsForStage,
  plan,
  runLeg,
  createLeg,
} from "../src/engine/index.js";
import { resolveSigner } from "../src/engine/signerResolver.js";
import {
  JUPITER_SAMPLE,
  XDEX_SAMPLE,
  LIFI_SWAP_SAMPLE,
  xdexSnapshotInput,
  jupiterQuoteInput,
  SOLANA_ADDRESS,
  EVM_ADDRESS,
} from "./golden/dexLegBuilders.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "fixtures", "golden", "dex-leg");
const read = (name) => JSON.parse(readFileSync(join(FIX, name), "utf8"));
const FIX_JUP1 = read("jupiter-step1-quote-request.json");
const FIX_JUP2 = read("jupiter-step2-swap-request.json");
const FIX_XD1 = read("xdex-step1-swap-quote.json");
const FIX_XD2 = read("xdex-step2-swap-ix.json");
const FIX_LIFI1 = read("lifi-step1-samechain-swap-request.json");

// ── Route shapes: the three DEX plans ──
test("engine dex: the three DEX swap routes plan with the right shape (legs/stages/families)", () => {
  const j = planJupiterSwap();
  assert.equal(j.id, "swap-sol-sol-jupiter");
  assert.equal(j.direction, "swap");
  assert.equal(j.sourceChain, "sol");
  assert.equal(j.destChain, "sol");
  assert.deepEqual(j.legs.map((l) => l.id), ["jupiter-swap"]);
  assert.equal(j.legs[0].family, "svm"); // Solana signer via the single SignerResolver
  assert.equal(j.legs[0].chain, "sol");

  const x = planXdexSwap();
  assert.equal(x.id, "swap-x1-x1-xdex");
  assert.equal(x.direction, "swap");
  assert.equal(x.sourceChain, "x1");
  assert.deepEqual(x.legs.map((l) => l.id), ["xdex-swap"]);
  assert.equal(x.legs[0].family, "svm"); // X1 is SVM-compatible — same resolver family
  assert.equal(x.legs[0].chain, "x1");

  const l = planLifiEvmSwap();
  assert.equal(l.id, "swap-eth-eth-lifi");
  assert.equal(l.direction, "swap");
  assert.deepEqual(l.legs.map((l) => l.id), ["lifi-evm-swap"]);
  assert.equal(l.legs[0].family, "evm"); // EIP-1193 — same family as the forward bridge leg

  // plan() dispatch: direction "swap" + via.
  assert.equal(plan({ direction: "swap", via: "jupiter" }).id, "swap-sol-sol-jupiter");
  assert.equal(plan({ direction: "swap", via: "xdex" }).id, "swap-x1-x1-xdex");
  assert.equal(plan({ direction: "swap", via: "lifi", chain: "polygon" }).id, "swap-polygon-polygon-lifi");
  assert.equal(plan({ direction: "swap", via: "unknown" }), null);
  assert.equal(plan({ direction: "dex" }), null); // pre-Phase-4 directions stay null
});

// ── The composition primitive: "swap then bridge" ──
test("engine dex: composeRoute expresses swap-then-bridge (leg order + stage re-keying)", () => {
  const composed = composeRoute(planJupiterSwap(), planLifiEvmSwap(), {
    id: "swap-sol-eth-via-jupiter-lifi",
  });
  // The Jupiter swap leg runs FIRST, then the LiFi legs (the planner's
  // composition contract: swap → bridge).
  assert.deepEqual(composed.legs.map((l) => l.id), ["jupiter-swap", "lifi-evm-swap"]);
  assert.equal(composed.sourceChain, "sol");
  assert.equal(composed.destChain, "eth");
  assert.deepEqual(composed.composedOf, ["swap-sol-sol-jupiter", "swap-eth-eth-lifi"]);
  // Both stage sets survive, re-keyed under the composed prefix.
  const stageKeys = Object.keys(composed.stages);
  assert.ok(stageKeys.includes("composed-a-swap"));
  assert.ok(stageKeys.includes("composed-b-swap"));
  assert.deepEqual(legsForStage(composed, "composed-a-swap").map((l) => l.id), ["jupiter-swap"]);

  // The canonical documented use: the THORChain post-landing auto-advance
  // (SOL lands → swap SOL→USDC on Jupiter → Warp hop into X1) is the swap
  // route composed in front of the forward route.
  const autoAdvance = composeRoute(planJupiterSwap(), RoutePlanner.planForward(), {
    id: "forward-sol-x1-via-jupiter",
  });
  assert.deepEqual(
    autoAdvance.legs.map((l) => l.id),
    ["jupiter-swap", "evm-approval", "lifi-evm-bridge", "x1-ata-create", "warp-lock"],
  );
  assert.deepEqual(legsForStage(autoAdvance, "composed-a-swap").map((l) => l.id), ["jupiter-swap"]);
  assert.deepEqual(legsForStage(autoAdvance, "composed-b-svm").map((l) => l.id), ["x1-ata-create", "warp-lock"]);
  assert.throws(() => composeRoute({ legs: [] }, RoutePlanner.planForward()), /both routes must have legs/);
});

// ── runLeg lifecycle: each dex leg builds through the LegContract ──
test("engine dex: jupiter-swap leg builds through runLeg (byte-identical to the golden fixture)", async () => {
  const route = planJupiterSwap();
  const leg = legById(route, "jupiter-swap");
  const ctx = {
    inputMint: JUPITER_SAMPLE.inputMint,
    outputMint: JUPITER_SAMPLE.outputMint,
    amount: JUPITER_SAMPLE.amount,
    slippageBps: JUPITER_SAMPLE.slippageBps,
    quote: jupiterQuoteInput(),
    userPublicKey: JUPITER_SAMPLE.userPublicKey,
  };
  const { legId, results, stoppedAt } = await runLeg(leg, ctx);
  assert.equal(legId, "jupiter-swap");
  assert.equal(stoppedAt, null);
  const artifact = results.build.artifact;
  // step1 byte-identity against the golden fixture…
  assert.deepEqual(JSON.parse(JSON.stringify(artifact.url)), FIX_JUP1.artifact.url);
  assert.equal(artifact.url, FIX_JUP1.artifact.url);
  // …and step2 (the swap request) byte-identity.
  assert.equal(artifact.step2SwapRequest.url, FIX_JUP2.artifact.url);
  assert.equal(
    JSON.stringify(artifact.step2SwapRequest.body),
    JSON.stringify(FIX_JUP2.artifact.body),
  );
});

test("engine dex: xdex-swap leg builds through runLeg (byte-identical to the golden fixture)", async () => {
  const route = planXdexSwap();
  const leg = legById(route, "xdex-swap");
  const ctx = {
    snapshot: xdexSnapshotInput(),
    userPubkey: XDEX_SAMPLE.userPubkey,
    inputMint: XDEX_SAMPLE.inputMint,
    amountInRaw: XDEX_SAMPLE.amountInRaw,
    slippageBps: XDEX_SAMPLE.slippageBps,
    blockhash: XDEX_SAMPLE.blockhash,
  };
  const { results } = await runLeg(leg, ctx);
  const artifact = results.build.artifact;
  assert.equal(artifact.discriminator, "8fbe5adac41e33de"); // LIVE-VERIFIED (anchor tx 65xjdHVd…)
  assert.equal(artifact.quote.outRaw, FIX_XD1.artifact.outRaw);
  assert.equal(artifact.ix.dataHex, FIX_XD2.artifact.ix.dataHex);
  assert.deepEqual(artifact.ix.keys, FIX_XD2.artifact.ix.keys);
  assert.equal(artifact.transaction.serializedBase64, FIX_XD2.artifact.transaction.serializedBase64);
});

test("engine dex: lifi-evm-swap leg builds through runLeg (byte-identical to the golden fixture)", async () => {
  const route = planLifiEvmSwap();
  const leg = legById(route, "lifi-evm-swap");
  const ctx = {
    chain: LIFI_SWAP_SAMPLE.chain,
    fromToken: LIFI_SWAP_SAMPLE.fromToken,
    toToken: LIFI_SWAP_SAMPLE.toToken,
    amount: LIFI_SWAP_SAMPLE.amount,
    fromAddress: LIFI_SWAP_SAMPLE.fromAddress,
    toAddress: LIFI_SWAP_SAMPLE.toAddress,
  };
  const { results } = await runLeg(leg, ctx);
  const artifact = results.build.artifact;
  assert.equal(artifact.upstreamUrl, FIX_LIFI1.artifact.upstreamUrl);
  assert.equal(artifact.policy.forcedFee, "0.005"); // same-chain → 0.5% integrator forced (fee-model v2)
});

// ── Leg validation + signer family mapping ──
test("engine dex: the dex legs reject missing ctx and map families through the SignerResolver", async () => {
  // A leg without its required ctx fails closed at build.
  const jupLeg = createLeg({
    id: "probe-jupiter",
    family: "svm",
    phases: { async build() { throw new Error("nope"); } },
  });
  await assert.rejects(() => runLeg(jupLeg, {}), /nope/);

  // The dex families resolve through the engine's single SignerResolver:
  // svm → null for a mock session with no signing surface (fail-soft),
  // exactly like the Phase-1/2 svm legs (resolveSolanaAdapter's contract).
  const svmSession = { provider: { adapter: null } };
  assert.equal(await resolveSigner("svm", svmSession), null);
  const evmSession = { provider: { getProvider: () => null } };
  assert.equal(await resolveSigner("evm", evmSession), null);
  // Families are the SAME enum the forward/reverse legs use — no new family.
  assert.equal(planXdexSwap().legs[0].family, "svm");
  assert.equal(planJupiterSwap().legs[0].family, "svm");
  assert.equal(planLifiEvmSwap().legs[0].family, "evm");
});
