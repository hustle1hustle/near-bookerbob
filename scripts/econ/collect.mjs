// Collect every public event of the BookerBob testnet economy into a snapshot.
//   node scripts/econ/collect.mjs [out.json]
import { writeFileSync, mkdirSync } from "node:fs";
import { accountTxs, fetchTxs } from "./source.mjs";
import { WATCH, eventsOfTx } from "./format.mjs";

const out = process.argv[2] || "fixtures/live/econ/txs.json";
const cache = process.env.ECON_CACHE || ".econ-cache/txs.json";
const all = new Map();
for (const a of WATCH.discover) {
  const ts = await accountTxs(a);
  console.log(`   ${a}: ${ts.length} txs`);
  for (const t of ts) if (t.is_success !== false) all.set(t.transaction_hash, t);
}
const hashes = [...all.keys()];
const txs = await fetchTxs(hashes, cache);
const keep = {};
let n = 0;
for (const h of hashes) {
  const t = txs[h];
  if (!t) throw new Error(`indexer has no body for ${h}`);
  const ev = eventsOfTx(t);
  if (ev.length) {
    keep[h] = t;
    n += ev.length;
  }
}
mkdirSync("fixtures/live/econ", { recursive: true });
writeFileSync(out, JSON.stringify({ note: "Every tx of the watched contracts that carries an economy event, as read from FastNear's public tx indexer. Public data. docs/anchor-format.md", txs: keep }, null, 0));
console.log(`   ${Object.keys(keep).length} txs with ${n} events of ${hashes.length} touched -> ${out}`);
