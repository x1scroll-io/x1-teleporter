/**
 * src/teleporter/lib/sdk/sdkCctpAptos.js — Circle CCTP on APTOS (pure
 * Move-call / script payload builders; dependency-free, signer-free).
 *
 * This is the Aptos sibling of sdkCctpSui.js. Everything here is PURE data — no
 * @aptos-labs/ts-sdk import, no RPC, no signing — so the test suite can assert
 * the exact documented targets/signatures offline and the wallet bridge
 * (src/aptosCctp.ts) owns the ts-sdk.
 *
 * ── SOURCE OF TRUTH (fetched 2026-09-18 — NEVER GUESSED) ────────────────────
 *   • https://developers.circle.com/cctp/references/aptos-packages
 *   • repo github.com/circlefin/aptos-cctp (Move)
 *   • domains: https://developers.circle.com/cctp/concepts/supported-chains-and-domains
 *     → Aptos is domain 9, Sui is domain 8.
 *   • see docs/cctp-sui-aptos.md in this repo for the copied addresses.
 *
 * Packages + shared objects (mainnet):
 *   MessageTransmitterV2   0x1b3f6d749cb835451202f9a1932e49014266f7e3d51611a9a763d156cb4bdaf6
 *   TokenMessengerMinterV2 0x551e32781793c30bf1580d11e4f5171e8d068c3d45c3a5b20ae240bfdad99af8
 *   CctpExtensions         0x93c742af9a876b10c8e13584fb443597611f0efdb342530aa0ebc5ad208815ff
 *   StablecoinHandler      0x2b963f8aa28b815d2e875bd85a1a01d5f2d346f08f5b9fcf8953c77680735af2
 *
 * ── THE HOT-POTATO CAVEAT (why the composed flow is a SCRIPT, not two calls) ─
 * Aptos entry functions cannot thread a Move RETURN VALUE into a later call in
 * the same transaction, and the CCTP receipts are hot potatoes (structs with no
 * `drop`) that MUST be consumed before the transaction ends. Therefore:
 *
 *   burn = token_messenger_minter::deposit_for_burn(...) -> (BurnReceipt,
 *          FungibleAsset); then stablecoin_handler::handler::burn(BurnReceipt,
 *          FungibleAsset)          ← must be ONE Move script.
 *   mint = message_transmitter::receive_message(...) -> Receipt; then
 *          token_messenger_minter::prepare_mint(Receipt) -> MintReceipt; then
 *          stablecoin_handler::handler::mint(MintReceipt)  ← ONE Move script.
 *
 * Circle ships precompiled `deposit_for_burn.mv` / `receive_message.mv` for
 * exactly this (github.com/circlefin/aptos-cctp typescript/example/
 * precompiled-move-scripts/). We do NOT have that bytecode vendored here, so we
 * encode the DOCUMENTED calls as a plan (below) and expose a script-payload
 * builder that accepts the precompiled bytecode when it is supplied. We never
 * synthesise or guess bytecode, module addresses, or signatures.
 */

/** Circle's CCTP domain for Aptos (supported-chains table). */
export const APTOS_CCTP_DOMAIN = 9;

/** Circle's Aptos CCTP package + shared-object ids, per network. Documented. */
export const APTOS_CCTP = Object.freeze({
  mainnet: Object.freeze({
    MessageTransmitterV2: "0x1b3f6d749cb835451202f9a1932e49014266f7e3d51611a9a763d156cb4bdaf6",
    TokenMessengerMinterV2: "0x551e32781793c30bf1580d11e4f5171e8d068c3d45c3a5b20ae240bfdad99af8",
    CctpExtensions: "0x93c742af9a876b10c8e13584fb443597611f0efdb342530aa0ebc5ad208815ff",
    StablecoinHandler: "0x2b963f8aa28b815d2e875bd85a1a01d5f2d346f08f5b9fcf8953c77680735af2",
    objects: Object.freeze({
      MessageTransmitterV2: "0x57ba011deccc5749aff12f4900fd30cac744098f7be91f1eba4e07847510ee72",
      TokenMessengerMinterV2: "0x52f4732b1cb52ce28f595e29978450132772f88277182e12bc431faa677be603",
      StablecoinHandler: "0x44a1eb6f97a962623ad9d4e8db3dc8408d1b62f90baf91ae6c0d6764b9f1b984",
      Stablecoin: "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b",
    }),
  }),
});

/**
 * Native USDC on Aptos — the FungibleAsset metadata object id. (Same id as the
 * documented `Stablecoin` shared object and ChangeNow's Aptos USDC
 * tokenContract — three independent confirmations, never guessed.)
 */
export const APTOS_USDC = "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b";

// ─────────────────────────────────────────────────────────── targets
// `<package>::<module>::<function>`, exactly as Circle documents them.

/** `token_messenger_minter::deposit_for_burn` (burn, Aptos as SOURCE). */
export function aptosDepositForBurnTarget(cfg = APTOS_CCTP.mainnet) {
  return `${cfg.TokenMessengerMinterV2}::token_messenger_minter::deposit_for_burn`;
}
/** `stablecoin_handler::handler::burn` (consumes the BurnReceipt, step 2). */
export function aptosBurnTarget(cfg = APTOS_CCTP.mainnet) {
  return `${cfg.StablecoinHandler}::handler::burn`;
}
/** `message_transmitter::receive_message` (mint, Aptos as DESTINATION, step 1). */
export function aptosReceiveMessageTarget(cfg = APTOS_CCTP.mainnet) {
  return `${cfg.MessageTransmitterV2}::message_transmitter::receive_message`;
}
/** `token_messenger_minter::prepare_mint` (turn the Receipt into a MintReceipt). */
export function aptosPrepareMintTarget(cfg = APTOS_CCTP.mainnet) {
  return `${cfg.TokenMessengerMinterV2}::token_messenger_minter::prepare_mint`;
}
/** `stablecoin_handler::handler::mint` (consumes the MintReceipt, step 3). */
export function aptosMintTarget(cfg = APTOS_CCTP.mainnet) {
  return `${cfg.StablecoinHandler}::handler::mint`;
}

// ─────────────────────────────────────────────────────────── documented signatures

/** Exact documented signatures — kept as data so tests can pin them. */
export const APTOS_CCTP_SIGNATURES = Object.freeze({
  depositForBurn:
    "token_messenger_minter::deposit_for_burn(&signer, FungibleAsset, u32, address, address, u64, u32, vector<u8>) -> (BurnReceipt, FungibleAsset)",
  burn: "stablecoin_handler::handler::burn(BurnReceipt, FungibleAsset)",
  receiveMessage:
    "message_transmitter::receive_message(&signer, &vector<u8>, &vector<u8>) -> Receipt",
  prepareMint: "token_messenger_minter::prepare_mint(Receipt) -> MintReceipt",
  mint: "stablecoin_handler::handler::mint(MintReceipt)",
});

function assertU32(v, name) {
  if (v === undefined || v === null) throw new Error(`aptosCctp: ${name} is required`);
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error(`aptosCctp: ${name} must be a u32 (got ${v})`);
  }
  return n;
}
function assertAddr(v, name) {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) {
    throw new Error(`aptosCctp: ${name} must be a hex address (got ${v})`);
  }
  return v;
}

/**
 * The documented Aptos BURN sequence, as a pure PLAN. `deposit_for_burn`
 * returns a hot-potato BurnReceipt + the FungibleAsset change; `handler::burn`
 * consumes both. They MUST be one script — see the file header.
 *
 * @returns {{kind:"script", reason:string, calls:Array<object>}}
 */
export function aptosCctpBurnPlan({
  amount,
  destinationDomain,
  mintRecipient,
  destinationCaller = "0x0",
  maxFee = 0,
  minFinalityThreshold = 2000,
  hookData = "0x",
  config = APTOS_CCTP.mainnet,
} = {}) {
  if (amount === undefined || amount === null) throw new Error("aptosCctpBurnPlan: amount is required");
  assertU32(destinationDomain, "destinationDomain");
  assertAddr(mintRecipient, "mintRecipient");
  assertAddr(destinationCaller, "destinationCaller");
  return {
    kind: "script",
    reason: "BurnReceipt is a hot potato — deposit_for_burn and handler::burn must run in one Move script",
    calls: [
      {
        function: aptosDepositForBurnTarget(config),
        signature: APTOS_CCTP_SIGNATURES.depositForBurn,
        args: {
          asset: `${APTOS_USDC} (FungibleAsset, withdrawn from the sender's primary store)`,
          destinationDomain: assertU32(destinationDomain, "destinationDomain"),
          mintRecipient,
          destinationCaller,
          maxFee: String(maxFee),
          minFinalityThreshold: assertU32(minFinalityThreshold, "minFinalityThreshold"),
          hookData,
        },
      },
      {
        function: aptosBurnTarget(config),
        signature: APTOS_CCTP_SIGNATURES.burn,
        args: { burnReceipt: "<return of deposit_for_burn>", asset: "<return of deposit_for_burn>" },
      },
    ],
  };
}

/**
 * The documented Aptos MINT sequence, as a pure PLAN: receive_message → Receipt,
 * prepare_mint(Receipt) → MintReceipt, handler::mint(MintReceipt). One script.
 */
export function aptosCctpMintPlan({
  message = "<Iris message bytes>",
  attestation = "<Iris attestation bytes>",
  config = APTOS_CCTP.mainnet,
} = {}) {
  return {
    kind: "script",
    reason: "Receipt / MintReceipt are hot potatoes — receive_message, prepare_mint and handler::mint must run in one Move script",
    calls: [
      {
        function: aptosReceiveMessageTarget(config),
        signature: APTOS_CCTP_SIGNATURES.receiveMessage,
        args: { message, attestation },
      },
      {
        function: aptosPrepareMintTarget(config),
        signature: APTOS_CCTP_SIGNATURES.prepareMint,
        args: { receipt: "<return of receive_message>" },
      },
      {
        function: aptosMintTarget(config),
        signature: APTOS_CCTP_SIGNATURES.mint,
        args: { mintReceipt: "<return of prepare_mint>" },
      },
    ],
  };
}

/** True when the bytecode looks like real Move script bytecode (starts 0xa1 0x1e... or non-empty bytes). */
export function isAptosScriptBytecode(bytecode) {
  if (bytecode instanceof Uint8Array) return bytecode.length > 0;
  if (typeof bytecode === "string") return /^0x[0-9a-fA-F]+$/.test(bytecode) && bytecode.length > 2;
  return false;
}

/**
 * Wrap Circle's precompiled Move script bytecode into an Aptos ts-sdk
 * `InputScriptData` payload. Fail-closed: no bytecode → throw (we never invent
 * bytecode). This is the payload the wallet bridge signs + submits.
 *
 * @param {{bytecode: Uint8Array|string, typeArguments?: any[], functionArguments?: any[], abi?: object}} p
 */
export function buildAptosCctpScriptPayload({ bytecode, typeArguments = [], functionArguments = [], abi } = {}) {
  if (!isAptosScriptBytecode(bytecode)) {
    throw new Error(
      "buildAptosCctpScriptPayload: a precompiled Move script bytecode (Uint8Array or 0x-hex) is required — " +
      "the hot-potato receipts make a plain multi-entry-function payload impossible (see sdkCctpAptos.js header).",
    );
  }
  const out = { bytecode, typeArguments, functionArguments };
  if (abi) out.abi = abi;
  return out;
}
