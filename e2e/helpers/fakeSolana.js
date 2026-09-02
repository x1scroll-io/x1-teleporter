/**
 * fakeSolana.js — Playwright addInitScript payload: a Wallet-Standard fake
 * Solana/X1 wallet for the REVERSE browser harness (e2e/reverse-leg.spec.js).
 *
 * Loaded AFTER e2e/helpers/fakeEthereum.js (which creates the shared
 * window.__x1TeleporterHarness). This script ADDS the Solana side to the same
 * harness: a registered Wallet Standard wallet named "Playwright Test Solana"
 * (deliberately NOT in the app's wallet registry, so it appears as the
 * announced-wallet row) whose adapter signs via the "solana:signTransaction"
 * feature.
 *
 * SAFETY (non-negotiable — the harness STOPS AT THE SIGNATURE)
 *   The solana:signTransaction feature NEVER returns a signed transaction. It
 *   records the exact serialized bytes the wallet was asked to sign
 *   (window.__x1TeleporterHarness.solSigningRequests — base64 of the raw
 *   serialized tx) and then either:
 *     - mode "hang"   — never resolves (the UI stays at the wallet prompt —
 *                       the "ready to sign" state), or
 *     - mode "reject" — throws { code: 4001 } (the user declined).
 *   Default mode: "reject". There is NO mode that signs or broadcasts.
 *   The test reads solSigningRequests to assert the app asked for the EXACT
 *   golden X1 burn tx — byte-for-byte vs step1-x1-burn.json — and that
 *   nothing was sent.
 *
 * ADDRESS
 *   The deterministic Solana address from the golden fixtures
 *   (wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV — the repo's warpBridge USER
 *   test constant, the same wallet the golden burn tx is built for). Because
 *   the harness also fakes the X1 RPC (fixed blockhash + slot), the tx the
 *   wallet is asked to sign is byte-identical to the golden fixture.
 *
 * This file is loaded with addInitScript({ path }) — it must be a standalone
 * classic script (no imports, no module syntax).
 */
(() => {
  // The shared harness (fakeEthereum creates it; extend, never clobber).
  const harness =
    window.__x1TeleporterHarness ||
    (window.__x1TeleporterHarness = {
      mode: "reject",
      setMode(m) {
        if (m !== "hang" && m !== "reject") {
          throw new Error("fake wallet mode must be 'hang' or 'reject'");
        }
        this.mode = m;
      },
    });
  if (!harness.solSigningRequests) {
    harness.solSigningRequests = [];
    harness.solSigningAddress = "wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV";
  }
  if (window.__x1TeleporterFakeSolana) return; // idempotent
  window.__x1TeleporterFakeSolana = true;

  // The deterministic golden-fixture pubkey (wJs2CD1p…, 32 bytes).
  const PUBLIC_KEY_BYTES = new Uint8Array([
    13, 233, 143, 144, 98, 123, 11, 79, 29, 140, 231, 153, 217, 124, 199, 68,
    239, 66, 96, 35, 196, 201, 172, 249, 149, 9, 31, 193, 107, 91, 163, 200,
  ]);
  const ADDRESS = "wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV";
  const NAME = "Playwright Test Solana";
  const CHAINS = ["solana:mainnet"];
  const FEATURE_KEYS = ["standard:connect", "standard:events", "solana:signTransaction"];

  const wallet = {
    version: "1.0.0",
    name: NAME,
    icon: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' rx='6' fill='%239945FF'/><text x='16' y='22' font-size='15' text-anchor='middle' fill='%2305070d'>SOL</text></svg>",
    chains: CHAINS,
    // The Wallet Standard account state lives ON the wallet object — the
    // adapter reads wallet.accounts (length check + accounts[0]) around the
    // standard:connect call, so connect() must update it.
    accounts: [],
    features: {
      "standard:connect": {
        version: "1.0.0",
        // The app calls connect() → we return the golden-fixture account
        // (and store it on the wallet, per the Wallet Standard spec).
        async connect() {
          const account = {
            address: ADDRESS,
            publicKey: PUBLIC_KEY_BYTES,
            chains: CHAINS,
            features: FEATURE_KEYS,
          };
          wallet.accounts = [account];
          return { accounts: [account] };
        },
      },
      "standard:events": {
        version: "1.0.0",
        on() {
          return () => {}; // unsubscribe no-op — nothing emits change events
        },
        off() {},
      },
      "solana:signTransaction": {
        version: "1.0.0",
        // The adapter reads this to decide legacy vs versioned tx support —
        // the golden burn is a LEGACY transaction (buildReverseBurn).
        supportedTransactionVersions: ["legacy"],
        // ── THE SIGNATURE BOUNDARY ──
        // A real wallet would show the sign prompt HERE. This harness never
        // signs: record the exact serialized bytes the wallet was asked to
        // sign, then hang (ready-to-sign state) or decline (4001).
        async signTransaction({ transaction }) {
          const bytes = transaction instanceof Uint8Array
            ? transaction
            : new Uint8Array(transaction);
          harness.solSigningRequests.push({
            at: new Date().toISOString(),
            serializedBase64: btoa(String.fromCharCode(...bytes)),
          });
          if (harness.mode === "hang") {
            return new Promise(() => {}); // wallet prompt open — never resolves
          }
          const err = new Error("User rejected the request.");
          err.code = 4001;
          throw err;
        },
      },
    },
  };

  // Register with the Wallet Standard registry when the app initializes it
  // (@wallet-standard/app dispatches wallet-standard:app-ready lazily).
  const onAppReady = (event) => {
    const register = event.detail?.register;
    if (typeof register === "function") {
      // DELAYED registration (the "late-announcing wallet" path the modal
      // explicitly supports): the app's discovery start() runs BEFORE its
      // subscribe(), so a wallet registered at app-ready is present for the
      // initial snapshot — which is taken pre-subscribe and LOST. Registering
      // ~1.5s later lands after start()+subscribe, so the register event
      // refreshes the discovery and the wallet row appears — exactly like a
      // real extension that injects after the page loads.
      setTimeout(() => {
        try {
          register(wallet);
        } catch {
          // Already registered / registry quirk — discovery refresh covers it.
        }
      }, 1500);
    }
  };
  window.addEventListener("wallet-standard:app-ready", onAppReady);
  // If the registry already initialized before this script (belt+braces —
  // addInitScript runs pre-load, so this is normally the app-ready path).
  if (window.walletStandard?.register) {
    try {
      window.walletStandard.register(wallet);
    } catch {
      /* no-op */
    }
  }
})();
