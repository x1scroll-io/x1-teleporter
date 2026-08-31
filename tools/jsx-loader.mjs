/**
 * Minimal JSX loader for node:test — no testing-library is installed, so this
 * is how the React-level wallet tests (WalletContext.test.jsx) run under
 * `node --test`: esbuild transpiles .jsx on the fly, everything else passes
 * through untouched. Registered via `node --import ./tools/jsx-loader.mjs`
 * in the npm test script.
 */
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { register } from "node:module";

const JSX_EXTENSIONS = new Set([".jsx"]);

export async function load(url, context, nextLoad) {
  if (JSX_EXTENSIONS.has(extname(url))) {
    const source = readFileSync(new URL(url), "utf8");
    const { code } = transformSync(source, {
      loader: "jsx",
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
