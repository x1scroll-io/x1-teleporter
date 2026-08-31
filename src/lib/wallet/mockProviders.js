/**
 * Mock wallet providers for the WalletContext (Step 2.1).
 *
 * Pure stubs — NO real wallet SDKs are wired in this step. Each provider
 * implements the minimal async surface the context needs (connect /
 * disconnect) and resolves a deterministic mock address in the family's
 * conventional shape (e.g. "mock:evm:0x…", "mock:solana:<44 chars>").
 *
 * Later steps swap these for real SDK adapters (EIP-1193 providers,
 * @solana/wallet-adapter, …) behind the SAME interface, so the context and
 * the isolation guarantees do not change when the mocks go away.
 */

/** Deterministic mock addresses — one per family, stable across tests. */
export const MOCK_ADDRESSES = Object.freeze({
  evm: "mock:evm:0x1234567890abcdef1234567890abcdef12345678",
  solana: "mock:solana:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  bitcoin: "mock:bitcoin:1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
  litecoin: "mock:litecoin:LbTjMGN7gELw4KbeyQf6cTCq859hD18guE",
  dogecoin: "mock:dogecoin:DAnj4R9LPKFMgGWW1QvJ6jWfBzS7c3p3xG",
  xrp: "mock:xrp:rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
  tron: "mock:tron:T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
});

/**
 * Create a mock provider for a family.
 *
 * @param {string} family one of the WALLET_FAMILIES keys
 * @param {{failOnConnect?: boolean, connectDelayMs?: number}} [options]
 *   - failOnConnect: connect() rejects (test fixture for error paths).
 *   - connectDelayMs: artificial latency before resolving (test fixture for
 *     in-flight/idempotency behavior).
 * @returns {{family: string, id: string, isMock: true, connect: () => Promise<{family, address, provider}>, disconnect: () => Promise<void>}}
 */
export function createMockProvider(family, options = {}) {
  const { failOnConnect = false, connectDelayMs = 0 } = options;
  if (!(family in MOCK_ADDRESSES)) {
    throw new Error(`createMockProvider: unknown family "${family}"`);
  }

  const provider = {
    family,
    id: `mock:${family}`,
    isMock: true,

    async connect() {
      if (failOnConnect) {
        throw new Error(`mock ${family} provider rejected connect (test fixture)`);
      }
      if (connectDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, connectDelayMs));
      }
      return { family, address: MOCK_ADDRESSES[family], provider };
    },

    async disconnect() {
      // Mock teardown — nothing to release yet.
    },
  };

  return provider;
}
