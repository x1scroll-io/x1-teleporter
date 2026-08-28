/**
 * BridgeCard — the ONE card of the Teleporter v2 bridge experience (Step 2.2).
 *
 * docs/BRIEF.md is binding: one card, tabs inside it, sequential states
 * inside each tab. No separate pages, no floating modals for the main flow.
 *
 * Phase 2 tabs (per the brief's Design direction): Teleport (hosts the
 * wallet connect flow — ConnectModal — this step), THORChain and Buy
 * (placeholders — later steps build their flows inside the same card).
 *
 * The card is NOT wired into main.jsx yet (Teleporter.jsx remains the live
 * UI until the Phase 3 swap). To preview: mount <BridgeCard /> (wrapped in
 * <WalletProvider>) temporarily in main.jsx — see the step 2.2 PR notes.
 */

import { useState } from "react";
import TeleportTab from "./TeleportTab.jsx";
import THORChainTab from "./THORChainTab.jsx";
import { THORCHAIN } from "../lib/flags.ts";

const TABS = Object.freeze([
  { id: "teleport", label: "Teleport" },
  { id: "thorchain", label: "THORChain" },
  { id: "buy", label: "Buy" },
]);

const PLACEHOLDERS = Object.freeze({
  thorchain: "THORChain swap flow arrives in a later step.",
  buy: "Buy flow arrives in a later step.",
});

const S = {
  card: {
    maxWidth: 480,
    margin: "0 auto",
    background: "#0a1019",
    border: "1px solid #1c2a3f",
    borderRadius: 12,
    overflow: "hidden",
  },
  tabs: { display: "flex", borderBottom: "1px solid #1c2a3f", background: "#0d1420" },
  tab: {
    flex: 1, padding: "12px 0", background: "none", border: "none",
    color: "#7d8aa0", cursor: "pointer", fontSize: 14, fontWeight: 600,
  },
  tabActive: { color: "#3fd3e8", boxShadow: "inset 0 -2px 0 #3fd3e8" },
  placeholder: { padding: 16, color: "#7d8aa0", fontSize: 14 },
};

export default function BridgeCard({ initialTab = "teleport", flags = { THORCHAIN } }) {
  const [tab, setTab] = useState(initialTab);
  const thorchainEnabled = flags.THORCHAIN === true;
  return (
    <div className="bridge-card" data-testid="bridge-card" style={S.card}>
      <nav className="bridge-card__tabs" role="tablist" style={S.tabs}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-tab={t.id}
            className={tab === t.id ? "tab tab--active" : "tab"}
            style={tab === t.id ? { ...S.tab, ...S.tabActive } : S.tab}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "teleport" ? (
        <TeleportTab />
      ) : tab === "thorchain" ? (
        thorchainEnabled ? <THORChainTab /> : <div className="placeholder-tab" role="tabpanel" data-testid="thorchain-tab" style={S.placeholder}>{PLACEHOLDERS.thorchain}</div>
      ) : (
        <div className="placeholder-tab" role="tabpanel" data-testid={`${tab}-tab`} style={S.placeholder}>
          {PLACEHOLDERS[tab]}
        </div>
      )}
    </div>
  );
}
