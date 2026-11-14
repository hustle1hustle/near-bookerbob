#!/usr/bin/env node
// Who sees what, on the one purchase made over real data: the mainnet purchase where the founder's
// signed-in GitHub proof (TLSNotary) was the proof set (fixtures/mainnet/real-refusal.json). Checked:
// the buyer's facts are absent from every byte on chain, and the gateway request (a testnet capture
// of the same code path) is ciphertext. Listed as rows: the parties that do see more (the TEE, REP's
// evaluator, the referee worker as run here) and this repo, which publishes the buyer's facts and presentation on purpose, with the
// founder's consent, so the run can be re-checked.
//
//   node scripts/who-sees-what.mjs            offline: the committed copy of the chain data
//   node scripts/who-sees-what.mjs --live     re-reads the 6 mainnet txs and requires the copy to match
//   node scripts/who-sees-what.mjs --record   writes the copy (fixtures/mainnet/who-sees-what.json)
//
// Parties: the merchant and any chain observer (every tx's args, logs and return values, the
// bazaar's views); the NEAR AI gateway outside the TEE (the request bytes; the mainnet request is
// not kept, so this row uses the testnet capture, same code path); the referee (its result tx on
// chain). REP's evaluator builds the model's request and reads the facts in the clear: it is listed
// as a party that sees them, and no check pretends otherwise.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rpcClient } from "../relayer/near.mjs";
import { openField } from "./lib/e2ee.mjs";

const REC = "fixtures/mainnet/real-refusal.json";
const COPY = "fixtures/mainnet/who-sees-what.json";
const CAPTURE = "fixtures/live/near-ai/request.json";
const RPC = process.env.NEAR_MAINNET_ARCHIVAL ?? "https://archival-rpc.mainnet.fastnear.com";
const sha = (b) => createHash("sha256").update(b).digest("hex");

/** What the chain shows about one tx: method, args, logs, status. */
function txView(r) {
  const t = r.result.transaction;
  const all = [r.result.transaction_outcome, ...r.result.receipts_outcome];
  return {
    hash: t.hash, signer: t.signer_id, receiver: t.receiver_id,
    actions: t.actions.map((a) => (a.FunctionCall ? { method: a.FunctionCall.method_name, args: Buffer.from(a.FunctionCall.args, "base64").toString() } : { kind: typeof a === "string" ? a : Object.keys(a)[0] })),
    logs: all.flatMap((o) => o.outcome.logs),
    ok: !all.some((o) => o.outcome.status.Failure),
  };
}

async function readChain(rec) {
  const c = rpcClient(RPC);
  const txs = {};
  for (const [name, h] of Object.entries(rec.txs)) {
    const r = await c.rpc("tx", { tx_hash: h, sender_account_id: rec.buyer, wait_until: "FINAL" });
    if (r.error) throw Object.assign(new Error(`${name}: ${JSON.stringify(r.error).slice(0, 200)}`), { answered: true });
    txs[name] = txView(r);
  }
  let verdict;
  try { verdict = await c.view(rec.bazaar, "verdict", { nullifier: rec.nullifier }); } catch (e) {
    // view() throws on an answered RPC error (a missing method, a panic); only "kept failing" is no answer.
    throw Object.assign(e, { answered: !/kept failing|fetch failed/i.test(e.message) });
  }
  return { network: "mainnet", bazaar: rec.bazaar, txs, views: { verdict } };
}

/** The strings that would reveal a fact: each field name, each field name next to its value,
 *  the presentation's sha256 (published, so it would link the purchase to the proof), the login. */
export function factTokens(rec, proofs) {
  const facts = [...proofs.facts, ...rec.facts.map((f, i) => ({ ...f, id: `G${i}` }))];
  const pres = existsSync(rec.presentation) ? sha(readFileSync(rec.presentation)) : null;
  const tokens = new Set();
  for (const f of facts) {
    tokens.add(f.field);
    tokens.add(`"${f.field}":${JSON.stringify(f.value)}`);
    if (f.proof_ref) tokens.add(f.proof_ref);
  }
  if (pres) tokens.add(pres);
  for (const login of ["hustle1hustle", "zeroxcholy"]) tokens.add(login);
  return [...tokens];
}

/** Hex that decodes to mostly printable text is plaintext in disguise. */
export function mostlyText(h) {
  const b = Buffer.from(h, "hex");
  if (!b.length) return false;
  const printable = b.filter((x) => (x >= 32 && x < 127) || x === 10 || x === 13 || x === 9).length;
  return printable / b.length > 0.85;
}

export function scan(text, tokens) {
  const low = text.toLowerCase();
  return tokens.filter((t) => low.includes(String(t).toLowerCase()));
}

const SEARCH = new Map();

/** A listed row states what a party sees; it is not a check. */
export const isListed = ([, party, what]) => /listed/.test(party) || /^(learns|links) /.test(what);

export function analyse(rec, copy, proofs, capture, buyRec = existsSync("fixtures/mainnet/buy.json") ? JSON.parse(readFileSync("fixtures/mainnet/buy.json", "utf8")) : null) {
  const tokens = factTokens(rec, proofs);
  const lines = [];
  const add = (ok, party, what) => lines.push([ok, party, what]);
  const chainText = JSON.stringify(copy.txs) + JSON.stringify(copy.views);

  // 1. The merchant and any chain observer.
  const hits = scan(chainText, tokens);
  add(hits.length === 0, "merchant and chain observer", `${Object.keys(copy.txs).length} txs (args, logs) and the verdict view: ${hits.length ? `FOUND ${hits.join(", ")}` : `none of ${tokens.length} fact strings (field names, field=value pairs, proof refs, the presentation's sha256, the login)`}`);

  // The model's answer is on chain with the key that opens it (so anyone checks the verdict): it
  // holds the attested predicates and the binding nonce, and the reasoning field stays sealed.
  const vtx = Object.values(copy.txs).find((t) => t.actions.some((a) => a.method === "submit_near_ai_verdict"));
  const { envelope, proof } = JSON.parse(vtx.actions.find((a) => a.method === "submit_near_ai_verdict").args);
  const msg = JSON.parse(proof.response).choices[0].message;
  const answer = JSON.parse(openField(msg.content, Buffer.from(proof.response_key, "hex")));
  const keys = Object.keys(answer).sort().join(",");
  const ansHits = scan(JSON.stringify(answer), tokens);
  const samePreds = JSON.stringify([...answer.predicates].sort()) === JSON.stringify([...envelope.predicates].sort());
  add(keys === "bind,predicates" && samePreds && /^[0-9a-f]{64}$/.test(answer.bind) && ansHits.length === 0, "merchant and chain observer", `the model's answer opens from chain to {${keys}}: predicates [${answer.predicates.join(", ")}] equal the envelope's, bind a 32-byte nonce${ansHits.length ? `; FOUND ${ansHits.join(", ")}` : ", no fact string"}`);
  // The reasoning field must be ciphertext: hex of the E2EE wire (a 32-byte ephemeral key, a 24-byte
  // nonce, the body and a 16-byte tag, so more than 72 bytes) that the disclosed key does not open.
  // Plaintext, or short hex, is a leak.
  const rc = msg.reasoning_content;
  let reasoningOpens = false;
  const rcSealed = rc == null || (/^[0-9a-f]+$/.test(rc) && rc.length > 2 * (32 + 24 + 16) && !mostlyText(rc));
  if (rc && rcSealed) { try { openField(rc, Buffer.from(proof.response_key, "hex")); reasoningOpens = true; } catch { reasoningOpens = false; } }
  add(rcSealed && !reasoningOpens, "merchant and chain observer", rc == null ? "the model's reasoning field is absent" : !rcSealed ? "the model's reasoning field is NOT ciphertext" : `the model's reasoning field is ciphertext (${rc.length / 2} bytes) and the on-chain key does not open it`);

  // proof_hash: an unblinded proof_ref would let anyone brute-force three small numbers back out
  // of it. Recompute the hash the unblinded design would give for the true facts: it must not be
  // on chain, and the on-chain proof_hash must differ from it.
  const pres = existsSync(rec.presentation) ? sha(readFileSync(rec.presentation)) : null;
  if (!pres) add(false, "merchant and chain observer", `the presentation ${rec.presentation} is missing, so proof_hash blinding was not checked`);
  else {
    // The proof set was exactly the three GitHub facts (ids F6..F8, compact JSON; the same layout
    // as scripts/lib/github-fact.mjs). An observer who knows the presentation's hash enumerates
    // small numbers; with a blinded ref no candidate matches, including the true one.
    const setFor = (vals, ref) => JSON.stringify({ facts: rec.facts.map((f, i) => ({ id: `F${6 + i}`, platform: f.platform, field: f.field, value: vals[i], proof_ref: ref })) });
    const truth = rec.facts.map((f) => f.value);
    const unblinded = sha(setFor(truth, pres));
    // The search is the same for the same (proof_hash, presentation): cached, so the tests that
    // plant leaks elsewhere do not repeat it.
    const ck = `${envelope.proof_hash}|${pres}`;
    if (!SEARCH.has(ck)) {
      let tried = 0, found = null;
      for (let a = 0; a <= 20 && !found; a++) for (let r = 0; r <= 200 && !found; r++) for (let f = 0; f <= 200; f++) {
        tried++;
        if (sha(setFor([a, r, f], pres)) === envelope.proof_hash) { found = [a, r, f]; break; }
      }
      SEARCH.set(ck, { tried, found });
    }
    const { tried, found } = SEARCH.get(ck);
    add(!found && envelope.proof_hash !== unblinded && !chainText.includes(unblinded), "merchant and chain observer", `proof_hash ${envelope.proof_hash.slice(0, 12)}.. is blinded: ${tried.toLocaleString("en")} guesses at (age, repos, followers) with the published presentation hash, the true one among them, match nothing on chain. The private salt is the protection; the search only illustrates it${found ? `; FOUND ${found}` : ""}`);
  }

  // What the merchant does learn, by design: listed so the table is complete.
  const v = copy.views.verdict;
  add(true, "merchant and chain observer", `learns by design: predicates [${(v?.predicates ?? envelope.predicates).join(", ")}], tier ${envelope.tier}, the price paid, the buyer's account (${rec.buyer.slice(0, 8)}..), the per-context nullifier`);
  add(buyRec?.buyer === rec.buyer, "merchant and chain observer", `links by account (listed, a limit${buyRec ? (buyRec.buyer === rec.buyer ? ", the same buyer in both records" : ", RECORDS DISAGREE") : ""}): this buyer account also made the earlier mainnet purchase (fixtures/mainnet/buy.json) and funded the bazaar and the merchant (fixtures/mainnet/bazaar.json, "fund bazaar", "fund merchant-b"); a fresh account per purchase would cut that link`);
  add(true, "NEAR AI (metadata, listed)", "the chat_id (it is on chain in the verdict), the API key, the client's one-time public key and the caller's IP: enough for NEAR AI to tie its own logs to this purchase, though the facts stay sealed past its gateway");

  // 2. The referee: its result on chain carries claims and a verdict; it is scanned for facts.
  const ref = Object.values(copy.txs).find((t) => t.actions.some((a) => a.method === "submit_referee_result"));
  if (!ref) add(false, "referee (result on chain)", "no submit_referee_result tx in the copy");
  else {
    const h = scan(JSON.stringify(ref), tokens);
    add(h.length === 0, "referee (result on chain)", h.length ? `FOUND ${h.join(", ")}` : "its signed result names the merchant, price and outcome, no fact string");
  }
  add(true, "referee worker (input, listed)", "received the proof set in the clear: this run invoked the worker locally (scripts/mainnet-real.mjs, worker-input) with REP's referee key; a referee in an attested OutLayer worker is the follow-up and is left out of this claim");

  // 3. The NEAR AI gateway outside the TEE: the request is sealed to the attested model key.
  if (!capture) add(false, "NEAR AI gateway, outside the TEE", "the request capture is missing");
  else {
    // The capture is a testnet request over the fixture facts; scan it for those and for the
    // real buyer's field=value pairs too.
    const synth = factTokens({ facts: rec.facts, presentation: "" }, proofs).filter((t) => !/^[0-9a-f]{64}$/.test(t));
    const h = scan(capture, synth);
    let req = null;
    try { req = JSON.parse(capture); } catch { req = null; }
    const msgs = req?.messages ?? [];
    const sealed = msgs.length > 0 && msgs.every((m) => /^[0-9a-f]+$/.test(m.content) && m.content.length > 2 * (32 + 24 + 16) && !mostlyText(m.content));
    add(h.length === 0 && sealed, "NEAR AI gateway, outside the TEE", h.length ? `FOUND ${h.join(", ")}` : `the request bytes hold ${msgs.length} messages, each hex ciphertext${sealed ? "" : " (NOT all sealed)"}, none of ${synth.length} fact strings. This is the testnet capture of the same code path (${req?.model}, 2026-11-04); the mainnet run used another model and its request bytes were not kept`);
  }

  // 4. REP's evaluator: it builds the request, so it reads the facts. A listed row.
  add(true, "REP's evaluator (listed)", "reads the facts in the clear to build the model's request and signs its hash (docs/details.md, Known limits)");
  add(true, "NEAR AI model in the TEE (listed)", "reads the facts: they are sealed to its attested key");
  add(true, "the notary (listed)", "REP's notary co-signed the GitHub TLS session the facts come from (the presentation): it saw that the session ran and its commitments, with the redacted parts hidden (docs/prove-me.md)");
  add(true, "the RPC providers (listed)", "the public NEAR RPC the buyer's agent and any checker use sees their IP and which txs and views they ask for");
  add(true, "this repo (listed, a deliberate disclosure)", "publishes this buyer's facts and its TLSNotary presentation (fixtures/mainnet/real-refusal.json, fixtures/live/prove-me/), with the founder's consent, so the run can be re-checked");
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rec = JSON.parse(readFileSync(REC, "utf8"));
  const proofs = JSON.parse(readFileSync("fixtures/proofs.json", "utf8"));
  const mode = process.argv[2];
  if (mode === "--record") {
    writeFileSync(COPY, JSON.stringify(await readChain(rec), null, 1) + "\n");
    console.log(`wrote ${COPY}`);
  }
  const copy = JSON.parse(readFileSync(COPY, "utf8"));
  if (mode === "--live") {
    let live;
    try { live = await readChain(rec); } catch (e) {
      // An RPC that answered with an error (a tx not found) is a failure; only no answer is a skip.
      if (e.answered) { console.log(`FAIL  who-sees-what --live: ${e.message.slice(0, 160)}`); process.exit(1); }
      console.log(`SKIP  who-sees-what --live: mainnet RPC unreachable (${e.message.slice(0, 80)})`); process.exit(3);
    }
    // The verdict view has fields a later call may change (review_joined, disputed, storage_reserve);
    // compare the ones that cannot, and name any that differ.
    const MUTABLE = new Set(["review_joined", "disputed", "storage_reserve", "receipt", "spent", "checkout_ref", "paid"]);
    const fixed = (v) => Object.fromEntries(Object.entries(v ?? {}).filter(([k]) => !MUTABLE.has(k)));
    const diff = Object.keys({ ...fixed(live.views.verdict), ...fixed(copy.views.verdict) }).filter((k) => JSON.stringify(live.views.verdict?.[k]) !== JSON.stringify(copy.views.verdict?.[k]));
    const same = JSON.stringify(live.txs) === JSON.stringify(copy.txs) && diff.length === 0;
    console.log(`${same ? "PASS" : "FAIL"}  the committed copy equals the ${Object.keys(copy.txs).length} mainnet txs and the verdict view's fixed fields read now${diff.length ? ` (differs: ${diff.join(", ")})` : ""}`);
    if (!same) process.exit(1);
  }
  const capture = existsSync(CAPTURE) ? readFileSync(CAPTURE, "utf8") : null;
  const lines = analyse(rec, copy, proofs, capture);
  let party = "";
  for (const [ok, p, what] of lines) {
    if (p !== party) { console.log(`\n${p}`); party = p; }
    console.log(`  ${isListed([ok, p, what]) ? "note" : ok ? "ok  " : "LEAK"}  ${what}`);
  }
  const bad = lines.filter(([ok]) => !ok).length;
  const checks = lines.filter((l) => !isListed(l)).length;
  const wantChecks = 6, wantListed = 9;
  const listedN = lines.length - checks;
  const ok = !bad && checks === wantChecks && listedN === wantListed;
  console.log(`\n${ok ? "PASS" : "FAIL"}  who sees what: the real-data mainnet purchase, ${checks} checks${checks === wantChecks ? "" : ` (expected ${wantChecks})`} and ${listedN} listed rows${listedN === wantListed ? "" : ` (expected ${wantListed})`}; the buyer's facts are absent on chain, and the gateway request (a testnet capture) is ciphertext`);
  process.exit(ok ? 0 : 1);
}
