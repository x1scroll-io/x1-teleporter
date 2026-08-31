/**
 * memo.js — THORChain deposit-memo construction for the deposit-address
 * stage of the THORChain lane (Step 3.2).
 *
 * LIFTED LOGIC (per docs/BRIEF.md — the swap.thorchain fork is a LOGIC
 * SOURCE ONLY, its UI is never mounted):
 *   - The memo scheme swap.thorchain uses for a THORChain swap deposit:
 *     `=:ASSET:DEST/REFUND[:LIMIT][:AFFILIATE:BPS]` — the fork sends
 *     `destination` + `refundAddress` into its quote API and the returned
 *     memo encodes BOTH in the destination field, separated by `/`
 *     (see swap.thorchain `src/components/swap/swap-recipient.tsx` and
 *     `src/lib/memo-helpers.ts` — the fork's remaining client-side memo code
 *     documents the same `=:ASSET:ADDR:LIMIT/INTERVAL/QTY:AFF:BPS` shape).
 *   - The canonical parser is THORNode `x/thorchain/memo/memo_swap.go`
 *     (`SwapMemo.String()`): `=`, destination asset (`SOL.SOL`), destination
 *     address with an optional `/REFUNDADDR` suffix, then optional limit /
 *     affiliate fields, joined with `:`. We implement that exact scheme as a
 *     small pure module instead of copying the fork wholesale.
 *
 * FORMAT (verified against THORNode SwapMemo.String()):
 *   `=:SOL.SOL:<solanaDestAddress>[/<refundAddress>][:<limit>][:<affiliate>:<bps>]`
 *   - `=` is the swap opcode (the short form of `SWAP:` — THORNode emits `=`
 *     for swap memos; both parse identically).
 *   - The refund address is the SOURCE-chain address refunds return to when
 *     the swap fails. When omitted, THORNode refunds to the tx sender
 *     (correct for the v1 deposit-address flow — the user sends from their
 *     own wallet).
 *   - LIMIT is the minimum-out in THORChain base units (1e8 convention) of
 *     the DESTINATION asset. NOT wired this step — the Step 3.3 aggregator
 *     quote supplies it (see the TODO in THORChainDeposit).
 *   - AFFILIATE is a THORName + bps. NOT wired this step — Franky has not
 *     registered the Teleporter THORName yet (brief: open item).
 *
 * PURE MODULE: no fetch, no DOM, no wallet. Runnable under `node --test`.
 */

/** The four allowed source assets (brief: restrict sources to these). */
export const THORCHAIN_SOURCE_ASSETS = Object.freeze({
  BTC: "BTC.BTC",
  DOGE: "DOGE.DOGE",
  LTC: "LTC.LTC",
  XRP: "XRP.XRP",
});

/** The pinned destination asset (brief: destination pinned to SOL.SOL). */
export const THORCHAIN_DESTINATION_ASSET = "SOL.SOL";

/** The swap opcode THORNode emits for swap memos (short form of `SWAP:`). */
export const SWAP_OPCODE = "=";

/**
 * Light sanity check for a memo address segment. THORNode does the REAL
 * per-chain validation at deposit time; this only rejects values that would
 * corrupt the memo itself (`:` / `/` are the memo separators) or that are
 * obviously empty/whitespace. Never blocks a legitimate address.
 */
export function isUsableMemoAddress(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length === 0) return false;
  if (/[\s:/]/.test(v)) return false;
  return true;
}

/**
 * Build a THORChain swap deposit memo in the exact scheme the fork uses
 * (verified against THORNode SwapMemo.String()).
 *
 * @param {object} args
 * @param {string} args.sourceChain the SOURCE chain id — "BTC" | "DOGE" |
 *   "LTC" | "XRP" (validated against THORCHAIN_SOURCE_ASSETS). Used for
 *   validation + documentation; the memo itself carries the destination
 *   asset, the destination address and the refund address.
 * @param {string} args.destAddress the DESTINATION address — the connected
 *   Solana session's public key (brief wallet rule 4: never user-typed).
 * @param {string} [args.refundAddress] the SOURCE-chain refund address.
 *   Optional: when omitted the memo has no refund segment and THORNode
 *   refunds to the sender.
 * @param {string|number} [args.limit] minimum-out in THORChain base units of
 *   the destination asset. Optional — arrives with the Step 3.3 quote.
 * @param {string} [args.affiliate] Teleporter THORName (optional, unwired —
 *   Franky has not registered it yet).
 * @param {string|number} [args.affiliateBps] affiliate basis points, required
 *   together with `affiliate`.
 * @returns {string} the memo, e.g. `=:SOL.SOL:9xQe.../bc1q...`
 * @throws {Error} on invalid sourceChain / missing or unusable destAddress /
 *   unusable refundAddress / affiliate without bps (and vice versa).
 */
export function buildDepositMemo({ sourceChain, destAddress, refundAddress, limit, affiliate, affiliateBps }) {
  if (!Object.prototype.hasOwnProperty.call(THORCHAIN_SOURCE_ASSETS, sourceChain)) {
    throw new Error(
      `buildDepositMemo: unknown sourceChain "${sourceChain}" — expected one of ${Object.keys(THORCHAIN_SOURCE_ASSETS).join(", ")}`,
    );
  }
  if (!isUsableMemoAddress(destAddress)) {
    throw new Error("buildDepositMemo: destAddress is required and must be a usable address");
  }

  // Destination segment: THORNode appends the custom refund address after a
  // "/" — `DEST/REFUND` (memo_swap.go: "destination + custom refund addr").
  // Whitespace-only is treated as absent (THORNode refunds to the sender).
  let destSegment = destAddress.trim();
  const hasRefund = typeof refundAddress === "string" && refundAddress.trim() !== "";
  if (hasRefund) {
    if (!isUsableMemoAddress(refundAddress)) {
      throw new Error("buildDepositMemo: refundAddress is unusable in a memo (empty, or contains ':', '/' or whitespace)");
    }
    destSegment = `${destSegment}/${refundAddress.trim()}`;
  }

  const parts = [SWAP_OPCODE, THORCHAIN_DESTINATION_ASSET, destSegment];

  // LIMIT (position 3). Optional; the Step 3.3 quote supplies it. THORNode
  // keeps the memo at 3 parts when the limit is absent/zero.
  const hasLimit = limit !== undefined && limit !== null && limit !== "" && Number(limit) > 0;
  if (hasLimit) {
    parts.push(String(limit));
  }

  // AFFILIATE (positions 4-5). Unwired until Franky registers the Teleporter
  // THORName; the builder still supports the exact scheme so 3.3 can pass
  // the pair through.
  const hasAffiliate = affiliate !== undefined && affiliate !== null && affiliate !== "";
  const hasBps = affiliateBps !== undefined && affiliateBps !== null && affiliateBps !== "";
  if (hasAffiliate !== hasBps) {
    throw new Error("buildDepositMemo: affiliate and affiliateBps must be provided together");
  }
  if (hasAffiliate) {
    // THORNode requires the affiliate segment to be a THORName (or address)
    // + basis points. The fork's memos use THORNames here.
    if (!isUsableMemoAddress(String(affiliate))) {
      throw new Error("buildDepositMemo: affiliate must be a usable THORName/address");
    }
    parts.push(String(affiliate), String(affiliateBps));
  }

  return parts.join(":");
}

/**
 * Split a built deposit memo back into its parts (the THORNode 3-part /
 * 6-part shape). Exported for tests + UI display; NOT a general memo parser.
 *
 * @param {string} memo
 * @returns {{asset:string, destination:string, refundAddress:string|null,
 *            limit:string|null, affiliate:string|null, affiliateBps:string|null}}
 */
export function parseDepositMemo(memo) {
  const parts = String(memo).split(":");
  const op = parts[0];
  const asset = parts[1] ?? "";
  const destSegment = parts[2] ?? "";
  const [destination, refundAddress] = destSegment.split("/");
  const out = {
    opcode: op,
    asset,
    destination: destination ?? "",
    refundAddress: refundAddress && refundAddress.length > 0 ? refundAddress : null,
    limit: null,
    affiliate: null,
    affiliateBps: null,
  };
  // Positional parts after the destination segment. THORNode's SwapMemo
  // shape is `=:ASSET:DEST[:LIMIT][:AFFILIATE:BPS]` — the LIMIT slot is
  // omitted when absent, so a 5-part memo (no limit, affiliate present)
  // puts the affiliate in slot 3 and the bps in slot 4. Only the 6-part
  // form carries all three.
  if (parts.length === 4) {
    if (parts[3] !== "") out.limit = parts[3];
  } else if (parts.length === 5) {
    if (parts[3] !== "") out.affiliate = parts[3];
    if (parts[4] !== "") out.affiliateBps = parts[4];
  } else if (parts.length >= 6) {
    if (parts[3] !== "") out.limit = parts[3];
    if (parts[4] !== "") out.affiliate = parts[4];
    if (parts[5] !== "") out.affiliateBps = parts[5];
  }
  return out;
}
