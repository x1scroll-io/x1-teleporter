// api/withdraw/[chainId].js — build the withdrawal tx for a given chain.
// The server NEVER signs. It returns the tx request; you sign with your fee
// wallet. EVM chains -> sign with FEE_WALLET_EVM; Solana/X1 -> FEE_WALLET_SVM.
import { lifiGet, cors, INTEGRATOR } from "../_lifi.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const chainId = req.query.chainId;
    const { status, data } = await lifiGet(
      `/integrators/${encodeURIComponent(INTEGRATOR)}/withdraw/${encodeURIComponent(chainId)}`
    );
    res.status(status).json(data);
  } catch (err) {
    res.status(502).json({ error: "withdraw_failed", message: String(err.message || err) });
  }
}
