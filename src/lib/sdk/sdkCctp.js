/**
 * src/lib/sdk/sdkCctp.js — Circle CCTP leg (permissionless burn-and-mint).
 *
 * The core CCTP V2 flow, without a Circle API key:
 *   1. burn   — approve USDC to TokenMessengerV2, call depositForBurn.
 *   2. attest — poll Circle's PUBLIC Iris API for the signed attestation.
 *   3. mint   — submit MessageTransmitter.receiveMessage(message, attestation).
 *
 * Design: pure builders (return { to, data } calldata + a contract address), so
 * the leg is signer-agnostic and unit-testable — the engine's runner signs and
 * broadcasts, same as the other sdk* adapters. No custodial deposit wallet, no
 * unrestricted spending delegate; every transfer is bound to the caller's
 * approved amount/destination/recipient/fee limits upstream.
 *
 * Addresses come from src/lib/cctp/config.js (verified from Circle docs, never
 * guessed). A chain whose minting path is not yet configured fails closed.
 */

import { TOKEN_MESSENGER_V2, cctpConfigFor } from "../cctp/config.js";

export const IRIS_API_BASE = "https://iris-api.circle.com";

// Stable, minimal CCTP interfaces (signatures only — the real ABIs are large).
export const TOKEN_MESSENGER_V2_ABI = [
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken) returns (uint64 nonce)",
  "function depositForBurnWithCaller(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller) returns (uint64 nonce)",
];
export const MESSAGE_TRANSMITTER_ABI = [
  "function receiveMessage(bytes message, bytes attestation)",
];

/**
 * Encode a destination address into the 32-byte `mintRecipient` CCTP expects.
 * EVM: 20-byte address left-padded to 32 bytes. Solana: the 32-byte pubkey.
 * @param {string} destAddress hex (0x-prefixed for EVM) or base58 (Solana)
 * @param {string} destChainKey our wallet chain key
 * @returns {string} 0x-prefixed 32-byte hex
 */
export function encodeMintRecipient(destAddress, destChainKey) {
  if (destChainKey === "solana") {
    // base58 -> 32 bytes (caller provides the decoded bytes as hex)
    return destAddress.startsWith("0x") ? destAddress : `0x${destAddress}`;
  }
  const hex = destAddress.replace(/^0x/, "").toLowerCase();
  if (hex.length !== 40) throw new Error(`encodeMintRecipient: invalid EVM address "${destAddress}"`);
  return `0x${"0".repeat(24)}${hex}`; // 12 zero bytes pad
}

/**
 * Build the burn step: { to, data } calldata for TokenMessengerV2.depositForBurn.
 * The caller approves USDC to `to` first (approval is the caller's step).
 *
 * @param {{sourceChainKey: string, amountWei: string|bigint, destinationDomain: number,
 *          mintRecipient: string, burnToken: string, destinationCaller?: string}}
 * @returns {{to: string, data: string}}
 */
export function buildBurn({ sourceChainKey, amountWei, destinationDomain, mintRecipient, burnToken, destinationCaller }) {
  const cfg = cctpConfigFor(sourceChainKey);
  const messenger = TOKEN_MESSENGER_V2.mainnet;
  if (!messenger) throw new Error("buildBurn: TokenMessengerV2 not configured for this environment");
  const amount = BigInt(amountWei);
  const fn = destinationCaller
    ? "depositForBurnWithCaller(uint256,uint32,bytes32,address,bytes32)"
    : "depositForBurn(uint256,uint32,bytes32,address)";
  // data is assembled by the caller via ethers `new Interface(ABI).encodeFunctionData` —
  // here we return the contract + the human args so the leg stays framework-agnostic.
  return {
    to: messenger,
    fn,
    args: destinationCaller
      ? [amount, destinationDomain, mintRecipient, burnToken, destinationCaller]
      : [amount, destinationDomain, mintRecipient, burnToken],
  };
}

/**
 * Fetch the signed attestation from Circle's public Iris API (keyless).
 * Polls until the message is attested or the timeout elapses.
 *
 * @param {{sourceDomain: number, txHash: string, pollMs?: number, timeoutMs?: number, fetchImpl?: typeof fetch}}
 * @returns {Promise<{message: string, attestation: string, status: string}>}
 */
export async function fetchAttestation({ sourceDomain, txHash, pollMs = 8000, timeoutMs = 300000, fetchImpl = fetch }) {
  const deadline = Date.now() + timeoutMs;
  // The Iris endpoint for a burn message: GET /v2/messages/{domain}/{txHash}
  const url = `${IRIS_API_BASE}/v2/messages/${sourceDomain}/${txHash}`;
  for (;;) {
    const res = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`fetchAttestation: Iris ${res.status}`);
    const data = await res.json();
    const status = data?.messages?.[0]?.status ?? data?.status;
    if (status === "complete") {
      const msg = data?.messages?.[0];
      return { message: msg.message, attestation: msg.attestation, status: "complete" };
    }
    if (Date.now() > deadline) throw new Error(`fetchAttestation: timed out (status=${status})`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Build the mint step: { to, data } for MessageTransmitter.receiveMessage.
 * Fails closed when the destination chain's transmitter isn't configured.
 *
 * @param {{destChainKey: string, message: string, attestation: string}}
 * @returns {{to: string, fn: string, args: [string, string]}}
 */
export function buildMint({ destChainKey, message, attestation }) {
  const cfg = cctpConfigFor(destChainKey);
  const transmitter = cfg?.messageTransmitter || cfg?.tokenMessengerMinterProgram;
  if (!transmitter) {
    throw new Error(`buildMint: MessageTransmitter not configured for ${destChainKey} (fail closed)`);
  }
  return { to: transmitter, fn: "receiveMessage(bytes,bytes)", args: [message, attestation] };
}
