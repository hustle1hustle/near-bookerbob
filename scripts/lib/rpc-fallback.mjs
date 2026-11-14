// Keyless reads for the verify CLIs: the regular public RPC first (recent txs), then the public
// archive (older ones), with a short backoff on HTTP 429 and network errors. Both are fastnear's
// public endpoints unless NEAR_RPC / NEAR_ARCHIVAL_RPC name others.
import { rpcClient } from "../../relayer/near.mjs";

export function readers(net = "testnet") {
  const urls = net === "mainnet"
    ? [process.env.NEAR_MAINNET_RPC || "https://rpc.mainnet.fastnear.com", process.env.NEAR_MAINNET_ARCHIVAL_RPC || "https://archival-rpc.mainnet.fastnear.com"]
    : [process.env.NEAR_RPC || "https://test.rpc.fastnear.com", process.env.NEAR_ARCHIVAL_RPC || "https://archival-rpc.testnet.fastnear.com"];
  const clients = urls.map((u) => rpcClient(u));
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const tryAll = async (f) => {
    let last;
    for (const c of clients) {
      for (let i = 0; i < 4; i++) {
        try {
          const v = await f(c);
          if (v !== undefined) return v;
          break;
        } catch (e) {
          last = e;
          if (!/429|Too Many|fetch failed|ETIMEDOUT|ECONNRESET|socket hang up|timed out/i.test(String(e?.message ?? e))) break;
          await wait(1500 * (i + 1));
        }
      }
    }
    if (last) throw last;
    return undefined;
  };
  return {
    view: (a, m, x) => tryAll((c) => c.view(a, m, x)),
    raw: (h, s) => tryAll(async (c) => (await c.rpc("tx", { tx_hash: h, sender_account_id: s, wait_until: "FINAL" })).result),
  };
}
