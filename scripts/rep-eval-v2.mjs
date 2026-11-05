#!/usr/bin/env node
// REP Eval v2 (panel round 4, action 7; protocol frozen in docs/eval.md before the set existed).
// 60 referee-claim items in 3 tiers; the answer is the number of the first claim the referee
// must refuse, or 0. The truth is the referee's own check (`bookerbob eval-truth`), not a label.
// 600-token budget; a reply cut at the budget is no answer. Qwen3.6 is a budget probe.
//
//   node scripts/rep-eval-v2.mjs set       make the private set once, truth from the code
//   node scripts/rep-eval-v2.mjs run       ask the 3 models once, check signatures, grade, sign
//   node scripts/rep-eval-v2.mjs onchain   the set owner account commits the root (commit_eval_set),
//                                          then the certificates go on chain
//   node scripts/rep-eval-v2.mjs verify    public check (make eval-verify)
//
// Private (KEYS_DIR/eval): items, salts, answers, replies, the set owner's seed. Public
// (fixtures/live/eval/rep-eval-v2.json): root, item hashes, signatures, correct vectors,
// certificates. Spend cap 1 USD.
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomInt, sign, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { certificateJson, itemHash, merkleRoot } from "./eval-run.mjs";
import { MODELS, sigOk } from "./rep-eval.mjs";

const API = process.env.NEAR_AI_BASE ?? "https://cloud-api.near.ai/v1";
const PRICE = { "z-ai/glm-5.3-flash": [0.08, 0.5], "deepseek-ai/DeepSeek-V4.1-Flash-1017": [0.3, 1.2], "Qwen/Qwen3.6-35B-A3B-FP8": [0.17, 1.1] };
export const BUDGET_TOKENS = 600;
export const BUDGET_PROBE = "Qwen/Qwen3.6-35B-A3B-FP8";
export const TIERS = { t1: { facts: 3, claims: 2 }, t2: { facts: 5, claims: 3 }, t3: { facts: 6, claims: 4 } };
const PER_TIER = 20;
const SPEND_CAP_USD = 1;
const TAG = Buffer.from("bookerbob/eval-certificate/v0\x00", "latin1");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const keysDir = process.env.KEYS_DIR || `${process.env.HOME}/.rep-secrets/bookerbob-testnet`;
const dir = join(keysDir, "eval");
const setPath = join(dir, "rep-eval-v2-60.json");
const PUBLIC = "fixtures/live/eval/rep-eval-v2.json";
const bazaar = process.env.BAZAAR_ACCOUNT_ID || "bookerbob.testnet";

// The rule table and the text rules, as the referee code has them (zkcore/src/referee.rs).
export const RULES = [
  ["airbnb", "trips_12m", 3, "airbnb_frequent"],
  ["booking", "genius_level", 2, "booking_genius"],
  ["anthropic", "monthly_spend_usd", 20, "claude_spender"],
  ["github", "account_age_years", 3, "github_builder"],
  ["steam", "account_age_years", 5, "steam_veteran"],
  ["uber", "trips_90d", 10, "uber_regular"],
  ["world_id", "verified", 1, "world_id_human"],
];
export const STATUS = ["platinum", "diamond", "titanium", "gold", "silver", "elite", "vip", "ambassador", "superhost", "premier", "executive", "centurion", "marriott", "hilton", "hyatt", "ihg", "accor", "bonvoy", "amex", "loyalty"];
export const PLATFORM_WORDS = [["airbnb", "airbnb_frequent"], ["booking", "booking_genius"], ["genius", "booking_genius"], ["anthropic", "claude_spender"], ["claude", "claude_spender"], ["github", "github_builder"], ["steam", "steam_veteran"], ["uber", "uber_regular"], ["world", "world_id_human"]];
const TEXTS = { airbnb_frequent: ["stays a lot", "books often", "a regular guest"], booking_genius: ["a seasoned traveller", "books trips well"], claude_spender: ["pays for ai tools", "a paying ai user"], github_builder: ["an old developer account", "has shipped code for years"], steam_veteran: ["a long time gamer", "plays for years"], uber_regular: ["rides often", "takes many rides"], world_id_human: ["one person, one agent", "a unique human"] };
const OTHER_FIELDS = { airbnb: "trips_90d", booking: "bookings_12m", anthropic: "seats", github: "public_repos", steam: "games_owned", uber: "trips_12m", world_id: "orb_level" };

const pick = (xs) => xs[randomInt(xs.length)];

/** One item: facts, revealed lines and numbered claims, maybe with one planted mistake. */
export function makeItem(tier) {
  const { facts: nf, claims: nc } = TIERS[tier];
  const rules = [...RULES].sort(() => randomInt(3) - 1).slice(0, nf);
  const facts = rules.map(([platform, field, min], i) => {
    // Mostly above the minimum; t2/t3 put some exactly at it (holds) or one under (does not).
    const r = randomInt(10);
    const value = tier !== "t1" && r === 0 ? min : tier !== "t1" && r === 1 ? Math.max(0, min - 1) : min + randomInt(1, 12);
    return { id: `F${i + 1}`, platform, field, value, proof_ref: "00".repeat(32) };
  });
  const proving = facts.map((f, i) => [f, rules[i]]).filter(([f, r]) => f.value >= r[2]);
  const usable = proving.length ? proving : [[facts[0], rules[0]]];
  const revealed = [...new Set(usable.map(([, r]) => r[3]))].sort();
  const claims = Array.from({ length: nc }, () => {
    const [f, r] = pick(usable);
    let text = pick(TEXTS[r[3]]);
    // An allowed decoy in t3: the line's own window number, or a word that only contains a status word.
    if (tier === "t3" && randomInt(3) === 0) text = r[1].includes("12m") ? `${text}, 12 months` : `${text}, golden record`;
    return { line: r[3], text, citations: [{ fact: f.id, field: f.field, value: f.value }] };
  });
  if (randomInt(4) !== 0) plant(tier, claims[randomInt(nc)], facts, revealed);
  return { tier, proofs: { facts }, revealed, claims };
}

function plant(tier, c, facts, revealed) {
  const cit = c.citations[0];
  const fact = facts.find((f) => f.id === cit.fact);
  const plain = [() => (cit.value += randomInt(1, 4)), () => (cit.fact = `F${facts.length + 1 + randomInt(3)}`)];
  const near = [
    () => (cit.field = OTHER_FIELDS[fact.platform]),
    () => { const low = facts.find((f) => { const r = RULES.find((x) => x[0] === f.platform && x[1] === f.field); return r && f.value < r[2]; }); if (low) { cit.fact = low.id; cit.field = low.field; cit.value = low.value; } else cit.value -= 1; },
    () => { const other = RULES.find((r) => !revealed.includes(r[3])); if (other) c.line = other[3]; else cit.value += 1; },
  ];
  const text = [
    () => (c.text = `${c.text}, ${pick(STATUS)} member`),
    () => { const w = pick(PLATFORM_WORDS.filter(([, p]) => p !== c.line)); c.text = `${c.text} on ${w[0]}`; },
    () => (c.text = `${c.text}, ${cit.value + randomInt(2, 9)} times`),
    () => (c.text = `${c.text.toUpperCase()} VIP`),
  ];
  const menu = tier === "t1" ? plain : tier === "t2" ? [...plain, ...near] : [...near, ...text];
  pick(menu)();
}

/** The model's prompt for an item. The rules are stated exactly as the referee code applies them. */
export function prompt(it) {
  const rules = RULES.map(([p, f, m, l]) => `- ${l}: a ${p} fact with field ${f} and value >= ${m}`).join("\n");
  const facts = it.proofs.facts.map((f) => `- ${f.id}: ${f.platform} ${f.field} = ${f.value}`).join("\n");
  const claims = it.claims.map((c, i) => `${i + 1}. line ${c.line}; text "${c.text}"; cites ${c.citations.map((x) => `${x.fact} ${x.field}=${x.value}`).join(", ")}`).join("\n");
  return `You are the referee of a market. A claim holds only if all of these are true:
1. its line is in the revealed list;
2. it cites at least one fact;
3. every cited fact id is in the proof set, and the cited field and value equal that fact's field and value exactly;
4. every cited fact proves the claim's line under the rule table;
5. its text is plain ASCII and at most 280 characters;
6. its text contains none of these words: ${STATUS.join(", ")};
7. its text contains no platform word that belongs to another line (${PLATFORM_WORDS.map(([w, l]) => `${w} -> ${l}`).join(", ")});
8. every number in its text is one of the claim's cited values or a number inside its line's rule field name (like 12 in trips_12m).
Words are split at every character that is not a letter or a digit, and compared in lower case.

Rule table:
${rules}

Proof set:
${facts}

Revealed lines: ${it.revealed.join(", ")}

Claims:
${claims}

Which is the first claim that does not hold? Reply with its number, or 0 if every claim holds. Reply with the number only.`;
}

const cli = (args, opts = {}) => execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", ...args], { encoding: "utf8", ...opts });

function makeSet() {
  if (existsSync(setPath)) throw new Error("the v2 set exists; it is made once");
  const raw = Object.keys(TIERS).flatMap((t) => Array.from({ length: PER_TIER }, () => makeItem(t)));
  const p = join(dir, `truth-${Date.now()}.json`);
  writeFileSync(p, JSON.stringify(raw.map(({ proofs, revealed, claims }) => ({ proofs, revealed, claims }))), { mode: 0o600 });
  const truth = JSON.parse(cli(["eval-truth", p]));
  const items = raw.map((it, i) => ({ level: it.tier, question: prompt(it), answer: String(truth[i].answer), reason: truth[i].reason, salt: randomBytes(16).toString("hex") }));
  writeFileSync(setPath, JSON.stringify(items, null, 2) + "\n", { mode: 0o600 });
  const zeros = items.filter((x) => x.answer === "0").length;
  console.log(`v2 set: ${items.length} private items, ${zeros} with every claim holding; root ${merkleRoot(items.map(itemHash))}`);
}

function issuerKey() {
  const seed = Buffer.from(readFileSync(join(keysDir, "eval-issuer.seed"), "utf8").trim(), "hex");
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  return { priv, pub: createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(12).toString("hex") };
}

async function pool(xs, k, f) {
  const out = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: k }, async () => { while (i < xs.length) { const j = i++; out[j] = await f(xs[j], j); } }));
  return out;
}

async function ask(model, item, KEY, spend) {
  if (spend.usd > SPEND_CAP_USD) throw new Error("spend cap reached");
  const req = Buffer.from(JSON.stringify({ model, max_tokens: BUDGET_TOKENS, temperature: 0, messages: [{ role: "user", content: item.question }] }));
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: req });
    const rb = Buffer.from(await res.arrayBuffer());
    if (res.status === 402) throw new Error("NEAR AI credits exhausted: stop (credits cost money)");
    if (!res.ok) { await new Promise((ok) => setTimeout(ok, 2000)); continue; }
    const body = JSON.parse(rb);
    const [pi, po] = PRICE[model];
    spend.usd += ((body.usage?.prompt_tokens ?? 0) * pi + (body.usage?.completion_tokens ?? 0) * po) / 1e6;
    const s = await (await fetch(`${API}/signature/${body.id}?model=${encodeURIComponent(model)}&signing_algo=ed25519`, { headers: { Authorization: `Bearer ${KEY}` } })).json().catch(() => null);
    return { chat_id: body.id, reply: body.choices?.[0]?.message?.content ?? "", finish: body.choices?.[0]?.finish_reason, signature_text: s?.text, signature: s?.signature, signing_address: s?.signing_address, signature_valid: sigOk(s, model, sha(req), sha(rb)) };
  }
  throw new Error(`${model}: no answer after 3 tries`);
}

/** Protocol v2: a reply cut at the budget is no answer, whatever it ends with. */
export const gradedReply = (a) => (a.finish === "length" ? "" : a.reply);

async function run() {
  const items = JSON.parse(readFileSync(setPath, "utf8"));
  const root = merkleRoot(items.map(itemHash));
  const KEY = (process.env.NEAR_AI_KEY ?? readFileSync(`${process.env.HOME}/.rep-secrets/near-ai.key`, "utf8")).trim();
  const spend = { usd: 0 };
  const iss = issuerKey();
  const pub = { note: "REP Eval v2: 60 sealed referee-claim items in 3 tiers, truth from the referee's own check; 3 NEAR AI models once, 600-token budget, a cut reply is no answer; every answer's TEE signature checks against its request and response hashes; grading and the CI in the worker's code; the eval issuer signed each certificate; the set owner account committed the root. The items stay private.", protocol: "v2", set_root: root, n: items.length, levels: Object.keys(TIERS), per_level: PER_TIER, budget_tokens: BUDGET_TOKENS, item_hashes: items.map(itemHash), issuer_key: `ed25519:${iss.pub}`, models: [] };
  const priv = {};
  for (const model of MODELS) {
    console.log(`\n${model}: ${items.length} items, at most 6 in flight`);
    const answers = await pool(items, 6, (it) => ask(model, it, KEY, spend));
    const valid = answers.filter((a) => a.signature_valid).length;
    if (valid !== answers.length) throw new Error(`${model}: ${answers.length - valid} TEE signatures did not verify; no certificate`);
    const p = join(dir, `grade-v2-${Date.now()}.json`);
    writeFileSync(p, JSON.stringify({ expected: items.map((it) => it.answer), replies: answers.map(gradedReply) }), { mode: 0o600 });
    const g = JSON.parse(cli(["eval-grade", p]));
    const byLevel = Object.fromEntries(Object.keys(TIERS).map((l) => [l, items.filter((it, i) => it.level === l && g.correct[i]).length]));
    const noAnswer = answers.filter((a) => a.finish === "length").length;
    const cert = { v: 0, subject: `${model}@${BUDGET_TOKENS}tok/referee-v2`, set_root: root, n: items.length, correct: g.n_correct, score_bucket: g.score_bucket, answers_hash: sha(answers.map((a) => a.signature_text).join("\n")), issued_at_ms: Date.now() };
    const signature = sign(null, createHash("sha256").update(Buffer.concat([TAG, Buffer.from(certificateJson(cert))])).digest(), iss.priv).toString("hex");
    console.log(`   ${g.n_correct}/${items.length} (95% CI ${g.ci95[0].toFixed(1)} to ${g.ci95[1].toFixed(1)}), by tier ${JSON.stringify(byLevel)}; no answer (cut at the budget) ${noAnswer}${model === BUDGET_PROBE ? "; budget probe" : ""}`);
    pub.models.push({ model, budget_probe: model === BUDGET_PROBE, correct: g.n_correct, ci95: g.ci95, by_level: byLevel, truncated: noAnswer, correct_vector: g.correct, answers: answers.map(({ reply, ...a }) => a), certificate: cert, signature });
    priv[model] = answers.map((a) => a.reply);
  }
  pub.cost_usd = Number(spend.usd.toFixed(4));
  writeFileSync(join(dir, "rep-eval-v2-replies-private.json"), JSON.stringify(priv) + "\n", { mode: 0o600 });
  writeFileSync(PUBLIC, JSON.stringify(pub, null, 2) + "\n");
  console.log(`\nrep-eval v2: 3 certificates signed; cost about $${spend.usd.toFixed(4)}; ${PUBLIC}`);
}

async function onchain() {
  const { keyFromSeed, near, nearPublicKey, rpcClient, send } = await import("../relayer/near.mjs");
  const { config } = await import("./demo-tester.mjs");
  const c = config(process.env);
  const client = rpcClient(c.rpc);
  const pub = JSON.parse(readFileSync(PUBLIC, "utf8"));
  pub.txs = pub.txs ?? {};
  const owner = `evalset.${c.treasury}`;
  const seedPath = join(dir, `${owner}.seed`);
  const fc = (method_name, args, deposit = 0n) => ({ type: "FunctionCall", method_name, args, gas: 100n * 10n ** 12n, deposit });
  const ok = (what, r) => { if (!r.ok) throw new Error(`${what}: ${r.error}`); console.log(`   ok ${what}  https://testnet.nearblocks.io/txns/${r.hash}`); return r.hash; };
  if (!(await client.account(owner))) {
    const seed = randomBytes(32).toString("hex");
    writeFileSync(seedPath, seed + "\n", { mode: 0o600 });
    const k = keyFromSeed(seed);
    const treasury = keyFromSeed(readFileSync(join(keysDir, "treasury.seed"), "utf8"));
    pub.txs.owner_account = ok(`create ${owner} (its own key ${nearPublicKey(k.pub)})`, await send(client, { signer_id: c.treasury, key: treasury, receiver_id: owner, actions: [{ type: "CreateAccount" }, { type: "Transfer", deposit: near(0.1) }, { type: "AddKey", public_key_hex: k.pub, permission: "FullAccess" }] }));
  }
  const ownerKey = keyFromSeed(readFileSync(seedPath, "utf8"));
  const as = (who, key, actions) => send(client, { signer_id: who, key, receiver_id: bazaar, actions });
  pub.set_owner = owner;
  if (!pub.txs.commit_set) pub.txs.commit_set = ok("commit_eval_set (by the set owner, not the bazaar owner)", await as(owner, ownerKey, [fc("commit_eval_set", { set_root: pub.set_root, n: pub.n, label: "REP Eval v2: 60 referee-claim items, 3 tiers, truth from the referee check, 600 tokens, protocol frozen before the set" }, 10n ** 22n)]));
  const relayerKey = keyFromSeed(readFileSync(join(keysDir, "treasury.seed"), "utf8"));
  for (const m of pub.models) {
    if (m.submit_tx) continue;
    m.submit_tx = ok(`${m.model}: certificate`, await as(c.treasury, relayerKey, [fc("submit_eval_certificate", { certificate: m.certificate, issuer_key: pub.issuer_key, signature: m.signature }, 10n ** 22n)]));
  }
  writeFileSync(PUBLIC, JSON.stringify(pub, null, 2) + "\n");
}

export async function verifyPublic(pub, view) {
  const lines = [];
  const owner = view ? await view(bazaar, "eval_set", { set_root: pub.set_root }) : null;
  for (const m of pub.models) {
    const sigs = m.answers.filter((a) => sigOk({ text: a.signature_text, signature: a.signature, signing_address: a.signing_address }, m.model, null, null)).length;
    const hashOk = sha(m.answers.map((a) => a.signature_text).join("\n")) === m.certificate.answers_hash;
    const k = m.correct_vector.filter(Boolean).length;
    const certOk = verify(null, createHash("sha256").update(Buffer.concat([TAG, Buffer.from(certificateJson(m.certificate))])).digest(), createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub.issuer_key.slice(8), "hex")]), format: "der", type: "spki" }), Buffer.from(m.signature, "hex"));
    const bucket = Math.floor((k * 100) / pub.n / 10) * 10;
    // A cut reply is no answer: none of them may be graded correct.
    const cutOk = m.answers.every((a, i) => a.finish !== "length" || !m.correct_vector[i]);
    const chain = view ? await view(bazaar, "eval_score", { subject: m.certificate.subject, set_root: pub.set_root }) : null;
    const ok = sigs === pub.n && hashOk && certOk && cutOk && k === m.certificate.correct && bucket === m.certificate.score_bucket && merkleRoot(pub.item_hashes) === pub.set_root && (view ? chain === bucket && owner?.[2] === pub.set_owner : true);
    lines.push([ok, `v2 ${m.model}${m.budget_probe ? " (budget probe)" : ""}: ${k}/${pub.n} (CI ${m.ci95[0].toFixed(1)} to ${m.ci95[1].toFixed(1)}), ${sigs}/${pub.n} TEE signatures valid, ${m.truncated} cut replies graded as no answer${view ? `, eval_score on chain ${chain}, set committed by ${owner?.[2]}` : ""}`]);
  }
  return lines;
}

const cmd = process.argv[2];
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (cmd === "set") makeSet();
    else if (cmd === "run") await run();
    else if (cmd === "onchain") await onchain();
    else if (cmd === "verify") {
      if (!existsSync(PUBLIC)) { console.log("SKIP  rep eval v2: not run yet"); return; }
      const { rpcClient } = await import("../relayer/near.mjs");
      const client = rpcClient(process.env.NEAR_RPC || "https://test.rpc.fastnear.com");
      const online = process.env.JUDGE_OFFLINE !== "1" && (await client.block().then(() => true, () => false));
      const lines = await verifyPublic(JSON.parse(readFileSync(PUBLIC, "utf8")), online ? (a, mth, args) => client.view(a, mth, args) : null);
      for (const [ok, t] of lines) console.log(`${ok ? "PASS" : "FAIL"}  rep eval ${t}`);
      if (!online) console.log("SKIP  rep eval v2 on-chain scores: no network");
      process.exit(lines.every(([ok]) => ok) ? 0 : 1);
    } else throw new Error("usage: rep-eval-v2.mjs set | run | onchain | verify");
  })().catch((e) => { console.error(`rep-eval v2: FAIL ${e.message}`); process.exit(1); });
}
