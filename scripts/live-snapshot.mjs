#!/usr/bin/env node
// The dated snapshot behind agents/board.html and agents/receipts.html. The pages read
// bookerbob.testnet live over public RPC; when RPC is unreachable they show this file and its
// date instead. Built from fixtures/live/testnet-manifest.json (every testnet purchase) plus
// one view call per nullifier, so the snapshot is what the chain said at `taken_at`.
//
//   node scripts/live-snapshot.mjs          writes agents/live.json
//
// Read-only: views only, no keys, no transactions.
import { readFileSync, writeFileSync } from "node:fs";

export const RPC = process.env.NEAR_RPC ?? "https://rpc.testnet.fastnear.com";

/**
 * Every nullifier the testnet purchases burned, one row per buyer, with the tx that paid (or,
 * for the one refunded pledge, the tx that refunded it). Its length must equal the contract's
 * spent_count; verify-live checks that.
 */
export function purchases(m) {
  const rows = m.testers.map((t) => ({
    kind: t.sealed ? "sealed" : t.merchant.startsWith("h") ? "hotel" : "single",
    tester: t.tester,
    merchant: t.merchant,
    nullifier: t.nullifier,
    paid: t.price,
    tx: t.txs.settle,
  }));
  for (const g of m.groups ?? []) {
    for (const x of g.members) rows.push({ kind: "group", tester: x.tester, merchant: g.offer.merchant, nullifier: x.nullifier, paid: x.paid, tx: x.txs.settle_group });
  }
  const d = m.group_dao;
  if (d) {
    for (const x of d.members) {
      // The dropout's pledge burned its nullifier; the DAO refunded the dUSDC, and the
      // nullifier stays spent (a refund is not a second use of the proof).
      const refunded = x.tester === d.dropout;
      rows.push({ kind: refunded ? "refunded" : "group-dao", tester: x.tester, merchant: d.offer.merchant, nullifier: x.nullifier, paid: refunded ? "0" : d.offer.price, tx: refunded ? d.txs.refund_vote4 : d.txs.release_vote4, dao: d.dao });
    }
  }
  return rows;
}

export async function view(account_id, method_name, args, rpc = RPC) {
  const body = { jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } };
  const r = await (await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })).json();
  if (r.error || r.result?.error) throw new Error(`rpc ${method_name}: ${JSON.stringify(r.error ?? r.result.error).slice(0, 120)}`);
  return { block: r.result.block_height, value: JSON.parse(Buffer.from(r.result.result).toString() || "null") };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = JSON.parse(readFileSync("fixtures/live/testnet-manifest.json", "utf8"));
  const rows = purchases(m);
  let block = 0;
  for (const r of rows) {
    const s = await view(m.bazaar, "nullifier_status", { nullifier: r.nullifier });
    r.status = s.value;
    block = Math.max(block, s.block);
  }
  const sc = await view(m.bazaar, "spent_count", {});
  const ms = await view(m.bazaar, "merchants", { from_index: 0, limit: 100 });
  const out = {
    note: "what bookerbob.testnet said at taken_at; the pages read the chain live and fall back to this file only when public RPC is unreachable. dUSDC is a testnet demo token; the facts behind every verdict are synthetic",
    taken_at: new Date().toISOString(),
    block_height: Math.max(block, sc.block, ms.block),
    bazaar: m.bazaar,
    rpc: RPC,
    spent_count: sc.value,
    merchants: ms.value.map(([account, x]) => ({ account, category: x.category, approved: x.approved })),
    purchases: rows,
  };
  writeFileSync("agents/live.json", JSON.stringify(out, null, 2) + "\n");
  const spent = rows.filter((r) => r.status === "Spent").length;
  console.log(`agents/live.json: ${rows.length} purchases (${spent} spent on chain), spent_count ${sc.value}, ${out.merchants.length} merchants, block ${out.block_height}`);
}
