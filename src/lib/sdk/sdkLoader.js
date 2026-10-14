/**
 * sdkLoader.js — the shared cached lazy-loader used by the grabbed official
 * SDKs in this directory (the heavy-SDK discipline of the standing rule).
 *
 * WHY A SHARED HELPER: each family module (sdkXrp.js, sdkTron.js, …) pins one
 * or two official SDK packages and must load them ONLY on the future leg's
 * execute path (never in the Vite main bundle). The loader here gives every
 * module the same semantics the audited XDEX refactor uses inline
 * (src/engine/legs/dex/xdexSwapLeg.js — official-SDK loader):
 *
 *   1. dynamic `import()` — the SDK lands in a lazily-loaded chunk (or, for
 *      today's UNUSED readiness modules, in no chunk at all: nothing in the
 *      app graph imports these modules yet, so the build is untouched).
 *   2. cached promise — the first load pays the import cost, later ones do
 *      not.
 *   3. fail-closed shape check — the loader verifies the exports the future
 *      leg actually needs exist on the resolved namespace; if an official
 *      SDK release ever renames/removes one, the loader THROWS loudly at
 *      load time instead of the future leg failing mid-construction (the
 *      same drift-canary philosophy as the XDEX 13-account order check).
 *   4. reset-on-failure — a transient import failure clears the cache so one
 *      retry is possible.
 *
 * ⛔ BOUNDARY: these modules are READINESS SCAFFOLDING (grabbed, version-
 * pinned, import-verified). They are NOT wired into any live flow — no app
 * module imports them, nothing here ever signs or broadcasts. Wiring happens
 * leg-by-leg on the roadmap (see docs/SDK-REGISTRY.md), and each wiring must
 * re-verify the SDK's live behavior against the chain it serves before any
 * real funds move.
 */

/**
 * Build a cached lazy loader for one official SDK package.
 *
 * @param {string} spec       the npm package specifier (bare specifier or
 *                            subpath, e.g. "@mysten/sui/client").
 * @param {object} [opts]
 * @param {string[]} [opts.exports]  export names the loader must find on the
 *                            resolved namespace; missing any → loud throw.
 * @param {(m: object) => object} [opts.resolve]  map the raw module namespace
 *                            to the namespace the exports are checked on
 *                            (default: the namespace itself).
 * @returns {() => Promise<object>} the cached loader (resolves the checked
 *                            namespace; never rejects after a successful
 *                            load).
 */
export function makeSdkLoader(spec, { exports: requiredExports = [], resolve } = {}) {
  let promise = null;
  return function loadSdk() {
    if (!promise) {
      promise = import(spec)
        .then((raw) => {
          const ns = resolve ? resolve(raw) : raw;
          const missing = requiredExports.filter((name) => !(name in ns));
          if (missing.length > 0) {
            throw new Error(
              `sdkLoader: ${spec} import shape check FAILED — missing export(s): ${missing.join(", ")}. ` +
                "The official SDK surface changed vs the pinned version; re-verify before wiring " +
                "(see docs/SDK-REGISTRY.md).",
            );
          }
          return ns;
        })
        .catch((e) => {
          promise = null; // allow one retry after a transient failure
          throw e;
        });
    }
    return promise;
  };
}
