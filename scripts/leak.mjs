#!/usr/bin/env node
// `make leak`: what a passive observer of public testnet data can link, from the txs in
// fixtures/live/testnet-manifest.json. No keys; only what anyone reading the chain sees:
// signers, receivers, args, events, block heights, who funded whom.
//
// Adversary rules (each one a public signal):
//   L1 same account   calls signed or delegated by one account belong to one actor
//   L2 timing order   the k-th sealed rating follows the k-th review-group join
//   L3 funding        a one-time account funded by the same relayer as the buyers
//   L4 reveal         a revealed rating opens one sealed hash, so it is tied to that sender
// Prints each link with the anonymity set it leaves, and writes docs/leak-report.json.
import { readFileSync, writeFileSync } from "node:fs";

const RPC = process.env.NEAR_RPC || "https://test.rpc.fastnear.com";
const m = JSON.parse(readFileSync(new URL("../fixtures/live/testnet-manifest.json", import.meta.url)));

async function rpc(method, params) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "leak", method, params }) });
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1000 * (i + 1))); continue; }
    return r.json();
  }
  throw new Error("rpc failed");
}
const heights = new Map();
async function height(blockHash) {
  if (!heights.has(blockHash)) heights.set(blockHash, (await rpc("block", { block_id: blockHash })).result.header.height);
  return heights.get(blockHash);
}
async function tx(hash, sender) {
  const r = (await rpc("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" })).result;
  const inner = r.transaction.actions.find((a) => a.Delegate)?.Delegate?.delegate_action;
  return { signer: r.transaction.signer_id, actor: inner?.sender_id ?? r.transaction.signer_id, height: await height(r.transaction_outcome.block_hash) };
}

if (!m.reviews) {
  console.error("no published reviews in the manifest yet");
  process.exit(2);
}
const buyers = m.testers;
const joins = await Promise.all(buyers.map(async (b) => ({ buyer: b.tester, ...(await tx(b.txs.review_join, m.treasury)) })));
const seals = await Promise.all(m.reviews.seal_txs.map(async (h, i) => ({ sender: m.reviews.senders[i], ...(await tx(h, m.treasury)) })));
const links = [];

// L1: every purchase call of one buyer is one actor.
for (const b of buyers) {
  const actors = new Set((await Promise.all(["verdict", "settle", "review_join"].map((k) => tx(b.txs[k], m.treasury)))).map((t) => t.actor));
  links.push({ rule: "L1 same account", what: `${b.tester.split(".")[0]}: verdict, settle and review-group join`, linked: actors.size === 1, anonymity_set: actors.size === 1 ? 1 : actors.size });
}

// L2: order of sealed ratings vs order of joins.
const joinOrder = [...joins].sort((a, b) => a.height - b.height).map((j) => j.buyer);
const sealOrder = [...seals].sort((a, b) => a.height - b.height).map((s) => s.sender);
// The adversary's guess: the k-th rating is the k-th joiner's. We know the truth locally
// only through the manifest's order (seal i was written for tester i in member order).
const truth = new Map(m.reviews.senders.map((s, i) => [s, buyers[i]?.tester]));
let correct = 0;
sealOrder.forEach((s, k) => { if (truth.get(s) === joinOrder[k]) correct++; });
links.push({ rule: "L2 timing order", what: "each sealed rating to the buyer who joined in the same position", linked: correct === sealOrder.length, correct, of: sealOrder.length, anonymity_set: correct === sealOrder.length ? 1 : Math.max(1, sealOrder.length - correct) });

// L3: funding. Review senders are funded by the relayer that also pays for the buyers.
const funders = new Set(seals.map((s) => s.signer));
links.push({ rule: "L3 funding", what: "review senders and buyers share one funder (the relayer)", linked: false, note: `${funders.size} funder(s); that alone narrows a rating to the relayer's buyers, ${buyers.length} here`, anonymity_set: buyers.length });

// L4: reveal ties a rating to its sealed hash and sender (by design; the sender is one-time).
links.push({ rule: "L4 reveal", what: "a revealed rating to its one-time sender", linked: true, note: "by design: the sender is fresh, so this only matters combined with L2", anonymity_set: 1 });

const ratingToBuyer = links.find((l) => l.rule.startsWith("L2")).linked;
console.log(`make leak: ${m.bazaar}, ${buyers.length} buyers, ${seals.length} sealed ratings (round ${m.reviews.round})\n`);
for (const l of links) console.log(`${l.linked ? "LINKED  " : "unlinked"}  ${l.rule.padEnd(16)} ${l.what}  (anonymity set ${l.anonymity_set}${l.correct !== undefined ? `, ${l.correct}/${l.of} right` : ""}${l.note ? `; ${l.note}` : ""})`);
console.log(`\nverdict: ${ratingToBuyer ? "LEAK  a passive observer links every rating to the buyer who wrote it, by order alone" : "ratings are not linked to buyers by order"}`);
writeFileSync(new URL("../docs/leak-report.json", import.meta.url), JSON.stringify({ when: new Date().toISOString(), bazaar: m.bazaar, round: m.reviews.round, links, rating_to_buyer_linked: ratingToBuyer }, null, 2) + "\n");
