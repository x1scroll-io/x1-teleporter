/**
 * BridgeCard — the ONE card of the Teleporter v2 bridge experience (Step 2.2).
 *
 * docs/BRIEF.md is binding: one card, tabs inside it, sequential states
 * inside each tab. No separate pages, no floating modals for the main flow.
 *
 * VARIANTS (the Teleport Console integration — docs/CONSOLE-DESIGN.md):
 *   - variant="classic" (DEFAULT): the original tabbed card — TeleportTab
 *     (connect modal → connected body → TeleportForm), THORChain, Buy.
 *     Byte-behavior-identical; the frozen browser harnesses (forward/
 *     reverse/thorchain-leg.spec.js) measure this variant. main.jsx mounts
 *     it on non-preview hosts (localhost, production domain).
 *   - variant="console": the Teleport Console (TeleportConsole.jsx) — the
 *     hardware-console swap surface driven by the REAL engine quote/send
 *     paths, hosted in the same tab shell (Teleport = the console; the
 *     THORChain/Buy tabs are preserved). main.jsx mounts it on the x1scroll
 *     Vercel preview hosts (branch previews + the git-v2 alias) or whenever
 *     the CONSOLE_UI flag forces it (src/lib/uiVariant.js).
 */

import { useState } from "react";
import TeleportTab from "./TeleportTab.jsx";
import THORChainTab from "./THORChainTab.jsx";
import TeleportConsole from "./TeleportConsole.jsx";
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

export default function BridgeCard({ initialTab = "teleport", variant = "classic", flags = { THORCHAIN }, formProps = {}, consoleProps = {} }) {
  if (variant === "console") {
    // The Teleport Console is the bridge card's console variant — the full
    // swap surface (Teleport tab) with the THORChain/Buy tabs preserved.
    return (
      <TeleportConsole
        flags={flags}
        initialTab={initialTab}
        formProps={formProps}
        consoleProps={consoleProps}
      />
    );
  }
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
        <TeleportTab formProps={formProps} />
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
