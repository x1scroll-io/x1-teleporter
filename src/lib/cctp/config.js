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
 *   - Arc went mainnet 2026-09-16 (Circle CCTP domain 26). It is an OPTIONAL
 *     destination, never a forced intermediate hop. Native-USDC mint + Message-
 *     Transmitter verified from Circle docs before the chain is offered.
 */

/** Circle CCTP domain id, keyed by our wallet chain key. */
export const DOMAIN_IDS = Object.freeze({
  eth: 0,
  avax: 1,
  opt: 2,
  arb: 3,
  noble: 4, // Cosmos — USDC issuance hub
  sol: 5,
  bas: 6,
  pol: 7,
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
  arc: 26, // Arc — Circle's L1, mainnet since 2026-09-16
  edge: 28,
  injective: 29,
  morph: 30,
  pharos: 31,
  cronos: 32,
  plasma: 33,
  xlayer: 37,
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
  eth: {
    domain: 0,
    usdcMint: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // mainnet native USDC
    usdcDecimals: 6,
    // MessageTransmitterV2 — receiveMessage(message, attestation) is the mint path
    // (the TokenMinter is called internally by the message handler, not by the user).
    messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    environment: "mainnet",
  },
  bas: {
    domain: 6,
    usdcMint: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcDecimals: 6,
    messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    environment: "mainnet",
  },
  arb: {
    domain: 3,
    usdcMint: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    usdcDecimals: 6,
    messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    environment: "mainnet",
  },
  arc: {
    domain: 26,
    // Native USDC on Arc (Circle docs 2026-09-17) + the deterministic Message-
    // TransmitterV2. Both verified live on Arc RPC (rpc.mainnet.arc.io).
    usdcMint: "0x3600000000000000000000000000000000000000",
    usdcDecimals: 6,
    messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    environment: "mainnet",
  },
  avax: { domain: 1, usdcMint: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  linea: { domain: 11, usdcMint: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  codex: { domain: 12, usdcMint: "0xd996633a415985DBd7D6D12f4A4343E31f5037cf", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  monad: { domain: 15, usdcMint: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  hyperevm: { domain: 19, usdcMint: "0xb88339CB7199b77E23DB6E890353E22632Ba630f", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  ink: { domain: 21, usdcMint: "0x2D270e6886d130D724215A266106e6832161EAEd", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  injective: { domain: 29, usdcMint: "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  morph: { domain: 30, usdcMint: "0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  cronos: { domain: 32, usdcMint: "0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  opt: { domain: 2, usdcMint: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  pol: { domain: 7, usdcMint: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  unichain: { domain: 10, usdcMint: "0x078D782b760474a361dDA0AF3839290b0EF57AD6", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  sonic: { domain: 13, usdcMint: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  worldchain: { domain: 14, usdcMint: "0x79A02482A880bCe3F13E09da970dC34dB4cD24D1", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  sei: { domain: 16, usdcMint: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  xdc: { domain: 18, usdcMint: "0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  plume: { domain: 22, usdcMint: "0x222365EF19F7947e5484218551B56bb3965Aa7aF", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  pharos: { domain: 31, usdcMint: "0xC879C018dB60520F4355C26eD1a6D572cdAC1815", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  plasma: { domain: 33, usdcMint: "0x2d661C89D812261039AF9764eceaAee884f5F67F", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  xlayer: { domain: 37, usdcMint: "0xB6CEceAB302E2E4948951eE7843FC24E92933061", usdcDecimals: 6, messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", environment: "mainnet" },
  sol: {
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
  return Boolean(c.messageTransmitter || c.tokenMessengerMinterProgram); // minting path must exist
}
