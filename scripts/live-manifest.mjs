// Writes fixtures/live/testnet-manifest.json for `make verify-live` from the demo run's local
// records: public data only (accounts, nullifiers, tx hashes, prices, Shopify order names).
// Seeds, Semaphore secrets and salts stay in KEYS_DIR.
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./demo-tester.mjs";

const c = config(process.env);
const recs = readdirSync(c.testersDir).filter((f) => /^t-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(c.testersDir, f), "utf8")));
const done = recs.filter((r) => r.txs?.settle && r.txs?.replay).sort((a, b) => (a.review?.size ?? 99) - (b.review?.size ?? 99));
const states = readdirSync(c.testersDir).filter((f) => /^reviews-state(-\d+)?\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(c.testersDir, f), "utf8"))).filter((x) => x.publish_tx);
// Public view of a round: senders and txs sorted, so the manifest itself never pairs a rating
// with a buyer (the pairing stays in KEYS_DIR, for make leak's scoring only).
const pub = (st) => ({ round: st.round, ratings: st.sealed.length, senders: st.sealed.map((s) => s.sender).sort(), seal_txs: st.sealed.map((s) => s.tx).sort(), reveal_txs: st.sealed.map((s) => s.reveal_tx).sort(), publish_tx: st.publish_tx, graph_events: st.graph_events });
const rounds = states.sort((a, b) => a.round - b.round).map(pub);
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
  testers: done.map((r) => ({ tester: r.tester, merchant: r.merchant ?? c.merchant, nullifier: r.nullifier, price: String(r.price), cohort_k: r.cohort_k ?? 0, ...(r.sealed ? { sealed: true } : {}), ...(r.prove_me ? { prove_me: r.prove_me } : {}), shopify_order: r.shopify?.name ?? null, txs: r.txs })),
  unfinished: recs.filter((r) => !(r.txs?.settle && r.txs?.replay) && !r.txs?.settle_group && !r.txs?.intent).map((r) => ({ tester: r.tester, reason: r.txs?.verdict ? "stopped before settle (see docs/testnet.md)" : "stopped before the verdict" })),
  fc_key_check: fck ? { tester: fck.tester, add_key_tx: fck.add_key_tx, refusals: fck.results.map((x) => ({ method: x.method, deposit: x.deposit, error: (x.error.match(/InvalidAccessKeyError":(\{[^}]*\}|"[A-Za-z]+")/) ?? [])[1] ?? x.error.slice(0, 80) })) } : null,
  reviews: rounds.at(-1) ?? null,
  review_rounds: rounds,
  standing: prev.standing ?? { input: "fixtures/zk/standing-testnet-input.json" },
  standing_history: prev.standing_history ?? [],
  open_round: prev.open_round ?? null,
  dao: prev.dao ?? null,
  blind_round: prev.blind_round ?? null,
  fee: prev.fee ?? null,
  eval: prev.eval ?? null,
  rep_eval: existsSync("fixtures/live/eval/rep-eval.json") ? (({ set_root, issuer_key, txs, models }) => ({ set_root, issuer_key, txs, models: models.map((m) => ({ subject: m.certificate.subject, bucket: m.certificate.score_bucket, submit_tx: m.submit_tx })) }))(JSON.parse(readFileSync("fixtures/live/eval/rep-eval.json", "utf8"))) : prev.rep_eval ?? null,
  cheat: existsSync("fixtures/live/cheat/run.json") ? JSON.parse(readFileSync("fixtures/live/cheat/run.json", "utf8")) : prev.cheat ?? null,
  gate: existsSync("fixtures/live/gate/run.json") ? JSON.parse(readFileSync("fixtures/live/gate/run.json", "utf8")) : prev.gate ?? null,
  group_dao: (() => {
    const f = join(c.testersDir, "group-dao-state.json");
    if (!existsSync(f)) return prev.group_dao ?? null;
    const g = JSON.parse(readFileSync(f, "utf8"));
    if (!g.result?.released) return prev.group_dao ?? null;
    return { dao: g.dao, group: g.group, offer: { merchant: g.offer[0], bps: g.offer[1], price: g.offer[2] }, dropout: g.dropout, members: g.members.map((m) => ({ tester: m.tester, nullifier: m.nullifier, intent: m.txs.intent, pledge: m.txs.pledge })), txs: g.txs };
  })(),
  groups: (() => {
    const f = join(c.testersDir, "group-state.json");
    if (!existsSync(f)) return prev.groups ?? [];
    const g = JSON.parse(readFileSync(f, "utf8"));
    return [{ group: g.group, offer_tx: g.offer_tx, offer: g.offer, members: g.members.map((x) => ({ tester: x.tester, nullifier: x.nullifier, receipt_price: String(x.receipt_price), paid: String(x.paid), txs: { intent: x.txs.intent, settle_group: x.txs.settle_group, verdict: x.txs.verdict } })) }];
  })(),
};
writeFileSync("fixtures/live/testnet-manifest.json", JSON.stringify(m, null, 2) + "\n");
console.log(`manifest: ${m.testers.length} testers, reviews ${m.reviews ? m.reviews.ratings : "not published yet"}`);
