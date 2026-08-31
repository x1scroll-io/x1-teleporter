/**
 * ConnectModal — the wallet connect flow (Step 2.2).
 *
 * Lives INSIDE the one-card Connect tab (docs/BRIEF.md: one card, tabs,
 * sequential states). NOT a floating overlay: it renders as tab content and
 * follows a sequential state machine — pick a family → pick a wallet →
 * connecting → connected / error (the status is derived from the family's
 * WalletContext session).
 *
 * Modal rules (docs/WALLET-REGISTRY.md, implemented via modalLogic.js):
 *   1. Fixed order — families render in WALLET_FAMILIES order.
 *   2. Starport pinned first — first row in every family, always visible.
 *   3. Installed highlighted — discovered wallets get the `installed` class
 *      and an "Installed" badge.
 *   4. Not-installed still shown — with their install link, never hidden.
 *   5. Never hide a wallet — every registry entry is always reachable.
 *
 * All ordering/highlighting logic is pure (modalLogic.js) and tested without
 * a browser; this component only renders.
 */

import { useState } from "react";
import { useWalletContext } from "../lib/wallet/WalletContext.jsx";
import { FAMILY_LABELS } from "../lib/wallet/families.js";
import { formatBtcBalance } from "../lib/wallet/bitcoinBalance.js";
import {
  formatLtcBalance,
  formatDogeBalance,
} from "../lib/wallet/altcoinBalance.js";
import { formatXrpBalance } from "../lib/wallet/xrpBalance.js";
import { formatTronBalance } from "../lib/wallet/tronBalance.js";
import {
  canSendInApp,
  depositMemoNote,
  depositRowSubtitle,
  isMemoRuleFamily,
  memoHandoffNote,
} from "../lib/wallet/memoRule.js";
import {
  buildFamilyRows,
  buildFamilyWalletRows,
  normalizeEvmDiscovered,
  normalizeSolanaDiscovered,
  normalizeBitcoinDiscovered,
  normalizeLitecoinDiscovered,
  normalizeDogecoinDiscovered,
  normalizeXrpDiscovered,
  normalizeTronDiscovered,
} from "../lib/wallet/modalLogic.js";

const S = {
  section: { padding: 16 },
  h2: { margin: "0 0 12px", fontSize: 18, color: "#e8ecf3" },
  back: {
    background: "none", border: "none", color: "#3fd3e8", cursor: "pointer",
    padding: "0 0 10px", fontSize: 13,
  },
  familyList: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 },
  familyRow: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    width: "100%", background: "#0d1420", border: "1px solid #1c2a3f",
    borderRadius: 8, padding: "12px 14px", cursor: "pointer", color: "#e8ecf3",
    textAlign: "left",
  },
  familyName: { fontWeight: 600 },
  familySubtitle: { fontSize: 12, color: "#7d8aa0" },
  status: {
    borderRadius: 8, padding: "10px 12px", marginBottom: 12, fontSize: 13,
    wordBreak: "break-all",
  },
  statusConnected: { background: "#0e2a1a", border: "1px solid #1f6b3a", color: "#5fd38a" },
  statusError: { background: "#2a1210", border: "1px solid #7a2a24", color: "#ff8f85" },
  statusConnecting: { background: "#101a2e", border: "1px solid #24406e", color: "#8fb8ff" },
  walletList: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 },
  walletRow: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    background: "#0d1420", border: "1px solid #1c2a3f", borderRadius: 8,
    padding: "10px 14px", color: "#e8ecf3",
  },
  walletRowInstalled: { border: "1px solid #2e7d4f", background: "#0f1d16" },
  walletRowPinned: { border: "1px solid #8a6d1a", background: "#1a160c" },
  walletName: { fontWeight: 600 },
  walletSub: { display: "block", fontSize: 11, color: "#7d8aa0", marginTop: 2 },
  badge: {
    marginLeft: 8, fontSize: 11, color: "#5fd38a", border: "1px solid #2e7d4f",
    borderRadius: 999, padding: "2px 8px",
  },
  verifyTag: {
    marginLeft: 8, fontSize: 11, color: "#e5c35c", border: "1px solid #8a6d1a",
    borderRadius: 999, padding: "2px 8px",
  },
  unmaintainedTag: {
    marginLeft: 8, fontSize: 11, color: "#ff9d85", border: "1px solid #7a3a2a",
    borderRadius: 999, padding: "2px 8px",
  },
  memoNote: { fontSize: 11, color: "#e5c35c", marginTop: 4, fontStyle: "italic" },
  depositOnlyNote: { fontSize: 11, color: "#7d8aa0", marginTop: 4, fontStyle: "italic" },
  depositRow: {
    marginTop: 10, border: "1px dashed #3a4a63", background: "#0c1320",
  },
  qrPlaceholder: {
    width: 88, height: 88, borderRadius: 6, border: "1px solid #2a3a55",
    background: "repeating-conic-gradient(#16223a 0% 25%, #0c1320 0% 50%) 0 0 / 14px 14px",
    marginRight: 12, flex: "0 0 auto",
  },
  memoTodo: { fontSize: 11, color: "#e5c35c", marginTop: 4, fontStyle: "italic" },
  pinnedTag: { marginLeft: 8, fontSize: 11, color: "#e5c35c", border: "1px solid #8a6d1a", borderRadius: 999, padding: "2px 8px" },
  connectBtn: {
    background: "#16404f", color: "#a8e6f5", border: "1px solid #1f5d74",
    borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontSize: 13,
  },
  connectBtnDisabled: { opacity: 0.5, cursor: "default" },
  installLink: { color: "#3fd3e8", fontSize: 13, textDecoration: "none" },
};

export default function ConnectModal() {
  const { sessions, connect, disconnect, discovered } = useWalletContext();
  const [selectedFamily, setSelectedFamily] = useState(null);

  // Step 1: pick a family (fixed order).
  if (!selectedFamily) {
    return (
      <section className="connect-modal" data-testid="connect-modal">
        <h2 style={S.h2}>Connect a wallet</h2>
        <ul className="family-list" style={S.familyList}>
          {buildFamilyRows().map(({ family, label }) => {
            const session = sessions[family];
            const subtitle =
              session.status === "connected"
                ? session.address
                : session.status === "error"
                  ? "Connection failed — retry"
                  : "Not connected";
            return (
              <li key={family}>
                <button
                  type="button"
                  className="family-row"
                  data-family={family}
                  data-status={session.status}
                  style={S.familyRow}
                  onClick={() => setSelectedFamily(family)}
                >
                  <span style={S.familyName}>{label}</span>
                  <span style={S.familySubtitle}>{subtitle}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    );
  }

  // Step 2: pick a wallet for the selected family. Status (connecting /
  // connected / error) is derived from the family's session.
  const family = selectedFamily;
  const session = sessions[family];
  const discoveredItems =
    family === "evm"
      ? normalizeEvmDiscovered(discovered.evm ?? [])
      : family === "solana"
        ? normalizeSolanaDiscovered(discovered.solana ?? [])
        : family === "bitcoin"
          ? normalizeBitcoinDiscovered(discovered.bitcoin ?? [])
          : family === "litecoin"
            ? normalizeLitecoinDiscovered(discovered.litecoin ?? [])
            : family === "dogecoin"
              ? normalizeDogecoinDiscovered(discovered.dogecoin ?? [])
              : family === "xrp"
                ? normalizeXrpDiscovered(discovered.xrp ?? [])
                : family === "tron"
                  ? normalizeTronDiscovered(discovered.tron ?? [])
                  : [];
  const rows = buildFamilyWalletRows({ family, discovered: discoveredItems });

  /** Per-family balance formatter for the connected-session line. */
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

  return (
    <section className="connect-modal" data-testid="connect-modal">
      <button type="button" className="back" style={S.back} onClick={() => setSelectedFamily(null)}>
        ← All families
      </button>
      <h2 style={S.h2}>Connect {FAMILY_LABELS[family]}</h2>

      {session.status === "connected" && (
        <div className="status status--connected" data-testid="connect-status" style={{ ...S.status, ...S.statusConnected }}>
          Connected: <code>{session.address}</code>
          {formatBalance(family, session.balance) && (
            <span className="balance" data-testid={`${family}-balance`}>
              {" "}· balance {formatBalance(family, session.balance)}
            </span>
          )}{" "}
          <button type="button" className="disconnect-btn" style={S.installLink} onClick={() => disconnect(family)}>
            Disconnect
          </button>
        </div>
      )}
      {session.status === "error" && (
        <div className="status status--error" data-testid="connect-status" style={{ ...S.status, ...S.statusError }}>
          {session.error}
        </div>
      )}
      {session.status === "connecting" && (
        <div className="status status--connecting" data-testid="connect-status" style={{ ...S.status, ...S.statusConnecting }}>
          Connecting…
        </div>
      )}

      <ul className="wallet-list" style={S.walletList}>
        {rows.map((row) => {
          // Deposit-address fallback row (BTC/LTC/DOGE/XRP): ALWAYS the
          // final row, never connectable — the v1 path. The deposit address
          // + memo come from the THORChain flow (Step 3.3); until then the
          // row shows the concept + a clearly marked TODO (family-aware:
          // OP_RETURN for LTC/DOGE, the XRPL Memos field for XRP). No
          // guessed APIs.
          if (row.depositAddress) {
            return (
              <li
                key={row.id}
                className="wallet-row wallet-row--deposit-address"
                data-wallet-id={row.id}
                data-deposit-address="true"
                style={{ ...S.walletRow, ...S.depositRow }}
              >
                <div style={{ display: "flex", alignItems: "center", width: "100%" }}>
                  <div className="qr-placeholder" style={S.qrPlaceholder} aria-hidden="true" />
                  <div>
                    <span style={S.walletName}>{row.name}</span>
                    <span style={S.walletSub}>{depositRowSubtitle(family)}</span>
                    <span className="deposit-memo-todo" style={S.memoTodo}>
                      {depositMemoNote(family)}
                    </span>
                  </div>
                </div>
              </li>
            );
          }

          // Deposit-only info rows (e.g. Tangem — registry: "Not a dApp
          // connector; deposit-address only"): rendered with an install
          // link, never connectable.
          if (row.depositOnly) {
            return (
              <li
                key={row.id}
                className="wallet-row"
                data-wallet-id={row.id}
                data-deposit-only="true"
                style={S.walletRow}
              >
                <span>
                  <span style={S.walletName}>{row.name}</span>
                  <span className="deposit-only-note" style={S.depositOnlyNote}>
                    Deposit-address only — not a dApp connector
                  </span>
                </span>
                {row.installUrl ? (
                  <a className="install-link" style={S.installLink} href={row.installUrl} target="_blank" rel="noreferrer">
                    Install
                  </a>
                ) : null}
              </li>
            );
          }

          const rowStyle = row.pinned
            ? { ...S.walletRow, ...S.walletRowPinned }
            : row.installed
              ? { ...S.walletRow, ...S.walletRowInstalled }
              : S.walletRow;
          const actionable = row.pinned || row.installed;
          // MEMO RULE (THORChain lane): wallets that cannot (or may not)
          // attach the THORChain memo (OP_RETURN for LTC/DOGE, XRPL Memos
          // for XRP) show their balance and hand sends off to the
          // deposit-address row — the note renders here (memoRule.js).
          const handoff = isMemoRuleFamily(family) && !canSendInApp(row) ? memoHandoffNote(family, row) : null;
          return (
            <li
              key={row.id}
              className={
                row.pinned
                  ? "wallet-row wallet-row--pinned"
                  : row.installed
                    ? "wallet-row wallet-row--installed"
                    : "wallet-row"
              }
              data-wallet-id={row.id}
              data-installed={row.installed}
              data-pinned={row.pinned}
              data-status={row.status ?? ""}
              data-unmaintained={row.unmaintained}
              style={rowStyle}
            >
              <span>
                <span style={S.walletName}>{row.name}</span>
                {row.pinned && <span className="badge badge--recommended" style={S.pinnedTag}>Recommended</span>}
                {row.installed && <span className="badge badge--installed" style={S.badge}>Installed</span>}
                {row.status === "verify" && (
                  <span className="badge badge--verify" style={S.verifyTag} title="Verify at build time (registry ⚠️ row)">
                    Verify
                  </span>
                )}
                {row.unmaintained && (
                  <span className="badge badge--unmaintained" style={S.unmaintainedTag} title="Stale / unmaintained (registry ❌ row)">
                    Unmaintained
                  </span>
                )}
                {handoff && (
                  <span className="memo-handoff-note" style={S.memoNote}>
                    {handoff}
                  </span>
                )}
              </span>
              {actionable ? (
                <button
                  type="button"
                  className="connect-btn"
                  style={{ ...S.connectBtn, ...(session.status === "connecting" ? S.connectBtnDisabled : {}) }}
                  disabled={session.status === "connecting"}
                  onClick={() => connect(family, row.id)}
                >
                  {session.status === "connecting" ? "Connecting…" : "Connect"}
                </button>
              ) : row.installUrl ? (
                <a className="install-link" style={S.installLink} href={row.installUrl} target="_blank" rel="noreferrer">
                  Install
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
