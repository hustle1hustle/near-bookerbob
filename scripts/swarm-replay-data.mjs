#!/usr/bin/env node
// agents/swarm-s1.json: the compact data the landing page replays, from the public record of
// the 96-buyer testnet swarm (fixtures/live/swarm/s1.json) plus, per round, which merchants
// committed and revealed (the bazaar's `round` view over public RPC). Public fields only.
//   node scripts/swarm-replay-data.mjs
import { readFileSync, writeFileSync } from "node:fs";

const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const rec = JSON.parse(readFileSync("fixtures/live/swarm/s1.json", "utf8"));
const short = (a) => a.replace(".bookerbob.testnet", "");
async function view(method, args) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: rec.bazaar, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }) }).then((x) => x.json()).catch(() => null);
    if (r?.result?.result) return JSON.parse(Buffer.from(r.result.result).toString() || "null");
    await new Promise((ok) => setTimeout(ok, 1500 * (i + 1)));
  }
  throw new Error(`${method}: no answer`);
}
const merchants = JSON.parse(readFileSync("agents/merchants.json", "utf8")).map((m) => short(m.account ?? m.id));
const rounds = [];
for (const r of rec.rounds) {
  const cats = [];
  for (const c of r.categories) {
    const info = await view("round", { round_id: c.round_id });
    const commits = (info.commits ?? []).map((x) => short(Array.isArray(x) ? x[0] : (x.merchant ?? x)));
    const revealed = (info.revealed ?? []).map((x) => short(Array.isArray(x) ? x[0] : (x.merchant ?? x)));
    if (commits.length !== c.commits || revealed.length !== c.reveals) throw new Error(`${c.round_id}: chain ${commits.length}/${revealed.length}, record ${c.commits}/${c.reveals}`);
    cats.push({ id: c.round_id, category: c.category, open_tx: c.open_tx, commits, revealed });
  }
  rounds.push({ n: r.n, categories: cats, replay_tx: r.replay?.tx, replay: r.replay?.refused });
}
const purchases = rec.purchases.map((p) => ({ round: p.round, round_id: p.round_id, merchant: short(p.merchant), price: p.price, settle: p.txs.settle, verdict: p.txs.verdict }));
const out = { note: "replay data for the landing page, from fixtures/live/swarm/s1.json and the bazaar's round view; public fields only", source: "fixtures/live/swarm/s1.json", bazaar: rec.bazaar, explorer: rec.explorer ?? "https://testnet.nearblocks.io/txns/", totals: rec.totals, merchants, rounds, purchases };
writeFileSync("agents/swarm-s1.json", JSON.stringify(out) + "\n");
console.log(`agents/swarm-s1.json: ${rounds.length} rounds, ${purchases.length} purchases, ${merchants.length} merchants`);
