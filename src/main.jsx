import "./polyfills.js"; // MUST be first — sets Buffer global before Solana loads

import React from "react";
import ReactDOM from "react-dom/client";
import Teleporter from "./Teleporter.jsx";
import BridgeCard from "./components/BridgeCard.jsx";
import { WalletProvider } from "./lib/wallet/WalletContext.jsx";
import { createWalletDiscovery } from "./lib/wallet/walletDiscovery.js";
import { LEGACY_UI, THORCHAIN, selectRootCard } from "./lib/flags.ts";

// BUILD MARKER — verify deployed build is current.
// v2 card mounted by default (preview). Set NEXT_PUBLIC_FLAG_LEGACY_UI=true
// (or VITE_FLAG_LEGACY_UI=true) to restore the v1 Teleporter card — it is
// NOT deleted; it stays as the flag-restorable fallback until the cutover.
// NO live sends: the WARP_LIVE_SEND gate stays false (Teleporter.jsx) and
// the THORChain auto-advance allowLive defaults to false (autoAdvance.js).
console.log(
  "%c[Teleporter] BUILD " + (typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "dev") + " (v2 card mounted — preview; live sends OFF)",
  "color:#3fd3e8;font-weight:bold"
);

// One discovery handle for the app lifetime. WalletProvider starts it on
// mount and stops it on unmount (start() is idempotent per handle).
const discovery = createWalletDiscovery();

// Flag → card. Pure decision, tested in src/lib/flags.test.ts.
// "legacy" = v1 Teleporter card (flag-restorable fallback).
// "v2"     = BridgeCard wrapped in WalletProvider (default).
const rootCard = selectRootCard({ LEGACY_UI });

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {rootCard === "legacy" ? (
      <Teleporter />
    ) : (
      <WalletProvider discovery={discovery}>
        <BridgeCard flags={{ THORCHAIN }} />
      </WalletProvider>
    )}
  </React.StrictMode>
);
