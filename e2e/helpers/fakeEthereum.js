/**
 * fakeEthereum.js — Playwright addInitScript payload: an EIP-6963-announcing
 * fake EVM wallet for the x1-teleporter browser harness (Tool 2).
 *
 * WHAT IT DOES
 *   Injected into the page BEFORE the app loads (addInitScript), so the
 *   app's wagmi EIP-6963 discovery sees a real-format injected wallet:
 *     - window.ethereum — a full EIP-1193 provider (request/events),
 *     - an `eip6963:announceProvider` dispatch (uuid/name/icon/rdns +
 *       provider), so wagmi lists it as an INSTALLED wallet in the connect
 *       modal (the generic "injected" fallback is deliberately excluded from
 *       the modal — an announced provider is required).
 *
 * SAFETY (non-negotiable — the harness STOPS AT THE SIGNATURE)
 *   eth_sendTransaction NEVER returns a hash. It records the exact params
 *   the wallet was asked to sign (window.__x1TeleporterHarness.signingRequests)
 *   and then either:
 *     - mode "hang"   — never resolves (the UI stays at the wallet prompt —
 *                       the "ready to sign" state), or
 *     - mode "reject" — throws { code: 4001 } (the user declined — the UI
 *                       must surface the honest rejection).
 *   Default mode: "reject". There is NO mode that signs or broadcasts.
 *   The test reads signingRequests to assert the app asked for the EXACT
 *   golden approval payload — byte-for-byte — and that nothing was sent.
 *
 * ADDRESS
 *   The deterministic EVM address from the golden fixtures
 *   (0x4634e8e0b1c2d3f4a5b6c7d8e9f0a1b2c3d4e5f6 — the repo's teleportQuote
 *   test constant, also the fromAddress of the frozen quote fixture).
 *
 * This file is loaded with addInitScript({ path }) — it must be a
 * standalone classic script (no imports, no module syntax).
 */
(() => {
  if (window.__x1TeleporterHarness) return; // idempotent

  const ADDRESS = "0x4634e8e0b1c2d3f4a5b6c7d8e9f0a1b2c3d4e5f6";
  const RDNS = "com.playwright.testwallet";
  const UUID = "11111111-1111-4111-8111-111111111111";
  const NAME = "Playwright Test Wallet";
  const CHAIN_ID = "0x1"; // Ethereum mainnet

  const harness = {
    address: ADDRESS,
    rdns: RDNS,
    name: NAME,
    /** "hang" | "reject" — see header. Default REJECT: never sign, never send. */
    mode: "reject",
    /** Every eth_sendTransaction the app asked the wallet to sign. */
    signingRequests: [],
    /** Every eth_call / estimate / accounts call, for diagnostics. */
    calls: [],
    setMode(m) {
      if (m !== "hang" && m !== "reject") {
        throw new Error("fake wallet mode must be 'hang' or 'reject'");
      }
      this.mode = m;
    },
  };
  window.__x1TeleporterHarness = harness;

  // ── The EIP-1193 provider ──
  const provider = {
    isMetaMask: false, // honest: this is a test wallet, not MetaMask
    isPlaywright: true,

    async request({ method, params = [] }) {
      harness.calls.push({ method, params });
      switch (method) {
        case "eth_chainId":
          return CHAIN_ID;
        case "net_version":
          return "1";
        case "eth_accounts":
          return [ADDRESS];
        case "eth_requestAccounts":
          return [ADDRESS];
        case "wallet_switchEthereumChain":
          return null; // accepted
        case "wallet_addEthereumChain":
          return null;
        case "eth_call": {
          const data = String(params?.[0]?.data || "0x");
          if (data.startsWith("0xdd62ed3e")) {
            // allowance(owner, spender) — return ZERO so the app takes the
            // exact-amount approval path (the golden step-1 shape).
            return "0x0000000000000000000000000000000000000000000000000000000000000000";
          }
          // Simulation eth_call of the approval/bridge tx — succeed.
          return "0x";
        }
        case "eth_estimateGas":
          return "0x5208"; // 21000 — any positive estimate passes the gate
        case "eth_getTransactionReceipt":
          return null; // never reached — we never send
        case "eth_sendTransaction": {
          // ── THE SIGNATURE BOUNDARY ──
          // A real wallet would show the sign prompt HERE. This harness never
          // signs: record the exact payload the wallet was asked to approve,
          // then hang (ready-to-sign state) or decline (4001).
          harness.signingRequests.push({
            at: new Date().toISOString(),
            params: params?.[0] ?? null,
          });
          if (harness.mode === "hang") {
            return new Promise(() => {}); // wallet prompt open — never resolves
          }
          const err = new Error("User rejected the request.");
          err.code = 4001;
          throw err;
        }
        default:
          return null;
      }
    },

    // Event surface the app/wagmi may touch — no-ops (nothing subscribes in a
    // way that affects the flow we assert).
    on() {},
    removeListener() {},
    removeAllListeners() {},
    off() {},
  };
  window.ethereum = provider;

  // ── EIP-6963 announce ──
  const info = {
    uuid: UUID,
    name: NAME,
    icon: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' rx='6' fill='%233fd3e8'/><text x='16' y='22' font-size='16' text-anchor='middle' fill='%2305070d'>PW</text></svg>",
    rdns: RDNS,
  };
  const announce = () => {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }),
    );
  };
  window.addEventListener("eip6963:requestProvider", () => announce());
  // Proactively announce on load too — covers a dapp that never dispatches
  // the request event (mipd de-dupes by uuid, a double announce is harmless).
  announce();
})();
