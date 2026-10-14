/**
 * thorchainLegBuilders.mjs — deterministic rebuild helpers for the
 * THORChain-leg golden fixtures (Phase 3 of the routing-engine migration).
 *
 * THE CONTRACT (mirror of test/golden/forwardLegBuilders.mjs +
 * test/golden/reverseLegBuilders.mjs)
 *   A routing engine will migrate the THORChain lane (BTC/DOGE/LTC/XRP →
 *   SOL.SOL deposit-address flow — the Buy/THORChain tab). It is correct
 *   IF AND ONLY IF, given the SAME inputs, it constructs the EXACT
 *   artifacts the current reference implementation constructs. This module
 *   is the single source of truth for the fixed sample input + the rebuild
 *   path: the capture script (tools/capture-thorchain-golden-fixtures.mjs)
 *   writes the fixtures from it, and test/goldenThorchain.test.js rebuilds
 *   from it and asserts byte-identity + sha256. The engine must make
 *   test/goldenThorchain.test.js pass UNCHANGED.
 *
 * WHAT THE THORCHAIN LANE CONSTRUCTS (the deposit-address flow — the v1
 *   lane, NOT the fork UI; per docs/BRIEF.md the swap.thorchain fork is a
 *   LOGIC SOURCE ONLY). The app NEVER signs or broadcasts the deposit
 *   itself — the user sends native BTC/DOGE/LTC/XRP from their OWN external
 *   wallet to the THORChain vault, attaching the memo, then pastes the
 *   txid back (THORChainDeposit). The app-constructed deterministic
 *   artifacts are therefore:
 *   1. THE QUOTE REQUEST — the canonical serialized request to OUR
 *      serverless proxy /api/thorchain/quote (src/lib/thorchain/quote.js
 *      quoteUrl — the client never holds the aggregator key; the proxy
 *      adds it server-side). Amounts in THORChain base units (1e8), the
 *      destination pinned to the connected Solana session pubkey, the
 *      affiliate pair OMITTED while the Teleporter THORName placeholder is
 *      empty (config — nothing invented ever goes to the quote API). The
 *      size cap (0.05 BTC-equivalent from config) is enforced BEFORE the
 *      fetch (assertWithinSwapCap).
 *   2. THE DEPOSIT PAYLOAD — the THORChain vault deposit address for the
 *      selected source chain (from the /thorchain/inbound_addresses
 *      refresh — src/lib/thorchain/inboundAddresses.js parseInboundAddresses
 *      + the by-chain selection THORChainDeposit performs) + the deposit
 *      MEMO `=:SOL.SOL:<solanaDest>[/<refund>]` (src/lib/thorchain/memo.js
 *      buildDepositMemo — THORNode SwapMemo.String() scheme, destination
 *      pinned to the Solana session pubkey, never user-typed).
 *   3. THE QUOTE PARSE — parseQuoteResponse's canonical quote
 *      (expectedAmountOut / slippageBps / halted…) given the proxy body.
 *
 * LIVE STATUS (honest oracle boundary): the THORChain lane is the NEXT
 * roadmap item — it has NOT gone live yet (the aggregator key is a parked
 * item server-side; the UI is flag-gated). There are therefore NO live
 * quote/inbound captures to freeze: the INPUT fixtures below are SYNTHETIC
 * THORNode-shaped bodies (documented loudly) and the fixtures pin the
 * CURRENT code's CONSTRUCTION as the oracle — the engine must reproduce it
 * exactly. Replace the synthetic inputs with a live capture when the
 * operator runs the first deposit (same procedure as the forward/reverse
 * quotes: read-only capture through the proxy, note the route/amounts).
 *
 * DETERMINISM
 *   - The Solana destination = the repo's own test constant SOLANA_ADDRESS
 *     (warpBridge USER — the SAME wallet the forward/reverse fixtures use
 *     and the e2e fake Solana wallet connects with).
 *   - The source-chain refund address is ABSENT in the sample (the harness
 *     state: no BTC wallet session connected → no refund segment — exactly
 *     how the current UI builds the memo for an external send). The refund
 *     and affiliate/limit segment encodings are covered by memo.test.js
 *     (unchanged) — the oracle pins the sample's construction.
 *   - No network, no wallet, no chain: quoteUrl/parseInboundAddresses/
 *     buildDepositMemo/parseQuoteResponse/assertWithinSwapCap are pure +
 *     DI (all proven modules, imported unchanged).
 */
import { createHash } from "node:crypto";
import {
  quoteUrl,
  toThorchainBaseUnits,
  parseQuoteResponse,
  assertWithinSwapCap,
  THORCHAIN_QUOTE_PROXY_PATH,
} from "../../src/lib/thorchain/quote.js";
import {
  buildDepositMemo,
  parseDepositMemo,
  THORCHAIN_SOURCE_ASSETS,
  THORCHAIN_DESTINATION_ASSET,
} from "../../src/lib/thorchain/memo.js";
import { parseInboundAddresses } from "../../src/lib/thorchain/inboundAddresses.js";
import {
  THORCHAIN_AFFILIATE_NAME,
  THORCHAIN_MAX_SWAP_BTC_EQUIVALENT,
} from "../../src/lib/thorchain/config.js";
import { computeFee } from "../../src/lib/fees.ts";
import { SOLANA_ADDRESS, canonicalJson, sha256Of, sha256Bytes } from "./forwardLegBuilders.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// FIXED SAMPLE INPUT — deterministic, reproducible offline. Wallet set = the
// repo's own test constants (the SAME set as the forward/reverse fixtures).
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The route sample: 0.01 BTC → SOL.SOL through THORChain's deposit-address
 * flow, destination = the repo-test Solana wallet. NO refund address (the
 * external-send state the UI reaches without a connected BTC session).
 */
export const SAMPLE_INPUT = Object.freeze({
  sourceChain: "BTC",
  fromAsset: THORCHAIN_SOURCE_ASSETS.BTC, // "BTC.BTC"
  toAsset: THORCHAIN_DESTINATION_ASSET, // "SOL.SOL"
  amount: 0.01, // BTC — the tested amount
  solanaAddress: SOLANA_ADDRESS, // the pinned destination (never user-typed)
  refundAddress: null, // absent in the sample — refunds default to the sender
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNTHETIC THORNode INPUT FIXTURES (the lane is NOT live yet — loudly
// labeled; replace with live captures on the first operator deposit)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Synthetic /thorchain/inbound_addresses body (THORNode returns a bare
 * array of vault entries; some gateways wrap it as { addresses: [...] } —
 * parseInboundAddresses accepts both). BTC is the sample's chain; DOGE is
 * marked halted to pin the halted-selection gate; every address is a
 * SYNTHETIC placeholder (bech32/base58-shaped), NOT a real vault.
 */
export const INBOUND_BODY = Object.freeze([
  {
    chain: "BTC",
    pub_key: "thorpub1addwdve3lcq7q2a06syftq28sx2p8lm7xq0j2",
    address: "bc1qj9teleportervault0btc000synthetic0x7k2m4",
    halted: false,
    router: null,
    gas_rate: "14",
    dust_threshold: "5000",
  },
  {
    chain: "DOGE",
    pub_key: "thorpub1addwdve3lcq7q2a06syftq28sx2p8lm7xq0j2",
    address: "D8B9teleportervault0doge0synthetic0x3p5n7",
    halted: true, // pins the paused-chain gate (greyed out in the UI)
    router: null,
    gas_rate: "100000",
    dust_threshold: "100000000",
  },
  {
    chain: "LTC",
    pub_key: "thorpub1addwdve3lcq7q2a06syftq28sx2p8lm7xq0j2",
    address: "ltc1qj9teleportervault0ltc000synthetic0x8r2t6",
    halted: false,
    router: null,
    gas_rate: "120",
    dust_threshold: "10000",
  },
  {
    chain: "XRP",
    pub_key: "thorpub1addwdve3lcq7q2a06syftq28sx2p8lm7xq0j2",
    address: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", // the well-known XRPL test account — SYNTHETIC stand-in
    halted: false,
    router: null,
    gas_rate: "0.000015",
    dust_threshold: "1000000",
  },
]);

/** The BTC vault address the sample selects (the inbound entry above). */
export const BTC_VAULT_ADDRESS = INBOUND_BODY[0].address;

/**
 * Synthetic THORNode /thorchain/quote/swap response body (the shape the
 * proxy passes through verbatim — see parseQuoteResponse's accepted body).
 * expected_amount_out is in THORChain base units (1e8 — even for SOL);
 * inbound_address non-empty → not halted. SYNTHETIC (no live capture yet).
 */
export const QUOTE_BODY = Object.freeze({
  expected_amount_out: "49750000", // 0.4975 SOL @ 1e8 — synthetic
  slippage_bps: "50",
  inbound_address: BTC_VAULT_ADDRESS,
  expiry: 60,
  recommended_min_amount_in: "5000000",
  notes: ["First output estimate may be inaccurate"],
});

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL SERIALIZATION + HASHING (re-exported from the forward builders —
// one implementation across every phase's oracle)
// ─────────────────────────────────────────────────────────────────────────────
export { canonicalJson, sha256Of, sha256Bytes } from "./forwardLegBuilders.mjs";
/** sha256 hex of a raw UTF-8 string (the URL / memo artifacts). */
export function sha256Text(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — THE QUOTE REQUEST (the canonical proxy request + the size cap)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Normalize the inbound entries into the by-chain map the deposit stage
 * uses (THORChainDeposit: byChain[e.chain] = e over parseInboundAddresses).
 * Pure — wraps the PROVEN parser unchanged.
 */
export function inboundByChain(body = INBOUND_BODY) {
  const parsed = parseInboundAddresses(body);
  if (!parsed.ok) throw new Error(`inboundByChain: ${parsed.reason}: ${parsed.message}`);
  const byChain = {};
  for (const e of parsed.entries) byChain[e.chain] = e;
  return byChain;
}

/**
 * Rebuild the quote-request artifact exactly as the deposit stage's quote
 * moment constructs it (THORChainDeposit.getQuote → createQuoteFetcher
 * fetchQuote's URL half + the cap gate that runs BEFORE any fetch):
 *   - assertWithinSwapCap (config 0.05 BTC-equivalent; BTC rate = 1),
 *   - toThorchainBaseUnits(amount) → 1e8 base units,
 *   - quoteUrl(/api/thorchain/quote, { from_asset, to_asset, amount,
 *     destination, refund_address? }) — the affiliate pair rides along ONLY
 *     when THORCHAIN_AFFILIATE_NAME is configured (currently EMPTY → the
 *     URL carries no affiliate params; the oracle asserts this invariant).
 *
 * @param {object} [args]
 * @param {string} [args.sourceChain] "BTC" | "DOGE" | "LTC" | "XRP"
 * @param {number} [args.amount] decimal amount in source units
 * @param {string} [args.destination] the Solana session pubkey
 * @param {string|null} [args.refundAddress] source-chain refund address
 *   (null/empty → omitted — refunds default to the sender)
 * @returns {{step:"quote-request", artifact, sha256, meta}}
 */
export function buildStep1QuoteRequest({
  sourceChain = SAMPLE_INPUT.sourceChain,
  amount = SAMPLE_INPUT.amount,
  destination = SAMPLE_INPUT.solanaAddress,
  refundAddress = SAMPLE_INPUT.refundAddress,
} = {}) {
  const fromAsset = THORCHAIN_SOURCE_ASSETS[sourceChain];
  if (!fromAsset) throw new Error(`buildStep1QuoteRequest: unknown sourceChain "${sourceChain}"`);

  // The cap gate runs FIRST in the reference flow (a blocked request never
  // reaches the fetch). BTC has a rate (1) → the cap is known.
  const cap = assertWithinSwapCap({
    asset: sourceChain,
    amount,
    rates: undefined, // config defaults (BTC:1; DOGE/LTC/XRP null → skipped)
    maxBtcEquivalent: undefined, // config default 0.05
  });
  if (!cap.ok) throw new Error(`buildStep1QuoteRequest: sample over-cap: ${cap.message}`);
  const capDecision = {
    ok: cap.ok,
    capKnown: cap.capKnown,
    ...(cap.capKnown && cap.capAmount !== undefined ? { capAmount: cap.capAmount } : {}),
  };

  const amountInBaseUnits = toThorchainBaseUnits(amount);
  const url = quoteUrl(THORCHAIN_QUOTE_PROXY_PATH, {
    fromAsset,
    toAsset: THORCHAIN_DESTINATION_ASSET,
    amountInBaseUnits,
    destination,
    refundAddress: refundAddress || undefined, // qs drops empty
    // affiliate pair: quoteUrl adds it only when args.affiliate is set —
    // the reference flow passes it only when THORCHAIN_AFFILIATE_NAME !== ""
    // (config placeholder empty → never sent).
    ...(THORCHAIN_AFFILIATE_NAME !== ""
      ? { affiliate: THORCHAIN_AFFILIATE_NAME, affiliateBps: undefined }
      : {}),
  });

  const artifact = {
    sourceChain,
    fromAsset,
    toAsset: THORCHAIN_DESTINATION_ASSET,
    amount,
    amountInBaseUnits,
    destination,
    refundAddress: refundAddress || null,
    capDecision,
    url,
  };

  return {
    step: "quote-request",
    artifact,
    sha256: sha256Of(artifact),
    // Hash SIBLINGS (never artifact fields — mirror of the forward/reverse
    // fixtures' bytesSha256): the sha256 of the canonical serialized request
    // string, pinned test-side.
    urlSha256: sha256Text(url),
    meta: {
      note:
        "The deterministic quote request the deposit stage sends to OUR proxy " +
        "/api/thorchain/quote (the aggregator key lives server-side; the client never " +
        "holds it). Amounts in THORChain 1e8 base units; destination = the connected " +
        "Solana session pubkey; the size cap (0.05 BTC-equivalent, config) is enforced " +
        "BEFORE the fetch. The affiliate pair is OMITTED while THORCHAIN_AFFILIATE_NAME " +
        "is empty (parked item) — nothing invented is ever sent to the quote API. " +
        "urlSha256 pins the canonical serialized request.",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — THE DEPOSIT PAYLOAD (vault address selection + the deposit memo)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Rebuild the deposit payload exactly as the deposit stage constructs it:
 * the vault entry for the selected source chain (from the normalized
 * inbound snapshot — halted chains are NOT selectable in the reference UI)
 * + the deposit memo `=:SOL.SOL:<dest>[/<refund>]` built by buildDepositMemo
 * with the destination pinned to the Solana session pubkey.
 *
 * @param {object} [args]
 * @param {string} [args.sourceChain] the selected source chain
 * @param {string} [args.destination] the Solana session pubkey
 * @param {string|null} [args.refundAddress] source-chain refund (null/empty
 *   → no refund segment — THORNode refunds to the sender)
 * @param {object} [args.byChain] normalized inbound entries keyed by chain
 *   (default: from the synthetic INBOUND_BODY)
 * @returns {{step:"deposit-payload", artifact, sha256, meta}}
 * @throws when the chain is halted or has no vault entry (the reference UI
 *   blocks exactly these states)
 */
export function buildStep2DepositPayload({
  sourceChain = SAMPLE_INPUT.sourceChain,
  destination = SAMPLE_INPUT.solanaAddress,
  refundAddress = SAMPLE_INPUT.refundAddress,
  byChain = inboundByChain(),
} = {}) {
  const fromAsset = THORCHAIN_SOURCE_ASSETS[sourceChain];
  if (!fromAsset) throw new Error(`buildStep2DepositPayload: unknown sourceChain "${sourceChain}"`);
  const entry = byChain[sourceChain];
  if (!entry) {
    throw new Error(`buildStep2DepositPayload: no inbound entry for ${sourceChain}`);
  }
  if (entry.halted === true) {
    throw new Error(`buildStep2DepositPayload: ${sourceChain} is halted by THORChain — not selectable`);
  }

  const memo = buildDepositMemo({
    sourceChain,
    destAddress: destination,
    ...(refundAddress ? { refundAddress } : {}),
    // affiliate pair: only when the THORName placeholder is configured.
    ...(THORCHAIN_AFFILIATE_NAME !== ""
      ? { affiliate: THORCHAIN_AFFILIATE_NAME, affiliateBps: undefined }
      : {}),
    // LIMIT (minimum-out) is NOT wired (documented in memo.js) — absent.
  });

  const artifact = {
    sourceChain,
    fromAsset,
    chain: entry.chain,
    destination,
    depositAddress: entry.address,
    halted: entry.halted === true,
    memo,
    memoParts: parseDepositMemo(memo),
  };

  return {
    step: "deposit-payload",
    artifact,
    sha256: sha256Of(artifact),
    // Hash SIBLING (mirror of the forward/reverse bytesSha256): the sha256
    // of the memo bytes, pinned test-side.
    memoSha256: sha256Text(memo),
    meta: {
      note:
        "The deterministic deposit payload the deposit stage shows the user: the THORChain " +
        "vault address for the selected source chain (from the inbound-addresses refresh — " +
        "in-memory only, never cached) + the deposit MEMO in THORNode SwapMemo.String() " +
        "scheme (`=:SOL.SOL:<solanaDest>[/<refund>]`), destination = the connected Solana " +
        "session pubkey (never user-typed). The user sends from their OWN external wallet " +
        "attaching the memo; the app never signs or broadcasts the deposit (v1 deposit-" +
        "address flow). memoSha256 pins the memo bytes.",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE QUOTE PARSE (canonical quote given the proxy body — deterministic)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Rebuild the canonical parse of the quote body (parseQuoteResponse — the
 * PROVEN parser; the proxy passes the THORNode body through verbatim).
 * The deposit stage gates the deposit address on this parse: the address is
 * shown ONLY after a fresh quote lands (fail-closed on error).
 */
export function buildQuoteParse(body = QUOTE_BODY) {
  const parsed = parseQuoteResponse(body, {});
  if (!parsed.ok) throw new Error(`buildQuoteParse: ${parsed.reason}: ${parsed.message}`);
  const q = parsed.quote;
  return {
    ok: true,
    quote: {
      expectedAmountOut: q.expectedAmountOut,
      expectedAmountOutRaw: q.expectedAmountOutRaw,
      affiliateBps: q.affiliateBps,
      slippageBps: q.slippageBps,
      memo: q.memo,
      halted: q.halted,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FEE LINES (the REAL fee code's display strings — the browser harness
// asserts the deposit card's fee lines against these exact strings)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The three pre-send fee lines the deposit stage renders for the sample
 * source (computeFee's thorchain-leg class — REAL code; the display mapping
 * mirrors THORChainDeposit.feeLinesFor: rates as %, flats as $).
 */
export function feeLinesForSource(sourceChain = SAMPLE_INPUT.sourceChain) {
  const fee = computeFee({ from: String(sourceChain).toLowerCase(), to: "sol", thorchain: true });
  return fee.components.map((c) => ({
    id: c.id,
    label: c.label,
    party: c.party,
    display: c.kind === "flat" ? `$${c.flatUsd} flat` : `${(c.rate * 100).toFixed(2)}%`,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FULL CAPTURE — one entry point for the capture script + the golden test
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Build BOTH THORChain-leg fixtures from the fixed sample input + the
 * synthetic THORNode input bodies. Returns the capture objects {step,
 * artifact, sha256, ...} plus the sample input, the quote parse and the
 * fee lines (all deterministic).
 */
export function captureThorchainLeg() {
  const step1 = buildStep1QuoteRequest({});
  const step2 = buildStep2DepositPayload({});
  const quoteParse = buildQuoteParse();
  const byChain = inboundByChain();

  return {
    sampleInput: SAMPLE_INPUT,
    inputBodies: {
      inbound: INBOUND_BODY,
      quote: QUOTE_BODY,
    },
    derived: {
      amountInBaseUnits: toThorchainBaseUnits(SAMPLE_INPUT.amount),
      depositAddress: BTC_VAULT_ADDRESS,
      selectedEntryHalted: byChain[SAMPLE_INPUT.sourceChain].halted === true,
      inboundChainCount: Object.keys(byChain).length,
      quote: quoteParse.quote,
      feeLines: feeLinesForSource(),
      url: step1.artifact.url,
      urlSha256: step1.urlSha256,
      memo: step2.artifact.memo,
      memoSha256: step2.memoSha256,
    },
    steps: { step1, step2 },
  };
}

export { THORCHAIN_AFFILIATE_NAME, THORCHAIN_MAX_SWAP_BTC_EQUIVALENT };
