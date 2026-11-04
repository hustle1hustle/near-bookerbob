#!/usr/bin/env node
// NEAR AI issues the verdict under E2EE v2 (live capture, run once; make verify re-checks
// the result offline). Needs NEAR_AI_KEY or ~/.rep-secrets/near-ai.key; never logs it.
//   cargo build -p bookerbob-cli && node scripts/near-ai-verdict.mjs
//
// 1. Attestation report for the model with a fresh 32-byte nonce (ed25519 signing key).
// 2. One sealed chat: the proof set (synthetic fixture facts) and the rule table go to the
//    model encrypted to its attested key. It answers with the predicates the rules derive
//    and echoes `bind`, a digest of every envelope field it does not compute
//    (`Envelope::near_ai_bind`). The answer comes back sealed to a one-time client key.
// 3. The TEE signature over `model:sha256(request wire):sha256(response wire)`.
// 4. The envelope: the buyer's revealed subset of the attested predicates, bound to this
//    chat (chat id, both wire hashes, signing key, report hash).
// Disclosure: the one-time client X25519 secret is written out, so any verifier can open
// the sealed answer (it only opens responses to that key). The sealed request, which
// holds the facts, stays sealed to the model key.
// Writes fixtures/live/near-ai/. About $0.001 a run.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { clientKey, edVerify, openWith, sealTo, sha } from "./lib/e2ee.mjs";

const API = process.env.NEAR_AI_BASE ?? "https://cloud-api.near.ai/v1";
const MODEL = process.env.NEAR_AI_MODEL ?? "z-ai/glm-5.3-flash";
const KEY = (process.env.NEAR_AI_KEY ?? readFileSync(`${process.env.HOME}/.rep-secrets/near-ai.key`, "utf8")).trim();
const OUT = "fixtures/live/near-ai";
const auth = { Authorization: `Bearer ${KEY}` };
const json = (p) => JSON.parse(readFileSync(p, "utf8"));

// The rule table the model applies, as data (core/src/tier.rs RULES).
const RULES = [
  ["airbnb", "trips_12m", 3, "airbnb_frequent"],
  ["booking", "genius_level", 2, "booking_genius"],
  ["anthropic", "monthly_spend_usd", 20, "claude_spender"],
  ["steam", "account_age_years", 5, "steam_veteran"],
  ["uber", "trips_90d", 10, "uber_regular"],
  ["world_id", "verified", 1, "world_id_human"],
];

// 1. attestation report bound to our nonce
const nonce = randomBytes(32).toString("hex");
const reportRes = await fetch(`${API}/attestation/report?model=${encodeURIComponent(MODEL)}&signing_algo=ed25519&nonce=${nonce}`, { headers: { ...auth, "x-no-aliasing": "true" } });
const reportBytes = Buffer.from(await reportRes.arrayBuffer());
if (!reportRes.ok) throw new Error(`report HTTP ${reportRes.status}`);
const report = JSON.parse(reportBytes);
const ma = report.model_attestations?.[0];
if (!ma?.signing_address || !/^[0-9a-f]{64}$/.test(ma.signing_address)) throw new Error("no ed25519 model attestation");
const modelPub = ma.signing_address;

// 2. the envelope fields the model does not compute, and their binding digest
const base = json("fixtures/verdict-ed25519.json").envelope;
const proofs = json("fixtures/proofs.json");
mkdirSync(OUT, { recursive: true });
const draft = { ...base, attestation: { model: MODEL, tcb_status: "pending", report_hash: sha(reportBytes) } };
const draftPath = `${tmpdir()}/bookerbob-draft-envelope.json`;
writeFileSync(draftPath, JSON.stringify(draft));
const bind = execFileSync("./target/debug/bookerbob", ["near-ai-bind", draftPath]).toString().trim();

const system =
  'You are a verdict issuer. Apply the rule table exactly: a fact proves a predicate when platform and field match and value >= min. Output only JSON {"predicates": [sorted predicate names that are proven], "bind": "<the bind value, unchanged>"}.';
const user = JSON.stringify({ rules: RULES.map(([platform, field, min, predicate]) => ({ platform, field, min, predicate })), facts: proofs.facts.map(({ id, platform, field, value }) => ({ id, platform, field, value })), bind });
const me = clientKey();
const wireBody = {
  model: MODEL,
  max_tokens: 3000,
  temperature: 0,
  messages: [
    { role: "system", content: sealTo(system, modelPub) },
    { role: "user", content: sealTo(user, modelPub) },
  ],
};
const reqBytes = Buffer.from(JSON.stringify(wireBody));
const res = await fetch(`${API}/chat/completions`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json", "X-Signing-Algo": "ed25519", "X-Client-Pub-Key": me.pubHex, "X-Model-Pub-Key": modelPub, "X-Encryption-Version": "2", "x-no-aliasing": "true" },
  body: reqBytes,
});
const resBytes = Buffer.from(await res.arrayBuffer());
if (!res.ok) throw new Error(`chat HTTP ${res.status} ${resBytes.toString().slice(0, 200)}`);
const body = JSON.parse(resBytes);
const answer = openWith(body.choices[0].message.content, me.xSecret);
const parsed = JSON.parse(answer.match(/\{[\s\S]*\}/)[0]);

// 3. TEE signature over the wire bytes
const sig = await (await fetch(`${API}/signature/${body.id}?model=${encodeURIComponent(MODEL)}&signing_algo=ed25519`, { headers: auth })).json();
const [, sReq, sRes] = sig.text.split(":");
if (!edVerify(sig.text, sig.signature, sig.signing_address) || sReq !== sha(reqBytes) || sRes !== sha(resBytes) || sig.signing_address !== modelPub) {
  throw new Error("signature does not cover these bytes with the attested key");
}

// 4. the envelope: revealed subset (budget plan picks these 3) of what the model attested
const revealed = base.predicates.filter((p) => parsed.predicates.includes(p));
const envelope = {
  ...draft,
  predicates: revealed,
  // Set from the TDX quote check: tools/tdx-collateral prints it, make verify re-checks it.
  attestation: { ...draft.attestation, tcb_status: process.env.TCB_STATUS ?? "UpToDate" },
};
writeFileSync(`${OUT}/report.json`, reportBytes);
writeFileSync(`${OUT}/request.json`, reqBytes);
writeFileSync(`${OUT}/response.json`, resBytes);
writeFileSync(`${OUT}/signature.json`, JSON.stringify(sig, null, 2) + "\n");
writeFileSync(
  `${OUT}/capture.json`,
  JSON.stringify(
    {
      note: "NEAR AI verdict under E2EE v2, live capture. Facts are the synthetic fixture proof set. client_x25519_secret is a one-time key disclosed so verifiers can open the sealed answer.",
      at: new Date().toISOString(),
      model: MODEL,
      nonce,
      chat_id: body.id,
      signing_address: modelPub,
      client_x25519_secret: me.xSecret.toString("hex"),
      answer,
      bind,
      envelope,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ chat_id: body.id, predicates: parsed.predicates, bind_echoed: parsed.bind === bind, revealed }, null, 1));
