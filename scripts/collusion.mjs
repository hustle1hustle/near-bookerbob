#!/usr/bin/env node
// Tacit collusion, measured (docs/collusion.md). Six NEAR AI merchant agents price one hoodie
// for 12 rounds under three rules: OPEN (posted prices, two revisions per round after seeing
// every rival's price), SEALED (one sealed price per round, the past revealed prices only: what
// the bazaar contract shows), TALK (OPEN plus a public message channel). Rules, prompts, the
// market and the metric: scripts/lib/collusion-market.mjs, frozen by the pre-registration.
//
//   node scripts/collusion.mjs anchor            put sha256(prereg) on testnet (memo of a
//                                                0.000001 dUSDC ft_transfer between demo accounts)
//   node scripts/collusion.mjs run <arm> <rep>   one replicate (NEAR AI calls; resumes a partial one)
//   node scripts/collusion.mjs run-all           pair 1 (open, sealed), then pairs 2 and 3, then
//                                                talk 1-3 if the spend allows (pre-registered rule)
//   node scripts/collusion.mjs check             offline: the pre-registration and its anchor, every
//                                                TEE signature, every prompt and answer, every
//                                                round, every number. Exit 1 on any mismatch.
//
// Every decision is an E2EE v2 chat. The record keeps the sealed request and response bytes,
// the model's signed text (sha256 of both) and signature, and the per-field keys that open the
// two prompts and the answer, so a reader re-derives what each agent saw and what it answered.
import { createHash, diffieHellman, generateKeyPairSync, createPublicKey, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { clientKey, edPubToX, edVerify, fieldKey, openField, openWith, xchachaSeal } from "./lib/e2ee.mjs";
import * as M from "./lib/collusion-market.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "fixtures", "live", "collusion");
const LIB = join(ROOT, "scripts", "lib", "collusion-market.mjs");
const PREREG = join(DIR, "prereg.md");
const DOC = join(ROOT, "docs", "collusion.md");
const AI = process.env.NEAR_AI_BASE ?? "https://cloud-api.near.ai/v1";
const PRICE = [0.08, 0.5]; // z-ai/glm-5.3-flash, USD per million input and output tokens (as scripts/rep-eval.mjs)
// 0.50 USD as pre-registered; 0.70 once amendment 1 (fixtures/live/collusion/amend-1.md) is anchored.
const BUDGET = existsSync(join(DIR, "anchor-amend-1.json")) ? 0.7 : 0.5, TALK_IF_UNDER = 0.25;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const file = (arm, rep) => join(DIR, `${arm}-${rep}.json.gz`);
const load = (arm, rep) => (existsSync(file(arm, rep)) ? JSON.parse(gunzipSync(readFileSync(file(arm, rep)))) : null);
const save = (rec) => { mkdirSync(DIR, { recursive: true }); writeFileSync(file(rec.arm, rec.rep), gzipSync(JSON.stringify(rec))); };
const cost = (u) => (u ? ((u.prompt_tokens ?? 0) * PRICE[0] + (u.completion_tokens ?? 0) * PRICE[1]) / 1e6 : 0);

/** sealTo with the per-field key kept, so the prompt can be disclosed. */
function sealKeep(plaintext, recipientEdHex) {
  const eph = generateKeyPairSync("x25519");
  const ephPub = eph.publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), edPubToX(Buffer.from(recipientEdHex, "hex"))]), format: "der", type: "spki" });
  const key = Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey: eph.privateKey, publicKey: pub }), Buffer.alloc(0), Buffer.from("ed25519_encryption"), 32));
  const nonce = randomBytes(24);
  return { wire: Buffer.concat([ephPub, nonce, xchachaSeal(key, nonce, Buffer.from(plaintext))]).toString("hex"), key: key.toString("hex") };
}

function auth() {
  const key = (process.env.NEAR_AI_KEY ?? readFileSync(`${process.env.HOME}/.rep-secrets/near-ai.key`, "utf8")).trim();
  return { Authorization: `Bearer ${key}` };
}

async function attest(h) {
  const nonce = randomBytes(32).toString("hex");
  const r = await fetch(`${AI}/attestation/report?model=${encodeURIComponent(M.MODEL)}&signing_algo=ed25519&nonce=${nonce}`, { headers: { ...h, "x-no-aliasing": "true" }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`attestation report HTTP ${r.status}`);
  const report = await r.json();
  const key = report.model_attestations?.[0]?.signing_address;
  if (!/^[0-9a-f]{64}$/.test(key ?? "")) throw new Error("no ed25519 model key in the report");
  return { nonce, key, report_sha256: sha(JSON.stringify(report)), model_attestation: { signing_address: key, request_nonce: report.model_attestations[0].request_nonce ?? null } };
}

/** One decision: up to 3 tries; returns the disclosed record or a fallback marker. */
async function decide(h, modelKey, system, user) {
  let last = "", answered = false, lastTry = null;
  for (let i = 0; i < 3; i++) {
    const me = clientKey();
    const s = sealKeep(system, modelKey), u = sealKeep(user, modelKey);
    const reqBytes = Buffer.from(JSON.stringify({ model: M.MODEL, ...M.GEN, messages: [{ role: "system", content: s.wire }, { role: "user", content: u.wire }] }));
    let res, resBytes;
    try {
      res = await fetch(`${AI}/chat/completions`, { method: "POST", headers: { ...h, "Content-Type": "application/json", "X-Signing-Algo": "ed25519", "X-Client-Pub-Key": me.pubHex, "X-Model-Pub-Key": modelKey, "X-Encryption-Version": "2", "x-no-aliasing": "true" }, body: reqBytes, signal: AbortSignal.timeout(300_000) });
      resBytes = Buffer.from(await res.arrayBuffer());
    } catch (e) { last = `fetch: ${e.message}`; continue; }
    if (res.status === 402) throw new Error("NEAR AI credit exhausted");
    if (!res.ok) { last = `HTTP ${res.status}`; await new Promise((ok) => setTimeout(ok, 3000 * (i + 1))); continue; }
    const body = JSON.parse(resBytes);
    answered = true;
    const content = body.choices?.[0]?.message?.content ?? "";
    let raw;
    try { raw = JSON.parse(openWith(content, me.xSecret).match(/\{[\s\S]*\}/)[0]); } catch (e) { last = `answer: ${e.message}; finish ${body.choices?.[0]?.finish_reason}`; lastTry = { chat_id: body.id, request_b64: reqBytes.toString("base64"), response_b64: resBytes.toString("base64"), answer_key: (() => { try { return fieldKey(content, me.xSecret); } catch { return null; } })() }; continue; }
    let sig = {};
    for (let j = 0; j < 3 && !sig.signature; j++) {
      sig = await fetch(`${AI}/signature/${body.id}?model=${encodeURIComponent(M.MODEL)}&signing_algo=ed25519`, { headers: h, signal: AbortSignal.timeout(60_000) }).then((r) => r.json()).catch(() => ({}));
      if (!sig.signature) await new Promise((ok) => setTimeout(ok, 2000));
    }
    const [, sReq, sRes] = String(sig.text ?? "").split(":");
    const tee_signed = Boolean(sig.signature) && edVerify(sig.text, sig.signature, sig.signing_address) && sReq === sha(reqBytes) && sRes === sha(resBytes) && sig.signing_address === modelKey;
    return { raw, chat_id: body.id, tee_signed, signer: sig.signing_address ?? null, signed_text: sig.text ?? null, signature: sig.signature ?? null, request_b64: reqBytes.toString("base64"), response_b64: resBytes.toString("base64"), keys: { system: s.key, user: u.key, answer: fieldKey(content, me.xSecret) }, usage: body.usage ?? null, tries: i + 1 };
  }
  // The fallback rule covers a model that answered unusably. A transport failure (no answer at
  // all, e.g. the laptop slept) stops the run instead; `run-all` resumes from the last saved step.
  if (!answered) throw new Error(`transport: no model answer in 3 tries (${last}); resume with run-all`);
  return { fallback: true, error: last, last_try: lastTry };
}

/** Replay a record's decisions into rounds (the same code the runner uses to build state). */
function replay(rec, onDecision) {
  const state = { rounds: [], posted: {}, said: {} };
  const byKey = new Map(rec.decisions.map((d) => [`${d.round}/${d.step}/${d.agent}`, d]));
  for (let round = 1; round <= M.ROUNDS; round++) {
    state.posted = {}; state.said = {};
    for (let step = 1; step <= M.STEPS[rec.arm]; step++) {
      const next = {}, nextSaid = {};
      for (const a of M.AGENTS) {
        const d = byKey.get(`${round}/${step}/${a.id}`);
        if (!d) return { state, complete: false, at: { round, step } };
        onDecision?.(d, a, M.systemPrompt(a, rec.arm), M.userPrompt(a, rec.arm, round, step, state), state);
        next[a.id] = d.price;
        if (rec.arm === "talk") nextSaid[a.id] = d.message ?? "";
      }
      state.posted = next; state.said = nextSaid;
    }
    state.rounds.push(M.clear(round, state.posted, rec.arm === "talk" ? state.said : null));
  }
  return { state, complete: true };
}

let SPENT = null;
async function runOne(arm, rep) {
  SPENT ??= spentAll();
  if (!M.ARMS.includes(arm) || !(rep >= 1)) throw new Error("usage: run <open|sealed|talk> <rep>");
  if (!existsSync(join(DIR, "anchor.json"))) throw new Error("no anchor.json: run `anchor` first (pre-registration before any model call)");
  const h = auth();
  let rec = load(arm, rep);
  if (rec?.complete) { console.log(`${arm}-${rep}: complete`); return rec; }
  if (!rec) rec = { arm, rep, model: M.MODEL, lib_sha256: sha(readFileSync(LIB)), started: new Date().toISOString(), attestations: [], decisions: [] };
  const att = await attest(h);
  rec.attestations.push({ at: new Date().toISOString(), ...att });
  for (;;) {
    const r = replay(rec);
    if (r.complete) break;
    const { round, step } = r.at;
    const state = r.state;
    const out = await Promise.all(M.AGENTS.map(async (a) => {
      const system = M.systemPrompt(a, arm), user = M.userPrompt(a, arm, round, step, state);
      const d = await decide(h, att.key, system, user);
      const base = { round, step, agent: a.id };
      if (d.fallback) return { ...base, fallback: true, error: d.error, ...(d.last_try ? { last_try: d.last_try } : {}), price: M.fallbackPrice(a, state), ...(arm === "talk" ? { message: "" } : {}) };
      const { raw, ...rest } = d;
      return { ...base, price: M.clampPrice(raw, a), ...(arm === "talk" ? { message: M.clampMessage(raw) } : {}), asked: raw.price ?? null, why: String(raw.why ?? "").slice(0, 240), ...rest };
    }));
    rec.decisions.push(...out);
    save(rec);
    SPENT += out.reduce((s, d) => s + cost(d.usage), 0);
    if (SPENT > BUDGET) throw new Error(`budget: $${SPENT.toFixed(4)} spent, over $${BUDGET}; ${arm}-${rep} stops incomplete`);
    const spent = rec.decisions.reduce((s, d) => s + cost(d.usage), 0);
    console.log(`${arm}-${rep} r${round}s${step}  ${out.map((d) => `${d.agent} ${d.price}${d.fallback ? "!" : d.tee_signed ? "" : "?"}`).join("  ")}  $${spent.toFixed(4)}`);
  }
  const { state } = replay(rec);
  rec.rounds = state.rounds;
  rec.margin = M.margin(state.rounds);
  rec.complete = true;
  rec.finished = new Date().toISOString();
  save(rec);
  console.log(`${arm}-${rep}: done, margin over C2 (rounds 4-12) ${rec.margin.toFixed(3)}`);
  return rec;
}

function spentAll() {
  if (!existsSync(DIR)) return 0;
  return readdirSync(DIR).filter((f) => f.endsWith(".json.gz")).reduce((s, f) => s + JSON.parse(gunzipSync(readFileSync(join(DIR, f)))).decisions.reduce((t, d) => t + cost(d.usage), 0), 0);
}

async function runAll() {
  await Promise.all([runOne("open", 1), runOne("sealed", 1)]);
  const per = ["open", "sealed"].reduce((s, arm) => s + load(arm, 1).decisions.reduce((t, d) => t + cost(d.usage), 0), 0);
  console.log(`pair 1 spent $${per.toFixed(4)}`);
  // Pre-registered: start pairs 2 and 3 while the projected spend stays under the budget.
  const pairs = [];
  for (const rep of [2, 3]) if (per * rep <= BUDGET) pairs.push(rep);
  await Promise.all(pairs.flatMap((rep) => [runOne("open", rep), runOne("sealed", rep)]));
  const s = spentAll();
  console.log(`main arms spent $${s.toFixed(4)}`);
  if (s < TALK_IF_UNDER) await Promise.all([1, 2, 3].map((rep) => runOne("talk", rep)));
  else console.log(`talk arm skipped: spend $${s.toFixed(4)} is at or over $${TALK_IF_UNDER}`);
  report();
}

/** The numbers, from complete records. */
export function results() {
  const recs = M.ARMS.flatMap((arm) => [1, 2, 3].map((rep) => load(arm, rep)).filter((r) => r?.complete));
  const by = (arm) => recs.filter((r) => r.arm === arm);
  const means = Object.fromEntries(M.ARMS.map((arm) => [arm, by(arm).map((r) => M.margin(r.rounds))]));
  const roundsOf = (arm) => by(arm).flatMap((r) => M.roundMargins(r.rounds));
  const primary = means.open.length && means.sealed.length ? M.verdict(means.open, means.sealed) : null;
  const pooled = means.open.length && means.sealed.length ? permPooled(roundsOf("open"), roundsOf("sealed")) : null;
  const talk = means.talk.length ? permPooled(roundsOf("talk"), roundsOf("sealed")) : null;
  const decisions = recs.flatMap((r) => r.decisions);
  return { C2: M.C2, means, primary, pooled, talk_vs_sealed: talk, calls: decisions.filter((d) => !d.fallback).length, fallbacks: decisions.filter((d) => d.fallback).length, usd: decisions.reduce((s, d) => s + cost(d.usage), 0), recs };
}

/** Pooled round-level test: exact when small, else 200,000 seeded random relabelings. */
function permPooled(a, b) {
  const n = a.length + b.length;
  if (n <= 20) return M.permutation(a, b);
  const all = [...a, ...b], mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const obs = mean(a) - mean(b);
  let seed = 20261114, hit = 0;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const N = 200_000;
  for (let t = 0; t < N; t++) {
    const x = all.slice();
    for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; }
    if (mean(x.slice(0, a.length)) - mean(x.slice(a.length)) >= obs - 1e-9) hit++;
  }
  return { diff: obs, p: (hit + 1) / (N + 1), relabelings: N, sampled: true };
}

function report() {
  const r = results();
  const f = (x) => x.toFixed(3);
  for (const arm of M.ARMS) if (r.means[arm].length) console.log(`${arm.padEnd(6)} replicate margins over C2=${r.C2}: ${r.means[arm].map(f).join(", ")}  mean ${f(r.means[arm].reduce((s, x) => s + x, 0) / r.means[arm].length)}`);
  if (r.primary) console.log(`primary  OPEN minus SEALED ${f(r.primary.diff)}, exact p ${r.primary.p.toFixed(3)} over ${r.primary.relabelings} relabelings: ${r.primary.word}`);
  if (r.pooled) console.log(`pooled   rounds 4-12, OPEN minus SEALED ${f(r.pooled.diff)}, p ${r.pooled.p.toFixed(4)}`);
  if (r.talk_vs_sealed) console.log(`talk     rounds 4-12, TALK minus SEALED ${f(r.talk_vs_sealed.diff)}, p ${r.talk_vs_sealed.p.toFixed(4)}`);
  console.log(`${r.calls} model decisions, ${r.fallbacks} fallbacks, $${r.usd.toFixed(4)} at the listed token price`);
  return r;
}

// ---- anchor ----

/** `anchor` puts the pre-registration on testnet; `anchor amend-1` an amendment
 *  (fixtures/live/collusion/amend-1.md, written into anchor-amend-1.json). */
async function anchor(name) {
  const { keyFromSeed, rpcClient, send } = await import("../relayer/near.mjs");
  const src = name ? join(DIR, `${name}.md`) : PREREG, out = join(DIR, name ? `anchor-${name}.json` : "anchor.json");
  if (existsSync(out)) throw new Error(`already anchored: ${out}`);
  const prereg = readFileSync(src);
  const libSha = sha(readFileSync(LIB));
  if (!prereg.toString().includes(libSha)) throw new Error(`${src} does not name the lib's sha256 ${libSha}`);
  const digest = sha(prereg);
  const keysDir = process.env.KEYS_DIR ?? join(process.env.HOME, ".rep-secrets", "bookerbob-testnet");
  // Two of our demo merchant accounts; 0.000001 dUSDC (a testnet demo token) carries the memo.
  const signer = "agent-1.bookerbob-demo.testnet", receiver = "agent-2.bookerbob-demo.testnet", token = "bookerbob-dusdc.testnet";
  const key = keyFromSeed(readFileSync(join(keysDir, "merchants", `${signer}.seed`), "utf8"));
  const client = rpcClient("https://rpc.testnet.near.org");
  const memo = `bookerbob collusion ${name ?? "pre-registration"} sha256:${digest}`;
  const o = await send(client, { signer_id: signer, key, receiver_id: token, actions: [{ type: "FunctionCall", method_name: "ft_transfer", args: { receiver_id: receiver, amount: "1", memo }, gas: 30_000_000_000_000n, deposit: 1n }] });
  if (!o.ok) throw new Error(`ft_transfer failed: ${o.error}`);
  const tx = await client.rpc("tx", { tx_hash: o.hash, sender_account_id: signer, wait_until: "FINAL" });
  const block = await client.rpc("block", { block_id: tx.result.transaction_outcome.block_hash });
  const rec = { network: "testnet", tx: o.hash, signer, receiver_id: token, memo, prereg_sha256: digest, lib_sha256: libSha, block_height: block.result?.header.height ?? null, block_time: block.result ? new Date(Number(BigInt(block.result.header.timestamp) / 1_000_000n)).toISOString() : null, action_args_b64: tx.result.transaction.actions[0].FunctionCall.args, nearblocks: `https://testnet.nearblocks.io/txns/${o.hash}` };
  writeFileSync(out, JSON.stringify(rec, null, 2) + "\n");
  console.log(`anchored sha256 ${digest} in ${o.hash} at ${rec.block_time}`);
}

// ---- check ----

function check() {
  let fails = 0, passes = 0;
  const line = (ok, what) => { ok ? passes++ : fails++; if (!ok || process.env.VERBOSE) console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); };
  const prereg = readFileSync(PREREG);
  const a = JSON.parse(readFileSync(join(DIR, "anchor.json"), "utf8"));
  const args = JSON.parse(Buffer.from(a.action_args_b64, "base64"));
  line(sha(prereg) === a.prereg_sha256 && args.memo === `bookerbob collusion pre-registration sha256:${sha(prereg)}`, `pre-registration sha256 ${sha(prereg).slice(0, 16)}... is the memo of testnet tx ${a.tx}`);
  line(readFileSync(DOC).subarray(0, prereg.length).equals(prereg), "docs/collusion.md opens with the pre-registered text, byte for byte");
  const libSha = sha(readFileSync(LIB));
  line(libSha === a.lib_sha256 && prereg.toString().includes(libSha), "scripts/lib/collusion-market.mjs is the file the pre-registration names");
  const amendFile = join(DIR, "amend-1.md"), amendAnchor = join(DIR, "anchor-amend-1.json");
  const am = existsSync(amendAnchor) ? JSON.parse(readFileSync(amendAnchor, "utf8")) : null;
  if (am) {
    const t = readFileSync(amendFile), mArgs = JSON.parse(Buffer.from(am.action_args_b64, "base64"));
    line(sha(t) === am.prereg_sha256 && mArgs.memo === `bookerbob collusion amend-1 sha256:${sha(t)}` && t.toString().includes(a.lib_sha256), `amendment 1 sha256 ${sha(t).slice(0, 16)}... is the memo of testnet tx ${am.tx}, same rules file`);
    line(readFileSync(DOC).includes(t), "docs/collusion.md carries amendment 1 verbatim");
  }
  const r = results();
  for (const rec of r.recs.filter((x) => x.rep === 3)) line(Boolean(am) && new Date(rec.started) > new Date(am.block_time), `${rec.arm}-3: started after amendment 1's anchor block (${am?.block_time})`);
  let sigs = 0, opened = 0;
  for (const rec of r.recs) {
    line(rec.lib_sha256 === a.lib_sha256, `${rec.arm}-${rec.rep}: run with the pre-registered rules`);
    line(new Date(rec.started) > new Date(a.block_time), `${rec.arm}-${rec.rep}: started after the anchor block (${a.block_time})`);
    const keys = new Set(rec.attestations.map((x) => x.key));
    let bad = 0;
    let fbs = 0, fbBad = 0;
    const rp = replay(rec, (d, agent, system, user, state) => {
      // A fallback carries no model answer: its price must be the pre-registered fallback rule's.
      if (d.fallback) { fbs++; if (d.price !== M.fallbackPrice(agent, state)) { fbBad++; bad++; } return; }
      const req = Buffer.from(d.request_b64, "base64"), res = Buffer.from(d.response_b64, "base64");
      const [sModel, sReq, sRes] = String(d.signed_text).split(":");
      const sigOk = edVerify(d.signed_text, d.signature, d.signer) && keys.has(d.signer) && sModel === M.MODEL && sReq === sha(req) && sRes === sha(res);
      let ok = sigOk;
      if (sigOk) sigs++;
      try {
        const body = JSON.parse(req), msgs = body.messages;
        ok &&= body.model === M.MODEL && body.temperature === M.GEN.temperature && body.max_tokens === M.GEN.max_tokens && msgs.length === 2;
        ok &&= openField(msgs[0].content, Buffer.from(d.keys.system, "hex")) === system;
        ok &&= openField(msgs[1].content, Buffer.from(d.keys.user, "hex")) === user;
        const raw = JSON.parse(openField(JSON.parse(res).choices[0].message.content, Buffer.from(d.keys.answer, "hex")).match(/\{[\s\S]*\}/)[0]);
        ok &&= M.clampPrice(raw, agent) === d.price && (rec.arm !== "talk" || M.clampMessage(raw) === d.message);
        if (ok) opened++;
      } catch { ok = false; }
      if (!ok) bad++;
    });
    line(rp.complete && bad === 0, `${rec.arm}-${rec.rep}: ${rec.decisions.length} decisions, each prompt opens to what the rules show at that step, each answer opens to the price used, ${fbs} fallbacks at the fallback rule's price, model ${M.MODEL} at temperature ${M.GEN.temperature} and max_tokens ${M.GEN.max_tokens} in every request, ${bad} mismatches`);
    line(JSON.stringify(rp.state.rounds) === JSON.stringify(rec.rounds) && Math.abs(M.margin(rp.state.rounds) - rec.margin) < 1e-9, `${rec.arm}-${rec.rep}: 12 rounds re-cleared from the decisions, margin ${rec.margin.toFixed(3)}`);
  }
  line(r.recs.length >= 6, `${r.recs.length} complete replicates in the record`);
  const committed = existsSync(join(DIR, "result.json")) ? JSON.parse(readFileSync(join(DIR, "result.json"), "utf8")) : {};
  const now = { means: r.means, primary: r.primary, pooled: r.pooled, talk_vs_sealed: r.talk_vs_sealed, calls: r.calls, fallbacks: r.fallbacks };
  line(JSON.stringify(now) === JSON.stringify(committed.numbers), "result.json: every number recomputed from the decisions");
  console.log(`PASS  ${sigs} TEE signatures re-verified offline (ed25519 over sha256 of the kept request and response bytes, signer = the attested model key), ${opened} prompts and answers opened`);
  if (r.primary) console.log(`${r.primary.word === "SUPPORTED" ? "PASS" : "INFO"}  hypothesis (SEALED prices nearer cost than OPEN): ${r.primary.word}; OPEN minus SEALED ${r.primary.diff.toFixed(3)} dUSDC, exact p ${r.primary.p.toFixed(3)} (3 vs 3 replicates)`);
  console.log(`${fails ? "FAIL" : "PASS"}  collusion-check: ${passes} checks${fails ? `, ${fails} failed` : ""}`);
  process.exit(fails ? 1 : 0);
}

function writeResult() {
  const r = results();
  const numbers = { means: r.means, primary: r.primary, pooled: r.pooled, talk_vs_sealed: r.talk_vs_sealed, calls: r.calls, fallbacks: r.fallbacks };
  writeFileSync(join(DIR, "result.json"), JSON.stringify({ note: "recomputed by `make collusion-check` from the decision records", usd_at_listed_price: Math.round(r.usd * 1e4) / 1e4, numbers }, null, 2) + "\n");
  report();
}

/** Per-round winning price, mean over replicates, as a markdown table and an SVG chart. */
function table() {
  const r = results();
  const arms = M.ARMS.filter((a) => r.means[a].length);
  const per = Object.fromEntries(arms.map((arm) => {
    const recs = r.recs.filter((x) => x.arm === arm);
    return [arm, Array.from({ length: M.ROUNDS }, (_, i) => recs.reduce((s, x) => s + x.rounds[i].winning_price, 0) / recs.length)];
  }));
  console.log(`| round | ${arms.map((a) => a.toUpperCase()).join(" | ")} |\n|---|${arms.map(() => "---|").join("")}`);
  for (let i = 0; i < M.ROUNDS; i++) console.log(`| ${i + 1} | ${arms.map((a) => per[a][i].toFixed(2)).join(" | ")} |`);
  console.log("\nper replicate, winning price by round:");
  // Sensitivity: rounds 4-12 where a winner's final price came from a fallback (no model choice).
  for (const x of r.recs) {
    const last = M.STEPS[x.arm];
    const fw = x.rounds.filter((q) => q.round >= M.MEASURED[0] && q.winners.some((w) => x.decisions.find((d) => d.round === q.round && d.step === last && d.agent === w)?.fallback)).length;
    const fb = x.decisions.filter((d) => d.fallback).length;
    console.log(`${x.arm}-${x.rep}: ${fb} fallbacks of ${x.decisions.length} decisions; ${fw} of 9 measured rounds won at a fallback price`);
  }
  for (const x of r.recs) console.log(`${x.arm}-${x.rep}: ${x.rounds.map((q) => `${q.winning_price}${q.winners.length > 1 ? `(${q.winners.length})` : ""}`).join(" ")}  winners ${x.rounds.slice(3).map((q) => q.winners.join("+")).join(" ")}`);
  // chart
  const W = 640, H = 300, L = 48, R = 110, T = 20, B = 36;
  const all = arms.flatMap((a) => per[a]);
  const lo = Math.floor(Math.min(M.C2 - 1, ...all)), hi = Math.ceil(Math.max(...all) + 1);
  const x = (i) => L + (i * (W - L - R)) / (M.ROUNDS - 1), y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
  const col = { open: "#3B5BFF", sealed: "#1a9e5a", talk: "#d9822b" };
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui,sans-serif" font-size="12"><rect width="${W}" height="${H}" fill="#fff"/>`;
  for (let v = lo; v <= hi; v += Math.max(1, Math.round((hi - lo) / 6))) s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#eee"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" fill="#666">${v}</text>`;
  s += `<line x1="${L}" x2="${W - R}" y1="${y(M.C2)}" y2="${y(M.C2)}" stroke="#999" stroke-dasharray="4 3"/><text x="${W - R + 6}" y="${y(M.C2) + 4}" fill="#666">C2 = ${M.C2}</text>`;
  s += `<rect x="${x(3)}" y="${T}" width="${x(11) - x(3)}" height="${H - T - B}" fill="#000" opacity="0.03"/>`;
  for (let i = 0; i < M.ROUNDS; i++) s += `<text x="${x(i)}" y="${H - B + 16}" text-anchor="middle" fill="#666">${i + 1}</text>`;
  s += `<text x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle" fill="#666">round (shaded: rounds 4 to 12, the metric)</text>`;
  arms.forEach((a, k) => {
    s += `<polyline fill="none" stroke="${col[a]}" stroke-width="2.5" points="${per[a].map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/>`;
    // Labels where the lines are far apart (round 2): above for the higher line, below for the lower.
    const hiLine = per[a][1] >= Math.max(...arms.map((b) => per[b][1]));
    s += `<text x="${hiLine ? x(1) + 6 : x(1) - 20}" y="${hiLine ? y(per[a][1]) - 10 : y(per[a][2]) + 20}" fill="${col[a]}" font-weight="600">${a.toUpperCase()}</text>`;
  });
  s += `<text x="${L}" y="12" fill="#333">winning price, mean of ${r.means[arms[0]].length} replicates per arm (dUSDC)</text></svg>\n`;
  writeFileSync(join(ROOT, "docs", "media", "collusion.svg"), s);
}

const [cmd, a1, a2] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd === "anchor") await anchor(a1);
  else if (cmd === "run") await runOne(a1, Number(a2));
  else if (cmd === "run-all") { await runAll(); writeResult(); }
  else if (cmd === "result") writeResult();
  else if (cmd === "report") report();
  else if (cmd === "table") table();
  else if (cmd === "check") check();
  else { console.error("usage: collusion.mjs anchor | run <arm> <rep> | run-all | result | report | check"); process.exit(2); }
}
