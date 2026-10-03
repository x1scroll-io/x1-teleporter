/**
 * nearSelector.js — the ONE place the app constructs the NEAR Wallet
 * Selector (@near-wallet-selector/core + its wallet modules).
 *
 * docs/NEAR-TON-DEX-RESEARCH.md (Wallet connectors) is binding: "NEAR
 * discovery uses the NEAR Wallet Selector and nothing else — never read a
 * NEAR wallet's injected global." The selector owns wallet detection,
 * optimised ordering and the sign-in handshake; our code only enumerates the
 * modules it exposes and calls signIn (see nearDiscovery.js).
 *
 * Browser-only by construction: setupWalletSelector needs the browser wallet
 * SDKs, so this factory returns null when no window exists. node:test NEVER
 * imports this module — nearDiscovery.js takes the selector via DI (tests
 * inject a fake), mirroring the tronAdapters.js / laserEyesHandle.js pattern.
 *
 * The `modules` below are the packages added to package.json (verified on npm
 * 2026-09-29 at 10.1.4 — the current @near-wallet-selector line):
 *   - my-near-wallet  (MyNearWallet — the reference wallet)
 *   - meteor-wallet   (Meteor)
 *   - sender          (Sender)
 *   - nightly         (Nightly)
 *   - ledger          (Ledger — hardware)
 *
 * NO signing: the selector is used for detection + sign-in only. Signing a
 * swap is the later NEAR swap-routing step (see the research note) and is NOT
 * wired here.
 */

import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupSender } from "@near-wallet-selector/sender";
import { setupLedger } from "@near-wallet-selector/ledger";
import { setupNightly } from "@near-wallet-selector/nightly";

/**
 * The default contract the connect handshake requests a (read-only)
 * function-call key for. Ref Finance is the engine's NEAR reference routing
 * target (docs/NEAR-TON-DEX-RESEARCH.md), so the key is scoped to it — the
 * same shape a NEAR swap dApp uses. Overridable at wiring time.
 *
 * NEAR wallets (MyNearWallet etc.) require a contractId to create the
 * function-call access key on sign-in; passing the swap venue keeps the
 * connect honest (a key the app can later use to call the reference DEX).
 * This is a connect handshake, NOT a signature over any transfer.
 */
export const NEAR_REFERENCE_CONTRACT_ID = "v2.ref-finance.near";

/**
 * Build the app's NEAR Wallet Selector.
 *
 * @param {{network?: string, contractId?: string|null}} [options]
 * @returns {Promise<object>|null} a WalletSelector (async), or null when no
 *   window exists (browser-less environments degrade to "nothing available").
 */
export function createNearWalletSelector({
  network = "mainnet",
  contractId = NEAR_REFERENCE_CONTRACT_ID,
} = {}) {
  if (typeof window === "undefined") return null;
  const options = {
    network,
    modules: [
      setupMyNearWallet(),
      setupMeteorWallet(),
      setupSender(),
      setupNightly(),
      setupLedger(),
    ],
  };
  if (contractId) options.createAccessKeyFor = contractId;
  return setupWalletSelector(options);
}
