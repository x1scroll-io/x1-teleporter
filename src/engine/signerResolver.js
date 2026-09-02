/**
 * signerResolver.js — the routing engine's SINGLE signer resolution point,
 * keyed by chain family.
 *
 * The engine never pokes at session shapes itself. A route leg declares its
 * family ("evm" | "svm" | "external") and the resolver returns the
 * sign-capable surface for that family from the WalletContext session:
 *
 *   evm      → the EIP-1193 provider ({ request }) — resolveEvmProvider
 *   svm      → the Wallet-Standard adapter (publicKey + signAndSendTransaction /
 *              signTransaction) — resolveSolanaAdapter
 *   external → null BY DESIGN — the deposit-address lane (THORChain, Phase 3):
 *              the artifact (vault address + memo) is executed OUT-OF-BAND in
 *              the user's OWN external wallet (BTC/DOGE/LTC/XRP), never by an
 *              in-app session signer. The resolver's null is the honest signal
 *              the caller surfaces as the "send from your wallet" step — the
 *              engine has exactly ONE resolver and it does not invent signers.
 *
 * BOTH session delegates are the PROVEN resolvers from
 * src/lib/wallet/sessionProviders.js (the ones the reference forward leg
 * already ships with — PR #34's stage-2 submit fix resolves the Solana
 * signer through exactly this path). The resolver adds the family keying +
 * a null when the family is unknown (fail-soft: the caller surfaces an
 * honest "connect a real wallet" error).
 *
 * A session's `provider` is the CONNECT adapter, not a signing surface — the
 * delegate resolvers unwrap the real thing (the EIP-6963 wagmi connector's
 * getProvider() for EVM, provider.adapter for Solana). Mock providers have no
 * signing surface and resolve to null by design.
 */
import {
  resolveEvmProvider,
  resolveSolanaAdapter,
  solanaSessionCanSign,
} from "../lib/wallet/sessionProviders.js";

/** The chain families the engine can resolve signers for (Phase 1: evm + svm;
 *  Phase 3 adds "external" — the deposit-address lane, which resolves null by
 *  design: no in-app session signer exists for an out-of-band external send). */
export const SIGNER_FAMILIES = Object.freeze({
  evm: "evm",
  svm: "svm",
  external: "external",
});

/**
 * Resolve the sign-capable surface for a family from its WalletContext session.
 *
 * @param {"evm"|"svm"|"external"} family the chain family key
 * @param {object|null} session the WalletContext session for that family
 * @returns {Promise<object|null>} the EIP-1193 provider (evm) or the
 *   sign-capable Solana adapter (svm), or null when the session can't sign,
 *   the family is "external" (deposit-address lane — no in-app signer by
 *   design), or the family is unknown.
 */
export async function resolveSigner(family, session) {
  if (family === SIGNER_FAMILIES.evm) {
    return resolveEvmProvider(session);
  }
  if (family === SIGNER_FAMILIES.svm) {
    return resolveSolanaAdapter(session);
  }
  return null; // external (deposit-address lane) + unknown families — fail-soft
}

/**
 * Sync sign-capability hint for a family's session (UI-level gate — whether
 * a handoff state can offer a Retry). svm delegates to the proven hint.
 * evm has no sync equivalent (its provider can be async-resolved); callers
 * that need a pre-check should resolve and test for null.
 */
export function familyCanSign(family, session) {
  if (family === SIGNER_FAMILIES.svm) return solanaSessionCanSign(session);
  return false;
}

/**
 * Human label for a family (status lines / errors).
 */
export function familyLabel(family) {
  if (family === SIGNER_FAMILIES.evm) return "EVM";
  if (family === SIGNER_FAMILIES.svm) return "Solana/X1";
  if (family === SIGNER_FAMILIES.external) return "External wallet (deposit address)";
  return String(family);
}

/**
 * The SignerResolver surface: one resolve() keyed by chain family. evm → the
 * EIP-1193 provider; svm → the sign-capable Solana adapter; external → null
 * by design (the deposit-address lane executes out-of-band). The session
 * delegates are the PROVEN sessionProviders resolvers (see module header).
 */
export const SignerResolver = Object.freeze({
  resolve: resolveSigner,
  canSign: familyCanSign,
  label: familyLabel,
  FAMILIES: SIGNER_FAMILIES,
});
