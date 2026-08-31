/**
 * THORChainTab — the THORChain lane inside the ONE card (Steps 3.1 + 3.2:
 * the deposit-address stage + the hop/progress stage; the quote stage
 * arrives with Step 3.3).
 *
 * Per docs/BRIEF.md + the design supersession, "Panel 1"/"Panel 2" are LOGIC
 * STAGES, not layout: the THORChain flow is sequential states inside the
 * THORChain tab of the single card — quote → deposit address → progress →
 * done. The swap.thorchain fork is a LOGIC SOURCE ONLY (memo construction,
 * inbound-address refresh, halted checks, status polling are lifted from it;
 * its UI is NEVER mounted).
 *
 * THIS STEP (3.2) builds the DEPOSIT-ADDRESS state — the stage that PRODUCES
 * the hook payload for the progress stage:
 *   - THORChainDeposit renders inside this tab: sources limited to
 *     BTC.BTC/DOGE.DOGE/LTC.LTC/XRP.XRP, destination pinned SOL.SOL prefilled
 *     from the Solana session in WalletContext (never user-typed; no Solana
 *     wallet → "connect a Solana wallet first"), inbound_addresses fetched on
 *     mount + every 60s with halted chains greyed out, deposit address +
 *     memo + QR, and the submit hook emitting {inboundTxid, sourceChain,
 *     destination, expectedAmountOut}.
 *   - The submit hook wires straight into the Step 3.1 progress state: the
 *     payload becomes the hop, is persisted (closed-tab resume), and the tab
 *     advances to progress. 3.1's autoAdvance consumes it (and fails
 *     honestly at the swap step until 3.3 supplies the SOL→USDC quote).
 *
 * The QUOTE state remains a clearly-marked placeholder: it arrives with
 * Step 3.3 (aggregator quote, THORCHAIN_API_KEY, expected_amount_out +
 * slippage bps, re-fetch before copy). `initialHop` stays the dev/test seam
 * + the hook emission entry point ({inboundTxid, sourceChain, destination,
 * expectedAmountOut}).
 *
 * THE WHOLE TAB RENDERS ONLY WHEN flags.THORCHAIN IS TRUE — BridgeCard owns
 * that gate (see BridgeCard.jsx); this component is never mounted otherwise.
 */

import { useMemo, useRef, useState } from "react";
import { useWallet } from "../lib/wallet/WalletContext.jsx";
import { createThorchainStorage } from "../lib/thorchain/storage.js";
import { createSolBalanceReader } from "../lib/thorchain/solBalance.js";
import THORChainProgress from "./THORChainProgress.jsx";
import THORChainDeposit from "./THORChainDeposit.jsx";

/** The sequential states of the THORChain flow inside the card. */
export const THORCHAIN_FLOW_STATES = Object.freeze([
  "quote",
  "deposit",
  "progress",
  "done",
]);

/** The four source families whose sessions prefill the refund address
 *  (the wallet-layer deposit-address rows from Steps 2.3/2.4 feed this). */
const SOURCE_FAMILIES = Object.freeze(["bitcoin", "litecoin", "dogecoin", "xrp"]);

const S = {
  placeholder: { padding: 16, color: "#7d8aa0", fontSize: 14, lineHeight: 1.6 },
  placeholderTitle: { fontSize: 14, fontWeight: 700, color: "#e8edf6", marginBottom: 6 },
  note: { fontSize: 12, color: "#475065", marginTop: 10 },
  continueBtn: {
    marginTop: 12, padding: "10px 14px", borderRadius: 10, fontSize: 13, fontWeight: 700,
    background: "linear-gradient(180deg, rgba(63,211,232,0.22), rgba(63,211,232,0.12))",
    border: "1px solid rgba(63,211,232,0.45)", color: "#e8edf6", cursor: "pointer",
  },
};

/**
 * @param {object} props
 * @param {{inboundTxid:string, sourceChain:string, destination:string,
 *          expectedAmountOut:number}} [props.initialHop] hook payload — the
 *   submit emission + dev/test seam. When present (or when a pending
 *   persisted hop exists) the tab renders the progress state directly.
 * @param {object} [props.storage] createThorchainStorage() handle (DI)
 * @param {object|null} [props.connection] @solana/web3.js Connection (Solana RPC)
 * @param {Function} [props.createInboundRefresher] DI for THORChainDeposit
 * @param {Function} [props.createPoller] DI for THORChainProgress (the tab's
 *   progress state defaults to the real poller; tests inject a fake so no
 *   network/wasm machinery fires)
 * @param {Function} [props.fetchImpl] fetch DI for the inbound refresher
 * @param {string} [props.inboundBaseUrl] THORChain API base URL
 * @param {number} [props.refreshIntervalMs] inbound refresh cadence
 * @param {Function} [props.qrFactory] QR renderer DI
 */
export default function THORChainTab({
  initialHop,
  storage,
  connection,
  createInboundRefresher,
  createPoller,
  fetchImpl,
  inboundBaseUrl,
  refreshIntervalMs,
  qrFactory,
}) {
  const storeRef = useRef(null);
  if (!storeRef.current) storeRef.current = storage ?? createThorchainStorage();

  const sol = useWallet("solana");
  const solAddress = sol?.address ?? null;
  const solProvider = sol?.provider ?? null;
  const solConnected = sol?.status === "connected" && !!solAddress;

  // Source-family sessions for the refund-address prefill (Steps 2.3/2.4).
  const bitcoinSession = useWallet("bitcoin");
  const litecoinSession = useWallet("litecoin");
  const dogecoinSession = useWallet("dogecoin");
  const xrpSession = useWallet("xrp");
  const sourceSessions = useMemo(() => {
    const session = (s) => (s?.status === "connected" ? { address: s.address ?? null } : null);
    return {
      bitcoin: session(bitcoinSession),
      litecoin: session(litecoinSession),
      dogecoin: session(dogecoinSession),
      xrp: session(xrpSession),
    };
  }, [bitcoinSession, litecoinSession, dogecoinSession, xrpSession]);

  // Resume: a pending persisted hop jumps straight back into progress; the
  // `initialHop` prop (the hook emission) wins over it.
  const [hop, setHop] = useState(() => {
    if (initialHop?.inboundTxid) return initialHop;
    try {
      const pending = storeRef.current.listHops()[0] ?? null;
      if (pending?.payload) return pending.payload;
    } catch { /* ignore */ }
    return null;
  });

  // Flow state: quote (3.3) / deposit (this step) / progress (3.1) / done.
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

  // The deposit stage's submit hook: emit the payload → persist the hop
  // (closed-tab resume from the moment of submit) → advance to progress.
  const handleDepositSubmit = (payload) => {
    if (!payload?.inboundTxid) return;
    setHop(payload);
    try {
      storeRef.current.saveHop({
        inboundTxid: payload.inboundTxid,
        stage: "observed",
        payload,
      });
    } catch { /* storage failure must never block the flow */ }
    setFlowState("progress");
  };

  if (flowState === "progress" && hop) {
    return (
      <div className="thorchain-tab" role="tabpanel" aria-label="THORChain" data-testid="thorchain-tab">
        <THORChainProgress
          hop={hop}
          storage={storeRef.current}
          createPoller={createPoller}
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

  if (flowState === "deposit") {
    return (
      <div className="thorchain-tab" role="tabpanel" aria-label="THORChain" data-testid="thorchain-tab">
        <THORChainDeposit
          solAddress={solAddress}
          solConnected={solConnected}
          sourceSessions={sourceSessions}
          onSubmit={handleDepositSubmit}
          onBack={() => setFlowState("quote")}
          createInboundRefresher={createInboundRefresher}
          fetchImpl={fetchImpl}
          inboundBaseUrl={inboundBaseUrl}
          refreshIntervalMs={refreshIntervalMs}
          qrFactory={qrFactory}
        />
      </div>
    );
  }

  // quote — Step 3.3 (placeholder, clearly marked; the deposit stage of this
  // step is one click in, keeping the sequential flow navigable).
  return (
    <div className="thorchain-tab" role="tabpanel" aria-label="THORChain" data-testid="thorchain-tab">
      <div style={S.placeholder} data-testid="thorchain-placeholder">
        <div style={S.placeholderTitle}>THORChain lane — quote</div>
        The quote state arrives with Step 3.3 (aggregator quote via
        THORCHAIN_API_KEY; expected_amount_out + slippage bps; re-fetch
        before copy). The deposit-address stage of this step already renders
        the THORChain deposit address + memo and hands your hop to the
        progress tracker.
        <div>
          <button type="button" style={S.continueBtn} data-testid="tc-continue-deposit" onClick={() => setFlowState("deposit")}>
            Continue to deposit address →
          </button>
        </div>
      </div>
    </div>
  );
}
