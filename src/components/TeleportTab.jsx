/**
 * TeleportTab — the Teleport tab of the one-card layout (Step 2.2).
 *
 * Per docs/BRIEF.md the whole bridge experience is ONE card with tabs
 * (Teleport / THORChain / Buy) and sequential states inside each tab. The
 * Teleport tab's first state is the wallet connect flow (ConnectModal) —
 * pick a family → pick a wallet → connecting → connected. Once a session
 * is connected the tab DERIVES its body from the sessions and renders the
 * connected view (the next sequential state); the bridge form is the
 * Phase 3 state after it. Phase 3 adds the bridge form as the next state
 * of this same tab.
 *
 * THE TRANSITION (bug fix): before this, the tab rendered ConnectModal
 * unconditionally — a successful connect flipped the session to
 * "connected" (the inline status box proved the state updated) but
 * nothing ever switched the render from picker to body, so the UI stayed
 * on the wallet-picker screen. The connected session is the derived
 * trigger: no session connected → picker; any session connected → body.
 * Wallet-agnostic by construction: it keys on session.status, never on a
 * wallet id or provider shape.
 *
 * PHASE 3 (bridge form): once ANY session is connected the body renders the
 * REAL bridge form (TeleportForm) — chains, tokens, amount, Get Quote, the
 * fee lines (Teleporter fee 1% + Warp bridge fee $1 on X1 routes), and the
 * simulation-gated send — wired to the WalletContext sessions (the EVM
 * session's provider/address drives the quote + stage-1 send; the Solana
 * session's address is the LiFi leg's destination and its adapter signs the
 * Warp stage 2). The old "Phase 3" placeholder is GONE — see
 * TeleportForm.jsx for the full flow + gates (WARP_LIVE_SEND, simulation).
 */

import { useEffect, useRef, useState } from "react";
import { useWalletContext } from "../lib/wallet/WalletContext.jsx";
import { WALLET_FAMILIES, FAMILY_LABELS } from "../lib/wallet/families.js";
import { formatBtcBalance } from "../lib/wallet/bitcoinBalance.js";
import {
  formatLtcBalance,
  formatDogeBalance,
} from "../lib/wallet/altcoinBalance.js";
import { formatXrpBalance } from "../lib/wallet/xrpBalance.js";
import { formatTronBalance } from "../lib/wallet/tronBalance.js";
import ConnectModal from "./ConnectModal.jsx";
import TeleportForm from "./TeleportForm.jsx";

const S = {
  h2: { margin: "0 0 12px", fontSize: 18, color: "#e8ecf3" },
  row: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    background: "#0d1420", border: "1px solid #1c2a3f", borderRadius: 8,
    padding: "12px 14px", marginBottom: 8, color: "#e8ecf3",
  },
  family: { fontWeight: 600 },
  address: { display: "block", fontSize: 12, color: "#7d8aa0", wordBreak: "break-all", marginTop: 2 },
  balance: { color: "#5fd38a", fontSize: 12 },
  disconnect: {
    background: "none", border: "1px solid #3a4a63", color: "#7d8aa0",
    borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 13,
  },
  connectAnother: {
    width: "100%", margin: "4px 0 8px", padding: "10px 0", borderRadius: 8,
    background: "transparent", border: "1px dashed #2e4a6b", color: "#3fd3e8",
    fontSize: 13, cursor: "pointer",
  },
  cancelConnect: {
    background: "none", border: "none", color: "#3fd3e8", cursor: "pointer",
    padding: "0 0 10px", fontSize: 13,
  },
};

/** Per-family balance formatter for the connected-session rows. */
function formatBalance(familyName, balance) {
  if (balance === undefined) return null;
  switch (familyName) {
    case "bitcoin":
      return formatBtcBalance(balance);
    case "litecoin":
      return formatLtcBalance(balance);
    case "dogecoin":
      return formatDogeBalance(balance);
    case "xrp":
      return formatXrpBalance(balance);
    case "tron":
      return formatTronBalance(balance);
    default:
      return null;
  }
}

/**
 * The connected body — the Teleport tab's second sequential state. Renders
 * every connected family session (one session per family, isolation intact)
 * with its address + balance and a per-family Disconnect, then the Phase 3
 * bridge form (TeleportForm) wired to the connected sessions — the EVM
 * session's provider/address drives the quote + stage-1 send, the Solana
 * session's address is the LiFi leg's destination and its adapter signs the
 * Warp stage 2.
 *
 * MULTI-WALLET (bug fix): the tab switches here as soon as ANY family
 * connects, which unmounts ConnectModal — the ONLY connect path. So the
 * body carries a "Connect another wallet" affordance that re-opens the
 * modal INLINE (a local `connecting` state); when the user connects a new
 * family the modal auto-closes back to the body showing ALL sessions. The
 * form's missing-wallet warnings are wired to the same affordance.
 */
function ConnectedBody({ formProps = {} }) {
  const { sessions, disconnect } = useWalletContext();
  // "Connect another wallet" mode: while set, the ConnectModal renders
  // INLINE in place of the body (it already has the family picker — pick a
  // family → pick a wallet → connecting → connected). This is the ONLY path
  // to connect additional families: the tab switches to this body as soon as
  // ANY family connects, so the modal (the connect path) would otherwise be
  // unmounted and unreachable (the live-preview bug).
  const [connecting, setConnecting] = useState(false);
  const connected = WALLET_FAMILIES.filter(
    (family) => sessions[family]?.status === "connected",
  );
  // Auto-close: when a NEW family connects while the inline modal is open
  // (the user just connected another wallet), fall back to the connected
  // body showing BOTH sessions + the form. Keyed on the connected count so
  // the modal is untouched — the fix lives entirely in the tab's UI state.
  const prevConnectedCount = useRef(connected.length);
  useEffect(() => {
    if (connecting && connected.length > prevConnectedCount.current) {
      setConnecting(false);
    }
    prevConnectedCount.current = connected.length;
  }, [connecting, connected.length]);

  if (connecting) {
    return (
      <div className="teleport-connected" data-testid="teleport-connected">
        <button
          type="button"
          className="cancel-connect"
          data-testid="cancel-connect"
          style={S.cancelConnect}
          onClick={() => setConnecting(false)}
        >
          ← Back to connected wallets
        </button>
        <ConnectModal />
      </div>
    );
  }

  return (
    <div className="teleport-connected" data-testid="teleport-connected">
      <h2 style={S.h2}>Wallet connected</h2>
      {connected.map((family) => {
        const session = sessions[family];
        const balance = formatBalance(family, session.balance);
        return (
          <div key={family} className="connected-wallet" data-family={family} style={S.row}>
            <span>
              <span style={S.family}>{FAMILY_LABELS[family]}</span>
              <span className="connected-wallet__address" style={S.address}>
                <code>{session.address}</code>
              </span>
              {balance && (
                <span className="connected-wallet__balance" data-testid={`${family}-balance`} style={S.balance}>
                  balance {balance}
                </span>
              )}
            </span>
            <button
              type="button"
              className="disconnect-btn"
              style={S.disconnect}
              onClick={() => disconnect(family)}
            >
              Disconnect
            </button>
          </div>
        );
      })}
      {connected.length < WALLET_FAMILIES.length && (
        <button
          type="button"
          className="connect-another"
          data-testid="connect-another"
          style={S.connectAnother}
          onClick={() => setConnecting(true)}
        >
          + Connect another wallet
        </button>
      )}
      <TeleportForm
        evmSession={sessions.evm}
        solSession={sessions.solana}
        onConnectWallet={() => setConnecting(true)}
        {...formProps}
      />
    </div>
  );
}

export default function TeleportTab({ formProps = {} }) {
  const { sessions } = useWalletContext();
  const anyConnected = WALLET_FAMILIES.some(
    (family) => sessions[family]?.status === "connected",
  );

  return (
    <div className="teleport-tab" role="tabpanel" aria-label="Teleport">
      {anyConnected ? <ConnectedBody formProps={formProps} /> : <ConnectModal />}
    </div>
  );
}
