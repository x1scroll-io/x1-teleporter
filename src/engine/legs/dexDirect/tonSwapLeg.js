/**
 * tonSwapLeg.js — the TON / STON.FI DEX-DIRECT swap leg (the dexDirect
 * family's TON leg).
 *
 * WHAT THIS LEG IS
 *   A DEX-DIRECT leg: the app can swap DIRECTLY through STON.fi — the on-chain
 *   AMM whose v1 Router is `EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt`
 *   (verified from the protocol's own @ston-fi/sdk `DEX.v1.Router.address`;
 *   see docs/NEAR-TON-DEX-RESEARCH.md §2–§3).
 *
 *   The build uses the OFFICIAL @ston-fi/sdk Router builders, DI-injected into
 *   the leg so it is offline-testable and never fires a network request on its
 *   own:
 *     Router.getSwapJettonToJettonTxParams(provider, params) → SenderArguments
 *     Router.getSwapJettonToTonTxParams(provider, params)    → SenderArguments
 *     Router.getSwapTonToJettonTxParams(provider, params)    → SenderArguments
 *       where SenderArguments = { to: Address, value: bigint, body: Cell }.
 *     Router.createSwapBody({ userWalletAddress, minAskAmount,
 *       askJettonWalletAddress, referralAddress? }) → Cell  (the v1 swap body,
 *       op 0x25938561 — PURE/offline; used by the jetton-transfer wrappers).
 *   Native TON is represented by proxyTON (pTON); the SDK resolves pTON v1.
 *
 * 🔴 FUNDS RULE — the build PRODUCES `{ to, value, body }` message(s); it
 *    NEVER signs, broadcasts, or calls sendTransaction. The tonSignable layer
 *    converts them to TON Connect messages and the anchor harness hands them
 *    to Mr. Esters' TON wallet (tonConnectUI.sendTransaction). submit() ALWAYS
 *    throws DexDirectLiveTestGateError — the agent CANNOT broadcast.
 *
 * ctx (build): { op: "jetton-to-jetton"|"jetton-to-ton"|"ton-to-jetton",
 *   router, provider, params, quote? }
 *   router   = a @ston-fi/sdk DEX.v1.Router (or a compatible fake);
 *   provider = a @ton/ton ContractProvider (the reader the router calls);
 *   params   = the matching getSwap*TxParams argument object.
 */
import { createLeg } from "../../legContract.js";
import { DexDirectLiveTestGateError, DEX_DIRECT_LIVE_TEST_GATE_MESSAGE } from "./liveTestGate.js";
import { senderArgumentsToMessage } from "./tonSignable.js";

/** The STON.fi v1 Router — the swap entry point (registry-verified). */
export const STONFI_ROUTER_V1_ADDRESS = "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt";
/** The DeDust mainnet Factory — the fallback entry point (DeDust has no router). */
export const DEDUST_FACTORY_ADDRESS = "EQBfBWT7X2BHg9tXAxzhz2aKiNTU1tpt5NsiK0uSDW_YAJ67";

/** The STON.fi v1 swap body op (VERIFIED: createSwapBody's first uint32). */
export const STONFI_SWAP_OP = 0x25938561;

/** op key → the RouterV1 builder method it dispatches to. */
export const STONFI_SWAP_OPS = Object.freeze({
  "jetton-to-jetton": "getSwapJettonToJettonTxParams",
  "jetton-to-ton": "getSwapJettonToTonTxParams",
  "ton-to-jetton": "getSwapTonToJettonTxParams",
});

/**
 * Build the swap body Cell through the OFFICIAL SDK (pure/offline — no
 * provider needed). Thin wrapper so the leg/test call the SDK's own builder.
 * @param {object} router a @ston-fi/sdk DEX.v1.Router
 * @param {object} params { userWalletAddress, minAskAmount,
 *   askJettonWalletAddress, referralAddress? }
 * @returns {Promise<object>} a @ton/core Cell
 */
export async function buildStonfiSwapBody(router, params) {
  if (!router || typeof router.createSwapBody !== "function") {
    throw new Error("tonSwapLeg.buildStonfiSwapBody: a STON.fi router with createSwapBody is required");
  }
  return router.createSwapBody(params);
}

/**
 * Build the TON swap artifact via the injected router. Async (the router's
 * builder may resolve jetton wallet addresses through the provider).
 * NO broadcast.
 *
 * @param {object} args { op, router, provider, params, quote? }
 * @returns {Promise<object>} { venue, chain, router, op, messages, quote,
 *   boundary }
 */
export async function buildTonSwapArtifact({ op, router, provider, params, quote = null } = {}) {
  const method = STONFI_SWAP_OPS[op];
  if (!method) {
    throw new Error('tonSwapLeg.build: op must be "jetton-to-jetton" | "jetton-to-ton" | "ton-to-jetton"');
  }
  if (!router || typeof router[method] !== "function") {
    throw new Error(`tonSwapLeg.build: the injected router has no ${method}`);
  }
  const senderArgs = await router[method](provider, params);
  const messages = [senderArgumentsToMessage(senderArgs)];
  return {
    venue: "stonfi",
    chain: "ton",
    router: STONFI_ROUTER_V1_ADDRESS,
    op,
    method,
    messages,
    quote,
    boundary:
      "produce-only: these are TON Connect messages ({address, amount, payload}) for the connected TON " +
      "wallet to sign (tonConnectUI.sendTransaction). The agent never broadcasts.",
  };
}

/**
 * Create the TON DEX-direct swap leg (STON.fi).
 * ctx per phase:
 *   build:  { op, router, provider, params, quote? }
 *   submit: 🔴 always throws DexDirectLiveTestGateError.
 */
export function createTonSwapLeg() {
  return createLeg({
    id: "ton-swap",
    family: "ton",
    chain: "ton",
    description:
      "The TON DEX-direct swap leg (STON.fi — v1 Router " +
      "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt, verified from the @ston-fi/sdk). Uses the " +
      "OFFICIAL SDK Router builders (getSwapJettonToJetton / JettonToTon / TonToJetton TxParams; " +
      "body op 0x25938561) to produce { to, value, body } messages — native TON routes via " +
      "proxyTON (pTON). tonSignable converts them to TON Connect messages for the connected " +
      "wallet (tonConnectUI.sendTransaction). 🔴 NO-BROADCAST GATE: submit() always throws " +
      "DexDirectLiveTestGateError — the agent CANNOT broadcast; sign in your wallet. " +
      "Swap-execution pending Mr. Esters' live anchor.",
    phases: {
      async build(ctx) {
        const artifact = await buildTonSwapArtifact({
          op: ctx.op,
          router: ctx.router,
          provider: ctx.provider,
          params: ctx.params,
          ...(ctx.quote !== undefined ? { quote: ctx.quote } : {}),
        });
        return { needed: true, artifact };
      },
      // 🔴 THE GUARD — the honest live-anchor boundary (never signs/broadcasts).
      async submit() {
        throw new DexDirectLiveTestGateError(DEX_DIRECT_LIVE_TEST_GATE_MESSAGE);
      },
    },
    meta: {
      wraps:
        "GREENFIELD DIRECT integration (STON.fi mainnet): v1 Router " +
        "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt. Build via the official @ston-fi/sdk " +
        "Router (getSwap*TxParams → { to, value, body }; swap body op 0x25938561); native TON " +
        "via pTON. Output = TON Connect messages; the connected TON wallet signs + submits. " +
        "No autonomous broadcast at any flag value. Fallback venue (no leg yet): DeDust Factory " +
        "EQBfBWT7X2BHg9tXAxzhz2aKiNTU1tpt5NsiK0uSDW_YAJ67.",
      liveTestAnchor: "ton-swap-execution",
    },
  });
}

/** The TON leg's SIGNABLE execute planner (see tonSignable.planTonExecute). */
export { planTonExecute } from "./tonSignable.js";
