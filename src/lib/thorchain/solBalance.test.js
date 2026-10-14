/**
 * solBalance.test.js — the native SOL balance reader (Step 3.1).
 *
 * The reader lazily builds a @solana/web3.js Connection (or uses an injected
 * one) and returns lamports / 1e9. Tests inject a fake Connection and a fake
 * web3 module so no network is touched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSolBalanceReader } from "./solBalance.js";

test("reads the native SOL balance via the injected connection (lamports → SOL)", async () => {
  const calls = [];
  const connection = {
    getBalance: async (address) => {
      calls.push(address);
      return 5_250_000_000; // 5.25 SOL
    },
  };
  const reader = createSolBalanceReader({ connection });
  const bal = await reader("FakeSolanaAddress11111111111111111111111111111111");

  assert.equal(bal, 5.25);
  assert.deepEqual(calls, ["FakeSolanaAddress11111111111111111111111111111111"]);
});

test("builds its own Connection from the injected web3 module when none is given", async () => {
  const fakeWeb3 = {
    Connection: class {
      constructor(url, commitment) {
        this.url = url;
        this.commitment = commitment;
      }
      async getBalance() {
        return 1_000_000;
      }
    },
  };
  const reader = createSolBalanceReader({ rpcUrl: "https://rpc.example", web3: fakeWeb3 });
  const bal = await reader("addr");

  assert.equal(bal, 0.001);
});

test("reuses ONE connection across calls (created lazily on first read)", async () => {
  let instances = 0;
  const fakeWeb3 = {
    Connection: class {
      constructor() {
        instances += 1;
      }
      async getBalance() {
        return 2_000_000;
      }
    },
  };
  const reader = createSolBalanceReader({ web3: fakeWeb3 });
  await reader("a");
  await reader("b");
  await reader("c");
  assert.equal(instances, 1, "connection created once and shared");
});

test("propagates balance read failures (the landing watcher surfaces them)", async () => {
  const connection = {
    getBalance: async () => {
      throw new Error("RPC 429");
    },
  };
  const reader = createSolBalanceReader({ connection });
  await assert.rejects(() => reader("addr"), /RPC 429/);
});
