/**
 * payoutConfig.js — the MEV CAPTURE PAYOUT CONFIG (pure).
 *
 * Mr. Esters' TREASURY DESIGN (confirmed — the deposit side of the capture
 * engine, src/lib/mev/). Read docs/MEV-PAYOUT.md for the full design; this
 * module is its config surface.
 *
 * ── THE DESIGN IN ONE SCREEN ──────────────────────────────────────────────
 *   1. PER-CHAIN PAYOUT ADDRESSES (deposit-only): the engine DEPOSITS
 *      captures to a per-chain treasury address map. The engine never holds
 *      or spends from these addresses — they are destinations, not keys
 *      (the SEEDs live offline with Mr. Esters, never in the repo).
 *      - evm      0xd907e2d4770D3222382eE619980075ac1e59a369
 *        (serves ETH / Base / BNB / Arb / Opt / Pol / RH — one address,
 *        one EVM key, per-chain deployment)
 *      - solana_x1  H3JfpvBRxAQ9ejrkyeKtCEy3WSRKbwcCxxxFBcohKSuY
 *        (Solana + X1 are the same SVM address space — one address serves
 *        both)
 *      BTC/XRP/… can be added later IF captures ever happen on those rails
 *      (today the capture engine scans the same-chain swap venues:
 *      eth/arb/bas/opt/pol/bsc/sol — CAPTURE_SCAN_CHAINS in routePlanner).
 *   2. CAPTURE CHEAP (drop-as-is): a captured token is dropped AS-IS into
 *      that chain's treasury — no per-trade conversion, no per-trade send
 *      beyond the deposit. Minimal gas per capture.
 *   3. ACCUMULATE: tokens pile up in the per-chain treasury over the
 *      period (the captureLedger.js record of the pile).
 *   4. BATCH SWEEP (daily/weekly — configurable, NOT per-trade): ONE
 *      batched op per chain converts the pile → the SOL/wBTC/wETH/USDC
 *      basket. Gas paid ONCE per batch (amortized — what makes small
 *      captures profitable). The sweep planner (sweepPlanner.js) produces
 *      the plan/signable artifacts; nothing here executes.
 *   5. CONSOLIDATION: Mr. Esters' later choice — keep per-chain treasuries
 *      OR bridge each chain's captures to the Solana hub (our own bridge)
 *      and convert there. DEFAULT: accumulate per-chain; the decision is
 *      deferred (sweepPlanner builds BOTH plan shapes).
 *
 * 🔴 DEPOSIT-ONLY BOUNDARY (structural): these addresses are DESTINATIONS.
 * Nothing in this module (or the ledger/planner built on it) ever signs,
 * spends, or moves funds FROM a treasury. Every consumer documents the
 * boundary; the capture path stays gated OFF (MEV_CAPTURE_ENABLED=false —
 * captureGate.js) and even armed it only produces signable artifacts
 * through the repo's existing guarded legs (DexDirectLiveTestGateError
 * discipline). No autonomous broadcast exists at any flag value.
 *
 * ── WHERE THE ADDRESSES COME FROM (the load pattern) ──────────────────────
 * The DEFAULT group map below carries the PUBLIC deposit addresses verbatim
 * (they are deposit-only destinations — public by design, like a store's
 * register). The CONFIG PATTERN mirrors how the repo loads every other
 * secret-ish value (flags.ts / .env.example): an env or gitignored-file
 * OVERRIDE may replace an address at deploy/arm time (readPayoutEnv +
 * resolvePayoutConfig). The treasury SEEDs/keys are NEVER in the repo —
 * they live in .sandbox/ (gitignored) and Mr. Esters' offline copy.
 * Sandbox measurement runs target the TEST fleet addresses (.sandbox
 * mev-treasury-hd.json) via the same override path.
 *
 * ── THE SWEEP BASKET ──────────────────────────────────────────────────────
 * Mr. Esters' basket: ["SOL", "wBTC", "wETH", "USDC"] — the batch-convert
 * targets. The member names are CONCEPTUAL (the wallet's shorthand); each
 * chain represents a member with its CANONICAL asset (BASKET_TARGETS,
 * verified against the repo's tokenResolver in the tests). A member with no
 * canonical entry on a chain (e.g. "SOL" on an EVM chain today) is honestly
 * marked unavailable there — the per-chain sweep converts the representable
 * slice and the hub-consolidation plan shape carries the rest to the Solana
 * hub where the FULL basket exists.
 *
 * All address/chain validations fail closed (throw) — a wrong destination
 * is a lost deposit, so the config never silently accepts a malformed one.
 */

/** The DEFAULT payout groups — the public deposit-only treasury map.
 *  `chains` = the canonical chain keys (teleportConstants CHAINS /
 *  tokenResolver CHAIN_META ids) each group's address serves.
 *  NOTE (interim): these addresses are Mr. Esters' current treasury
 *  destinations. Post-cutover he re-derives them from his own offline seed —
 *  the override path (env / gitignored file) is the swap-out mechanism. */
export const MEV_PAYOUT_GROUPS_DEFAULT = Object.freeze({
  evm: Object.freeze({
    label: "EVM treasury (ETH / Base / BNB / Arb / Opt / Pol / RH — one EVM address)",
    family: "evm",
    address: "0xd907e2d4770D3222382eE619980075ac1e59a369",
    chains: Object.freeze(["eth", "bas", "bsc", "arb", "opt", "pol", "rbn"]),
  }),
  solana_x1: Object.freeze({
    label: "Solana + X1 treasury (same SVM address — Solana and X1 share the SVM address space)",
    family: "svm",
    address: "H3JfpvBRxAQ9ejrkyeKtCEy3WSRKbwcCxxxFBcohKSuY",
    chains: Object.freeze(["sol", "x1"]),
  }),
});

/** The deposit-only boundary note, carried on every config + plan. */
export const MEV_PAYOUT_DEPOSIT_ONLY_NOTE =
  "DEPOSIT-ONLY: the engine sends captures TO these treasury addresses and never holds, signs, or spends " +
  "from them — the treasury keys live offline with Mr. Esters (never in the repo). No autonomous broadcast " +
  "exists at any flag value (captureGate.js: gated OFF by default; armed = signable artifacts only, " +
  "DexDirectLiveTestGateError discipline).";

/** The drop-as-is note (capture cheap — no per-trade conversion). */
export const MEV_PAYOUT_DROP_AS_IS_NOTE =
  "drop-as-is: a capture is deposited AS-IS into its chain's treasury (the captured token, no per-trade " +
  "conversion, no per-trade send beyond the deposit) — minimal gas per capture. Conversion happens ONCE per " +
  "batch at sweep time (gas amortized across the pile).";

/** Allowed sweep frequencies. */
export const MEV_SWEEP_FREQUENCIES = Object.freeze(["daily", "weekly"]);

/** The config default cadence (batch sweep — NOT per-trade). */
export const MEV_SWEEP_FREQUENCY_DEFAULT = "daily";

/** The batch-sweep basket (Mr. Esters' shorthand names — the conversion
 *  targets of a sweep). Order is the display/priority order. */
export const MEV_SWEEP_BASKET = Object.freeze(["SOL", "wBTC", "wETH", "USDC"]);

/** The basket note (conceptual names vs canonical per-chain assets). */
export const MEV_SWEEP_BASKET_NOTE =
  "the basket member names are Mr. Esters' shorthand (SOL/wBTC/wETH/USDC); each chain represents a member " +
  "with its CANONICAL asset via BASKET_TARGETS (verified against the repo tokenResolver in the tests). A " +
  "member with no canonical entry on a chain is honestly unavailable there (the per-chain sweep converts " +
  "the representable slice; the hub-consolidation shape carries the rest to the Solana hub).";

/**
 * BASKET_TARGETS — per-chain canonical representation of each basket member.
 * Key: canonical chain id; value: { basket member → canonical symbol }.
 * The canonical symbols are the tokenResolver row keys (WSOL = the SPL
 * native-wrap of SOL; cbBTC = Solana's canonical wrapped BTC; ETH = native
 * EVM gas identity / the Solana Wormhole-wrapped ETH row; the .X symbols are
 * the X1 Warp twins). VERIFIED: the tests assert every mapped symbol
 * actually resolves on its chain through tokenResolver.resolve — this table
 * is data, the resolver is the ground truth.
 *
 * Representability today (why some chains are partial):
 *   - sol: the FULL basket — SOL→WSOL (native wrap; legs swap via WSOL and
 *     the treasury deposit can unwrap), wBTC→cbBTC, wETH→ETH (Wormhole
 *     wrap), USDC→USDC.
 *   - x1: the FULL basket via the Warp twins — SOL→wSOL.X, wBTC→cbBTC.X,
 *     wETH→ETH.X, USDC→USDC.x.
 *   - eth/arb/opt/bas: wETH→ETH (native gas identity; the swap leg's
 *     native handling wraps/unwraps at arm time) + USDC. SOL/wBTC have no
 *     canonical EVM entry in the resolver → unavailable today.
 *   - bsc/pol/avax/sonic: USDC only (native gas is BNB/MATIC/AVAX/S, not
 *     ETH; no canonical wBTC wrap in the resolver).
 *   - rbn (Robinhood Chain): NONE of the four resolve today (the canonical
 *     stable is Paxos USDG; there is no Circle USDC / ETH ground truth —
 *     tokenResolver deliberately leaves those entries unverified). Captures
 *     still drop into the EVM treasury; basket conversion waits for rails
 *     or rides the hub-consolidation path.
 */
export const BASKET_TARGETS = Object.freeze({
  // SVM family — full basket
  sol: Object.freeze({ SOL: "WSOL", wBTC: "cbBTC", wETH: "ETH", USDC: "USDC" }),
  x1: Object.freeze({ SOL: "wSOL.X", wBTC: "cbBTC.X", wETH: "ETH.X", USDC: "USDC.x" }),
  // EVM family — the representable slice (resolver ground truth today)
  eth: Object.freeze({ wETH: "ETH", USDC: "USDC" }),
  arb: Object.freeze({ wETH: "ETH", USDC: "USDC" }),
  opt: Object.freeze({ wETH: "ETH", USDC: "USDC" }),
  bas: Object.freeze({ wETH: "ETH", USDC: "USDC" }),
  bsc: Object.freeze({ USDC: "USDC" }),
  pol: Object.freeze({ USDC: "USDC" }),
  avax: Object.freeze({ USDC: "USDC" }),
  sonic: Object.freeze({ USDC: "USDC" }),
  rbn: Object.freeze({}),
});

/** Which group family a chain key belongs to (evm | svm | null). Mirrors
 *  tokenResolver CHAIN_META families for the chains the capture engine
 *  serves — kept local so this module stays dependency-free. */
const CHAIN_FAMILY = Object.freeze({
  eth: "evm", bsc: "evm", arb: "evm", bas: "evm", opt: "evm", pol: "evm",
  avax: "evm", sonic: "evm", rbn: "evm", tron: "evm",
  sol: "svm", x1: "svm",
});

// ── pure address validation (fail-closed) ──────────────────────────────────

/** The base58 alphabet (bitcoin/solana). */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Pure base58 decode → Uint8Array. Throws on empty input, invalid
 * characters, or over-long input. (No external dep — ~20 lines.)
 * @param {string} input
 * @returns {Uint8Array} big-endian bytes (leading '1's → leading zero bytes)
 */
export function base58Decode(input) {
  if (typeof input !== "string" || input.length === 0) throw new Error("payoutConfig: base58 input must be a non-empty string");
  if (input.length > 64) throw new Error("payoutConfig: base58 input too long");
  let n = 0n;
  for (const ch of input) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`payoutConfig: invalid base58 character "${ch}"`);
    n = n * 58n + BigInt(idx);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  const lead = input.match(/^1*/)[0].length; // each leading '1' = one leading zero byte
  return new Uint8Array([...new Array(lead).fill(0), ...bytes]);
}

/** True when the address is a well-formed EVM address (0x + 40 hex). */
export function isValidEvmAddress(address) {
  return typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address);
}

/** True when the address is a well-formed SVM address (base58, 32 bytes). */
export function isValidSvmAddress(address) {
  if (typeof address !== "string" || address.length === 0) return false;
  try {
    return base58Decode(address).length === 32;
  } catch {
    return false;
  }
}

/** The per-family format validator (used by resolvePayoutConfig). */
export function assertValidTreasuryAddress(groupId, address) {
  const family = MEV_PAYOUT_GROUPS_DEFAULT[groupId]?.family;
  if (!family) throw new Error(`payoutConfig: unknown payout group "${groupId}" (evm | solana_x1)`);
  const ok = family === "evm" ? isValidEvmAddress(address) : isValidSvmAddress(address);
  if (!ok) {
    throw new Error(
      `payoutConfig: group "${groupId}" address "${address}" is not a valid ${family.toUpperCase()} address ` +
      `(${family === "evm" ? "0x + 40 hex chars" : "base58 encoding 32 bytes"}) — a wrong treasury destination is a lost deposit, so the config fails closed`,
    );
  }
  return true;
}

// ── the config resolver (pure) ─────────────────────────────────────────────

/**
 * resolvePayoutConfig — validate + normalize the payout config from
 * optional overrides. Pure: given overrides in, config out; no env access
 * here (readPayoutEnv is the separate env→overrides mapper; tools compose
 * the two). Defaults = MEV_PAYOUT_GROUPS_DEFAULT (the public deposit
 * addresses) + daily cadence + the full basket.
 *
 * @param {object} [overrides]
 * @param {object} [overrides.groups]      { evm?: { address? }, solana_x1?:
 *   { address? } } — override an address (env / gitignored file at arm
 *   time); chains stay the group defaults unless a `chains` array is given.
 * @param {string} [overrides.sweepFrequency] "daily" | "weekly"
 * @param {string[]} [overrides.sweepBasket]  subset/order of MEV_SWEEP_BASKET
 * @returns {object} the frozen, validated config:
 *   { version, groups, payouts: {chain→address}, sweep: {frequency,
 *   basket}, depositOnly: true, note }
 * @throws on any malformed override (fail-closed)
 */
export function resolvePayoutConfig(overrides = {}) {
  const o = overrides ?? {};
  const groupsRaw = o.groups ?? {};
  for (const key of Object.keys(groupsRaw)) {
    if (!MEV_PAYOUT_GROUPS_DEFAULT[key]) {
      throw new Error(`payoutConfig: unknown payout group override "${key}" (known: ${Object.keys(MEV_PAYOUT_GROUPS_DEFAULT).join(" | ")})`);
    }
  }

  const groups = {};
  const payouts = {};
  for (const [groupId, def] of Object.entries(MEV_PAYOUT_GROUPS_DEFAULT)) {
    const ov = groupsRaw[groupId] ?? {};
    const address = typeof ov.address === "string" && ov.address ? ov.address : def.address;
    assertValidTreasuryAddress(groupId, address);
    const chains = Array.isArray(ov.chains) && ov.chains.length > 0 ? [...ov.chains] : [...def.chains];
    for (const chain of chains) {
      if (typeof chain !== "string" || !chain) throw new Error(`payoutConfig: group "${groupId}" has an invalid chain key`);
      if (CHAIN_FAMILY[chain] !== def.family) {
        throw new Error(`payoutConfig: chain "${chain}" is not ${def.family} — it cannot be served by the "${groupId}" group`);
      }
    }
    groups[groupId] = Object.freeze({ ...def, address, chains: Object.freeze([...chains]) });
    for (const chain of chains) payouts[chain] = address;
  }

  const frequency = o.sweepFrequency ?? MEV_SWEEP_FREQUENCY_DEFAULT;
  if (!MEV_SWEEP_FREQUENCIES.includes(frequency)) {
    throw new Error(`payoutConfig: sweepFrequency must be one of ${MEV_SWEEP_FREQUENCIES.join(" | ")} (got "${frequency}")`);
  }

  const basket = Array.isArray(o.sweepBasket) && o.sweepBasket.length > 0 ? [...o.sweepBasket] : [...MEV_SWEEP_BASKET];
  const seen = new Set();
  for (const member of basket) {
    if (!MEV_SWEEP_BASKET.includes(member)) {
      throw new Error(`payoutConfig: unknown basket member "${member}" (known: ${MEV_SWEEP_BASKET.join(", ")})`);
    }
    if (seen.has(member)) throw new Error(`payoutConfig: duplicate basket member "${member}"`);
    seen.add(member);
  }

  return Object.freeze({
    version: 1,
    kind: "mev-payout-config",
    groups: Object.freeze(groups),
    /** chain key → treasury address (the drop-as-is destination map). */
    payouts: Object.freeze(payouts),
    sweep: Object.freeze({
      frequency,
      basket: Object.freeze(basket),
      basketNote: MEV_SWEEP_BASKET_NOTE,
    }),
    depositOnly: true,
    note: MEV_PAYOUT_DEPOSIT_ONLY_NOTE,
  });
}

/** The singleton default config (public deposit addresses + defaults). */
export const DEFAULT_MEV_PAYOUT_CONFIG = resolvePayoutConfig({});

/**
 * readPayoutEnv — map an env object to config overrides (the repo's env
 * pattern: VITE_/NEXT_PUBLIC_ names for client-build values + plain names
 * for server/tool values — mirrors flags.ts + .env.example). Empty/unset
 * values are skipped so defaults stand. Pure.
 *
 * Recognized keys:
 *   VITE_MEV_PAYOUT_EVM | NEXT_PUBLIC_MEV_PAYOUT_EVM  → groups.evm.address
 *   VITE_MEV_PAYOUT_SOLANA_X1 | NEXT_PUBLIC_MEV_PAYOUT_SOLANA_X1 → groups.solana_x1.address
 *   MEV_SWEEP_FREQUENCY   → sweepFrequency ("daily" | "weekly")
 *   MEV_SWEEP_BASKET      → sweepBasket (comma-separated)
 *
 * @param {object} env process.env / import.meta.env / a gitignored-file map
 * @returns {object} overrides ready for resolvePayoutConfig
 */
export function readPayoutEnv(env = {}) {
  const pick = (names) => {
    for (const name of names) {
      const raw = env[name];
      if (raw !== undefined && raw !== null && String(raw) !== "") return String(raw).trim();
    }
    return null;
  };
  const groups = {};
  const evm = pick(["VITE_MEV_PAYOUT_EVM", "NEXT_PUBLIC_MEV_PAYOUT_EVM"]);
  if (evm) groups.evm = { address: evm };
  const svm = pick(["VITE_MEV_PAYOUT_SOLANA_X1", "NEXT_PUBLIC_MEV_PAYOUT_SOLANA_X1"]);
  if (svm) groups.solana_x1 = { address: svm };
  const overrides = {};
  if (Object.keys(groups).length) overrides.groups = groups;
  const frequency = pick(["MEV_SWEEP_FREQUENCY"]);
  if (frequency) overrides.sweepFrequency = frequency;
  const basket = pick(["MEV_SWEEP_BASKET"]);
  if (basket) {
    overrides.sweepBasket = basket.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return overrides;
}

/**
 * treasuryForChain — the drop-as-is destination for a chain.
 * @param {object} config from resolvePayoutConfig (default when omitted)
 * @param {string} chain canonical chain key
 * @returns {string|null} the treasury address, or null when the chain is
 *   NOT covered by the payout map (capture on an unconfigured chain cannot
 *   drop anywhere — the ledger record builder fails closed on that).
 */
export function treasuryForChain(config = DEFAULT_MEV_PAYOUT_CONFIG, chain) {
  if (!chain) return null;
  return config.payouts[chain] ?? null;
}

/**
 * payoutGroupForChain — which payout group serves a chain.
 * @returns {string|null} "evm" | "solana_x1" | null (unconfigured chain)
 */
export function payoutGroupForChain(config = DEFAULT_MEV_PAYOUT_CONFIG, chain) {
  if (!chain) return null;
  for (const [groupId, g] of Object.entries(config.groups)) {
    if (g.chains.includes(chain)) return groupId;
  }
  return null;
}

/** The configured chains (all groups' chains, in group order). */
export function configuredChains(config = DEFAULT_MEV_PAYOUT_CONFIG) {
  const out = [];
  for (const g of Object.values(config.groups)) out.push(...g.chains);
  return out;
}

/** The configured payout group for an ADDRESS (reverse lookup — the sweep
 *  destination summary uses it). @returns {string|null} group id */
export function payoutGroupForAddress(config = DEFAULT_MEV_PAYOUT_CONFIG, address) {
  if (!address) return null;
  for (const [groupId, g] of Object.entries(config.groups)) {
    if (g.address === address) return groupId;
  }
  return null;
}
