/**
 * THORChainTab — the THORChain lane inside the ONE card (Steps 3.1 + 3.2 +
 * 3.3: the deposit-address stage with its QUOTE GATE, plus the
 * hop/progress stage).
 *
 * Per docs/BRIEF.md + the design supersession, "Panel 1"/"Panel 2" are LOGIC
 * STAGES, not layout: the THORChain flow is sequential states inside the
 * THORChain tab of the single card — quote → deposit address → progress →
 * done. The swap.thorchain fork is a LOGIC SOURCE ONLY (memo construction,
 * inbound-address refresh, halted checks, status polling are lifted from it;
 * its UI is NEVER mounted).
 *
 * THIS STEP (3.3) builds the QUOTE stage logic + fee wiring:
 *   - The quote state is the QUOTE GATE at the top of the deposit stage
 *     (THORChainDeposit): the user enters the amount, fetches a FRESH quote
 *     (THORChain aggregator API via OUR proxy /api/thorchain/quote — the
 *     key lives server-side only, parked item), and the deposit address
 *     appears ONLY after the quote lands
 *     (re-fetch immediately before the address is shown — runbook; failure
 *     blocks the address with a retry). The three fees (THORChain affiliate
 *     protocol fee + our 1% skim + Warp's $1) render from computeFee's
 *     thorchain-leg class before the user sends. The size cap (0.05
 *     BTC-equivalent, config) is enforced at quote time.
 *   - The submit hook emits {inboundTxid, sourceChain, destination,
 *     expectedAmountOut} with expectedAmountOut from the FRESH QUOTE (the
 *     3.2 sent-amount guess is gone). The payload becomes the hop, is
 *     persisted (closed-tab resume), and the tab advances to progress.
 *     3.1's autoAdvance consumes it.
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

/** The sequential states of the THORChain flow inside the card. The quote
 *  state is the quote gate inside the deposit stage (Step 3.3) — the tab
 *  renders the deposit stage directly; "quote" is the conceptual first
 *  state, not a separate screen. */
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
 * @param {Function} [props.fetchQuote] DI quote fetcher for the deposit
 *   stage's quote gate (default: real createQuoteFetcher — env key)
 * @param {number} [props.maxSwapBtcEquivalent] DI size cap (config default)
 * @param {object} [props.btcEquivalentRates] DI per-asset cap rates
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
  fetchQuote,
  maxSwapBtcEquivalent,
  btcEquivalentRates,
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

  // Flow state: the deposit stage (with its quote gate) is the default — the
  // "quote" state is the gate at the top of it (Step 3.3). progress/done are
  // 3.1's stages.
  const [flowState, setFlowState] = useState(() => (hop ? "progress" : "deposit"));

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

  // Default: the deposit stage — whose quote gate IS the quote state
  // (Step 3.3: fresh quote → fees → cap → THEN the deposit address).
  return (
    <div className="thorchain-tab" role="tabpanel" aria-label="THORChain" data-testid="thorchain-tab">
      <THORChainDeposit
        solAddress={solAddress}
        solConnected={solConnected}
        sourceSessions={sourceSessions}
        onSubmit={handleDepositSubmit}
        createInboundRefresher={createInboundRefresher}
        fetchImpl={fetchImpl}
        inboundBaseUrl={inboundBaseUrl}
        refreshIntervalMs={refreshIntervalMs}
        qrFactory={qrFactory}
        fetchQuote={fetchQuote}
        maxSwapBtcEquivalent={maxSwapBtcEquivalent}
        btcEquivalentRates={btcEquivalentRates}
      />
    </div>
  );
}
