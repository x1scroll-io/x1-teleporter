/**
 * dexAnchorRunner.js — the DEX-DIRECT LIVE-ANCHOR harness (the
 * SIGNED-IN-YOUR-WALLET execute lane for the dexDirect family).
 *
 * 🔴 FUNDS RULE — READ FIRST:
 *   The dexDirect legs BUILD signable swaps; THIS runner is the only layer
 *   that hands them to Mr. Esters' wallet, and it does so exclusively
 *   through the wallet's own signing surface (resolved by the engine's
 *   single SignerResolver):
 *     EVM  → the EIP-1193 provider (Rabby): sim-gated eth_sendTransaction
 *            (guardedSendEvmTx — the repo's standard Step-1.3A send path).
 *            Rabby pops the approval UI; Mr. Esters reviews + confirms;
 *            RABBY's own connection broadcasts. eth_sendTransaction is
 *            NEVER called on a tx whose simulation reverts.
 *     SVM  → the Wallet-Standard adapter (Backpack):
 *            adapter.signAndSendTransaction ONLY. There is deliberately NO
 *            signTransaction + app-side sendRawTransaction fallback — the
 *            wallet's own connection must broadcast.
 *   There is no sendRawTransaction anywhere in this module (or the legs —
 *   see the no-broadcast test). If a session cannot sign, the runner
 *   stops with an honest error instead of inventing a broadcast path.
 *
 * FLOW (per leg, exactly what the live anchor walks):
 *   1. connect — resolve the signer for the leg's family (Rabby/Backpack);
 *   2. build   — leg.phases.build(ctx) → the quote-pinned artifact;
 *   3. plan    — the leg's signable planner: EVM → { needsApproval,
 *                approvalTx?, swapTx } (allowance eth_call, read-only);
 *                SVM → { needsSetup, setupTx?, swapTx } (ATA getAccountInfo
 *                checks, read-only);
 *   4. sign    — each tx in order through the wallet adapter (the user
 *                approves in the wallet UI; the wallet broadcasts);
 *   5. confirm — the returned hash/signature is the anchor receipt.
 *
 * The runner never simulates Solana swaps itself: the swap instructions are
 * official-SDK-built + byte-pinned to layouts that were read-only
 * SIMULATED on mainnet during capture (the dex-direct fixtures), and the
 * quote-pinned min-out protects the live anchor. The wallet UI is the
 * final gate.
 */
import { CHAINS } from "../teleportConstants.js";
import { SignerResolver } from "../../engine/signerResolver.js";
import { guardedSendEvmTx } from "../simulateTx.js";
import { createUniswapSwapLeg } from "../../engine/legs/dexDirect/uniswapSwapLeg.js";
import { createPancakeSwapSwapLeg } from "../../engine/legs/dexDirect/pancakeswapSwapLeg.js";
import { createRaydiumSwapLeg } from "../../engine/legs/dexDirect/raydiumSwapLeg.js";
import { createOrcaSwapLeg } from "../../engine/legs/dexDirect/orcaSwapLeg.js";
import { planEvmDexExecute } from "../../engine/legs/dexDirect/evmSignable.js";
import { planRaydiumExecute, planOrcaExecute } from "../../engine/legs/dexDirect/solanaSignable.js";

/** The anchor's per-dex leg factories (the same legs RoutePlanner plans). */
export function anchorLegForDex(dex) {
  switch (dex) {
    case "uniswap": return createUniswapSwapLeg();
    case "pancakeswap": return createPancakeSwapSwapLeg();
    case "raydium": return createRaydiumSwapLeg();
    case "orca": return createOrcaSwapLeg();
    default: throw new Error(`dexAnchorRunner: unknown dex "${dex}" (uniswap | pancakeswap | raydium | orca)`);
  }
}

/** True when a dex is an EVM leg (Rabby) vs a Solana leg (Backpack). */
export function dexAnchorFamily(dex) {
  if (dex === "uniswap" || dex === "pancakeswap") return "evm";
  if (dex === "raydium" || dex === "orca") return "svm";
  throw new Error(`dexAnchorRunner: unknown dex "${dex}"`);
}

/** The EIP-1193 tx params a wallet step hands to the provider. */
export function evmTxParamsFromStep(step) {
  const t = step.tx;
  return { from: t.from, to: t.to, data: t.data, value: t.value ?? "0x0" };
}

/**
 * Ensure the wallet is on the tx's chain (eth_chainId +
 * wallet_switchEthereumChain — the teleportExecute discipline). Throws an
 * honest, user-actionable error when the switch is refused.
 */
export async function ensureEvmChain(provider, chainId, chainName) {
  try {
    const targetHex = "0x" + Number(chainId).toString(16);
    const currentHex = await provider.request({ method: "eth_chainId" });
    if (String(currentHex).toLowerCase() === targetHex.toLowerCase()) return;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: targetHex }] });
    } catch (switchErr) {
      if (switchErr?.code === 4902) {
        throw new Error(`Add ${chainName} to your wallet (chainId ${chainId}), then retry the anchor`);
      }
      throw new Error(`Approve the network switch to ${chainName} in your wallet, then retry`);
    }
  } catch (e) {
    if (e?.message?.includes("network switch") || e?.message?.includes("Add ")) throw e;
    // Non-fatal (some providers don't support eth_chainId cleanly) — continue.
  }
}

/**
 * The ordered EVM wallet steps from a plan: approval (when needed) FIRST,
 * then the swap. Signing order matters — the swap reverts without the
 * allowance.
 * @returns {Array<{kind: "approval"|"swap", label: string, tx: object}>}
 */
export function evmAnchorSteps(plan) {
  const steps = [];
  if (plan.needsApproval) {
    steps.push({ kind: "approval", label: "Approve the source token spend (1 of 2)", tx: plan.approvalTx });
  }
  steps.push({ kind: "swap", label: plan.needsApproval ? "Confirm the swap (2 of 2)" : "Confirm the swap", tx: plan.swapTx });
  return steps;
}

/** The ordered Solana wallet steps from a plan: ATA setup (when needed)
 *  FIRST, then the swap. */
export function solanaAnchorSteps(plan) {
  const steps = [];
  if (plan.needsSetup) {
    steps.push({ kind: "ata-setup", label: "Create the missing token account(s) (1 of 2)", tx: plan.setupTx });
  }
  steps.push({ kind: "swap", label: plan.needsSetup ? "Confirm the swap (2 of 2)" : "Confirm the swap", tx: plan.swapTx });
  return steps;
}

/**
 * Run EVM wallet steps: each tx is sim-gated (eth_call + gas estimate —
 * a revert BLOCKS the send) and then sent via eth_sendTransaction, which
 * pops in Rabby for Mr. Esters to review + confirm. RABBY broadcasts.
 *
 * @returns {Promise<Array<{kind, label, hash}>>}
 */
export async function runEvmAnchorSteps({ steps, provider, onStatus = () => {} }) {
  const results = [];
  for (const step of steps) {
    onStatus(step.label);
    const params = evmTxParamsFromStep(step);
    // guardedSendEvmTx: simulate → eth_sendTransaction. The wallet UI is
    // the broadcast path; a failed simulation means the send NEVER runs.
    const hash = await guardedSendEvmTx(provider, params);
    results.push({ kind: step.kind, label: step.label, hash });
    onStatus(`✓ ${step.kind} sent — ${hash}`);
  }
  return results;
}

/**
 * Run Solana wallet steps: adapter.signAndSendTransaction ONLY (Backpack
 * pops; the user approves; BACKPACK broadcasts). There is deliberately NO
 * fallback to signTransaction + app-side sendRawTransaction.
 *
 * @returns {Promise<Array<{kind, label, signature}>>}
 */
export async function runSolanaAnchorSteps({ steps, adapter, onStatus = () => {} }) {
  if (!adapter || typeof adapter.signAndSendTransaction !== "function") {
    throw new Error(
      "dexAnchorRunner: the Solana session cannot sign-and-send — connect Backpack. " +
        "(This runner NEVER falls back to an agent-side broadcast.)",
    );
  }
  const results = [];
  for (const step of steps) {
    onStatus(step.label);
    const res = await adapter.signAndSendTransaction(step.tx.transaction);
    const signature = typeof res === "string" ? res : (res?.signature ?? res?.txid ?? JSON.stringify(res));
    results.push({ kind: step.kind, label: step.label, signature });
    onStatus(`✓ ${step.kind} signed + sent — ${signature}`);
  }
  return results;
}

/** A minimal Solana read handle from a Connection (ATA checks + blockhash
 *  + the anchor SDK's structural needs). */
export function readHandleFromConnection(connection) {
  return {
    getAccountInfo: (pubkey) => connection.getAccountInfo(pubkey),
    getLatestBlockhash: () => connection.getLatestBlockhash().then((r) => ({ blockhash: r.blockhash })),
    getMinimumBalanceForRentExemption: (bytes) => connection.getMinimumBalanceForRentExemption(bytes),
  };
}

/**
 * THE LIVE-ANCHOR FLOW: build → plan → sign-in-wallet (per leg).
 *
 * @param {object} args
 * @param {string} args.dex "uniswap" | "pancakeswap" | "raydium" | "orca"
 * @param {object} args.buildCtx the leg's build ctx (chain/fromToken/
 *   toToken/amount/…; Solana legs need the decoded snapshot + blockhash
 *   inputs the leg requires)
 * @param {object} args.sessions the WalletContext sessions ({ evm, solana })
 * @param {object} [args.read] Solana read handle (defaults to a Connection
 *   on the env Solana RPC)
 * @param {string} [args.from] the connected wallet address — EVM: the 0x
 *   address (required); SVM: the base58 pubkey (defaults to the adapter's)
 * @param {(msg: string) => void} [args.onStatus]
 * @returns {Promise<{legId, dex, family, chain, plan, results,
 *            statuses: string[]}>}
 */
export async function runDexAnchor({ dex, buildCtx, sessions, read = null, from = null, onStatus = () => {} }) {
  const statuses = [];
  const say = (msg) => { statuses.push(msg); onStatus(msg); };
  const leg = anchorLegForDex(dex);
  const family = dexAnchorFamily(dex);

  // 1. CONNECT — resolve the wallet for the leg's family (never invents one).
  const signer = await SignerResolver.resolve(family, sessions?.[family === "svm" ? "solana" : "evm"]);
  if (!signer) {
    throw new Error(`dexAnchorRunner: no ${family === "evm" ? "EVM" : "Solana"} signing session — connect ${family === "evm" ? "Rabby" : "Backpack"} first`);
  }

  // 2. BUILD — the quote-pinned artifact.
  const built = await leg.phases.build(buildCtx);
  if (!built?.needed || !built?.artifact) {
    throw new Error(`dexAnchorRunner: ${dex} build did not produce an artifact`);
  }
  const artifact = built.artifact;
  say(`${dex}: quote-pinned artifact built (${artifact.chain})`);

  // 3. PLAN + 4/5. SIGN — per family.
  if (family === "evm") {
    const fromAddr = from ?? null;
    if (!fromAddr || !/^0x[0-9a-fA-F]{40}$/.test(fromAddr)) {
      throw new Error("dexAnchorRunner: EVM anchor needs `from` = the connected 0x wallet address");
    }
    const chain = artifact.chain;
    const chainId = CHAINS[chain]?.chainId ?? artifact.chainId;
    const chainName = CHAINS[chain]?.name ?? chain;
    await ensureEvmChain(signer, chainId, chainName);
    say(`${dex}: wallet on ${chainName} — checking the source-token allowance (read-only)`);
    const plan = await planEvmDexExecute({ provider: signer, artifact, chainId, from: fromAddr });
    const steps = evmAnchorSteps(plan);
    say(plan.needsApproval ? `${dex}: allowance short — approval tx first` : `${dex}: allowance sufficient — swap only`);
    const results = await runEvmAnchorSteps({ steps, provider: signer, onStatus: say });
    return { legId: leg.id, dex, family, chain, plan, results, statuses };
  }

  // SVM
  const adapter = signer;
  const userPubkey = from ?? (adapter.publicKey ? String(adapter.publicKey) : null);
  if (!userPubkey) throw new Error("dexAnchorRunner: Solana anchor needs the wallet pubkey (connect Backpack)");
  let readHandle = read;
  if (!readHandle) {
    const { Connection } = await import("@solana/web3.js");
    const rpc = (typeof import.meta !== "undefined" && import.meta.env?.VITE_SOLANA_RPC) || "https://berty-633y20-fast-mainnet.helius-rpc.com";
    readHandle = readHandleFromConnection(new Connection(rpc, "confirmed"));
  }
  const plan = dex === "raydium"
    ? await planRaydiumExecute({ dex: buildCtx.dex ?? "cpmm", artifact, snapshot: buildCtx.snapshot, userPubkey, read: readHandle })
    : await planOrcaExecute({ artifact, snapshot: buildCtx.snapshot, userPubkey, read: readHandle });
  const steps = solanaAnchorSteps(plan);
  say(plan.needsSetup ? `${dex}: ATA(s) missing — setup tx first` : `${dex}: token accounts present — swap only`);
  const results = await runSolanaAnchorSteps({ steps, adapter, onStatus: say });
  return { legId: leg.id, dex, family, chain: artifact.chain, plan, results, statuses };
}
