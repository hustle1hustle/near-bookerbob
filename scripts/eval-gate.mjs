#!/usr/bin/env node
// `make eval-gate`: a merchant that sells only to a buyer whose verdict was issued by a model
// that passes REP Eval v4 (docs/eval.md). Testnet only.
//
//   node scripts/eval-gate.mjs setup    vetted.<treasury> registers with m01's schedule and sets
//                                       eval_gate {v4 root, "@4000tok/referee-v4", 70}
//   node scripts/eval-gate.mjs refuse   a fresh tester with an ordinary (issuer key) sealed
//                                       verdict asks for a receipt from it: refused on chain
//   node scripts/eval-gate.mjs verify   public check (views and the refusal tx), no keys
//
// What a pass needs, and is not run live: a verdict through submit_near_ai_verdict from a model
// whose v4 certificate is at 70 or more (DeepSeek, 70; glm is 50 and does not pass). That path is
// covered on near-sdk's mocked chain (contract/src/tests.rs, certified_eval).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { keyFromSeed, near, nearPublicKey, rpcClient, send } from "../relayer/near.mjs";

const OUT = "fixtures/live/eval-gate/run.json";
const V4 = "fixtures/live/eval/rep-eval-v4.json";
const SUFFIX = "@4000tok/referee-v4";
const THRESHOLD = 70;
const TGAS = 10n ** 12n;
const fc = (method_name, args, deposit = 0n, gas = 100n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const link = (h) => `https://testnet.nearblocks.io/txns/${h}`;

async function setup(c) {
  const client = rpcClient(c.rpc);
  const merchant = `vetted.${c.treasury}`;
  const seedPath = join(c.keysDir, `${merchant}.seed`);
  const treasury = keyFromSeed(readFileSync(join(c.keysDir, "treasury.seed"), "utf8"));
  const out = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { merchant, txs: {} };
  const ok = (what, r) => {
    if (!r.ok) throw new Error(`${what}: ${r.error}`);
    console.log(`   ok ${what}  ${link(r.hash)}`);
    return r.hash;
  };
  if (!(await client.account(merchant))) {
    writeFileSync(seedPath, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    const k = keyFromSeed(readFileSync(seedPath, "utf8"));
    out.txs.account = ok(`create ${merchant} (its own key ${nearPublicKey(k.pub)})`, await send(client, { signer_id: c.treasury, key: treasury, receiver_id: merchant, actions: [{ type: "CreateAccount" }, { type: "Transfer", deposit: near(0.3) }, { type: "AddKey", public_key_hex: k.pub, permission: "FullAccess" }] }));
  }
  const key = keyFromSeed(readFileSync(seedPath, "utf8"));
  const as = (actions) => send(client, { signer_id: merchant, key, receiver_id: c.bazaar, actions });
  const schedule = (await client.view(c.bazaar, "merchant", { merchant: "m01.bookerbob.testnet" })).schedule;
  if (!(await client.view(c.bazaar, "merchant", { merchant }))) out.txs.register = ok("register_merchant (m01's schedule, category hoodie)", await as([fc("register_merchant", { schedule, category: "hoodie", payout: null }, near(0.05))]));
  const pub = JSON.parse(readFileSync(V4, "utf8"));
  const gate = { set_root: pub.set_root, subject_suffix: SUFFIX, threshold: THRESHOLD };
  out.txs.gate = ok(`set_eval_gate (v4 root ${pub.set_root.slice(0, 12)}.., ${SUFFIX}, ${THRESHOLD})`, await as([fc("set_eval_gate", { gate }, near(0.01))]));
  Object.assign(out, { merchant, gate, schedule });
  mkdirSync("fixtures/live/eval-gate", { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
}

async function refuse(c) {
  const { Demo } = await import("./demo-tester.mjs");
  const out = JSON.parse(readFileSync(OUT, "utf8"));
  const dir = join(c.keysDir, "eval-gate");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "merchants.json"), JSON.stringify([{ account: out.merchant, label: "eval-gated merchant", category: "hoodie", schedule: out.schedule }], null, 2) + "\n");
  for (const f of ["proofs.json", "claims-honest.json"]) writeFileSync(join(dir, f), readFileSync(join("fixtures", f)));
  const d = new Demo({ ...c, merchant: out.merchant, category: "hoodie" });
  const want = "merchant's eval gate: the verdict was not issued by a NEAR AI model key";
  try {
    await d.run({ proofs: join(dir, "proofs.json"), fixturesDir: dir, sealed: true });
    throw new Error("the receipt went through: the gate did not hold");
  } catch (e) {
    const last = d.log.at(-1);
    if (!String(e.message).includes(want) || !last?.hash) throw e;
    out.refusal = { tester: last.account, tx: last.hash, error: want };
    console.log(`\nrefused on chain as expected: ${want}\n   ${link(last.hash)}`);
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
}

export async function verifyGate(view, tx) {
  const out = JSON.parse(readFileSync(OUT, "utf8"));
  const pub = JSON.parse(readFileSync(V4, "utf8"));
  const lines = [];
  const g = await view("bookerbob.testnet", "eval_gate", { merchant: out.merchant });
  lines.push([g?.set_root === pub.set_root && g.threshold === THRESHOLD && g.subject_suffix === SUFFIX, `eval_gate on ${out.merchant.split(".")[0]}: v4 root ${pub.set_root.slice(0, 12)}.., ${SUFFIX}, threshold ${THRESHOLD}`]);
  for (const m of pub.models) {
    const passes = await view("bookerbob.testnet", "eval_passes", { subject: m.certificate.subject, set_root: pub.set_root, threshold: THRESHOLD });
    lines.push([passes === m.certificate.score_bucket >= THRESHOLD, `eval_passes(${m.model.split("/")[1]}${SUFFIX}, v4, ${THRESHOLD}) = ${passes} (bucket ${m.certificate.score_bucket})`]);
  }
  if (out.refusal && tx) {
    const t = await tx(out.refusal.tx, out.refusal.tester);
    const fail = JSON.stringify([t.transaction_outcome, ...t.receipts_outcome].map((o) => o.outcome.status.Failure).find(Boolean) ?? "");
    lines.push([fail.includes("not issued by a NEAR AI model key"), `an ordinary verdict's receipt for the gated merchant was refused on chain (${out.refusal.tx.slice(0, 8)}..)`]);
  }
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { config, guard } = await import("./demo-tester.mjs");
  const c = config(process.env);
  const cmd = process.argv[2];
  const go = async () => {
    if (cmd === "setup") return setup(c);
    if (cmd === "refuse") return refuse(c);
    if (cmd === "verify") {
      const client = rpcClient(process.env.NEAR_RPC || "https://test.rpc.fastnear.com");
      const lines = await verifyGate((a, m, args) => client.view(a, m, args), async (h, s) => (await client.rpc("tx", { tx_hash: h, sender_account_id: s, wait_until: "FINAL" })).result);
      for (const [ok, t] of lines) console.log(`${ok ? "PASS" : "FAIL"}  ${t}`);
      process.exit(lines.every(([ok]) => ok) ? 0 : 1);
    }
    throw new Error("usage: eval-gate.mjs setup | refuse | verify");
  };
  const no = cmd === "verify" ? null : guard(c);
  if (no) {
    console.error(`refusing: ${no}`);
    process.exit(2);
  }
  go().catch((e) => {
    console.error(`eval-gate: STOP ${e.message}`);
    process.exit(1);
  });
}
