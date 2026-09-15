/**
 * src/lib/cctp/config.js — Circle CCTP configuration (versioned, per environment).
 *
 * Source of truth: Circle's official docs. Every address/domain here is copied
 * from https://developers.circle.com/cctp/references/contract-addresses and
 * /cctp/concepts/supported-chains-and-domains (fetched 2026-09-15), NOT guessed.
 *
 * RULE (from the owner's CCTP directive):
 *   - Circle DOMAIN IDs and wallet CHAIN IDs are SEPARATE concepts — never merge
 *     them. `DOMAIN_IDS` maps a wallet chain key to Circle's domain id.
 *   - Native USDC is identified by MINT + DECIMALS, never by symbol alone.
 *   - X1 is NOT a CCTP chain and is never advertised as one (no Circle contracts
 *     on X1). The X1 hop stays on the Warp lane, out of CCTP's scope.
 *   - Arc is testnet-only and must not be inserted as a forced intermediate hop.
 */

/** Circle CCTP domain id, keyed by our wallet chain key. */
export const DOMAIN_IDS = Object.freeze({
  ethereum: 0,
  avalanche: 1,
  optimism: 2,
  arbitrum: 3,
  noble: 4, // Cosmos — USDC issuance hub
  solana: 5,
  base: 6,
  polygon: 7,
  sui: 8,
  aptos: 9,
  unichain: 10,
  linea: 11,
  codex: 12,
  sonic: 13,
  worldchain: 14,
  monad: 15,
  sei: 16,
  xdc: 18,
  hyperevm: 19, // our wallet already supports HyperEVM (EVM chain) — it IS a CCTP chain
  ink: 21,
  plume: 22,
});

/**
 * TokenMessengerV2 — identical address on every EVM chain (Circle deploys the
 * same bytecode; the domain id disambiguates the chain).
 * Verified from Circle docs 2026-09-15 (Ethereum/Avalanche/OP/Arbitrum/Base/
 * Polygon/Unichain/Linea all list this address).
 */
export const TOKEN_MESSENGER_V2 = Object.freeze({
  mainnet: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  // testnet addresses differ per chain — fill from Circle docs before testnet runs
  testnet: null,
});

/**
 * Per-chain CCTP contract set + native USDC mint/decimals.
 * MINT + DECIMALS are authoritative for USDC identity (never symbol).
 * TODO(fill from Circle docs, remaining entries): TokenMinter, MessageTransmitter,
 * and Solana program IDs (Token Messenger / Token Minter / Message Transmitter)
 * from /cctp/references/solana-programs. Until an entry is filled, that chain
 * is NOT offered as a CCTP endpoint (fail closed).
 */
export const CHAINS = Object.freeze({
  ethereum: {
    domain: 0,
    usdcMint: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // mainnet native USDC
    usdcDecimals: 6,
    tokenMinter: null, // TODO: from docs
    messageTransmitter: null, // TODO: from docs
    environment: "mainnet",
  },
  base: {
    domain: 6,
    usdcMint: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcDecimals: 6,
    tokenMinter: null,
    messageTransmitter: null,
    environment: "mainnet",
  },
  arbitrum: {
    domain: 3,
    usdcMint: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    usdcDecimals: 6,
    tokenMinter: null,
    messageTransmitter: null,
    environment: "mainnet",
  },
  solana: {
    domain: 5,
    usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    usdcDecimals: 6,
    // Solana program IDs (verified from /cctp/references/solana-programs, 2026-09-15;
    // identical on mainnet + devnet):
    tokenMessengerMinterProgram: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe", // combines TokenMessenger + TokenMinter
    messageTransmitterProgram: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
    environment: "mainnet",
  },
});

/**
 * Resolve a wallet chain key to its CCTP config entry, or null when the chain is
 * not a configured CCTP endpoint (fail closed — never invent a config).
 */
export function cctpConfigFor(chainKey) {
  return CHAINS[chainKey] ?? null;
}

/**
 * True when the chain is a *configured* CCTP endpoint (has a resolved minting
 * path — EVM TokenMinter or Solana TokenMessengerMinterV2). An entry with null
 * critical fields is NOT yet usable (fail closed).
 */
export function isCctpConfigured(chainKey) {
  const c = cctpConfigFor(chainKey);
  if (!c) return false;
  return Boolean(c.tokenMinter || c.tokenMessengerMinterProgram); // minting path must exist
}
