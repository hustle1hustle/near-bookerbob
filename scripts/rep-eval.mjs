#!/usr/bin/env node
// REP Eval, calibrated (panel round 3, action 9). A sealed set of 120 items at four difficulty
// levels (30 each: 4-digit and 5-digit multiplication, small modular powers, 6-digit
// multiplication), answered by 3 NEAR AI models inside a fixed token budget (400 for the certificates). Every answer's TEE
// signature is checked against the request and response hashes; grading and the bootstrap 95%
// CI run in the worker's code (`bookerbob eval-grade`, worker/src/eval.rs); a separate eval
// issuer key (not the set owner, not the verdict issuer) signs one certificate per model.
//
//   node scripts/rep-eval.mjs set        make the private set once (KEYS_DIR/eval/rep-eval-120.json)
//   node scripts/rep-eval.mjs run        ask, check signatures, grade, sign the certificates
//   node scripts/rep-eval.mjs onchain    register the issuer and the set, submit the certificates
//   node scripts/rep-eval.mjs verify     public check from fixtures/live/eval/rep-eval.json (make eval-verify)
//
// Public: the set root, item hashes, per-answer chat ids, signature texts and signatures, the
// per-item correct vector, the certificates and CIs. Private (KEYS_DIR/eval): the items, salts,
// expected answers and replies. Spend cap 1 USD. Needs ~/.rep-secrets/near-ai.key (never logged).
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { certificateJson, itemHash, merkleRoot } from "./eval-run.mjs";

const API = process.env.NEAR_AI_BASE ?? "https://cloud-api.near.ai/v1";
export const MODELS = ["z-ai/glm-5.3-flash", "deepseek-ai/DeepSeek-V4.1-Flash-1017", "Qwen/Qwen3.6-35B-A3B-FP8"];
const PRICE = { "z-ai/glm-5.3-flash": [0.08, 0.5], "deepseek-ai/DeepSeek-V4.1-Flash-1017": [0.3, 1.2], "Qwen/Qwen3.6-35B-A3B-FP8": [0.17, 1.1] };
// Calibration (fixtures/live/eval/rep-eval-calibration-1000.json, not certified): at 1,000
// tokens glm and DeepSeek scored 95% and 100%, so the set did not discriminate; 400 tokens put
// them near the 40 to 80% band in probes. The Qwen models reason at length and run out of any
// tight budget, which the certificate reports as it is.
export const BUDGET_TOKENS = Number(process.env.REP_EVAL_BUDGET ?? 400);
const SPEND_CAP_USD = 1;
const PER_LEVEL = 30;
const TAG = Buffer.from("bookerbob/eval-certificate/v0\x00", "latin1");
const PUBLIC = "fixtures/live/eval/rep-eval.json";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const r = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const modpow = (b, e, m) => { let x = 1n, B = BigInt(b) % BigInt(m), E = BigInt(e); const M = BigInt(m); while (E > 0n) { if (E & 1n) x = (x * B) % M; B = (B * B) % M; E >>= 1n; } return x; };

export const LEVELS = {
  mul4: () => { const a = r(1000, 9999), b = r(1000, 9999); return [`Compute ${a} * ${b}.`, BigInt(a) * BigInt(b)]; },
  mul5: () => { const a = r(10000, 99999), b = r(10000, 99999); return [`Compute ${a} * ${b}.`, BigInt(a) * BigInt(b)]; },
  modpow: () => { const b = r(3, 30), e = r(8, 16), m = r(101, 199); return [`Compute ${b}^${e} mod ${m}.`, modpow(b, e, m)]; },
  mul6: () => { const a = r(100000, 999999), b = r(100000, 999999); return [`Compute ${a} * ${b}.`, BigInt(a) * BigInt(b)]; },
};

const keysDir = process.env.KEYS_DIR || `${process.env.HOME}/.rep-secrets/bookerbob-testnet`;
const dir = join(keysDir, "eval");
const setPath = join(dir, "rep-eval-120.json");
const bazaar = process.env.BAZAAR_ACCOUNT_ID || "bookerbob.testnet";

function issuerKey() {
  const p = join(keysDir, "eval-issuer.seed");
  if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  const seed = Buffer.from(readFileSync(p, "utf8").trim(), "hex");
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  return { priv, pub: createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(12).toString("hex") };
}

/** Run `f` over `xs` with at most `k` in flight. */
async function pool(xs, k, f) {
  const out = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: k }, async () => { while (i < xs.length) { const j = i++; out[j] = await f(xs[j], j); } }));
  return out;
}

async function ask(model, item, KEY, spend) {
  if (spend.usd > SPEND_CAP_USD) throw new Error("spend cap reached");
  const req = Buffer.from(JSON.stringify({ model, max_tokens: BUDGET_TOKENS, temperature: 0, messages: [{ role: "user", content: `${item.question} Reply with the number only.` }] }));
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: req });
    const rb = Buffer.from(await res.arrayBuffer());
    if (res.status === 402) throw new Error("NEAR AI credits exhausted");
    if (!res.ok) { await new Promise((ok) => setTimeout(ok, 2000)); continue; }
    const body = JSON.parse(rb);
    const [pi, po] = PRICE[model];
    spend.usd += ((body.usage?.prompt_tokens ?? 0) * pi + (body.usage?.completion_tokens ?? 0) * po) / 1e6;
    const s = await (await fetch(`${API}/signature/${body.id}?model=${encodeURIComponent(model)}&signing_algo=ed25519`, { headers: { Authorization: `Bearer ${KEY}` } })).json().catch(() => null);
    const ok = sigOk(s, model, sha(req), sha(rb));
    return { chat_id: body.id, reply: body.choices?.[0]?.message?.content ?? "", finish: body.choices?.[0]?.finish_reason, signature_text: s?.text, signature: s?.signature, signing_address: s?.signing_address, signature_valid: ok };
  }
  throw new Error(`${model}: no answer after 3 tries`);
}

export function sigOk(s, model, reqSha, resSha) {
  if (!s?.signing_address || !s?.text || !s?.signature) return false;
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(s.signing_address, "hex")]);
  const [m, q, a] = s.text.split(":");
  const good = verify(null, Buffer.from(s.text, "utf8"), createPublicKey({ key: der, format: "der", type: "spki" }), Buffer.from(s.signature, "hex"));
  return good && m === model && (reqSha == null || q === reqSha) && (resSha == null || a === resSha);
}

function grade(expected, replies) {
  const p = join(dir, `grade-${Date.now()}.json`);
  writeFileSync(p, JSON.stringify({ expected, replies }), { mode: 0o600 });
  return JSON.parse(execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", "eval-grade", p], { encoding: "utf8" }));
}

async function run() {
  const items = JSON.parse(readFileSync(setPath, "utf8"));
  const root = merkleRoot(items.map(itemHash));
  const KEY = (process.env.NEAR_AI_KEY ?? readFileSync(`${process.env.HOME}/.rep-secrets/near-ai.key`, "utf8")).trim();
  const spend = { usd: 0 };
  const iss = issuerKey();
  const pub = { note: "REP Eval, calibrated: 120 sealed items at 4 levels, 3 NEAR AI models in a fixed token budget; every answer's TEE signature checks against its request and response hashes; grading and the bootstrap CI ran in the worker's code; a separate eval issuer key signed each certificate. The items stay private.", set_root: root, n: items.length, levels: Object.keys(LEVELS), per_level: PER_LEVEL, budget_tokens: BUDGET_TOKENS, item_hashes: items.map(itemHash), issuer_key: `ed25519:${iss.pub}`, models: [] };
  const priv = {};
  for (const model of MODELS) {
    console.log(`\n${model}: ${items.length} items, at most 6 in flight`);
    const answers = await pool(items, 6, (it) => ask(model, it, KEY, spend));
    const valid = answers.filter((a) => a.signature_valid).length;
    if (valid !== answers.length) throw new Error(`${model}: ${answers.length - valid} TEE signatures did not verify; no certificate`);
    const g = grade(items.map((it) => String(it.answer)), answers.map((a) => a.reply));
    const byLevel = Object.fromEntries(Object.keys(LEVELS).map((l) => [l, items.map((it, i) => [it.level, g.correct[i]]).filter(([x, c]) => x === l && c).length]));
    const cert = { v: 0, subject: `${model}@${BUDGET_TOKENS}tok`, set_root: root, n: items.length, correct: g.n_correct, score_bucket: g.score_bucket, answers_hash: sha(answers.map((a) => a.signature_text).join("\n")), issued_at_ms: Date.now() };
    const signature = sign(null, createHash("sha256").update(Buffer.concat([TAG, Buffer.from(certificateJson(cert))])).digest(), iss.priv).toString("hex");
    console.log(`   ${g.n_correct}/${items.length} correct (95% CI ${g.ci95[0].toFixed(1)} to ${g.ci95[1].toFixed(1)}), by level ${JSON.stringify(byLevel)}; ${valid} signatures valid; truncated ${answers.filter((a) => a.finish === "length").length}`);
    pub.models.push({ model, correct: g.n_correct, ci95: g.ci95, by_level: byLevel, truncated: answers.filter((a) => a.finish === "length").length, correct_vector: g.correct, answers: answers.map(({ reply, ...a }) => a), certificate: cert, signature });
    priv[model] = answers.map((a) => a.reply);
  }
  pub.cost_usd = Number(spend.usd.toFixed(4));
  writeFileSync(join(dir, "rep-eval-replies-private.json"), JSON.stringify(priv) + "\n", { mode: 0o600 });
  mkdirSync("fixtures/live/eval", { recursive: true });
  writeFileSync(PUBLIC, JSON.stringify(pub, null, 2) + "\n");
  console.log(`\nrep-eval: ${MODELS.length} certificates signed; cost about $${spend.usd.toFixed(4)}; ${PUBLIC}`);
}

function near(args) {
  for (let i = 0; i < 4; i++) {
    const o = spawnSync("near", args, { encoding: "utf8" });
    const out = `${o.stdout}${o.stderr}`;
    const hash = out.match(/Transaction ID: ([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1];
    if (o.status === 0 && hash) return hash;
    if (!/nonce|429|Too Many|timeout/i.test(out)) throw new Error(out.slice(-400));
  }
  throw new Error("retries exhausted");
}
const call = (method, args, deposit = "0 NEAR") => near(["contract", "call-function", "as-transaction", bazaar, method, "json-args", JSON.stringify(args), "prepaid-gas", "100.0 Tgas", "attached-deposit", deposit, "sign-as", bazaar, "network-config", "testnet", "sign-with-keychain", "send"]);

async function onchain() {
  const pub = JSON.parse(readFileSync(PUBLIC, "utf8"));
  pub.txs = pub.txs ?? {};
  if (!pub.txs.register_issuer) pub.txs.register_issuer = call("register_issuer", { key_id: pub.issuer_key, label: "REP Eval issuer (separate from the set owner and the verdict issuer)" });
  if (!pub.txs.register_set) pub.txs.register_set = call("register_eval_set", { set_root: pub.set_root, n: pub.n, label: `REP Eval 120: 4 levels x ${pub.per_level}, ${pub.budget_tokens}-token budget` });
  for (const m of pub.models) {
    if (m.submit_tx) continue;
    m.submit_tx = call("submit_eval_certificate", { certificate: m.certificate, issuer_key: pub.issuer_key, signature: m.signature }, "0.01 NEAR");
    console.log(`   ${m.model}: certificate on chain ${m.submit_tx}`);
  }
  writeFileSync(PUBLIC, JSON.stringify(pub, null, 2) + "\n");
  // The leaderboard page's data (agents/eval.html reads the scores live and falls back to this).
  const board = { bazaar, set_root: pub.set_root, n: pub.n, levels: pub.levels, budget_tokens: pub.budget_tokens, issuer_key: pub.issuer_key, models: pub.models.map((m) => ({ model: m.model, subject: m.certificate.subject, correct: m.correct, ci95: m.ci95, by_level: m.by_level, bucket: m.certificate.score_bucket, submit_tx: m.submit_tx })) };
  writeFileSync("agents/eval.json", JSON.stringify(board, null, 2) + "\n");
}

/** The public check: no keys, no private items. */
export async function verifyPublic(pub, view) {
  const lines = [];
  for (const m of pub.models) {
    const sigs = m.answers.filter((a) => sigOk({ text: a.signature_text, signature: a.signature, signing_address: a.signing_address }, m.model, null, null)).length;
    const hashOk = sha(m.answers.map((a) => a.signature_text).join("\n")) === m.certificate.answers_hash;
    const k = m.correct_vector.filter(Boolean).length;
    const certOk = verify(null, createHash("sha256").update(Buffer.concat([TAG, Buffer.from(certificateJson(m.certificate))])).digest(), createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub.issuer_key.slice(8), "hex")]), format: "der", type: "spki" }), Buffer.from(m.signature, "hex"));
    const bucket = Math.floor((k * 100) / pub.n / 10) * 10;
    const chain = view ? await view(bazaar, "eval_score", { subject: m.certificate.subject, set_root: pub.set_root }) : null;
    const ok = sigs === pub.n && hashOk && certOk && k === m.certificate.correct && bucket === m.certificate.score_bucket && merkleRoot(pub.item_hashes) === pub.set_root && (view ? chain === bucket : true);
    lines.push([ok, `${m.model}: ${k}/${pub.n} (CI ${m.ci95[0].toFixed(1)} to ${m.ci95[1].toFixed(1)}), ${sigs}/${pub.n} TEE signatures valid, answers hash and issuer signature valid${view ? `, eval_score on chain ${chain}` : ""}`]);
  }
  return lines;
}

const cmd = process.argv[2];
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (cmd === "set") {
      if (existsSync(setPath)) throw new Error("the set exists; it is made once");
      const items = Object.entries(LEVELS).flatMap(([level, f]) => Array.from({ length: PER_LEVEL }, () => { const [question, answer] = f(); return { level, question, answer: String(answer), salt: randomBytes(16).toString("hex") }; }));
      writeFileSync(setPath, JSON.stringify(items, null, 2) + "\n", { mode: 0o600 });
      console.log(`set of ${items.length} private items; root ${merkleRoot(items.map(itemHash))}`);
    } else if (cmd === "run") await run();
    else if (cmd === "onchain") await onchain();
    else if (cmd === "verify") {
      const { rpcClient } = await import("../relayer/near.mjs");
      const client = rpcClient(process.env.NEAR_RPC || "https://test.rpc.fastnear.com");
      const online = process.env.JUDGE_OFFLINE !== "1" && (await client.block().then(() => true, () => false));
      const pub = JSON.parse(readFileSync(PUBLIC, "utf8"));
      const lines = await verifyPublic(pub, online ? (a, mth, args) => client.view(a, mth, args) : null);
      for (const [ok, t] of lines) console.log(`${ok ? "PASS" : "FAIL"}  rep eval ${t}`);
      if (!online) console.log("SKIP  rep eval on-chain scores: no network");
      process.exit(lines.every(([ok]) => ok) ? 0 : 1);
    } else throw new Error("usage: rep-eval.mjs set | run | onchain | verify");
  })().catch((e) => { console.error(`rep-eval: FAIL ${e.message}`); process.exit(1); });
}
