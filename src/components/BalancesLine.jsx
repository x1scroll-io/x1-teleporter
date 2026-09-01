/**
 * BalancesLine.jsx — the bridge form's wallet-balances line with LIVE USD
 * values (Mr. Esters' directive: "bridge should have values of what is in
 * the users wallets").
 *
 * Renders one compact line under the Amount field showing, per CONNECTED
 * wallet, the tokens relevant to the current direction + selection with
 * their live USD worth:
 *
 *   EVM    — the selected token (USDC/USDT/DAI per TOKENS[chain].address) on
 *            the EVM side of the current leg: the SOURCE chain in forward
 *            (`from`), the DESTINATION chain in reverse (`to`).
 *   Solana — USDC + WSOL on the connected Solana wallet (both live there;
 *            the Warp leg locks whichever the burn released).
 *   X1     — USDC.x + wSOL.X on the connected wallet (same Solana session
 *            address — X1 is SVM-compatible; the app derives X1 ATAs from
 *            the Solana session's publicKey).
 *
 * Fail-soft by construction: a wallet that isn't connected, a dead RPC, a
 * missing price — each yields "—" for that side (or no USD value), and the
 * bridge form is NEVER blocked or thrown. Prices are LIVE (Coingecko batch,
 * cached 60s via src/lib/prices.js) — never hardcoded.
 *
 * Refresh triggers: wallets connect/disconnect, chain/token/direction
 * changes, amount changes (debounced), and `refreshSignal` bumps (the form
 * bumps it after a bridge completes). All fetchers are DI-able so tests mock
 * the network; nothing here touches a chain in tests.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CHAINS, TOKENS, SOLANA_RPC, X1_RPC } from "../lib/teleportConstants.js";
import { resolveEvmProvider } from "../lib/wallet/sessionProviders.js";
import { getPricesUSD, usdValue } from "../lib/prices.js";
import {
  fetchEvmTokenBalance,
  fetchSvmTokenBalances,
  SOLANA_MINTS,
  X1_MINTS,
  formatBalance,
} from "../lib/balances.js";

/** Default connection factory: real web3.js Connections for Solana + X1
 *  whose HTTP transport is routed through the app's OWN serverless RPC
 *  proxies (/api/rpc/solana + /api/rpc/x1 — fix/proxy-solana-x1-rpc).
 *  The live Balances-line symptom was `Solana: —` / `X1: —` while EVM
 *  worked: the browser's DIRECT fetches to the Solana/X1 RPCs failed in the
 *  user's network. Same-origin /api/rpc/* eliminates the browser-network
 *  variable (the same pattern that fixed the Warp release poll).
 *  DI-able via props so tests inject fakes (no network). Lazy: only built
 *  when a Solana/X1 wallet is connected and a read is actually needed. */
export async function defaultCreateConnections() {
  const { createProxiedConnection } = await import("../lib/proxiedConnection.js");
  return {
    sol: await createProxiedConnection(SOLANA_RPC, "/api/rpc/solana"),
    x1: await createProxiedConnection(X1_RPC, "/api/rpc/x1"),
  };
}

/** Default amount-debounce (ms) before refetching balances while typing. */
export const BALANCE_DEBOUNCE_MS = 400;

const S = {
  line: {
    display: "flex", flexWrap: "wrap", gap: "2px 14px", alignItems: "baseline",
    fontSize: 11, color: "#9aa6bb", marginTop: 6, lineHeight: 1.5,
  },
  label: { color: "#5B9DFF", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" },
  side: { whiteSpace: "nowrap" },
  value: { color: "#e8ecf3", fontWeight: 600 },
  dash: { color: "#7d8aa0" },
};

/**
 * @param {{
 *   direction: string, from: string, to: string, token: string,
 *   reverseToken: string, destToken: string, amount: string,
 *   evmSession: ?object, solSession: ?object, refreshSignal?: number,
 *   evmBalanceFetcher?: Function, solBalanceFetcher?: Function,
 *   x1BalanceFetcher?: Function, priceFetcher?: Function,
 *   createConnections?: Function, resolveEvmProviderFn?: Function,
 *   debounceMs?: number
 * }} props
 */
export default function BalancesLine({
  direction,
  from,
  to,
  token,
  reverseToken,
  destToken,
  amount,
  evmSession,
  solSession,
  refreshSignal = 0,
  evmBalanceFetcher = fetchEvmTokenBalance,
  solBalanceFetcher = fetchSvmTokenBalances,
  x1BalanceFetcher = fetchSvmTokenBalances,
  priceFetcher = getPricesUSD,
  createConnections = defaultCreateConnections,
  resolveEvmProviderFn = resolveEvmProvider,
  debounceMs = BALANCE_DEBOUNCE_MS,
}) {
  const [balances, setBalances] = useState(null); // { evm, sol, x1 } | null
  const [prices, setPrices] = useState(null); // { USDC, USDT, DAI, WSOL, USDC.x, wSOL.X } | null
  const [conns, setConns] = useState(null); // { sol, x1 } connections
  const seqRef = useRef(0); // stale-response guard

  const evmAddr = evmSession?.address || null;
  const solAddr = solSession?.address || null;
  // EVM side of the current leg: source chain in forward, destination in
  // reverse. The token shown is the user's selected stable (TOKENS[chain]).
  const evmChain = direction === "forward" ? from : to;
  const evmToken = TOKENS[evmChain]?.[token] || null;

  // Lazy, one-time connection build (only when a Solana/X1 wallet exists).
  useEffect(() => {
    if (!solAddr) return;
    let alive = true;
    createConnections()
      .then((c) => { if (alive) setConns(c); })
      .catch(() => { if (alive) setConns(null); }); // fail-soft
    return () => { alive = false; };
  }, [solAddr, createConnections]);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    const next = { evm: null, sol: null, x1: null };

    // Prices are the cheap, shared part — cache is inside priceFetcher.
    let priceMap = null;
    try { priceMap = await priceFetcher(); } catch { priceMap = null; }

    // EVM side (selected token on the leg's EVM chain).
    if (evmAddr && evmToken) {
      try {
        const provider = await resolveEvmProviderFn(evmSession);
        const bal = await evmBalanceFetcher({ provider, wallet: evmAddr, token: evmToken });
        next.evm = bal == null ? null : { symbol: token, balance: bal };
      } catch {
        next.evm = null; // fail-soft
      }
    }

    // Solana + X1 sides (both use the Solana session's address).
    if (solAddr && conns) {
      if (conns.sol) {
        try {
          next.sol = await solBalanceFetcher({ connection: conns.sol, wallet: solAddr, mints: SOLANA_MINTS });
        } catch {
          next.sol = null;
        }
      }
      if (conns.x1) {
        try {
          next.x1 = await x1BalanceFetcher({ connection: conns.x1, wallet: solAddr, mints: X1_MINTS });
        } catch {
          next.x1 = null;
        }
      }
    }

    if (seq !== seqRef.current) return; // a newer load superseded this one
    setBalances(next);
    setPrices(priceMap);
  }, [evmAddr, evmToken, solAddr, conns, evmSession, token, evmBalanceFetcher, solBalanceFetcher, x1BalanceFetcher, priceFetcher, resolveEvmProviderFn]);

  // Immediate refresh: wallets connect/disconnect + chain/token/direction
  // changes + manual refreshSignal bumps (after a bridge completes).
  useEffect(() => {
    if (!evmAddr && !solAddr) { setBalances(null); return; }
    load();
  }, [load, direction, from, to, token, reverseToken, destToken, refreshSignal, evmAddr, solAddr]);

  // Debounced refresh while the amount changes (typing) — the balance line
  // stays fresh without hammering RPCs on every keystroke.
  useEffect(() => {
    if (!evmAddr && !solAddr) return;
    const t = setTimeout(load, debounceMs);
    return () => clearTimeout(t);
  }, [amount, debounceMs, load, evmAddr, solAddr]);

  // Nothing to show until at least one wallet is connected.
  if (!evmAddr && !solAddr) return null;

  const evmChainName = CHAINS[evmChain]?.name || evmChain.toUpperCase();
  const usd = (symbol, balance) => {
    const p = prices?.[symbol];
    return p != null && balance != null ? usdValue(balance, p) : null;
  };
  const fmtUsd = (v) => (v == null ? null : `$${v.toFixed(2)}`);

  const evmPart = balances?.evm
    ? `${formatBalance(balances.evm.balance)} ${token}${fmtUsd(usd(token, balances.evm.balance)) ? ` (${fmtUsd(usd(token, balances.evm.balance))})` : ""}`
    : "—";

  /** Render a side's token parts joined by " · " separators. */
  const joinParts = (parts) =>
    parts.flatMap((p, i) =>
      i === 0 ? [<span key={0} style={S.value}>{p}</span>] : [<span key={`s${i}`} style={S.dash}> · </span>, <span key={i} style={S.value}>{p}</span>],
    );
  const solParts = balances?.sol
    ? joinParts(SOLANA_MINTS.map((m) => {
        const b = balances.sol[m.symbol];
        const u = usd(m.symbol, b);
        return b == null
          ? `${m.symbol}: —`
          : `${formatBalance(b)} ${m.symbol}${u != null ? ` (${fmtUsd(u)})` : ""}`;
      }))
    : null;
  const x1Parts = balances?.x1
    ? joinParts(X1_MINTS.map((m) => {
        const b = balances.x1[m.symbol];
        const u = usd(m.symbol, b);
        return b == null
          ? `${m.symbol}: —`
          : `${formatBalance(b)} ${m.symbol}${u != null ? ` (${fmtUsd(u)})` : ""}`;
      }))
    : null;

  return (
    <div className="balances-line" data-testid="balances-line" style={S.line}>
      <span style={S.label}>Balances</span>
      {evmAddr && (
        <span className="balances-side" data-testid="balance-evm" style={S.side}>
          {evmChainName}: <span data-testid={`balance-token-${token}`} style={S.value}>{evmPart}</span>
        </span>
      )}
      {solAddr && (
        <span className="balances-side" data-testid="balance-sol" style={S.side}>
          Solana: {solParts || <span style={S.value}>—</span>}
        </span>
      )}
      {solAddr && (
        <span className="balances-side" data-testid="balance-x1" style={S.side}>
          X1: {x1Parts || <span style={S.value}>—</span>}
        </span>
      )}
    </div>
  );
}
