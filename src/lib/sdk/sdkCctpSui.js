/**
 * src/teleporter/lib/sdk/sdkCctpSui.js — Circle CCTP **V1 (Legacy)** on SUI
 * (pure Move-call builders).
 *
 * The wallet's EVM CCTP leg lives in sdkCctp.js (EVM calldata) and its Solana
 * leg in sdkCctpSolana.js (Anchor instructions). This module adds the two Sui
 * Move operations for native-USDC burn-and-mint where Sui is one end:
 *
 *   1. Sui → EVM  : TokenMessengerMinter `deposit_for_burn`
 *   2. EVM → Sui  : MessageTransmitter `receive_message` (+ the V1 receipt
 *                   stamping dance — see below)
 *
 * Everything here is PURE and signer-free — each builder mutates a caller-owned
 * `@mysten/sui` `Transaction` (a Programmable Transaction Block) by appending
 * `moveCall` commands. The wallet's own Sui ed25519 key signs + executes it
 * (see src/suiCctp.ts). Passing the Transaction in (rather than importing the
 * SDK) keeps this module dependency-free and lets the test suite drive the REAL
 * SDK builder offline and assert the exact command graph.
 *
 * ── SOURCE OF TRUTH (fetched 2026-09-18; never guessed) ─────────────────────
 *   • Docs   : https://developers.circle.com/cctp/v1/sui-packages
 *   • Guide  : https://developers.circle.com/cctp/v1/transfer-usdc-on-testnet-from-sui-to-ethereum
 *   • Repo   : github.com/circlefin/sui-cctp (branches mainnet / testnet)
 *
 * KEY FACTS this module encodes (all from the docs above):
 *   • Sui CCTP is **V1 only** (domain 8), and Sui is BOTH a source and a
 *     destination. `developers.circle.com/cctp/concepts/supported-chains-and-domains`
 *     lists Sui under "CCTP V1 (Legacy) only".
 *   • Move has no interfaces, so `receive_message()` cannot call the receiver
 *     package directly. Callers must, in the SAME PTB, run:
 *       receive_message → handle_receive_message → deconstruct_… →
 *       stamp_receipt → complete_receive_message
 *     The Receipt / StampedReceipt structs are hot potatoes that MUST be
 *     destroyed in the same transaction or it fails.
 *   • The target is `<package>::<module>::<function>`:
 *       deposit_for_burn      module `deposit_for_burn`      fn `deposit_for_burn`
 *       receive_message       module `receive_message`       fn `receive_message`
 *     (package ids come from Circle; module == fn for the two top-level calls.)
 */

/** Circle's Sui CCTP V1 package ids + shared object ids, per network. */
export const SUI_CCTP = Object.freeze({
  mainnet: Object.freeze({
    tokenMessengerMinterPackage: "0x2aa6c5d56376c371f88a6cc42e852824994993cb9bab8d3e6450cbe3cb32b94e",
    messageTransmitterPackage: "0x08d87d37ba49e785dde270a83f8e979605b03dc552b5548f26fdf2f49bf7ed1b",
    tokenMessengerMinterState: "0x45993eecc0382f37419864992c12faee2238f5cfe22b98ad3bf455baf65c8a2f",
    messageTransmitterState: "0xf68268c3d9b1df3215f2439400c1c4ea08ac4ef4bb7d6f3ca6a2a239e17510af",
    usdcTreasury: "0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7",
    denyList: "0x403",
  }),
  testnet: Object.freeze({
    tokenMessengerMinterPackage: "0x31cc14d80c175ae39777c0238f20594c6d4869cfab199f40b69f3319956b8beb",
    messageTransmitterPackage: "0x4931e06dce648b3931f890035bd196920770e913e43e45990b383f6486fdd0a5",
    tokenMessengerMinterState: "0x5252abd1137094ed1db3e0d75bc36abcd287aee4bc310f8e047727ef5682e7c2",
    messageTransmitterState: "0x98234bd0fa9ac12cc0a20a144a22e36d6a32f7e0a97baaeaf9c76cdc6d122d2e",
    usdcTreasury: "0x7170137d4a6431bf83351ac025baf462909bffe2877d87716374fb42b9629ebe",
    denyList: "0x403",
  }),
});

/** Native USDC on Sui — the Move coin type (6 decimals). */
export const SUI_USDC_COIN_TYPE =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

/** DenyList shared object for the stablecoin token T — constant on every network. */
export const SUI_DENY_LIST = "0x403";

// ─────────────────────────────────────────────────────────────── targets

/** `TokenMessengerMinter::deposit_for_burn::deposit_for_burn` (Sui → other). */
export function suiDepositForBurnTarget(cfg = SUI_CCTP.mainnet) {
  return `${cfg.tokenMessengerMinterPackage}::deposit_for_burn::deposit_for_burn`;
}

/** `MessageTransmitter::receive_message::receive_message` (other → Sui, step 1). */
export function suiReceiveMessageTarget(cfg = SUI_CCTP.mainnet) {
  return `${cfg.messageTransmitterPackage}::receive_message::receive_message`;
}

/** `TokenMessengerMinter::handle_receive_message::handle_receive_message` (step 2). */
export function suiHandleReceiveMessageTarget(cfg = SUI_CCTP.mainnet) {
  return `${cfg.tokenMessengerMinterPackage}::handle_receive_message::handle_receive_message`;
}

/** `TokenMessengerMinter::handle_receive_message::deconstruct_stamp_receipt_ticket_with_burn_message` (step 3). */
export function suiDeconstructStampReceiptTicketTarget(cfg = SUI_CCTP.mainnet) {
  return `${cfg.tokenMessengerMinterPackage}::handle_receive_message::deconstruct_stamp_receipt_ticket_with_burn_message`;
}

/** `MessageTransmitter::receive_message::stamp_receipt` (step 4). */
export function suiStampReceiptTarget(cfg = SUI_CCTP.mainnet) {
  return `${cfg.messageTransmitterPackage}::receive_message::stamp_receipt`;
}

/** `MessageTransmitter::receive_message::complete_receive_message` (step 5). */
export function suiCompleteReceiveMessageTarget(cfg = SUI_CCTP.mainnet) {
  return `${cfg.messageTransmitterPackage}::receive_message::complete_receive_message`;
}

/** The authenticator type `stamp_receipt` is parameterised over. */
export function suiMessageTransmitterAuthenticatorType(cfg = SUI_CCTP.mainnet) {
  return `${cfg.tokenMessengerMinterPackage}::message_transmitter_authenticator::MessageTransmitterAuthenticator`;
}

// ─────────────────────────────────────────────────────────── builders

function assertTx(tx, who) {
  if (!tx || typeof tx.moveCall !== "function" || typeof tx.pure !== "function" || typeof tx.object !== "function") {
    throw new Error(`${who}: a @mysten/sui Transaction (Programmable Transaction Block) is required`);
  }
}

/**
 * Append the Sui → EVM burn to a Transaction.
 *
 * Move call (`TokenMessengerMinter::deposit_for_burn::deposit_for_burn`), argument
 * order exactly as Circle's guide:
 *   [ Coin<USDC> (burned in full),
 *     destination_domain: u32,
 *     mint_recipient: address,          // EVM addr → also pass as @0x… address
 *     state: &TokenMessengerMinterState,
 *     message_transmitter_state: &mut MessageTransmitterState,
 *     deny_list: &DenyList (0x403),
 *     treasury: &mut Treasury<USDC> ]
 * typeArguments: [ <ascii USDC coin type> ]
 *
 * The full `amount` is split off `coinObjectId` first, so only that much burns.
 *
 * @param {object} tx @mysten/sui Transaction (mutated)
 * @param {object} p
 * @param {string|object} p.coinObjectId  sender's USDC coin object id (or arg)
 * @param {bigint|number|string} p.amount  base units (USDC = 6 decimals)
 * @param {number} p.destinationDomain  Circle domain of the destination
 * @param {string} p.mintRecipient      32-byte hex address (0x…) on destination
 * @param {string} [p.usdcCoinType]     defaults to SUI_USDC_COIN_TYPE
 * @param {object} [p.config]           defaults to SUI_CCTP.mainnet
 * @returns {{coin: object, result: object, target: string}}
 */
export function buildSuiDepositForBurn(tx, {
  coinObjectId,
  amount,
  destinationDomain,
  mintRecipient,
  usdcCoinType = SUI_USDC_COIN_TYPE,
  config = SUI_CCTP.mainnet,
}) {
  assertTx(tx, "buildSuiDepositForBurn");
  if (amount === undefined || amount === null) throw new Error("buildSuiDepositForBurn: amount is required");
  if (!mintRecipient) throw new Error("buildSuiDepositForBurn: mintRecipient is required");
  if (destinationDomain === undefined || destinationDomain === null) {
    throw new Error("buildSuiDepositForBurn: destinationDomain is required");
  }

  // Split the exact burn amount off the caller's USDC coin.
  const [coin] = tx.splitCoins(coinObjectId, [tx.pure.u64(BigInt(amount))]);

  const target = suiDepositForBurnTarget(config);
  const [result] = tx.moveCall({
    target,
    arguments: [
      coin,                                                  // Coin<USDC>
      tx.pure.u32(destinationDomain >>> 0),                  // destination_domain
      tx.pure.address(mintRecipient),                        // mint_recipient
      tx.object(config.tokenMessengerMinterState),           // state
      tx.object(config.messageTransmitterState),             // message_transmitter_state
      tx.object(config.denyList ?? SUI_DENY_LIST),           // deny_list
      tx.object(config.usdcTreasury),                        // treasury
    ],
    typeArguments: [usdcCoinType],
  });
  return { coin, result, target };
}

/**
 * Append the EVM → Sui mint (the full V1 receipt flow) to a Transaction.
 *
 * Five atomic `moveCall`s, in order (Move has no interfaces, so the receipt is
 * threaded through manually and destroyed before the PTB ends):
 *   1. MessageTransmitter::receive_message::receive_message
 *        [vector<u8> message, vector<u8> attestation, &mut MessageTransmitterState]
 *        → Receipt
 *   2. TokenMessengerMinter::handle_receive_message::handle_receive_message
 *        [Receipt, &TokenMessengerMinterState, &DenyList, &mut Treasury<USDC>]
 *        typeArguments [USDC]  → StampReceiptTicket<BurnMessage>
 *   3. …::deconstruct_stamp_receipt_ticket_with_burn_message
 *        [StampReceiptTicket<BurnMessage>] → StampReceiptTicket
 *   4. MessageTransmitter::receive_message::stamp_receipt
 *        [StampReceiptTicket, &mut MessageTransmitterState]
 *        typeArguments [<pkg>::message_transmitter_authenticator::MessageTransmitterAuthenticator]
 *        → StampedReceipt
 *   5. MessageTransmitter::receive_message::complete_receive_message
 *        [StampedReceipt, &mut MessageTransmitterState]   (destroys the hot potato)
 *
 * @param {object} tx @mysten/sui Transaction (mutated)
 * @param {object} p
 * @param {Uint8Array|number[]} p.message     CCTP message bytes (from Iris)
 * @param {Uint8Array|number[]} p.attestation signed attestation bytes
 * @param {string} [p.usdcCoinType]           defaults to SUI_USDC_COIN_TYPE
 * @param {object} [p.config]                 defaults to SUI_CCTP.mainnet
 * @returns {{target: string}}
 */
export function buildSuiReceiveMessage(tx, {
  message,
  attestation,
  usdcCoinType = SUI_USDC_COIN_TYPE,
  config = SUI_CCTP.mainnet,
}) {
  assertTx(tx, "buildSuiReceiveMessage");
  if (!message) throw new Error("buildSuiReceiveMessage: message is required");
  if (!attestation) throw new Error("buildSuiReceiveMessage: attestation is required");
  const msg = Uint8Array.from(message);
  const att = Uint8Array.from(attestation);

  // 1. receive_message → Receipt
  const [receipt] = tx.moveCall({
    target: suiReceiveMessageTarget(config),
    arguments: [
      tx.pure.vector("u8", msg),
      tx.pure.vector("u8", att),
      tx.object(config.messageTransmitterState),
    ],
  });

  // 2. handle_receive_message → StampReceiptTicket<BurnMessage>
  const [stampTicketWithBurn] = tx.moveCall({
    target: suiHandleReceiveMessageTarget(config),
    arguments: [
      receipt,
      tx.object(config.tokenMessengerMinterState),
      tx.object(config.denyList ?? SUI_DENY_LIST),
      tx.object(config.usdcTreasury),
    ],
    typeArguments: [usdcCoinType],
  });

  // 3. deconstruct_stamp_receipt_ticket_with_burn_message → StampReceiptTicket
  const [stampTicket] = tx.moveCall({
    target: suiDeconstructStampReceiptTicketTarget(config),
    arguments: [stampTicketWithBurn],
  });

  // 4. stamp_receipt → StampedReceipt
  const [stampedReceipt] = tx.moveCall({
    target: suiStampReceiptTarget(config),
    arguments: [stampTicket, tx.object(config.messageTransmitterState)],
    typeArguments: [suiMessageTransmitterAuthenticatorType(config)],
  });

  // 5. complete_receive_message — consumes/destroys the hot potato.
  tx.moveCall({
    target: suiCompleteReceiveMessageTarget(config),
    arguments: [stampedReceipt, tx.object(config.messageTransmitterState)],
  });

  return { target: suiReceiveMessageTarget(config) };
}
