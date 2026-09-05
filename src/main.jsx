import "./polyfills.js"; // MUST be first — sets Buffer global before Solana loads

import React from "react";
import ReactDOM from "react-dom/client";
import Teleporter from "./Teleporter.jsx";
import BridgeCard from "./components/BridgeCard.jsx";
import { WalletProvider } from "./lib/wallet/WalletContext.jsx";
import { createWalletDiscovery } from "./lib/wallet/walletDiscovery.js";
import { createLaserEyesHandle } from "./lib/wallet/laserEyesHandle.js";
import { createBtcBalanceFetcher } from "./lib/wallet/bitcoinBalance.js";
import { LEGACY_UI, THORCHAIN, WARP_LIVE_SEND, resolveConsoleUi, selectRootCard } from "./lib/flags.ts";
import { resolveUiVariant } from "./lib/uiVariant.js";
import { buildBanner } from "./lib/buildBanner.js";

// BUILD MARKER — verify deployed build is current.
// v2 card mounted by default (preview). Set NEXT_PUBLIC_FLAG_LEGACY_UI=true
// (or VITE_FLAG_LEGACY_UI=true) to restore the v1 Teleporter card — it is
// NOT deleted; it stays as the flag-restorable fallback until the cutover.
// Live-send state is read from the REAL compiled flag (WARP_LIVE_SEND,
// pinned at build time by the vite.config.js allowlist — v2 branch arms it).
console.log(
  "%c" +
    buildBanner({
      buildTime: typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : undefined,
      WARP_LIVE_SEND,
      THORCHAIN,
    }),
  "color:#3fd3e8;font-weight:bold"
);

// One discovery handle for the app lifetime. WalletProvider starts it on
// mount and stops it on unmount (start() is idempotent per handle).
// Bitcoin (Step 2.3) wiring: the LaserEyes handle + the mempool.space
// balance fetcher. Without bitcoinLaserEyes every LaserEyes-covered
// wallet's connect fails with "the LaserEyes handle is not wired" — the
// red banner from the live preview. Detection stays impersonation-aware
// (bitcoinDiscovery.js); this only supplies the connect handle.
const discovery = createWalletDiscovery({
  bitcoinLaserEyes: createLaserEyesHandle(),
  bitcoinBalanceFetcher: createBtcBalanceFetcher(),
});

// Flag → card. Pure decision, tested in src/lib/flags.test.ts.
// "legacy" = v1 Teleporter card (flag-restorable fallback).
// "v2"     = BridgeCard wrapped in WalletProvider (default).
const rootCard = selectRootCard({ LEGACY_UI });

// UI variant for the v2 card (Teleport Console vs the classic card). Pure
// decision, tested in src/lib/uiVariant.test.js:
//   - legacy flag  → the v1 Teleporter card (above, wins).
//   - CONSOLE_UI env set → its value decides (console / classic).
//   - env unset + x1scroll Vercel preview host (branch previews + the
//     stable git-v2 alias) → the CONSOLE mounts (this PR's live preview).
//   - env unset + any other host (localhost default builds, the production
//     domain) → classic — the frozen browser harnesses keep measuring the
//     classic flow unchanged on local default builds.
const bridgeVariant =
  rootCard === "legacy"
    ? "legacy"
    : resolveUiVariant({
        LEGACY_UI,
        CONSOLE_UI: resolveConsoleUi(import.meta.env),
        hostname: typeof window !== "undefined" ? window.location.hostname : "",
      });

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {bridgeVariant === "legacy" ? (
      <Teleporter />
    ) : (
      <WalletProvider discovery={discovery}>
        <BridgeCard variant={bridgeVariant} flags={{ THORCHAIN }} />
      </WalletProvider>
    )}
  </React.StrictMode>
);
