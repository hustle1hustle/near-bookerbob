// Writes fixtures/live/testnet-manifest.json for `make verify-live` from the demo run's local
// records: public data only (accounts, nullifiers, tx hashes, prices, Shopify order names).
// Seeds, Semaphore secrets and salts stay in KEYS_DIR.
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./demo-tester.mjs";

const c = config(process.env);
const recs = readdirSync(c.testersDir).filter((f) => /^t-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(c.testersDir, f), "utf8")));
const done = recs.filter((r) => r.txs?.settle && r.txs?.replay).sort((a, b) => (a.review?.size ?? 99) - (b.review?.size ?? 99));
const st = existsSync(join(c.testersDir, "reviews-state.json")) ? JSON.parse(readFileSync(join(c.testersDir, "reviews-state.json"), "utf8")) : null;
const prev = existsSync("fixtures/live/testnet-manifest.json") ? JSON.parse(readFileSync("fixtures/live/testnet-manifest.json", "utf8")) : {};
const fck = existsSync("fixtures/live/fc-key-check.json") ? JSON.parse(readFileSync("fixtures/live/fc-key-check.json", "utf8")) : null;
const m = {
  note: "Public testnet facts for make verify-live. dUSDC is a testnet demo token with no value; production uses Circle USDC.",
  bazaar: c.bazaar,
  dusdc: c.dusdc,
  treasury: c.treasury,
  merchant: c.merchant,
  review_round_ms: 300000,
  merchants_approved: 30,
  testers: done.map((r) => ({ tester: r.tester, merchant: c.merchant, nullifier: r.nullifier, price: String(r.price), cohort_k: r.cohort_k ?? 0, shopify_order: r.shopify?.name ?? null, txs: r.txs })),
  unfinished: recs.filter((r) => !(r.txs?.settle && r.txs?.replay)).map((r) => ({ tester: r.tester, reason: r.txs?.verdict ? "stopped before settle (see docs/testnet.md)" : "stopped before the verdict" })),
  fc_key_check: fck ? { tester: fck.tester, add_key_tx: fck.add_key_tx, refusals: fck.results.map((x) => ({ method: x.method, deposit: x.deposit, error: (x.error.match(/InvalidAccessKeyError":(\{[^}]*\}|"[A-Za-z]+")/) ?? [])[1] ?? x.error.slice(0, 80) })) } : null,
  reviews: st?.publish_tx ? { round: st.round, ratings: st.sealed.length, senders: st.sealed.map((s) => s.sender), seal_txs: st.sealed.map((s) => s.tx), reveal_txs: st.sealed.map((s) => s.reveal_tx), publish_tx: st.publish_tx, graph_events: st.graph_events } : null,
  standing: prev.standing ?? { input: "fixtures/zk/standing-testnet-input.json" },
};
writeFileSync("fixtures/live/testnet-manifest.json", JSON.stringify(m, null, 2) + "\n");
console.log(`manifest: ${m.testers.length} testers, reviews ${m.reviews ? m.reviews.ratings : "not published yet"}`);
