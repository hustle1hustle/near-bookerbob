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
//   L10 price decode  a settled amount, read against the public schedule, names the bits
//   L9 committed keys every 32-byte value in the repo tried on every sealed model field
// Prints each link with the anonymity set it leaves, and writes docs/leak-report.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const RPC = process.env.NEAR_RPC || "https://test.rpc.fastnear.com";
const m = JSON.parse(readFileSync(new URL("../fixtures/live/testnet-manifest.json", import.meta.url)));

async function rpc(method, params) {
  for (let i = 0; i < 8; i++) {
    const url = i % 2 ? "https://archival-rpc.testnet.fastnear.com" : RPC;
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "leak", method, params }) });
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

// LEAK_ROUND picks a released round (default: the latest).
const round = process.env.LEAK_ROUND ? (m.review_rounds ?? []).find((r) => String(r.round) === process.env.LEAK_ROUND) : m.reviews;
if (!round) {
  console.error("no published reviews in the manifest yet");
  process.exit(2);
}
const buyers = m.testers;
const joins = await Promise.all(buyers.map(async (b) => ({ buyer: b.tester, ...(await tx(b.txs.review_join, m.treasury)) })));
const seals = await Promise.all(round.seal_txs.map(async (h) => {
  const t = (await rpc("tx", { tx_hash: h, sender_account_id: m.treasury, wait_until: "FINAL" })).result;
  return { sender: t.transaction.receiver_id, signer: t.transaction.signer_id, height: await height(t.transaction_outcome.block_hash) };
}));
const links = [];

// L1: every purchase call of one buyer is one actor.
for (const b of buyers) {
  const actors = new Set((await Promise.all(["verdict", "settle", "review_join"].map((k) => tx(b.txs[k], m.treasury)))).map((t) => t.actor));
  links.push({ rule: "L1 same account", what: `${b.tester.split(".")[0]}: verdict, settle and review-group join`, linked: actors.size === 1, anonymity_set: actors.size === 1 ? 1 : actors.size });
}

// L2: order of sealed ratings vs order of joins.
const joinOrder = [...joins].sort((a, b) => a.height - b.height).map((j) => j.buyer);
const sealOrder = [...seals].sort((a, b) => a.height - b.height).map((s) => s.sender);
// The adversary's guess: the k-th rating is the k-th joiner's. The truth (which tester wrote
// which rating) is never public: it is read from the demo's local state in KEYS_DIR, only to
// score the guess. Rounds before the fix sent rating i for member i, in member order.
const keys = process.env.KEYS_DIR || join(homedir(), ".rep-secrets", "bookerbob-testnet");
const local = [join(keys, "testers", `reviews-state-${round.round}.json`), join(keys, "testers", "reviews-state.json")].map((p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null)).find((x) => x?.round === round.round);
if (!local) throw new Error(`no local truth for round ${round.round} in ${keys}: the score needs the demo operator's state`);
const truth = new Map(local.sealed.map((s) => [s.sender, s.tester]));
let correct = 0;
sealOrder.forEach((s, k) => { if (truth.get(s) === joinOrder[k]) correct++; });
links.push({ rule: "L2 timing order", what: "each sealed rating to the buyer who joined in the same position", linked: correct === sealOrder.length, correct, of: sealOrder.length, anonymity_set: correct === sealOrder.length ? 1 : Math.max(1, sealOrder.length - correct) });

// L3: funding. Review senders are funded by the relayer that also pays for the buyers.
const funders = new Set(seals.map((s) => s.signer));
links.push({ rule: "L3 funding", what: "review senders and buyers share one funder (the relayer)", linked: false, note: `${funders.size} funder(s); that alone narrows a rating to the relayer's buyers, ${buyers.length} here`, anonymity_set: buyers.length });

// L4: reveal ties a rating to its sealed hash and sender (by design; the sender is one-time).
links.push({ rule: "L4 reveal", what: "a revealed rating to its one-time sender", linked: true, note: "by design: the sender is fresh, so this only matters combined with L2", anonymity_set: 1 });

// L5: plaintext facts in tx args. Every recorded tester tx (and the delegate actions inside
// it) is decoded and searched for the proof set's field names and proof refs. The referee
// input must travel sealed (request_referee refuses plaintext); the receipt and the verdict
// carry predicates, hashes and prices, never a fact.
const facts = JSON.parse(readFileSync(new URL("../fixtures/proofs.json", import.meta.url))).facts;
const needles = [...new Set(facts.flatMap((f) => [`"${f.field}"`, f.proof_ref]))];
const argsOf = (actions) => (actions ?? []).flatMap((a) => {
  if (a.FunctionCall) return [Buffer.from(a.FunctionCall.args, "base64").toString("utf8")];
  if (a.Delegate) return argsOf(a.Delegate.delegate_action.actions.map((x) => x.NonDelegateAction ?? x));
  return [];
});
// The rule must be able to fire: a plaintext referee input (what request_referee now refuses)
// is caught.
const probe = argsOf([{ FunctionCall: { args: Buffer.from(JSON.stringify({ proofs: { facts } })).toString("base64") } }]);
if (!probe.some((a) => needles.some((n) => a.includes(n)))) throw new Error("L5 cannot detect a plaintext fact: rule broken");
const hashes = buyers.flatMap((b) => Object.values(b.txs));
let scanned = 0;
const hits = [];
for (const h of hashes) {
  const r = (await rpc("tx", { tx_hash: h, sender_account_id: m.treasury, wait_until: "FINAL" })).result;
  if (!r) continue;
  scanned++;
  for (const a of argsOf(r.transaction.actions)) for (const n of needles) if (a.includes(n)) hits.push({ tx: h, needle: n.slice(0, 20) });
}
links.push({ rule: "L5 plaintext facts", what: `the proof set's fields and proof refs in the args of ${scanned} tester txs`, linked: hits.length > 0, note: hits.length ? `found in ${hits.length} places: ${hits.slice(0, 3).map((x) => x.tx.slice(0, 8)).join(", ")}` : "none: facts never left the buyer side in tx args", anonymity_set: hits.length ? 1 : buyers.length });

// L5b: plaintext predicates for a sealed verdict. Its verdict tx must name no predicate and
// no tier; the chain holds the disclosure commitment instead.
const PRED = /"(airbnb_frequent|claude_spender|world_id_human|steam_[a-z_]+|chatgpt_[a-z_]+)"|"tier":"(bronze|silver|gold)"/;
if (!PRED.test(JSON.stringify({ predicates: ["claude_spender"] }))) throw new Error("L5b cannot detect a plaintext predicate: rule broken");
const sealedBuyers = buyers.filter((b) => b.sealed);
if (sealedBuyers.length) {
  const named = [];
  for (const b of sealedBuyers) {
    const r = (await rpc("tx", { tx_hash: b.txs.verdict, sender_account_id: m.treasury, wait_until: "FINAL" })).result;
    if (!r || argsOf(r.transaction.actions).some((a) => PRED.test(a))) named.push(b.tester);
  }
  links.push({ rule: "L5b sealed predicates", what: `predicate names or tier in the verdict tx of ${sealedBuyers.length} sealed buyer(s)`, linked: named.length > 0, note: named.length ? `named in ${named.join(", ")}` : "none: hashes only (the disclosure commitment)", anonymity_set: named.length ? 1 : buyers.length });
}

// L6: the amount oracle. A settled amount is public; an exact price can reveal which
// discount lines (and so which predicates) a buyer had. Anonymity set per buyer: the buyers
// who paid the same amount, over every purchase (single, buying group, group DAO treasury).
// L7: the funding set. Who funded a buyer's account is public: a subaccount of the treasury
// can only have been created by it; an implicit account is funded by the transfer we recorded.
//
// The k-gate: every amount set and every funding set must hold at least K buyers. Purchases
// settled before the gate (fixtures/live/leak-before-gate.json, frozen) are printed as KNOWN,
// never hidden; any other purchase under K fails `make leak`. A purchase whose amount would sit
// under K settles through a buying group on a fixed tier instead (the tier grid: 10%, 20%).
const K = 5;
const { purchases } = await import("./live-snapshot.mjs");
const rows = purchases(m).filter((r) => r.kind !== "refunded");
const byAmount = new Map();
for (const r of rows) byAmount.set(r.paid, (byAmount.get(r.paid) ?? 0) + 1);
const funderOf = async (r) => {
  if (r.tester.endsWith(`.${m.treasury}`)) return m.treasury;
  const t = m.testers.find((x) => x.tester === r.tester);
  return t?.txs?.account ? (await tx(t.txs.account, m.treasury)).signer : "unknown";
};
const byFunder = new Map();
for (const r of rows) {
  r.funder = await funderOf(r);
  byFunder.set(r.funder, (byFunder.get(r.funder) ?? 0) + 1);
}
const gate = JSON.parse(readFileSync(new URL("../fixtures/live/leak-before-gate.json", import.meta.url)));
const known = new Set(gate.known.map((x) => x.nullifier));
const under = rows.flatMap((r) => [
  ...(byAmount.get(r.paid) < K ? [{ r, what: `amount ${Number(r.paid) / 1e6} paid by ${byAmount.get(r.paid)}` }] : []),
  ...(byFunder.get(r.funder) < K ? [{ r, what: `funder ${r.funder} funded ${byFunder.get(r.funder)}` }] : []),
]);
const newUnder = under.filter((u) => !known.has(u.r.nullifier));
const minAmount = Math.min(...[...byAmount.values()]);
links.push({ rule: "L6 amount oracle", what: `settled amounts of ${rows.length} buyers: ${[...byAmount].sort((x, y) => y[1] - x[1]).map(([a, n]) => `${Number(a) / 1e6} x${n}`).join(", ")}`, linked: minAmount < K, note: `smallest set sharing an amount ${minAmount}; under ${K}: ${under.filter((u) => u.what.startsWith("amount")).length} buyer(s), all settled before the gate: ${newUnder.length === 0}`, anonymity_set: minAmount });
const minFunder = Math.min(...[...byFunder.values()]);
links.push({ rule: "L7 funding set", what: `who funded each of ${rows.length} buyer accounts: ${[...byFunder].map(([f, n]) => `${f.length > 30 ? f.slice(0, 12) + ".." : f} x${n}`).join(", ")}`, linked: minFunder < K, anonymity_set: minFunder });

// L8: the account name. A subaccount of the treasury says whose it is in its name; a one-time
// implicit account is the hex of a fresh key. Accounts reused across purchases count too (L1
// covers one purchase; this covers two purchases by one account). Funding is L7: an implicit
// account is still funded by the treasury today, so the name goes and the funding set stays.
const beforeImplicit = JSON.parse(readFileSync(new URL("../fixtures/live/leak-before-implicit.json", import.meta.url)));
const knownNamed = new Set(beforeImplicit.known);
const named = rows.filter((r) => r.tester.endsWith(`.${m.treasury}`));
const newNamed = named.filter((r) => !knownNamed.has(r.tester));
const reused = rows.length - new Set(rows.map((r) => r.tester)).size;
links.push({ rule: "L8 account name", what: `${rows.length} buyers: ${named.length} named under ${m.treasury}, ${rows.length - named.length} one-time implicit; ${reused} account(s) used twice`, linked: newNamed.length > 0 || reused > 0, note: `${knownNamed.size} named before implicit became the default (${beforeImplicit.date}), listed in fixtures/live/leak-before-implicit.json; ${newNamed.length} since`, anonymity_set: rows.length - named.length });

// L10: the price decodes. The schedule is public and the amount is public, so a sealed verdict
// hides its predicates only as far as other bit sets give the same amount. Reported, not gated:
// every purchase settled so far decodes, and the k-gate (L6) counts buyers, not bits.
const { decodeAmount } = await import("./leak-decode.mjs");
const schedules = new Map(JSON.parse(readFileSync(new URL("../agents/merchants.json", import.meta.url))).map((x) => [x.account, x.schedule]));
const seenAmounts = new Set();
const decoded = rows.flatMap((r) => {
  const s = schedules.get(r.merchant);
  const id = `${r.merchant} ${r.paid}`;
  if (!s || seenAmounts.has(id) || !["single", "sealed", "hotel"].includes(r.kind)) return [];
  seenAmounts.add(id);
  return [{ merchant: r.merchant.split(".")[0], amount: Number(r.paid) / 1e6, kind: r.kind, ...decodeAmount(s, r.paid) }];
});
for (const d of decoded) links.push({ rule: "L10 price decode", what: `${d.amount} at ${d.merchant} (${d.kind}): ${d.sets.length} of ${d.of} bit sets give this amount: ${d.sets.map((x) => `{${x.join(", ") || "none"}}`).join(" or ")}`, linked: d.sets.length === 1, anonymity_set: d.sets.length });

// L9: a key in this repo that opens more than the one field a buyer disclosed.
const { l9, report } = await import("./leak-keys.mjs");
const keyScan = await l9(rpc, m.treasury);
links.push({ rule: "L9 committed keys", what: `${keyScan.keys} values on ${keyScan.checked} sealed fields of ${keyScan.model} model txs and 1 capture`, linked: keyScan.fresh.length + keyScan.freshExtra.length > 0, note: `${keyScan.exposures.length} field(s) opened by keys since removed, all synthetic facts, fixtures/live/leak-exposed.json; ${keyScan.fresh.length} open today`, anonymity_set: keyScan.fresh.length ? 1 : buyers.length });

const ratingToBuyer = links.find((l) => l.rule.startsWith("L2")).linked;
console.log(`make leak: ${m.bazaar}, ${buyers.length} buyers, ${seals.length} sealed ratings (round ${round.round})\n`);
for (const l of links) console.log(`${l.linked ? "LINKED  " : "unlinked"}  ${l.rule.padEnd(16)} ${l.what}  (anonymity set ${l.anonymity_set}${l.correct !== undefined ? `, ${l.correct}/${l.of} right` : ""}${l.note ? `; ${l.note}` : ""})`);
console.log(`\nverdict: ${ratingToBuyer ? "LEAK  a passive observer links every rating to the buyer who wrote it, by order alone" : "ratings are not linked to buyers by order"}`);
console.log(`\nk-gate (k >= ${K} for every amount and funding set):`);
for (const u of under) console.log(`${known.has(u.r.nullifier) ? "KNOWN " : "FAIL  "}  ${u.r.kind} ${u.r.tester.slice(0, 18)}: ${u.what}${known.has(u.r.nullifier) ? `  (before the gate: ${gate.known.find((x) => x.nullifier === u.r.nullifier).reason})` : ""}`);
console.log(newUnder.length ? `FAIL  k-gate: ${newUnder.length} purchase(s) after the gate sit in a set under ${K}` : `PASS  k-gate: no purchase after the gate (${gate.date}) sits in a set under ${K}; ${under.length} known one(s) before it, listed above`);
writeFileSync(new URL(`../docs/leak-report-${round.round}.json`, import.meta.url), JSON.stringify({ when: new Date().toISOString(), bazaar: m.bazaar, round: round.round, links, rating_to_buyer_linked: ratingToBuyer, k_gate: { k: K, pass: newUnder.length === 0, known: under.filter((u) => known.has(u.r.nullifier)).map((u) => ({ nullifier: u.r.nullifier, what: u.what })) } }, null, 2) + "\n");
console.log(`${newNamed.length ? "FAIL " : "PASS "} account names: ${newNamed.length} new named buyer(s) since ${beforeImplicit.date}, ${reused} reused`);
for (const l of report(keyScan)) console.log(l);
if (newUnder.length || newNamed.length || reused || keyScan.fresh.length || keyScan.freshExtra.length) process.exit(1);
