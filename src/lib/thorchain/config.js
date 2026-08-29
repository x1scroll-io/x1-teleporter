/**
 * config.js — THORChain lane CONFIG VALUES (Step 3.3: fees + quote + caps).
 *
 * EVERYTHING here is a config value, never a hardcoded string buried in a
 * component. The fee class (src/lib/fees.ts → thorchain-leg) reads the
 * affiliate rate from here; the quote module (quote.js) reads the size cap
 * and the affiliate name; the deposit stage renders both.
 *
 * PARKED-ITEM BOUNDARY (Mr. Esters owns these — see docs/BRIEF.md "Open
 * items Franky must supply" and the Step 3.3 ground rules):
 *   - The REAL THORName is NOT registered yet. THORCHAIN_AFFILIATE_NAME is
 *     an EMPTY placeholder: while it stays empty, quotes are fetched WITHOUT
 *     affiliate params and memos carry no affiliate segment — nothing
 *     invented ever goes on-chain. When Franky registers the Teleporter
 *     THORName, set it here (and only here).
 *   - The REAL THORChain aggregator API key is parked. THORCHAIN_API_KEY
 *     (env, never this file) is a placeholder in Preview scope. The quote
 *     module reads the key from the environment at call time — see
 *     quote.js readApiKey().
 *   - The BTC-equivalent rates for the size cap (DOGE/LTC/XRP) need the live
 *     quote integration to derive (or Franky supplies them) — they are null
 *     with a TODO until then, and the cap check SKIPS unknown assets with an
 *     explicit signal instead of guessing a price.
 *
 * PURE MODULE: constants only — no DOM, no fetch, no wallet, no env reads.
 * Runnable under `node --test` and importable from fees.ts (type stripping).
 */

/**
 * Teleporter THORName for the THORChain affiliate fee (protocol-side, paid
 * to our THORName per docs/BRIEF.md Workstream A).
 *
 * TODO(set real THORName when registered): Franky registers the THORName
 * (brief open item); until then this stays EMPTY so no placeholder name is
 * ever sent to the THORChain quote API or embedded in a memo.
 */
export const THORCHAIN_AFFILIATE_NAME = "";

/**
 * THORChain affiliate basis points — the PROTOCOL fee rate paid to our
 * THORName (docs/BRIEF.md: "affiliate_bps (start 100)"). This is a THORChain
 * protocol fee, NOT Teleporter's 1% — see the fee-policy note in fees.ts.
 * Ignored while THORCHAIN_AFFILIATE_NAME is empty (no affiliate params sent).
 */
export const THORCHAIN_AFFILIATE_BPS = 100;

/**
 * Per-swap size cap in BTC-equivalent (docs/BRIEF.md: "0.05 BTC-equivalent
 * per swap until Solana pool depth improves. Config value, not hardcoded.").
 * Enforced at quote time — see assertWithinSwapCap() in quote.js.
 */
export const THORCHAIN_MAX_SWAP_BTC_EQUIVALENT = 0.05;

/**
 * BTC-equivalence rates for the size cap, per source asset (source units per
 * 1 BTC). BTC is 1:1. DOGE/LTC/XRP are null — the real rates arrive with the
 * live quote integration (parked item) or from Franky; the cap check SKIPS
 * assets with a null rate and reports capKnown:false (the UI shows a note)
 * rather than guessing a price. TODO(3.3+live): set the real rates.
 */
export const THORCHAIN_BTC_EQUIVALENT_RATES = Object.freeze({
  BTC: 1,
  DOGE: null, // TODO(3.3+live): real BTC-equivalent rate when the live quote wiring lands
  LTC: null,  // TODO(3.3+live): real BTC-equivalent rate when the live quote wiring lands
  XRP: null,  // TODO(3.3+live): real BTC-equivalent rate when the live quote wiring lands
});
