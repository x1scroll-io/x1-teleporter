import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEX_FAMILIES, CHAIN_DEXES, DEX_FAMILY_IDS, CHAIN_DEX_KEYS,
  resolveDexFamily, dexFamiliesForChain, verifyDeploymentOnChain,
  MIN_CONTRACT_CODE_LEN,
} from "./dexMap.js";
import { QUOTE_BASES, quoteBasesForChain, enumerateV2Pools, enumerateV3Pools, enumeratePoolsForToken } from "./poolEnumerator.js";
import { normalizePoolPrice, priceV2Pool, priceV3Pool } from "./poolPricer.js";

test("dexMap: the map is GENERAL — chain → families, not per-chain builds", () => {
  assert.ok(DEX_FAMILY_IDS.includes("uniswap-v3"));
  assert.ok(DEX_FAMILY_IDS.includes("uniswap-v2"));
  assert.ok(CHAIN_DEX_KEYS.includes("eth"));
  assert.ok(CHAIN_DEX_KEYS.includes("rh"), "RH is one instance of the same map");
  // every chain's families resolve
  for (const chain of CHAIN_DEX_KEYS) {
    for (const fam of dexFamiliesForChain(chain)) {
      assert.equal(fam.id, resolveDexFamily(fam.id).id);
      assert.ok(["v2", "v3", "v4"].includes(fam.version), `${fam.id} has a version`);
    }
  }
  // unserved chain → empty (honest, not guessed)
  assert.deepEqual(dexFamiliesForChain("zeta"), []);
});

test("dexMap: RH carries the stub-lesson note — canonical ≠ live", () => {
  const rh = DEX_FAMILIES["rh-uniswap-v3"];
  assert.equal(rh.factory, "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA", "RH's OWN factory — not the canonical stub address");
  assert.equal(rh.version, "v3");
  assert.ok(rh.verifiedChains.includes("rh"));
  // the canonical v3 family does NOT claim rh
  assert.ok(!DEX_FAMILIES["uniswap-v3"].verifiedChains.includes("rh"), "canonical v3 is NOT verified on rh (stubs there)");
});

test("dexMap: verifyDeploymentOnChain — the stub detector (unit: fake provider)", async () => {
  // fake provider: canonical-shaped addresses return 4220B (stub), real return 49072B
  const fakeProv = {
    getCode: async (addr) => {
      if (addr === DEX_FAMILIES["rh-uniswap-v3"].factory) return "0x" + "11".repeat(49072 / 2);
      return "0x" + "11".repeat(4220 / 2); // stub-sized
    },
  };
  const stubResult = await verifyDeploymentOnChain(fakeProv, { factory: "0xdead", router: "0xbeef" });
  assert.equal(stubResult.verified, false, "4220B contracts are stubs → not verified");
  const realResult = await verifyDeploymentOnChain(fakeProv, { factory: DEX_FAMILIES["rh-uniswap-v3"].factory });
  assert.equal(realResult.verified, true, "49KB factory is real → verified");
  assert.ok(MIN_CONTRACT_CODE_LEN > 4220, "the floor is above stub size");
});

test("poolEnumerator: quote bases are mapped per chain (RH = WETH + USDG, no USDC)", () => {
  const rh = quoteBasesForChain("rh");
  assert.ok(rh.includes("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"), "RH WETH");
  assert.ok(rh.includes("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"), "RH USDG");
  assert.ok(!rh.some((a) => a.toLowerCase() === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"), "NO Ethereum USDC on RH bases");
  assert.ok(quoteBasesForChain("bsc").some((a) => a.toLowerCase() === "0x55d398326f99059ff775485246999027b3197955"), "BSC bases include USDT");
});

test("poolEnumerator: enumerateV2Pools uses getPair (fake provider)", async () => {
  const { Interface, getAddress } = await import("ethers");
  const token = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const base = getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const PAIR = getAddress("0xcccccccccccccccccccccccccccccccccccccccc");
  const iface = new Interface(["function getPair(address,address) view returns (address)"]);
  let called = false;
  const fakeProv = {
    call: async ({ to, data }) => {
      called = true;
      assert.equal(to, "0xFACTORY");
      return iface.encodeFunctionResult("getPair", [PAIR]);
    },
  };
  const out = await enumerateV2Pools(fakeProv, "0xFACTORY", token, [base], iface);
  assert.ok(called, "getPair was probed");
  assert.equal(out.length, 1);
  assert.equal(out[0].pairAddress, PAIR);
});

test("poolEngine scan shape (pure): enumeratePoolsForToken on an unserved chain is honest-empty", async () => {
  const res = await enumeratePoolsForToken({ prov: {}, chain: "zeta", token: "0xAAAA" });
  assert.equal(res.pools.length, 0);
  assert.ok(res.notes.length >= 0);
});
