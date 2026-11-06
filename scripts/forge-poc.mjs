#!/usr/bin/env node
// `make forge-poc`: a KNOWN LIMIT, shown on purpose. Nothing here touches the chain.
//
// On the model path the buyer writes the prompt and the facts. The contract sees only the hash
// of the request, and check_binding only checks that it is hex, so a real TEE signature on a
// real answer says what the model was told, not what is true. This script asks the attested
// model about a fact we invent, with no proof and no notary, and gets the predicate with a valid
// TEE signature. Submitting that answer with a real binding is the forgery; the contract test
// known_limit_the_prompt_is_never_checked shows the contract has nothing to refuse it with.
//
// Bound today: the buyer still gets the discount only at schedule prices, and the facts are
// synthetic on every purchase. The fix (an evaluator countersignature) is not built. About $0.001.
// `node scripts/forge-poc.mjs verify` rechecks the committed record offline, no key.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { clientKey, edVerify, fieldKey, openField, openWith, sealTo, sha } from "./lib/e2ee.mjs";

const OUT = "fixtures/live/forge-poc/run.json";
const API = process.env.NEAR_AI_BASE ?? "https://cloud-api.near.ai/v1";
const INVENTED = { id: "F1", platform: "anthropic", field: "monthly_spend_usd", value: 999 };
const RULE = { platform: "anthropic", field: "monthly_spend_usd", min: 20, predicate: "claude_spender" };

function verify() {
  const r = JSON.parse(readFileSync(OUT, "utf8"));
  const body = JSON.parse(r.response);
  const answer = JSON.parse(openField(body.choices[0].message.content, Buffer.from(r.response_key, "hex")).match(/\{[\s\S]*\}/)[0]);
  const [, sReq, sRes] = r.signature.text.split(":");
  const ok = edVerify(r.signature.text, r.signature.signature, r.signing_key) && sRes === sha(Buffer.from(r.response)) && sReq === r.request_sha256 && answer.predicates.includes(RULE.predicate) && answer.bind === r.bind;
  console.log(`${ok ? "PASS" : "FAIL"}  forge PoC: the model attested ${RULE.predicate} from a typed fact, TEE signature valid (a known limit, README)`);
  return ok;
}

if (process.argv[2] === "verify") process.exit(verify() ? 0 : 1);

const CAPTURE = JSON.parse(readFileSync("fixtures/live/near-ai/capture.json", "utf8"));
const MODEL = CAPTURE.model;
const KEY = (process.env.NEAR_AI_KEY ?? readFileSync(`${process.env.HOME}/.rep-secrets/near-ai.key`, "utf8")).trim();
const auth = { Authorization: `Bearer ${KEY}` };
const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
const rep = await fetch(`${API}/attestation/report?model=${encodeURIComponent(MODEL)}&signing_algo=ed25519&nonce=${nonce}`, { headers: { ...auth, "x-no-aliasing": "true" } }).then((r) => r.json());
const signing_key = rep.model_attestations?.[0]?.signing_address;
if (!signing_key) throw new Error("no attested key in the report");
const bind = sha(Buffer.from("forge-poc: a binding the buyer chooses"));
const system = 'You are a verdict issuer. Apply the rule table exactly: a fact proves a predicate when platform and field match and value >= min. Output only JSON {"predicates": [sorted predicate names that are proven], "bind": "<the bind value, unchanged>"}.';
const me = clientKey();
const req = Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 3000, temperature: 0, messages: [{ role: "system", content: sealTo(system, signing_key) }, { role: "user", content: sealTo(JSON.stringify({ rules: [RULE], facts: [INVENTED], bind }), signing_key) }] }));
const res = await fetch(`${API}/chat/completions`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", "X-Signing-Algo": "ed25519", "X-Client-Pub-Key": me.pubHex, "X-Model-Pub-Key": signing_key, "X-Encryption-Version": "2", "x-no-aliasing": "true" }, body: req });
const resBytes = Buffer.from(await res.arrayBuffer());
if (res.status === 402) throw new Error("NEAR AI credits exhausted: stop");
if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
const body = JSON.parse(resBytes);
const wire = body.choices[0].message.content;
openWith(wire, me.xSecret);
const sig = await (await fetch(`${API}/signature/${body.id}?model=${encodeURIComponent(MODEL)}&signing_algo=ed25519`, { headers: auth })).json();
mkdirSync("fixtures/live/forge-poc", { recursive: true });
writeFileSync(OUT, JSON.stringify({
  note: "KNOWN LIMIT, shown on purpose (scripts/forge-poc.mjs). The fact below was typed by us and has no proof. Nothing here went on chain, nothing was bought. response_key opens the answer only.",
  model: MODEL, signing_key, chat_id: body.id, invented_fact: INVENTED, rule: RULE, bind,
  request_sha256: sha(req), response: resBytes.toString("utf8"), response_key: fieldKey(wire, me.xSecret),
  signature: { text: sig.text, signature: sig.signature, signing_address: sig.signing_address },
}, null, 2) + "\n");
if (!verify()) process.exit(1);
