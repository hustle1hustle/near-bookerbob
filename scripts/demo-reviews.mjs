// Sealed reviews for the demo testers' purchases (docs/demo-mode.md):
//   seal     each tester who joined m01's group rates it with a Semaphore proof, sent from a
//            fresh one-time implicit account through the relayer (review policy): the sender
//            is not the buyer
//   reveal   after the round closes: open each sealed rating (refused below k = 5)
//   publish  after the reveal window: release the round's ratings together; the contract
//            pushes the Seed graph event that standing flows from
// Round length on the demo bazaar: review_round_ms (set_review_round_ms, testnet only).
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check as checkReview } from "../relayer/relay.mjs";
import { delegateFor, keyFromSeed, near } from "../relayer/near.mjs";

const TGAS = 10n ** 12n;
const MILLI = 10n ** 21n;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const RATINGS = [
  [5, true, "arrived in two days, as described"],
  [4, true, "good, a little late"],
  [5, true, "exactly the hoodie on the page"],
  [3, true, "ok"],
  [4, true, "fine"],
  [5, true, "would buy again"],
];
const fc = (method_name, args, deposit = 0n, gas = 100n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });

export function members(d) {
  const recs = readdirSync(d.c.testersDir).filter((f) => f.endsWith(".json")).map((f) => ({ file: join(d.c.testersDir, f), ...JSON.parse(readFileSync(join(d.c.testersDir, f), "utf8")) }));
  return recs.filter((r) => r.review?.commitment && r.review?.size).sort((a, b) => a.review.size - b.review.size);
}

export async function reviews(d, phase) {
  const c = d.c;
  d.treasury = keyFromSeed(readFileSync(join(c.keysDir, "treasury.seed"), "utf8"));
  const ms = members(d);
  const g = await d.client.view(c.bazaar, "review_group", { merchant: c.merchant });
  const roundMs = await d.client.view(c.bazaar, "review_round_ms");
  const now = await d.client.view(c.bazaar, "review_round_now");
  console.log(`${c.merchant}: ${g?.tree?.size ?? 0} members on chain, ${ms.length} demo testers joined, round ${now} (${roundMs / 60000} min rounds)`);
  const state = join(c.testersDir, "reviews-state.json");
  const st = (() => { try { return JSON.parse(readFileSync(state, "utf8")); } catch { return { sealed: [] }; } })();
  const save = () => writeFileSync(state, JSON.stringify(st, null, 2) + "\n", { mode: 0o600 });

  if (phase === "seal") {
    const all = ms.map((m) => m.review.commitment);
    if (all.length !== (g?.tree?.size ?? 0)) throw new Error(`the group has ${g?.tree?.size} members, ${all.length} known locally: proofs need the full member list`);
    st.round = now;
    st.sealed = [];
    for (const [i, m] of ms.entries()) {
      const [rating, delivered, reason] = RATINGS[i % RATINGS.length];
      const r = { rating, delivered, reason_hash: sha(reason), salt: randomBytes(32).toString("hex") };
      const sealed = sha(JSON.stringify([r.rating, r.delivered, r.reason_hash, r.salt]));
      const secret = readFileSync(join(c.testersDir, m.tester, "semaphore.secret"), "utf8").trim();
      const q = { secret, members: all, message_hex: sealed, scope_hex: sha(`bookerbob/review/v0|${c.merchant}|${now}`) };
      const out = spawnSync("node", ["identity.mjs", "prove"], { cwd: "semaphore", input: JSON.stringify(q), encoding: "utf8" });
      if (out.status !== 0) throw new Error(`proof: ${out.stderr.slice(-300)}`);
      const proof = JSON.parse(out.stdout);
      if (!g.recent_roots.includes(proof.root_js)) throw new Error("the local group root is not one of the contract's recent roots");
      delete proof.root_js;
      // A fresh one-time implicit account (its own key), funded by the relayer: no transfer
      // from the buyer, so the rating is not linked to the tester's account.
      const seed = randomBytes(32).toString("hex");
      const k = keyFromSeed(seed);
      console.log(`${i + 1}. ${m.tester} rates ${rating}/5 from one-time account ${k.pub.slice(0, 12)}..`);
      await d.direct("fund one-time account", c.treasury, d.treasury, k.pub, [{ type: "Transfer", deposit: near(0.02) }]);
      const signed = await delegateFor(d.client, { sender_id: k.pub, key: k, receiver_id: c.bazaar, actions: [fc("submit_review", { merchant: c.merchant, sealed, proof }, 10n * MILLI, 150n * TGAS)] });
      const h = await d.client.block();
      const ok = checkReview(signed, { bazaar: c.bazaar, block_height: h.height, max_deposit: String(50n * MILLI) });
      if (!ok.ok) throw new Error(`relayer refused submit_review: ${ok.reason}`);
      const tx = await d.direct("submit_review (relayed)", c.treasury, d.treasury, k.pub, [{ type: "Delegate", ...signed }]);
      st.sealed.push({ tester: m.tester, sender: k.pub, sealed, ...r, tx: tx.hash });
      save();
    }
    console.log(`\nsealed ${st.sealed.length} ratings in round ${now}. Reveal after round ${now} closes (${new Date((now + 1) * roundMs).toISOString()}).`);
  } else if (phase === "reveal") {
    if (now <= st.round) throw new Error(`round ${st.round} still open until ${new Date((st.round + 1) * roundMs).toISOString()}`);
    for (const r of st.sealed) {
      if (r.reveal_tx) continue;
      const tx = await d.direct(`reveal ${r.rating}/5`, c.treasury, d.treasury, c.bazaar, [fc("reveal_review", { merchant: c.merchant, round: st.round, rating: r.rating, delivered: r.delivered, reason_hash: r.reason_hash, salt: r.salt }, 10n * MILLI)]);
      r.reveal_tx = tx.hash;
      save();
    }
    console.log(`\nrevealed. Publish after ${new Date((st.round + 2) * roundMs).toISOString()}.`);
  } else if (phase === "publish") {
    if (now <= st.round + 1) throw new Error(`reveal window open until ${new Date((st.round + 2) * roundMs).toISOString()}`);
    const tx = await d.direct("publish_reviews", c.treasury, d.treasury, c.bazaar, [fc("publish_reviews", { merchant: c.merchant, round: st.round }, 10n * MILLI)]);
    st.publish_tx = tx.hash;
    st.graph_events = tx.logs.filter((l) => l.includes('"event":"graph_event"')).map((l) => JSON.parse(l.slice(11)).data[0]);
    save();
    const s = await d.client.view(c.bazaar, "merchant_score", { merchant: c.merchant });
    console.log(`\nreleased: ${s.ratings} ratings, mean ${s.mean_x100 / 100}, score ${s.score_x100 / 100}; seed graph event ${st.graph_events.map((e) => e.event.slice(0, 16)).join(", ")}..`);
  } else throw new Error("reviews seal|reveal|publish");
}
