/**
 * balances.js — per-chain token balance readers for the v2 bridge form's
 * balance line ("bridge should have values of what is in the users wallets").
 *
 * Three sides, all fail-soft (a dead RPC / disconnected wallet → null → the
 * UI shows "—" for that side; the bridge form is NEVER blocked or thrown):
 *
 *   EVM    — eth_call balanceOf(token, wallet) on the connected EIP-1193
 *            provider. Decimals come from TOKENS (USDC 6, USDT 6, DAI 18 —
 *            BSC's USDC/USDT are 18 — handled correctly per chain).
 *   Solana — RAW JSON-RPC getTokenAccountsByOwner (encoding: "jsonParsed")
 *            over plain fetch with a MULTI-RPC fallback ladder — the LIVE
 *            SITE's exact, proven pattern (Teleporter.jsx). A single
 *            endpoint 403/429 never kills the read; the ladder walks to the
 *            next RPC. Sums across every token account for a mint (a wallet
 *            can hold the same mint in multiple ATAs).
 *   X1     — the same raw JSON-RPC read against X1_RPC (the app's own
 *            infra; X1 documents a single mainnet public RPC).
 *
 * WHY plain fetch + raw JSON-RPC instead of a web3.js Connection (the v2
 * regression this file fixes): (1) web3.js 1.x requires PublicKey INSTANCES
 * for getParsedTokenAccountsByOwner — a raw base58 string throws
 * `ownerAddress.toBase58 is not a function` BEFORE any RPC round-trip, which
 * is exactly how the live Balances line showed `Solana: —` / `X1: —` even
 * with a healthy network; the raw JSON-RPC method accepts plain strings.
 * (2) the Connection reads went to a SINGLE endpoint (SOLANA_RPC default =
 * the IP-rate-limited Helius Secure URL), so one 403/429 killed the balance;
 * the live site's ladder has five rungs. Both are matched here.
 *
 * Every reader takes its transport as a parameter (provider / rpcs ladder)
 * so tests inject fakes — no network, no DOM. The component (BalancesLine.jsx)
 * passes the default ladders below.
 */

import { TOKENS, SOLANA_RPC, X1_RPC } from "./teleportConstants.js";

/** balanceOf(address) selector — the only EVM read the balance line needs. */
const BALANCE_OF_SIG = "0x70a08231";

/**
 * The Solana RPC fallback ladder — VERBATIM from the live site
 * (Teleporter.jsx, the multi-RPC fallback block): the first rung is the
 * env-overridable SOLANA_RPC, then four public endpoints, tried in order.
 * A 403/429/error on one rung falls through to the next. (With the default
 * SOLANA_RPC the Helius URL appears twice — that is the live code's exact
 * array; harmless, first success wins.)
 */
export const SOLANA_RPC_LADDER = [
  SOLANA_RPC,
  "https://berty-633y20-fast-mainnet.helius-rpc.com",
  "https://solana-rpc.publicnode.com",
  "https://rpc.ankr.com/solana",
  "https://solana.drpc.org",
].filter(Boolean);

/**
 * The X1 RPC ladder — X1 is the app's own infra and the X1 docs list a
 * single mainnet public RPC (https://rpc.mainnet.x1.xyz), so one rung is
 * correct; the reader below still walks it the same way as the Solana side.
 */
export const X1_RPC_LADDER = [X1_RPC].filter(Boolean);

/**
 * Read a wallet's balance of an ERC-20 token via eth_call.
 *
 * @param {{provider: ?object, wallet: ?string, token: ?{address: string,
 *          decimals: number}}} args
 *   provider = the resolved EIP-1193 provider ({ request }), wallet = the
 *   connected EVM address, token = TOKENS[chain][symbol] (address + decimals).
 * @returns {Promise<?number>} human units (raw base units / 10^decimals), or
 *   null when the wallet/provider/token is missing or the RPC read fails —
 *   fail-soft, never throws.
 */
export async function fetchEvmTokenBalance({ provider, wallet, token }) {
  if (!provider?.request || !wallet || !token?.address) return null;
  try {
    const data = BALANCE_OF_SIG + wallet.slice(2).toLowerCase().padStart(64, "0");
    const hex = await provider.request({
      method: "eth_call",
      params: [{ to: token.address, data }, "latest"],
    });
    if (hex == null) return null;
    const raw = BigInt(hex || "0x0");
    const decimals = token.decimals ?? 6;
    return Number(raw) / 10 ** decimals;
  } catch {
    return null; // RPC error / revert — fail-soft
  }
}

/**
 * Read one mint's balance for a wallet via the raw JSON-RPC
 * getTokenAccountsByOwner method (encoding: "jsonParsed") over plain fetch,
 * walking the RPC ladder until a rung answers. Sums across every token
 * account for the mint (a wallet can hold the same mint in multiple ATAs).
 *
 * The body/params/shape and the walk logic are the LIVE SITE's exact
 * pattern: `[wallet, { mint }, { encoding: "jsonParsed" }]`, non-ok HTTP →
 * next rung, jsonrpc error → next rung, `uiAmount` summed, null only when
 * EVERY rung failed. Plain base58 strings work directly — no PublicKey
 * instances (the raw JSON-RPC method has no web3.js arg validation).
 *
 * @param {{rpcs: ?Array<string>, wallet: ?string, mint: ?string,
 *          fetchFn?: Function}} args
 *   rpcs = endpoint URLs, tried in order; wallet = base58 owner address;
 *   mint = base58 mint address; fetchFn = fetch impl (tests inject a mock).
 * @returns {Promise<?number>} human units (uiAmount) summed across the
 *   wallet's accounts for the mint, 0 when the RPC answered with no
 *   accounts, or null when EVERY rung failed (403/429/error/jsonrpc error)
 *   — the UI shows "—", never a false 0.00.
 */
export async function fetchSvmMintBalance({ rpcs, wallet, mint, fetchFn = fetch }) {
  if (!rpcs?.length || !wallet || !mint) return null;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getTokenAccountsByOwner",
    params: [wallet, { mint }, { encoding: "jsonParsed" }],
  });
  for (const rpc of rpcs) {
    try {
      const r = await fetchFn(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!r.ok) continue; // try next RPC on 403/429/etc
      const j = await r.json();
      if (j.error) continue; // jsonrpc error (e.g. method blocked) → next RPC
      const accts = j?.result?.value || [];
      let total = 0;
      for (const a of accts) {
        const amt = a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
        if (typeof amt === "number") total += amt;
      }
      return total; // 0 = honest empty balance (RPC answered, no accounts)
    } catch {
      /* network/parse failure → try next rpc */
    }
  }
  return null; // ALL failed → null (unknown), UI shows "—", never 0.00
}

/**
 * Read a wallet's balances of several SPL/Token-2022 mints on an SVM chain
 * (Solana or X1) via the raw JSON-RPC getTokenAccountsByOwner ladder.
 * Each mint is read independently through the ladder; a mint whose WHOLE
 * ladder failed becomes null in the map (the UI renders "—" for it), and if
 * EVERY mint failed the whole result is null (the side renders "—").
 *
 * @param {{rpcs: ?Array<string>, wallet: ?string, mints: Array<{symbol: string,
 *          mint: string, decimals: number}>, fetchFn?: Function}} args
 *   rpcs = the chain's fallback ladder (SOLANA_RPC_LADDER / X1_RPC_LADDER);
 *   wallet = base58 owner address; mints = [{ symbol, mint, decimals }].
 * @returns {Promise<?Object<string, ?number>>} { symbol: humanUnits|null },
 *   or null when inputs are missing or EVERY mint's ladder failed —
 *   fail-soft, never throws.
 */
export async function fetchSvmTokenBalances({ rpcs, wallet, mints, fetchFn = fetch }) {
  if (!rpcs?.length || !wallet || !mints?.length) return null;
  const out = {};
  let anyOk = false;
  for (const m of mints) {
    const bal = await fetchSvmMintBalance({ rpcs, wallet, mint: m.mint, fetchFn });
    if (bal != null) anyOk = true;
    out[m.symbol] = bal;
  }
  return anyOk ? out : null;
}

/** The Solana-side mints the balance line shows (USDC + WSOL, per TOKENS). */
export const SOLANA_MINTS = [
  { symbol: "USDC", mint: TOKENS.sol.USDC.address, decimals: TOKENS.sol.USDC.decimals },
  { symbol: "WSOL", mint: TOKENS.sol.WSOL.address, decimals: TOKENS.sol.WSOL.decimals },
];

/** The X1-side mints the balance line shows (USDC.x + wSOL.X, per TOKENS). */
export const X1_MINTS = [
  { symbol: "USDC.x", mint: TOKENS.x1["USDC.x"].address, decimals: TOKENS.x1["USDC.x"].decimals },
  { symbol: "wSOL.X", mint: TOKENS.x1["wSOL.X"].address, decimals: TOKENS.x1["wSOL.X"].decimals },
];

/** Format a human-unit balance compactly: trim trailing zeros, cap decimals. */
export function formatBalance(n) {
  if (n == null) return null;
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  // 27.5900000 → "27.59"; 0.3000000 → "0.3"; 5 → "5"
  return parseFloat(num.toFixed(6)).toString();
}
