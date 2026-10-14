/**
 * depositBuildLeg.js — the THORChain DEPOSIT-BUILD leg of the THORChain
 * route (Phase 3: the deposit-address lane BTC/DOGE/LTC/XRP → SOL.SOL — the
 * Buy/THORChain tab). This leg is the engine home of the deposit stage's
 * deposit construction (THORChainDeposit — Steps 3.2 + 3.3): the THORChain
 * VAULT address for the selected source chain (from the normalized
 * /thorchain/inbound_addresses snapshot) + the deposit MEMO in THORNode
 * SwapMemo.String() scheme.
 *
 * WHAT IS APP-CONSTRUCTED vs WHAT HAPPENS OUT-OF-BAND (documented — the
 * golden step2 fixture pins the split): the app constructs the deposit
 * PAYLOAD — the vault address to send to + the memo to attach. The deposit
 * transaction itself is executed OUT-OF-BAND in the user's OWN external
 * wallet (BTC/DOGE/LTC/XRP — the v1 deposit-address flow: the user sends
 * native coins attaching the memo, then pastes the inbound txid back). The
 * app NEVER signs or broadcasts the deposit — hence family "external": the
 * engine's single SignerResolver returns null for it by design, and the UI
 * surfaces the honest "send from your wallet" step (copy address + memo)
 * instead of a wallet prompt. The quote gate (a fresh quote MUST land
 * before the address is shown) and the refund-prefill live in the stage/UI
 * layer — this leg builds the payload given the already-gated state.
 *
 * REUSE (wrap, don't rewrite): parseInboundAddresses (normalization of the
 * refresh snapshot — src/lib/thorchain/inboundAddresses.js) + buildDepositMemo
 * / parseDepositMemo (src/lib/thorchain/memo.js) come from the PROVEN
 * modules, unchanged — the SAME functions THORChainDeposit calls. One
 * construction code path for the reference flow and the engine.
 *
 * ctx: { sourceChain ("BTC"|"DOGE"|"LTC"|"XRP"), byChain (normalized inbound
 *        entries keyed by chain — the createInboundAddressRefresher snapshot
 *        shape), destination (the Solana session pubkey — the PIN, never
 *        user-typed), refundAddress? }
 */
import { createLeg } from "../../legContract.js";
import {
  buildDepositMemo,
  parseDepositMemo,
  THORCHAIN_SOURCE_ASSETS,
} from "../../../lib/thorchain/memo.js";
import {
  THORCHAIN_AFFILIATE_NAME,
  THORCHAIN_AFFILIATE_BPS,
} from "../../../lib/thorchain/config.js";

/**
 * Shape the golden step2 artifact from the same pure functions the deposit
 * stage calls (by-chain vault selection → buildDepositMemo → parseDepositMemo)
 * — the EXACT shape test/fixtures/golden/thorchain-leg/step2-deposit-payload.json
 * records. Halted chains and chains with no entry THROW (mirror of the
 * reference UI's paused/no-address gates).
 *
 * @param {object} args
 * @param {string} args.sourceChain "BTC" | "DOGE" | "LTC" | "XRP"
 * @param {object} args.byChain normalized inbound entries keyed by chain
 * @param {string} args.destination the Solana session pubkey (the PIN)
 * @param {string|null} [args.refundAddress] source-chain refund address
 *   (null/empty → no refund segment — THORNode refunds to the sender)
 * @returns {object} the fixture-shaped artifact
 * @throws when the chain is halted / missing / unknown
 */
export function shapeDepositPayloadArtifact({ sourceChain, byChain, destination, refundAddress = null }) {
  const fromAsset = THORCHAIN_SOURCE_ASSETS[sourceChain];
  if (!fromAsset) throw new Error(`shapeDepositPayloadArtifact: unknown sourceChain "${sourceChain}"`);
  const entry = byChain?.[sourceChain];
  if (!entry) {
    throw new Error(`shapeDepositPayloadArtifact: no inbound entry for ${sourceChain}`);
  }
  if (entry.halted === true) {
    throw new Error(`shapeDepositPayloadArtifact: ${sourceChain} is halted by THORChain — not selectable`);
  }

  const memo = buildDepositMemo({
    sourceChain,
    destAddress: destination,
    ...(refundAddress ? { refundAddress } : {}),
    // affiliate pair: only when the THORName placeholder is configured
    // (quoteLeg + the golden builders share the same config read).
    ...(THORCHAIN_AFFILIATE_NAME !== ""
      ? { affiliate: THORCHAIN_AFFILIATE_NAME, affiliateBps: THORCHAIN_AFFILIATE_BPS }
      : {}),
    // LIMIT (minimum-out) is NOT wired (documented in memo.js) — absent.
  });

  return {
    sourceChain,
    fromAsset,
    chain: entry.chain,
    destination,
    depositAddress: entry.address,
    halted: entry.halted === true,
    memo,
    memoParts: parseDepositMemo(memo),
  };
}

/**
 * Create the THORChain deposit-build leg.
 * ctx per phase:
 *   build: { sourceChain, byChain, destination, refundAddress? }
 */
export function createThorchainDepositBuildLeg() {
  return createLeg({
    id: "thorchain-deposit-build",
    family: "external",
    chain: "thorchain",
    description:
      "The THORChain deposit-build leg — the vault deposit address for the selected source " +
      "chain (inbound-addresses snapshot; halted chains blocked) + the deposit MEMO " +
      "`=:SOL.SOL:<solanaDest>[/<refund>]` (THORNode SwapMemo.String() scheme; destination " +
      "pinned to the Solana session pubkey). The deposit itself is sent OUT-OF-BAND from " +
      "the user's external wallet — family 'external', no in-app signer (golden step2).",
    goldenStep: "step2-deposit-payload",
    phases: {
      async build(ctx) {
        if (!ctx.sourceChain) throw new Error("thorchainDepositBuild.build: sourceChain is required");
        if (!ctx.byChain || typeof ctx.byChain !== "object") {
          throw new Error("thorchainDepositBuild.build: byChain (the normalized inbound snapshot) is required");
        }
        if (!ctx.destination) {
          throw new Error("thorchainDepositBuild.build: destination (the Solana session pubkey) is required");
        }
        const artifact = shapeDepositPayloadArtifact({
          sourceChain: ctx.sourceChain,
          byChain: ctx.byChain,
          destination: ctx.destination,
          refundAddress: ctx.refundAddress ?? null,
        });
        return { needed: true, artifact };
      },
    },
    meta: {
      wraps:
        "src/lib/thorchain/inboundAddresses.js parseInboundAddresses (the refresher snapshot " +
        "the stage feeds in) + src/lib/thorchain/memo.js buildDepositMemo / parseDepositMemo " +
        "— the deposit construction of THORChainDeposit, unchanged",
    },
  });
}
