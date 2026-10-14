/**
 * Minimal JSX/TS loader for node:test — no testing-library is installed, so
 * this is how the React-level wallet tests (WalletContext.test.jsx) run under
 * `node --test`: esbuild transpiles .jsx (and .ts/.tsx) on the fly, everything
 * else passes through untouched. Registered via `node --import
 * ./tools/jsx-loader.mjs` in the npm test script.
 *
 * WHY .ts TOO: Node 22's built-in TypeScript type-stripping (amaro) works,
 * but its wasm engine reserves ~10GB of VIRTUAL address space per process.
 * Under the suite's 16GB `ulimit -v` guardrail that leaves almost no headroom
 * for a SECOND wasm reservation (e.g. undici's lazy llhttp when a test's
 * fetch fires) — the second instantiation fails with "Cannot allocate Wasm
 * memory" and the suite dies with an unhandledRejection. Transforming .ts
 * through esbuild (pure JS output, no wasm) keeps the whole suite at a few GB
 * of virtual memory. The repo's .ts files are plain type-strippable modules
 * (flags/routes/fees), so esbuild output is equivalent.
 */
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { register } from "node:module";

/** extension → esbuild loader. */
const TRANSFORM_EXTENSIONS = new Map([
  [".jsx", "jsx"],
  [".ts", "ts"],
  [".tsx", "tsx"],
]);

export async function load(url, context, nextLoad) {
  const loader = TRANSFORM_EXTENSIONS.get(extname(url));
  if (loader) {
    const source = readFileSync(new URL(url), "utf8");
    const { code } = transformSync(source, {
      loader,
      jsx: "automatic", // react/jsx-runtime — matches @vitejs/plugin-react
      format: "esm",
      target: "node22",
      sourcemap: "inline",
    });
    return { format: "module", source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}

// Register this module's hooks explicitly — `--import` alone does not
// register exported hooks in Node 22.
register(new URL("./jsx-loader.mjs", import.meta.url));
