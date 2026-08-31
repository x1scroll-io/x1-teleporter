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
 */

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
  placeholder: {
    marginTop: 8, padding: 12, border: "1px dashed #3a4a63", borderRadius: 8,
    color: "#7d8aa0", fontSize: 12, fontStyle: "italic",
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
 * with its address + balance and a per-family Disconnect. The bridge form
 * is the Phase 3 next state; until then the placeholder marks the seam.
 */
function ConnectedBody() {
  const { sessions, disconnect } = useWalletContext();
  const connected = WALLET_FAMILIES.filter(
    (family) => sessions[family]?.status === "connected",
  );

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
      <div className="bridge-form-placeholder" data-testid="bridge-form-placeholder" style={S.placeholder}>
        The bridge form is the next state of this tab (Phase 3).
      </div>
    </div>
  );
}

export default function TeleportTab() {
  const { sessions } = useWalletContext();
  const anyConnected = WALLET_FAMILIES.some(
    (family) => sessions[family]?.status === "connected",
  );

  return (
    <div className="teleport-tab" role="tabpanel" aria-label="Teleport">
      {anyConnected ? <ConnectedBody /> : <ConnectModal />}
    </div>
  );
}
