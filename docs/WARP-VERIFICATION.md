WARP VERIFICATION — 2026-09-13 (solana: api.mainnet-beta.solana.com, x1: rpc.mainnet.x1.xyz)

PROGRAM  6JbPTuxVuoTgyQeXFb9MH8C8nUY8NBbLP1Lu4B13JfMD
  Solana: EXISTS, owner=BPFLoaderUpgradeable, executable=true
  X1:     EXISTS
STATE (Solana)
  config 48Po6qAHRJojbXH7KRqt6s5GfNfs9VEGccfqYEHmubEi  EXISTS len=321
  guardian_set 837ujVePfx3EB5CibC4FAAZJf5CTpiVXCE41BNBJoB3x EXISTS len=335
  evt_out(seed=["evt_out", u64LE(72058023433695936)]) CJzYaKwYn9vQDXgqp1NWNT968LTjctC5xAGi9UwLgLmr EXISTS len=106
    -> the PDA derivation implemented in src/warpBridge.js matches a REAL on-chain account
STATE (X1)
  evt_in(seq) 2fd3VeLDtrgvfJAVCdKWE81DyQXKhMA13naS31Z6LTqo EXISTS len=116
    -> bridge_in landed on X1 for that seq => USDC.x mint completion DID occur
  config / guardian_set: EXISTS
GROUND-TRUTH TX 5EwuE3rr4exxnzaVNLzfZ9kUbrqWmz43Bj6bWgWE6Qy9trLVAkz7sQF12BkBzXVsBAtLw7LEMjVQkrETGcq3nSPU
  slot 429395775 | meta.err = null | invokes Warp program
  logs: "Instruction: BridgeOut" / "Bridge out initiated"
  token post-balances: TiPy76vi (fee wallet) 1.73 USDC | C6byAvMf (vault) 73126.262893 | user 24.009986

VERDICT: PROVEN for program existence, outgoing-PDA correctness, and historical completion.
RESIDUAL: the `seq` SOURCE (fetchSeq placeholder offset) is not yet validated -> must be confirmed
by simulation before any live send. Already structurally fenced: simulate-before-send guard in
runStage2 + WARP_LIVE_SEND armed ONLY on branch `v2` (compiles false on main and everywhere else).
