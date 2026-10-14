/**
 * lifiEvmLeg.js — the LiFi stage-1 bridge leg of the forward route (ETH → X1).
 *
 * LI.Fi builds the bridge transaction; the app's contract is to forward the
 * quote's `transactionRequest` VERBATIM — same to/data/value/gas — through the
 * same simulation gate, and never to invent or rewrite a single byte of the
 * calldata. This leg is the engine home of the bridge-tx half of
 * executeLiFiEvmTx (src/lib/teleportExecute.js): the chain-ensure prelude
 * lives in the stage runner (runners/forwardEvmStage.js), the sim-gated send
 * lives here via simulateTx.simulateEvmTx — the PROVEN code, wrapped.
 *
 * BYTE-IDENTITY CONTRACT (the oracle)
 *   The frozen quote's transactionRequest is the byte reference: the fixture
 *   summary records txDataSha256 (sha256 over the raw calldata bytes,
 *   0x-prefix stripped), txTo, txChainId, txValue. build(ctx).artifact must
 *   reproduce all of them — the stage-1 calldata the engine sends must be the
 *   exact calldata the golden capture recorded.
 *
 * LIFECYCLE
 *   build    → pure: params from transactionRequest verbatim (from = the
 *              connected EVM address; value defaults to "0x0"; gasLimit
 *              carried as hex) + the sha256 byte reference.
 *   simulate → eth_call + eth_estimateGas on the EXACT params (throws
 *              SimulationError on revert → the leg stops, eth_sendTransaction
 *              is NEVER called on a doomed tx).
 *   submit   → eth_sendTransaction → the bridge tx hash (the reference path
 *              treats the hash as final — no receipt wait on this leg).
 *
 * ctx: { lifiData, provider, address }
 */
import { createLeg } from "../../legContract.js";
import { simulateEvmTx } from "../../../lib/simulateTx.js";

/**
 * sha256 hex over raw bytes via WebCrypto (browser + node 22 global). Returns
 * null when WebCrypto is unavailable (non-secure jsdom) — the byte reference
 * is evidence, never a gate; txParams are unaffected.
 */
export async function sha256Hex(bytes) {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle?.digest) return null;
    const buf = await subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/**
 * Build the stage-1 bridge tx params + byte reference from the quote.
 * Deterministic + offline. Throws when the quote carries no transactionRequest
 * (the reference path's "No transaction data in quote").
 */
export async function buildBridgeTxArtifact({ lifiData, address }) {
  const txReq = lifiData?.transactionRequest || lifiData?.steps?.[0]?.transactionRequest;
  if (!txReq) throw new Error("No transaction data in quote");
  const from = String(address || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(from)) {
    throw new Error("lifiEvmLeg.build: no usable from address");
  }
  const params = {
    from,
    to: txReq.to,
    data: txReq.data,
    value: txReq.value || "0x0",
    ...(txReq.gasLimit
      ? { gas: typeof txReq.gasLimit === "string" ? txReq.gasLimit : "0x" + BigInt(txReq.gasLimit).toString(16) }
      : {}),
  };
  const dataSha =
    typeof txReq.data === "string" && txReq.data.startsWith("0x")
      ? await sha256Hex(Buffer.from(txReq.data.slice(2), "hex"))
      : null;
  const artifact = {
    chainId: txReq.chainId ?? null,
    to: String(txReq.to || "").toLowerCase(),
    value: txReq.value ?? null,
    txDataSha256: dataSha,
    txParams: params,
  };
  return { artifact };
}

/**
 * Create the LiFi stage-1 bridge leg.
 * ctx: { lifiData, provider, address }
 */
export function createLifiEvmLeg() {
  return createLeg({
    id: "lifi-evm-bridge",
    family: "evm",
    chain: "eth",
    description:
      "LiFi stage-1 bridge tx — the quote's transactionRequest forwarded verbatim " +
      "(calldata sha256 reference), simulation-gated send (Step 1.3A).",
    goldenStep: "quoteReference (txDataSha256)",
    phases: {
      async build(ctx) {
        return buildBridgeTxArtifact({ lifiData: ctx.lifiData, address: ctx.address });
      },

      async simulate(ctx, built) {
        const params = built?.build?.artifact?.txParams;
        if (!params) throw new Error("lifiEvmLeg.simulate: no bridge tx params");
        if (!ctx.provider || typeof ctx.provider.request !== "function") {
          throw new Error("lifiEvmLeg.simulate: no EIP-1193 provider (connect an EVM wallet)");
        }
        // Throws SimulationError on revert — submit is never reached.
        await simulateEvmTx(ctx.provider, params);
        return { ok: true };
      },

      async submit(ctx, built) {
        const params = built?.build?.artifact?.txParams;
        if (!params) throw new Error("lifiEvmLeg.submit: no bridge tx params");
        return ctx.provider.request({ method: "eth_sendTransaction", params: [params] });
      },
    },
    meta: {
      wraps:
        "the bridge-tx half of teleportExecute.executeLiFiEvmTx (simulateTx.simulateEvmTx + " +
        "eth_sendTransaction with the verbatim transactionRequest)",
      byteRef: "txDataSha256 over the raw calldata bytes — matches forward-leg-summary.json quoteReference",
    },
  });
}
