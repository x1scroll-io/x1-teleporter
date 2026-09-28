/**
 * pickerOrder.js — pure ORDERING + CUSTOM-ENTRY resolution for the SWAP/BRIDGE
 * token picker (consumed by `mountTokenPicker` / `tokenOptions` in src/popup.ts).
 *
 * WHY THIS MODULE EXISTS / WHY IT IS PURE
 *   The picker itself is DOM code, but two decisions inside it are policy, not
 *   rendering: (1) the ORDER of the dropdown, and (2) whether a typed ticker /
 *   address / name resolves to a token — and whether that should be WARNED as
 *   ambiguous or unverified. Both live here as side-effect-free functions so
 *   they can be unit-tested without a browser, and so popup.ts stays a thin
 *   wiring layer. Nothing here touches swap/bridge execution, fees, the F-02
 *   verify gate, or src/lib/mev/.
 *
 * LIQUIDITY PROXY — DOCUMENTED, DETERMINISTIC, NOT INVENTED
 *   There is NO live liquidity/volume feed wired into the wallet, and the
 *   picker must paint instantly and work offline (the UI-QA audit ran with all
 *   external HTTP aborted). So instead of inventing liquidity numbers or
 *   hitting a price API that isn't already wired, we use the ONE canonical,
 *   deterministic signal the wallet already has:
 *
 *     • EVM chains → TOKEN_TABLE row order, exactly as projected by
 *       `evmPickerTokens()` in tokenResolver.js (the wallet's own canonical
 *       registry ordering: stables first, then majors).
 *     • SOL / X1   → the curated selector order (SOL_TOKENS + the wired Warp
 *       selector options) — same idea, same table.
 *
 *   The caller therefore passes its options IN CANONICAL ORDER and this module
 *   treats the input INDEX as the liquidity rank. Documented fallback, no fake
 *   data, no network.
 *
 * ORDERING (owner spec)
 *   1. native asset first (it is the default selection),
 *   2. stablecoins (USDC.x, USDT, USDC, DAI, …others),
 *   3. tokens the user actually HOLDS in this wallet (the "· in wallet" rows),
 *   4. everything else, in canonical order (= the liquidity proxy above).
 */

/** Stablecoin symbols the picker recognises, in the owner's display order.
 *  Anything after DAI is "other stablecoins", sorted alphabetically. */
export const STABLE_SYMBOLS = Object.freeze([
  "USDC.x", "USDT", "USDC", "USDC.e", "DAI",
  "USDG", "USDH", "PYUSD", "USDE", "USDS", "FRAX", "TUSD", "BUSD", "GUSD", "LUSD",
]);

/** Lowercased lookup set for O(1) is-stable checks. */
const STABLE_SET = new Set(STABLE_SYMBOLS.map((s) => s.toLowerCase()));

/**
 * The plain SYMBOL of a picker option: strips the display decorations the popup
 * adds ("· in wallet", "(native)") so ordering + matching key on identity, not
 * presentation. `{label:"USDC · in wallet"}` → "USDC".
 */
export function symbolOf(option) {
  if (!option) return "";
  const raw = String(option.symbol ?? option.label ?? "");
  return raw
    .split(" · ")[0]
    .replace(/\s*\(native\)\s*$/i, "")
    .trim();
}

/** Is this option a stablecoin? */
export function isStable(option) {
  return STABLE_SET.has(symbolOf(option).toLowerCase());
}

/** Display rank of a stable (lower = earlier); non-stables → Infinity. */
export function stableRank(option) {
  const i = STABLE_SYMBOLS.findIndex((s) => s.toLowerCase() === symbolOf(option).toLowerCase());
  return i === -1 ? Infinity : i;
}

/** Is this option the native asset? (the popup signals native with value === "") */
export function isNative(option) {
  return !option || !(option.value ?? "");
}

/**
 * orderPickerTokens(options) → a NEW array in owner-spec order:
 *   native → stables → held-in-wallet → rest (canonical = liquidity proxy).
 * Stable: properties are NOT mutated; the input array is not modified.
 */
export function orderPickerTokens(options = []) {
  return options
    .map((o, i) => ({ o, i }))
    .sort((a, b) => {
      const ra = sortKey(a.o, a.i);
      const rb = sortKey(b.o, b.i);
      for (let k = 0; k < ra.length; k++) {
        if (ra[k] !== rb[k]) return ra[k] - rb[k];
      }
      return 0;
    })
    .map((x) => x.o);
}

function sortKey(o, idx) {
  if (isNative(o)) return [0, 0, idx];                       // native — the default
  if (isStable(o)) return [1, stableRank(o), idx];           // stables (ranked)
  if (o.held) return [2, idx, 0];                            // tokens the user holds
  return [3, idx, 0];                                        // the rest — canonical order
}

// ── custom entry: ticker / contract address / name ──────────────────────────

/** The exact warning shown when a NAME lookup resolves to >1 contract. */
export const MULTI_CONTRACT_WARNING =
  "This name matches more than one contract — it may be a security risk. " +
  "Verify the contract address before you swap.";

/** Shown when a well-formed address is not in the wallet's verified list. */
export const UNVERIFIED_ADDRESS_WARNING =
  "That address isn't in this wallet's verified token list — only continue if you trust the contract.";

/** Address formats the picker accepts, per chain family. */
const ADDRESS_FORMATS = {
  evm:      /^0x[0-9a-fA-F]{40}$/,
  solana:   /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  x1:       /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  sui:      /^(0x[0-9a-fA-F]{1,64})(::[A-Za-z0-9_]+){0,2}$/,
  aptos:    /^0x[0-9a-fA-F]{1,64}$/,
  tron:     /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  bitcoin:  /^(bc1[0-9a-z]{8,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  litecoin: /^(ltc1[0-9a-z]{8,71}|[LM3][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  dogecoin: /^D[1-9A-HJ-NP-Za-km-z]{33}$/,
  xrp:      /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
  cardano:  /^(addr1[0-9a-z]{20,}|[0-9a-fA-F]{56,})$/,
};

/** Default decimals per family when an unlisted address is pasted (the address
 *  itself carries no decimals; this is the family's native convention and is
 *  surfaced to the user as an unverified fallback). */
const FAMILY_DECIMALS = {
  evm: 18, solana: 9, x1: 9, sui: 9, aptos: 8, tron: 6,
  bitcoin: 8, litecoin: 8, dogecoin: 8, xrp: 6, cardano: 6,
};

/** Any shape we might treat as a raw address (before per-family validation). */
const ANY_ADDRESS =
  /^(0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{1,64}(::[A-Za-z0-9_]+){0,2}|[1-9A-HJ-NP-Za-km-z]{26,44}|bc1[0-9a-z]{8,71}|ltc1[0-9a-z]{8,71}|addr1[0-9a-z]{20,})$/;

export function looksLikeAddress(q) {
  return ANY_ADDRESS.test(String(q ?? "").trim());
}

/** Does the address match the FORMAT required by the selected chain? */
export function addressValidForFamily(q, family) {
  const re = ADDRESS_FORMATS[family];
  if (!re) return true; // unknown family → do not block
  return re.test(String(q ?? "").trim());
}

export function defaultDecimalsFor(family) {
  return FAMILY_DECIMALS[family] ?? 18;
}

function familyLabel(family) {
  return family === "evm" ? "EVM (0x…)" : family;
}

function toToken(option, fallbackDecimals) {
  return {
    label: String(option.label ?? option.symbol ?? ""),
    value: String(option.value ?? ""),
    dec: Number.isFinite(option.dec) ? option.dec : fallbackDecimals,
    ...(option.icon !== undefined ? { icon: option.icon } : {}),
  };
}

function shortLabel(addr) {
  const s = String(addr);
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

/**
 * resolveCustomEntry(query, options, { family, options? }) → a decision object.
 *
 * Statuses:
 *   "empty"     — nothing typed.
 *   "ok"        — resolved. `token` is a picker-shaped entry; `source` is
 *                 "address" | "ticker" | "name"; `verified` is false when a raw
 *                 address is not in the wallet's list (still selectable, but
 *                 `warning` explains the risk).
 *   "ambiguous" — a name/ticker matched MULTIPLE contracts → `matches` +
 *                 MULTI_CONTRACT_WARNING. The UI must warn and NOT auto-pick.
 *   "invalid"   — address-shaped but the WRONG FORMAT for the selected chain.
 *   "unknown"   — no match at all.
 */
export function resolveCustomEntry(query, options = [], opts = {}) {
  const { family = "evm" } = opts;
  const q = String(query ?? "").trim();
  if (!q) return { status: "empty", query: q };

  const norm = q.toLowerCase();
  const dec = defaultDecimalsFor(family);
  const list = Array.isArray(options) ? options : [];

  // 1) contract address
  if (looksLikeAddress(q)) {
    if (!addressValidForFamily(q, family)) {
      return {
        status: "invalid", query: q,
        warning: `"${shortLabel(q)}" isn't a valid ${familyLabel(family)} token address for this network.`,
      };
    }
    const hit = list.find((o) => String(o.value ?? "").toLowerCase() === norm);
    if (hit) {
      return { status: "ok", source: "address", verified: true, token: toToken(hit, dec), query: q };
    }
    // well-formed but not in the verified list — allow, but warn.
    return {
      status: "ok", source: "address", verified: false,
      token: { label: shortLabel(q), value: q, dec },
      warning: UNVERIFIED_ADDRESS_WARNING, query: q,
    };
  }

  // 2) exact ticker/symbol match
  const exact = list.filter((o) => symbolOf(o).toLowerCase() === norm || String(o.label ?? "").toLowerCase() === norm);
  if (exact.length === 1) {
    return { status: "ok", source: "ticker", verified: true, token: toToken(exact[0], dec), query: q };
  }
  if (exact.length > 1) {
    return { status: "ambiguous", matches: exact.map((o) => toToken(o, dec)), warning: MULTI_CONTRACT_WARNING, query: q };
  }

  // 3) name / partial match
  const loose = list.filter((o) => o.value && String(o.label ?? "").toLowerCase().includes(norm));
  if (loose.length === 1) {
    return { status: "ok", source: "name", verified: true, token: toToken(loose[0], dec), query: q };
  }
  if (loose.length > 1) {
    return { status: "ambiguous", matches: loose.map((o) => toToken(o, dec)), warning: MULTI_CONTRACT_WARNING, query: q };
  }

  return {
    status: "unknown", query: q,
    warning: `No token on this network matches "${q}". Paste its contract address to add it.`,
  };
}
