/**
 * TeleportTab — the Teleport tab of the one-card layout (Step 2.2).
 *
 * Per docs/BRIEF.md the whole bridge experience is ONE card with tabs
 * (Teleport / THORChain / Buy) and sequential states inside each tab. The
 * wallet connect flow (ConnectModal) is the Teleport tab's first sequential
 * state — pick a family → pick a wallet → connecting → connected / error.
 * Phase 3 adds the bridge form as the next state of this same tab.
 */

import ConnectModal from "./ConnectModal.jsx";

export default function TeleportTab() {
  return (
    <div className="teleport-tab" role="tabpanel" aria-label="Teleport">
      <ConnectModal />
    </div>
  );
}
