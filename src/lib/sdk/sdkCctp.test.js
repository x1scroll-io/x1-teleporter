/**
 * sdkCctp.test.js — the CCTP leg builders: encode/burn/attest/mint, fail-closed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { encodeMintRecipient, buildBurn, buildMint, fetchAttestation, TOKEN_MESSENGER_V2_ABI } from "../sdk/sdkCctp.js";

test("encodeMintRecipient: EVM address -> 32-byte left-padded hex", () => {
  const out = encodeMintRecipient("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "base");
  assert.equal(out.length, 66); // 0x + 64 hex
  assert.match(out, /^0x0{24}a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48$/);
});

test("encodeMintRecipient: rejects a non-20-byte EVM address", () => {
  assert.throws(() => encodeMintRecipient("0xdeadbeef", "base"), /invalid EVM address/);
});

test("buildBurn: returns TokenMessengerV2 + depositForBurn args", () => {
  const b = buildBurn({
    sourceChainKey: "base",
    amountWei: "1000000",
    destinationDomain: 5,
    mintRecipient: "0x" + "0".repeat(24) + "a0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    burnToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  });
  assert.equal(b.to, "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d");
  assert.equal(b.fn, "depositForBurn(uint256,uint32,bytes32,address)");
  assert.equal(b.args[1], 5); // destinationDomain (Solana)
  assert.equal(String(b.args[0]), "1000000");
});

test("buildMint: fails closed when the destination transmitter is not configured", () => {
  // Solana has programs, but MessageTransmitter (EVM field) is what buildMint
  // reads for EVM chains; base's messageTransmitter is null in config.
  assert.throws(() => buildMint({ destChainKey: "base", message: "0x01", attestation: "0x02" }), /not configured/);
});

test("fetchAttestation: returns the message + attestation once 'complete'", async () => {
  const calls = [];
  const fetchImpl = async () => {
    calls.push(1);
    return {
      ok: true,
      json: async () => ({
        messages: [{ status: "complete", message: "0xMSG", attestation: "0xATT" }],
      }),
    };
  };
  const out = await fetchAttestation({ sourceDomain: 6, txHash: "0xabc", pollMs: 1, fetchImpl });
  assert.equal(out.status, "complete");
  assert.equal(out.message, "0xMSG");
  assert.equal(out.attestation, "0xATT");
  assert.equal(calls.length, 1);
});

test("TOKEN_MESSENGER_V2_ABI declares the two burn entry points", () => {
  assert.ok(TOKEN_MESSENGER_V2_ABI.some((s) => s.includes("depositForBurn(")));
  assert.ok(TOKEN_MESSENGER_V2_ABI.some((s) => s.includes("depositForBurnWithCaller(")));
});
