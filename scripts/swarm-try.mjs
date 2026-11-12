#!/usr/bin/env node
// make swarm-try: a mini swarm you run yourself, in about 15 s once built, with no keys.
//
//   1. On your machine: 5 merchant agents bid sealed in one round and 6 buyer agents settle,
//      on the bazaar contract's own code (near-sdk's mocked chain, `bookerbob swarm-try`).
//      Fixture keys, synthetic facts, no network.
//   2. Only if NEAR_AI_KEY is set (yours; a free key from cloud.near.ai): 6 buyer agents each
//      get a live verdict from a NEAR AI model under E2EE v2: the synthetic facts sealed to the
//      model's attested key, the answer sealed back, and the TEE signature over both wire
//      hashes checked against that key. About $0.001 a buyer, on your key. Never printed.
//   3. Over public RPC, no keys: 6 purchases picked at random from our 96-buyer testnet swarm
//      (fixtures/live/swarm/s1.json), each nullifier spent under a NEAR AI verdict and the round
//      still naming the same winner at the same price, with the settle tx on the explorer.
//
// What it is not: step 1 is not testnet, step 3 is our run, not yours. docs/swarm-run.md has
// the full record and its limits.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { clientKey, edVerify, openWith, sealTo, sha } from "./lib/e2ee.mjs";

const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const AI = process.env.NEAR_AI_BASE ?? "https://cloud-api.near.ai/v1";
const MODEL = process.env.NEAR_AI_MODEL ?? "z-ai/glm-5.3-flash";
const EXPLORER = "https://testnet.nearblocks.io/txns/";
const t0 = Date.now();
const ts = () => `${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(5)} s`;
let fails = 0;
const line = (ok, what) => {
  if (!ok) fails++;
  console.log(`${ts()}  ${ok ? "ok  " : "FAIL"}  ${what}`);
};
const head = (s) => console.log(`\n== ${s}`);

// 1. the mini swarm on the contract's own code
head("1. a mini swarm on the bazaar contract's code (your machine, mocked chain, no network)");
const bin = process.env.BOOKERBOB ?? "./target/debug/bookerbob";
await new Promise((done) => {
  const p = spawn(bin, ["swarm-try"], { stdio: ["ignore", "pipe", "ignore"] });
  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d;
    const parts = buf.split("\n");
    buf = parts.pop();
    for (const l of parts) if (!l.startsWith("EVENT_JSON")) console.log(l);
  });
  p.on("close", (code) => {
    if (code !== 0) fails++;
    done();
  });
  p.on("error", (e) => {
    console.log(`FAIL  ${bin}: ${e.message} (run: cargo build -p bookerbob-cli)`);
    fails++;
    done();
  });
});

// 2. live NEAR AI verdicts, on the judge's own key
head("2. live NEAR AI verdicts under E2EE on the same synthetic facts (your NEAR_AI_KEY; not tied to the buyers in 1)");
const KEY = (process.env.NEAR_AI_KEY ?? "").trim();
if (!KEY) {
  console.log("  skipped: set NEAR_AI_KEY (a free key from https://cloud.near.ai) to run 6 live verdicts, about $0.006 on your key.");
  console.log("  offline instead, make verify re-checks a recorded live verdict: its TDX quote, report data, TEE signature and sealed answer.");
} else {
  const auth = { Authorization: `Bearer ${KEY}` };
  const nonce = randomBytes(32).toString("hex");
  const r = await fetch(`${AI}/attestation/report?model=${encodeURIComponent(MODEL)}&signing_algo=ed25519&nonce=${nonce}`, { headers: { ...auth, "x-no-aliasing": "true" } });
  const report = r.ok ? await r.json() : null;
  const modelPub = report?.model_attestations?.[0]?.signing_address;
  line(Boolean(modelPub), `attestation report for ${MODEL}, bound to a fresh nonce: model key ${modelPub ? modelPub.slice(0, 16) + ".." : `missing (HTTP ${r.status})`}`);
  if (modelPub) {
    const proofs = JSON.parse(readFileSync("fixtures/proofs.json", "utf8"));
    const rules = [
      ["airbnb", "trips_12m", 3, "airbnb_frequent"],
      ["anthropic", "monthly_spend_usd", 20, "claude_spender"],
      ["world_id", "verified", 1, "world_id_human"],
    ].map(([platform, field, min, predicate]) => ({ platform, field, min, predicate }));
    const system = 'You are a verdict issuer. Apply the rule table exactly: a fact proves a predicate when platform and field match and value >= min. Output only JSON {"predicates": [sorted predicate names that are proven], "bind": "<the bind value, unchanged>"}.';
    const buyer = async (i) => {
      const bind = sha(`swarm-try buyer ${i} ${nonce}`);
      const me = clientKey();
      const user = JSON.stringify({ rules, facts: proofs.facts.map(({ id, platform, field, value }) => ({ id, platform, field, value })), bind });
      const reqBytes = Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 3000, temperature: 0, messages: [{ role: "system", content: sealTo(system, modelPub) }, { role: "user", content: sealTo(user, modelPub) }] }));
      const res = await fetch(`${AI}/chat/completions`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json", "X-Signing-Algo": "ed25519", "X-Client-Pub-Key": me.pubHex, "X-Model-Pub-Key": modelPub, "X-Encryption-Version": "2", "x-no-aliasing": "true" },
        body: reqBytes,
      });
      const resBytes = Buffer.from(await res.arrayBuffer());
      if (!res.ok) return line(false, `buyer ${i}: chat HTTP ${res.status}${res.status === 402 ? " (credit exhausted on this key)" : ""}`);
      const body = JSON.parse(resBytes);
      const parsed = JSON.parse(openWith(body.choices[0].message.content, me.xSecret).match(/\{[\s\S]*\}/)[0]);
      const sig = await (await fetch(`${AI}/signature/${body.id}?model=${encodeURIComponent(MODEL)}&signing_algo=ed25519`, { headers: auth })).json();
      const [, sReq, sRes] = String(sig.text).split(":");
      const ok = edVerify(sig.text, sig.signature, sig.signing_address) && sReq === sha(reqBytes) && sRes === sha(resBytes) && sig.signing_address === modelPub && parsed.bind === bind;
      line(ok, `buyer ${i}: sealed facts in, sealed answer out [${(parsed.predicates ?? []).join(", ")}], TEE signature over both wire hashes ${ok ? "checked against the attested key" : "DOES NOT CHECK"}`);
    };
    for (let i = 1; i <= 6; i += 3) await Promise.all([i, i + 1, i + 2].map(buyer));
    console.log("  not checked here: the TDX quote behind the model key (make verify checks a recorded one offline).");
  }
}

// 3. our testnet swarm, spot-checked live
head("3. our 96-buyer testnet swarm, 6 purchases picked at random, read live over public RPC");
const rec = JSON.parse(readFileSync("fixtures/live/swarm/s1.json", "utf8"));
const view = async (method, args) => {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: rec.bazaar, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }), signal: AbortSignal.timeout(15000) }).then((x) => x.json()).catch(() => null);
    if (r?.result?.result) return JSON.parse(Buffer.from(r.result.result).toString() || "null");
    await new Promise((ok) => setTimeout(ok, 1500 * (i + 1)));
  }
  throw new Error(`${method}: public RPC did not answer`);
};
const pick = [...rec.purchases].sort(() => Math.random() - 0.5).slice(0, 6);
for (const p of pick) {
  try {
    const [v, w] = await Promise.all([view("verdict", { nullifier: p.nullifier }), view("round_best_quote", { round_id: p.round_id, nullifier: p.nullifier })]);
    const ok = v?.spent && String(v.issuer).startsWith("near-ai:") && w?.merchant === p.merchant && String(w?.quote?.price) === p.price;
    line(ok, `${p.round_id}: NEAR AI verdict ${v?.issuer ? String(v.issuer).slice(0, 16) + ".." : "?"} spent, winner ${w?.merchant ?? "?"} at ${(Number(p.price) / 1e6).toFixed(2)} dUSDC  ${EXPLORER}${p.txs.settle}`);
  } catch (e) {
    line(false, `${p.round_id}: ${e.message}`);
  }
}
console.log(`\nthe whole run: make swarm-verify (all ${rec.totals.purchases_settled} purchases, ${rec.totals.sealed_bids} sealed bids, ${rec.totals.refused_replays} refused replays, public RPC). What it is and is not: docs/swarm-run.md`);
console.log(fails ? `FAIL  swarm-try: ${fails} steps failed` : `PASS  swarm-try in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(fails ? 1 : 0);
