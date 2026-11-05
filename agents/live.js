// Live testnet reads for the board and receipts pages: bookerbob.testnet over public RPC,
// with the dated snapshot (live.json, scripts/live-snapshot.mjs) as the fallback.
// Views only: no keys, no transactions.
const LIVE_RPCS = ["https://rpc.testnet.fastnear.com", "https://test.rpc.fastnear.com"];

async function liveView(account_id, method_name, args) {
  let last;
  for (const rpc of LIVE_RPCS) {
    try {
      const r = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id, method_name, args_base64: btoa(JSON.stringify(args)) } }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      if (j.error || j.result?.error) throw new Error("rpc error");
      return { block: j.result.block_height, value: JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)) || "null") };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/**
 * The snapshot, refreshed from the chain when public RPC answers. Returns
 * { source: "live" | "snapshot", at, block, data }; data has the snapshot's shape.
 */
async function loadLive(snapshotPath = "live.json") {
  let snap = null;
  try {
    const r = await fetch(snapshotPath);
    snap = r.ok ? await r.json() : null;
  } catch {}
  if (!snap) return null;
  try {
    const data = structuredClone(snap);
    const [sc, ms] = await Promise.all([liveView(data.bazaar, "spent_count", {}), liveView(data.bazaar, "merchants", { from_index: 0, limit: 100 })]);
    data.spent_count = sc.value;
    data.merchants = ms.value.map(([account, x]) => ({ account, category: x.category, approved: x.approved }));
    let block = Math.max(sc.block, ms.block);
    for (let i = 0; i < data.purchases.length; i += 6) {
      const part = data.purchases.slice(i, i + 6);
      const st = await Promise.all(part.map((p) => liveView(data.bazaar, "nullifier_status", { nullifier: p.nullifier })));
      st.forEach((s, j) => { part[j].status = s.value; block = Math.max(block, s.block); });
    }
    return { source: "live", at: new Date().toISOString(), block, data };
  } catch {
    return { source: "snapshot", at: snap.taken_at, block: snap.block_height, data: snap };
  }
}

function liveBanner(l) {
  if (!l) return "live.json not found. run node scripts/live-snapshot.mjs";
  const d = l.data;
  const spent = d.purchases.filter((p) => p.status === "Spent").length;
  const when = l.source === "live" ? `live from ${d.bazaar} over public RPC, block ${l.block}` : `public RPC unreachable: the snapshot of ${l.at.slice(0, 16).replace("T", " ")} UTC (block ${l.block})`;
  return `${when}. ${d.spent_count} nullifiers spent on chain; ${spent} of the ${d.purchases.length} purchases listed here settled; ${d.merchants.filter((m) => m.approved).length} approved merchants. dUSDC is a testnet demo token, the facts are synthetic.`;
}
