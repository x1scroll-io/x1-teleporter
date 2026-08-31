/**
 * THORChainTab — the THORChain lane inside the ONE card (Step 3.1: the hop /
 * progress state; quote + deposit states arrive with Steps 3.2 / 3.3).
 *
 * Per docs/BRIEF.md + the design supersession, "Panel 1"/"Panel 2" are LOGIC
 * STAGES, not layout: the THORChain flow is sequential states inside the
 * THORChain tab of the single card — quote → deposit address → progress →
 * done. The swap.thorchain fork is a LOGIC SOURCE ONLY (memo construction,
 * inbound-address refresh, halted checks, status polling are lifted from it;
 * its UI is NEVER mounted).
 *
 * THIS STEP (3.1) builds the PROGRESS state — the hop side — first because it
 * reuses existing code: poll `/thorchain/tx/status/{inboundTxid}` every 15s
 * (max 90 min), show observed → swapping → outbound_signed → done, detect the
 * SOL landing in the connected Solana wallet, then auto-advance into the
 * existing SOL→USDC swap → 1% skim → Warp (THORChainProgress). Closed-tab
 * resume: {inboundTxid, stage} is persisted in window.storage keyed by txid —
 * on mount, a pending entry jumps straight back into the progress state.
 *
 * The quote + deposit states are clearly-marked placeholders: they arrive
 * with Steps 3.2 (deposit address + memo) and 3.3 (quote via the aggregator
 * API, THORCHAIN_API_KEY). `initialHop` is the dev/test seam + the future
 * hook emission point ({inboundTxid, sourceChain, destination,
 * expectedAmountOut} — the exact shape Step 3.3's submit emits).
 *
 * THE WHOLE TAB RENDERS ONLY WHEN flags.THORCHAIN IS TRUE — BridgeCard owns
 * that gate (see BridgeCard.jsx); this component is never mounted otherwise.
 */

import { useMemo, useRef, useState } from "react";
import { useWallet } from "../lib/wallet/WalletContext.jsx";
import { createThorchainStorage } from "../lib/thorchain/storage.js";
import { createSolBalanceReader } from "../lib/thorchain/solBalance.js";
import THORChainProgress from "./THORChainProgress.jsx";

/** The sequential states of the THORChain flow inside the card. */
export const THORCHAIN_FLOW_STATES = Object.freeze([
  "quote",
  "deposit",
  "progress",
  "done",
]);

const S = {
  placeholder: { padding: 16, color: "#7d8aa0", fontSize: 14, lineHeight: 1.6 },
  placeholderTitle: { fontSize: 14, fontWeight: 700, color: "#e8edf6", marginBottom: 6 },
  note: { fontSize: 12, color: "#475065", marginTop: 10 },
};

/**
 * @param {object} props
 * @param {{inboundTxid:string, sourceChain:string, destination:string,
 *          expectedAmountOut:number}} [props.initialHop] hook payload — the
 *   Step 3.3 submit emission + dev/test seam. When present (or when a pending
 *   persisted hop exists) the tab renders the progress state directly.
 * @param {object} [props.storage] createThorchainStorage() handle (DI)
 * @param {object|null} [props.connection] @solana/web3.js Connection (Solana RPC)
 */
export default function THORChainTab({ initialHop, storage, connection }) {
  const storeRef = useRef(null);
  if (!storeRef.current) storeRef.current = storage ?? createThorchainStorage();

  const sol = useWallet("solana");
  const solAddress = sol?.address ?? null;
  const solProvider = sol?.provider ?? null;

  // Resume: a pending persisted hop jumps straight back into progress; the
  // `initialHop` prop (the future Step 3.3 hook emission) wins over it.
  const [hop] = useState(() => {
    if (initialHop?.inboundTxid) return initialHop;
    try {
      const pending = storeRef.current.listHops()[0] ?? null;
      if (pending?.payload) return pending.payload;
    } catch { /* ignore */ }
    return null;
  });

  // Flow state: quote/deposit are 3.2/3.3; progress is this step; done is the
  // post-advance completion.
  const [flowState, setFlowState] = useState(() => (hop ? "progress" : "quote"));

  const getSolBalance = useMemo(() => {
    if (!solAddress) return null;
    return createSolBalanceReader({ connection });
  }, [solAddress, connection]);

  const handleStateChange = (s) => {
    if (s?.phase === "arrived") {
      setFlowState("done");
    }
  };

  if (flowState === "progress" && hop) {
    return (
      <div className="thorchain-tab" role="tabpanel" aria-label="THORChain" data-testid="thorchain-tab">
        <THORChainProgress
          hop={hop}
          storage={storeRef.current}
          getSolBalance={getSolBalance}
          solAddress={solAddress}
          solWallet={solProvider ? { provider: solProvider } : null}
          connection={connection}
          onStateChange={handleStateChange}
        />
      </div>
    );
  }

  if (flowState === "done") {
    return (
      <div className="thorchain-tab" role="tabpanel" aria-label="THORChain" data-testid="thorchain-tab">
        <div style={S.placeholder} data-testid="thorchain-done">
          <div style={S.placeholderTitle}>On X1 ✓</div>
          Your funds landed on X1 as USDC.x. The next deposit starts a new hop.
        </div>
      </div>
    );
  }

  // quote / deposit — Steps 3.2 / 3.3 (placeholders, clearly marked).
  return (
    <div className="thorchain-tab" role="tabpanel" aria-label="THORChain" data-testid="thorchain-tab">
      <div style={S.placeholder} data-testid="thorchain-placeholder">
        <div style={S.placeholderTitle}>
          {flowState === "quote" ? "THORChain lane — quote" : "THORChain lane — deposit address"}
        </div>
        {flowState === "quote"
          ? "The quote state arrives with Step 3.2 (deposit address + memo rules; inbound-address refresh + halted checks lifted from swap.thorchain)."
          : "The deposit-address + memo state arrives with Step 3.3 (memo construction lifted from swap.thorchain; THORCHAIN_API_KEY for the aggregator quote)."}
        <div style={S.note}>
          The hop/progress state is live in this build — when a hop payload
          exists (or a pending hop is saved in this browser), progress renders here.
        </div>
      </div>
    </div>
  );
}
