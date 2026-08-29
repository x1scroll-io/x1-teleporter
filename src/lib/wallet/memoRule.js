/**
 * Memo-rule logic (Step 2.4) — PURE, no React, no browser.
 *
 * The THORChain lane's hard constraint (docs/WALLET-REGISTRY.md, Litecoin /
 * Dogecoin / XRP sections): the THORChain memo must travel WITH the
 * deposit. For Litecoin and Dogecoin that means an OP_RETURN; for XRP it
 * goes in the XRPL `Memos` field (NOT a destination tag). A wallet that
 * cannot attach the memo cannot do the send in-app — for those, show the
 * balance, then hand off to the deposit-address row. This module is the
 * single source of that rule; the modal renders its notes.
 *
 * `memoSupport` values on registry rows (see the per-family registries):
 *   - "op_return" — LTC/DOGE: wallet can attach the OP_RETURN memo.
 *   - "memos"     — XRP: wallet can attach the XRPL Memos field.
 *   - "verify"    — registry marked the memo path ⚠️ (verify at build time).
 *   - "none"      — cannot attach a memo at all.
 * Anything missing defaults to "none" (fail closed: never assume memo
 * support that the registry did not document).
 */

/** Families governed by the memo rule (THORChain lane). */
export const MEMO_RULE_FAMILIES = Object.freeze(["litecoin", "dogecoin", "xrp"]);

/** Is this family governed by the memo rule? */
export function isMemoRuleFamily(family) {
  return MEMO_RULE_FAMILIES.includes(family);
}

/** The registry row's memo capability (defaults to "none" — fail closed). */
export function memoCapability(entry) {
  return entry?.memoSupport ?? "none";
}

/**
 * Can this wallet send in-app for a memo-rule family? True only when the
 * registry documents a working memo path ("op_return" for LTC/DOGE,
 * "memos" for XRP). "verify"/"none"/missing → false (balance-only +
 * deposit-address hand-off).
 *
 * @param {{memoSupport?: string}} entry
 * @returns {boolean}
 */
export function canSendInApp(entry) {
  const capability = memoCapability(entry);
  return capability === "op_return" || capability === "memos";
}

/**
 * The hand-off note the modal renders under a connectable wallet row that
 * cannot (or may not) attach the THORChain memo. Returns null when the
 * wallet can send in-app or the row is not memo-rule-governed.
 *
 * @param {string} family "litecoin" | "dogecoin" | "xrp"
 * @param {{memoSupport?: string}} entry
 * @returns {string|null}
 */
export function memoHandoffNote(family, entry) {
  if (!isMemoRuleFamily(family)) return null;
  if (entry?.depositAddress) return null; // the deposit row IS the hand-off target
  const capability = memoCapability(entry);
  if (capability === "op_return" || capability === "memos") return null;
  if (capability === "verify") {
    return family === "xrp"
      ? "⚠️ XRPL Memos support unverified — balance shown; sends hand off to the deposit-address row."
      : "⚠️ OP_RETURN memo unverified — balance shown; sends hand off to the deposit-address row.";
  }
  return family === "xrp"
    ? "No XRPL Memos support — balance only; use the deposit-address row to send."
    : "No OP_RETURN memo support — balance only; use the deposit-address row to send.";
}

/**
 * The deposit-address row's subtitle, per family. The BTC-flavored default
 * (Sparrow/Electrum) is wrong for the altcoin families.
 *
 * @param {string} family
 * @returns {string}
 */
export function depositRowSubtitle(family) {
  switch (family) {
    case "litecoin":
      return "Send from any Litecoin wallet — no extension needed";
    case "dogecoin":
      return "Send from any Dogecoin wallet — no extension needed";
    case "xrp":
      return "Send from any XRP wallet or exchange — no extension needed";
    default:
      return "Send from any desktop wallet (Sparrow, Electrum, …) — no extension needed";
  }
}

/**
 * The deposit-address row's memo note, per family — documents the THORChain
 * memo transport rule for each chain. The deposit address + memo themselves
 * now render in the THORChain tab's DEPOSIT stage (Step 3.2 — the address
 * comes from /thorchain/inbound_addresses, the memo from memo.js); the
 * wallet-layer row points there instead of duplicating it.
 *
 * @param {string} family
 * @returns {string}
 */
export function depositMemoNote(family) {
  switch (family) {
    case "litecoin":
    case "dogecoin":
      return "THORChain needs the memo as an OP_RETURN — copy address + memo from the THORChain tab's deposit stage.";
    case "xrp":
      return "THORChain needs the memo in the XRPL Memos field (NOT a destination tag) — copy address + memo from the THORChain tab's deposit stage.";
    default:
      return "Copy the deposit address + memo from the THORChain tab's deposit stage — not guessed here.";
  }
}
