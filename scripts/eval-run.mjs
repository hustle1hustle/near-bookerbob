#!/usr/bin/env node
// Certified private eval, the envelope's second use (README "Three flows": prove, then the
// same certificate machinery for an agent's skill). A model answers a SEALED set of 20 items
// on NEAR AI Cloud; every answer's TEE signature is checked against the attested model key;
// code grades exact answers; the testnet issuer key signs a certificate (set root, n, correct,
// score floored to 10, sha256 of the signature texts) that the bazaar stores.
//
//   node scripts/eval-run.mjs set            make the private set once (KEYS_DIR/eval/set.json)
//   node scripts/eval-run.mjs run            ask, check signatures, grade, sign the certificate
//
// Public (fixtures/live/eval/run.json): the set root, item hashes, per-answer chat ids and
// signatures, the certificate. Private (KEYS_DIR/eval): the items, their salts, the answers.
// Needs ~/.rep-secrets/near-ai.key (never logged). Spend cap 0.05 USD.
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./demo-tester.mjs";

const API = process.env.NEAR_AI_BASE ?? "https://cloud-api.near.ai/v1";
const MODEL = process.env.NEAR_AI_MODEL ?? "z-ai/glm-5.3-flash";
const BUDGET_USD = 0.05;
const PRICE_IN = 0.1 / 1e6, PRICE_OUT = 0.4 / 1e6;
const N = 20;
const TAG = Buffer.from("bookerbob/eval-certificate/v0\x00", "latin1");
const sha = (b) => createHash("sha256").update(b).digest("hex");

/** Merkle root over the item hashes (sha256 of left || right; an odd last node is carried up). */
export function merkleRoot(leaves) {
  let level = leaves.map((h) => Buffer.from(h, "hex"));
  if (!level.length) return sha("");
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? createHash("sha256").update(Buffer.concat([level[i], level[i + 1]])).digest() : level[i]);
    level = next;
  }
  return level[0].toString("hex");
}

export const itemHash = (it) => sha(`${it.salt}|${it.question}|${it.answer}`);

/** The last integer in a reply, or null. */
export function parseAnswer(text) {
  const m = String(text).replace(/,/g, "").match(/-?\d+/g);
  return m ? Number(m.at(-1)) : null;
}

/** The certificate exactly as the contract's serde writes it (field order matters). */
export function certificateJson(c) {
  return JSON.stringify({ v: c.v, subject: c.subject, set_root: c.set_root, n: c.n, correct: c.correct, score_bucket: c.score_bucket, answers_hash: c.answers_hash, issued_at_ms: c.issued_at_ms });
}

function makeSet() {
  const items = [];
  for (let i = 0; i < N; i++) {
    const a = 12 + Math.floor(Math.random() * 88), b = 12 + Math.floor(Math.random() * 88), c = 2 + Math.floor(Math.random() * 9);
    items.push({ question: `Compute (${a} * ${b}) - ${c}. Reply with the number only.`, answer: a * b - c, salt: randomBytes(16).toString("hex") });
  }
  return items;
}

async function main() {
  const c = config(process.env);
  const dir = join(c.keysDir, "eval");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const setPath = join(dir, "set.json");
  const cmd = process.argv[2];
  if (cmd === "set") {
    if (existsSync(setPath)) throw new Error("the set exists; it is made once");
    const items = makeSet();
    writeFileSync(setPath, JSON.stringify(items, null, 2) + "\n", { mode: 0o600 });
    console.log(`set of ${N} private items; root ${merkleRoot(items.map(itemHash))}`);
    return;
  }
  if (cmd !== "run") throw new Error("usage: eval-run.mjs set | run");
  const items = JSON.parse(readFileSync(setPath, "utf8"));
  const root = merkleRoot(items.map(itemHash));
  const KEY = (process.env.NEAR_AI_KEY ?? readFileSync(`${process.env.HOME}/.rep-secrets/near-ai.key`, "utf8")).trim();
  let spent = 0;
  const answers = [];
  for (const [i, it] of items.entries()) {
    if (spent > BUDGET_USD) throw new Error("budget reached");
    const req = Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 1200, temperature: 0, messages: [{ role: "user", content: it.question }] }));
    const res = await fetch(`${API}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: req });
    const resBytes = Buffer.from(await res.arrayBuffer());
    if (!res.ok) throw new Error(`item ${i}: HTTP ${res.status}`);
    const body = JSON.parse(resBytes);
    spent += (body.usage?.prompt_tokens ?? 0) * PRICE_IN + (body.usage?.completion_tokens ?? 0) * PRICE_OUT;
    const s = await (await fetch(`${API}/signature/${body.id}?model=${encodeURIComponent(MODEL)}&signing_algo=ed25519`, { headers: { Authorization: `Bearer ${KEY}` } })).json().catch(() => null);
    const der = s ? Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(s.signing_address, "hex")]) : null;
    const sigOk = Boolean(s) && verify(null, Buffer.from(s.text, "utf8"), createPublicKey({ key: der, format: "der", type: "spki" }), Buffer.from(s.signature, "hex"));
    const [sm, sq, sr] = s ? s.text.split(":") : [];
    const bound = sm === MODEL && sq === sha(req) && sr === sha(resBytes);
    const got = parseAnswer(body.choices?.[0]?.message?.content ?? "");
    answers.push({ i, item_hash: itemHash(it), chat_id: body.id, signature_text: s?.text, signature: s?.signature, signing_address: s?.signing_address, signature_valid: sigOk && bound, correct: got === it.answer, _got: got });
    console.log(`${String(i + 1).padStart(2)}  ${got === it.answer ? "correct" : "wrong  "}  signature ${sigOk && bound ? "valid, bound to request and response" : "NOT valid"}`);
  }
  if (!answers.every((a) => a.signature_valid)) throw new Error("an answer's TEE signature did not verify: no certificate");
  const correct = answers.filter((a) => a.correct).length;
  const cert = { v: 0, subject: MODEL, set_root: root, n: N, correct, score_bucket: Math.floor((correct * 100) / N / 10) * 10, answers_hash: sha(answers.map((a) => a.signature_text).join("\n")), issued_at_ms: Date.now() };
  const seed = Buffer.from(readFileSync(join(c.keysDir, "issuer.seed"), "utf8").trim(), "hex");
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(12).toString("hex");
  const digest = createHash("sha256").update(Buffer.concat([TAG, Buffer.from(certificateJson(cert))])).digest();
  const signature = sign(null, digest, priv).toString("hex");
  writeFileSync(join(dir, "answers-private.json"), JSON.stringify(answers.map(({ i, _got }) => ({ i, got: _got })), null, 2) + "\n", { mode: 0o600 });
  mkdirSync("fixtures/live/eval", { recursive: true });
  const pubRun = { note: "Certified private eval: the items stay private; each answer's NEAR AI TEE signature is public and checks against the request and response hashes; code graded the answers; the testnet issuer key signed the certificate.", model: MODEL, set_root: root, item_hashes: items.map(itemHash), answers: answers.map(({ _got, ...a }) => a), certificate: cert, issuer_key: `ed25519:${pub}`, signature, cost_usd: Number(spent.toFixed(5)) };
  writeFileSync("fixtures/live/eval/run.json", JSON.stringify(pubRun, null, 2) + "\n");
  console.log(`\n${correct}/${N} correct, bucket ${cert.score_bucket}; ${answers.length}/${N} TEE signatures valid; cost $${spent.toFixed(4)}; certificate signed. fixtures/live/eval/run.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`eval-run: FAIL ${e.message}`); process.exit(1); });
