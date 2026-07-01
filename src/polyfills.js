// Side-effect module: must be imported FIRST in main.jsx, before any module
// that (transitively) pulls in @solana/web3.js. ES module imports are hoisted
// and run top-to-bottom, so importing this before ./Teleporter.jsx guarantees
// Buffer exists as a global before the Solana library's module code evaluates.
import { Buffer } from "buffer";

if (typeof globalThis !== "undefined" && !globalThis.Buffer) globalThis.Buffer = Buffer;
if (typeof window !== "undefined" && !window.Buffer) window.Buffer = Buffer;
