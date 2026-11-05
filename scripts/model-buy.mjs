#!/usr/bin/env node
// `make model-buy`: one testnet purchase whose verdict a NEAR AI model issued, not REP's issuer key.
//
//  1. A fresh tester: account, storage, dUSDC, World attestation (the demo path).
//  2. The model: the tester's proof set (synthetic fixture facts) and the rule table go sealed to
//     the model key registered on bookerbob.testnet (E2EE v2; registered against its on-chain TDX
//     quote verification). It answers with the predicates the rules derive and echoes `bind`, a
//     digest of every envelope field it does not compute. Its TEE signature covers both wire hashes.
//  3. submit_near_ai_verdict: the contract checks the registered key, the attestation nonce, the
//     TEE signature, the binding and that every revealed predicate is one the model attested.
//  4. The gate: the same verdict asks vetted (eval gate: REP Eval v4 >= 70) for a receipt. The
//     model is glm at bucket 50, so the contract refuses it.
//  5. m01 (no gate): receipt, escrow, settle in dUSDC, the replay refused.
//  6. fixtures/live/model-buy/run.json: hashes and txs; the one-time client secret is disclosed
//     so anyone can open the sealed answer (the sealed request, with the facts, stays sealed).
//
// Testnet only; dUSDC is a demo token. Needs NEAR_AI_KEY or ~/.rep-secrets/near-ai.key (never logged).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clientKey, edVerify, fieldKey, openWith, sealTo, sha } from "./lib/e2ee.mjs";

const API = process.env.NEAR_AI_BASE ?? "https://cloud-api.near.ai/v1";
const CAPTURE = JSON.parse(readFileSync("fixtures/live/near-ai/capture.json", "utf8"));
const MODEL_KEY = CAPTURE.signing_address;
const OUT = "fixtures/live/model-buy/run.json";
// The rule table the model applies (core/src/tier.rs RULES), as in scripts/near-ai-verdict.mjs.
const RULES = [
  ["airbnb", "trips_12m", 3, "airbnb_frequent"],
  ["booking", "genius_level", 2, "booking_genius"],
  ["anthropic", "monthly_spend_usd", 20, "claude_spender"],
  ["github", "account_age_years", 3, "github_builder"],
  ["steam", "account_age_years", 5, "steam_veteran"],
  ["uber", "trips_90d", 10, "uber_regular"],
  ["world_id", "verified", 1, "world_id_human"],
];
const cli = (args) => execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", ...args], { encoding: "utf8" }).trim();

/** The model issues the verdict for `base` (the tester's envelope): returns envelope, proof, record. */
export async function issue(client, bazaar, base, proofsPath, keysDir) {
  const KEY = (process.env.NEAR_AI_KEY ?? readFileSync(`${process.env.HOME}/.rep-secrets/near-ai.key`, "utf8")).trim();
  const auth = { Authorization: `Bearer ${KEY}` };
  const att = await client.view(bazaar, "model_attestation", { signing_key: MODEL_KEY });
  if (!att) throw new Error(`model key ${MODEL_KEY.slice(0, 12)}.. is not registered on ${bazaar}`);
  // The key must still be the model's: a fresh report today names the same signing address.
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const rep = await fetch(`${API}/attestation/report?model=${encodeURIComponent(att.model)}&signing_algo=ed25519&nonce=${nonce}`, { headers: { ...auth, "x-no-aliasing": "true" } }).then((r) => r.json());
  const today = (rep.model_attestations ?? []).map((m) => m.signing_address);
  if (!today.includes(MODEL_KEY)) throw new Error(`the model no longer signs with the registered key (today: ${today.map((k) => k.slice(0, 12)).join(", ")}): register the new key first`);
  const draft = { ...base, attestation: { model: att.model, tcb_status: att.tcb_status, report_hash: att.report_hash } };
  const dir = join(keysDir, "model-buy");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "draft.json"), JSON.stringify(draft));
  const bind = cli(["near-ai-bind", join(dir, "draft.json")]);
  const proofs = JSON.parse(readFileSync(proofsPath, "utf8"));
  const system = 'You are a verdict issuer. Apply the rule table exactly: a fact proves a predicate when platform and field match and value >= min. Output only JSON {"predicates": [sorted predicate names that are proven], "bind": "<the bind value, unchanged>"}.';
  const user = JSON.stringify({ rules: RULES.map(([platform, field, min, predicate]) => ({ platform, field, min, predicate })), facts: proofs.facts.map(({ id, platform, field, value }) => ({ id, platform, field, value })), bind });
  const me = clientKey();
  const req = Buffer.from(JSON.stringify({ model: att.model, max_tokens: 3000, temperature: 0, messages: [{ role: "system", content: sealTo(system, MODEL_KEY) }, { role: "user", content: sealTo(user, MODEL_KEY) }] }));
  const res = await fetch(`${API}/chat/completions`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", "X-Signing-Algo": "ed25519", "X-Client-Pub-Key": me.pubHex, "X-Model-Pub-Key": MODEL_KEY, "X-Encryption-Version": "2", "x-no-aliasing": "true" }, body: req });
  const resBytes = Buffer.from(await res.arrayBuffer());
  if (res.status === 402) throw new Error("NEAR AI credits exhausted: stop");
  if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
  const body = JSON.parse(resBytes);
  const wire = body.choices[0].message.content;
  const answer = JSON.parse(openWith(wire, me.xSecret).match(/\{[\s\S]*\}/)[0]);
  if (answer.bind !== bind) throw new Error("the model did not echo the binding");
  const missing = base.predicates.filter((p) => !answer.predicates.includes(p));
  if (missing.length) throw new Error(`the model did not attest ${missing.join(", ")}: stop (the referee claims cite them)`);
  const sig = await (await fetch(`${API}/signature/${body.id}?model=${encodeURIComponent(att.model)}&signing_algo=ed25519`, { headers: auth })).json();
  const [, sReq, sRes] = sig.text.split(":");
  if (!edVerify(sig.text, sig.signature, sig.signing_address) || sReq !== sha(req) || sRes !== sha(resBytes) || sig.signing_address !== MODEL_KEY) throw new Error("the TEE signature does not cover these bytes with the registered key");
  const proof = { chat_id: body.id, signing_key: MODEL_KEY, nonce: att.nonce, request_sha256: sha(req), response: resBytes.toString("utf8"), response_key: fieldKey(wire, me.xSecret), signature: sig.signature };
  console.log(`   ${att.model} (E2EE v2, facts sealed to the registered key ${MODEL_KEY.slice(0, 12)}..): ${answer.predicates.join(", ")}; binding echoed; TEE signature valid`);
  return { envelope: { ...draft, predicates: base.predicates }, proof, record: { model: att.model, signing_key: MODEL_KEY, chat_id: body.id, request_sha256: sha(req), response_sha256: sha(resBytes), client_x25519_secret: me.xSecret.toString("hex"), attested: answer.predicates } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { config, guard, Demo } = await import("./demo-tester.mjs");
  const c = config(process.env);
  const no = guard(c);
  if (no) {
    console.error(`refusing: ${no}`);
    process.exit(2);
  }
  const gate = JSON.parse(readFileSync("fixtures/live/eval-gate/run.json", "utf8"));
  const d = new Demo(c);
  const out = { note: "One testnet purchase whose verdict a NEAR AI model issued (submit_near_ai_verdict), not REP's issuer key. Facts are the synthetic fixture proof set. client_x25519_secret is a one-time key disclosed so anyone can open the sealed answer; the sealed request, which holds the facts, stays sealed to the model key." };
  const beforeReceipt = async ({ tester, rec, live, d: demo }) => {
    // The same verdict asks the eval-gated merchant first: refused, glm is under its threshold.
    const dir = join(c.keysDir, "model-buy", "vetted");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "merchants.json"), JSON.stringify([{ account: gate.merchant, label: "eval-gated merchant", category: "hoodie", schedule: gate.schedule }]));
    for (const f of ["proofs.json", "claims-honest.json"]) writeFileSync(join(dir, f), readFileSync(join("fixtures", f)));
    const q = await demo.client.view(c.bazaar, "quote", { merchant: c.merchant, nullifier: rec.nullifier });
    const input = execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", "worker-input", dir, join(live, "verdict.json"), String(q?.cohort?.k ?? 0)], { encoding: "utf8" });
    const seed = readFileSync(join(c.keysDir, "referee.seed"), "utf8").trim();
    const result = JSON.parse(execFileSync("cargo", ["run", "-q", "-p", "bookerbob-referee-worker"], { input, encoding: "utf8", env: { ...process.env, REFEREE_SIGNING_SEED: seed } }));
    console.log(`   the eval gate: ${gate.merchant.split(".")[0]} requires v4 >= ${gate.gate.threshold}; the same verdict asks it for a receipt`);
    try {
      await demo.relay("submit_referee_result (gated merchant)", tester, c.bazaar, { type: "FunctionCall", method_name: "submit_referee_result", args: { result }, gas: 100n * 10n ** 12n, deposit: 0n });
      throw new Error("the gated merchant accepted a model under its threshold");
    } catch (e) {
      if (!String(e.message).includes("does not pass")) throw e;
      rec.txs.gate_refused = demo.log.at(-1).hash;
      console.log("   refused on chain as expected: the model does not pass the gate");
    }
  };
  const rec = await d.run({ nearAi: (base) => issue(d.client, c.bazaar, base, "fixtures/proofs.json", c.keysDir), beforeReceipt });
  const v = await d.client.view(c.bazaar, "verdict", { nullifier: rec.nullifier });
  if (v.issuer !== `near-ai:${MODEL_KEY}`) throw new Error(`the verdict's issuer is ${v.issuer}`);
  Object.assign(out, { tester: rec.tester, merchant: c.merchant, nullifier: rec.nullifier, price: rec.price, issuer: v.issuer, gate_merchant: gate.merchant, near_ai: rec.near_ai, txs: rec.txs });
  mkdirSync("fixtures/live/model-buy", { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nmodel-buy: PASS  ${OUT} (issuer ${v.issuer.slice(0, 20)}.., paid ${Number(rec.price) / 1e6} dUSDC)`);
}
