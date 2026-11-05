#!/usr/bin/env node
// `node scripts/register-model.mjs <model>`: a NEAR AI model key registered on bookerbob.testnet
// only against its TDX quote verified on chain.
//   1. the model's attestation report with a fresh nonce (NEAR AI, no credit used)
//   2. its Intel PCS collateral (tools/tdx-collateral, checked off chain at fetch time)
//   3. the quote verified on chain by spike.bookerbob.testnet (start, then step until verified)
//   4. register_model_attestation_verified: the bazaar takes the TCB status from that verification
// Writes fixtures/live/near-ai/models/<slug>/{report.json, collateral.json, run.json}. Testnet only.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { keyFromSeed, rpcClient, send } from "../relayer/near.mjs";

const model = process.argv[2];
if (!model) {
  console.error("usage: register-model.mjs <model id, e.g. deepseek-ai/DeepSeek-V4.1-Flash-1017>");
  process.exit(2);
}
const API = process.env.NEAR_AI_BASE ?? "https://cloud-api.near.ai/v1";
const KEY = (process.env.NEAR_AI_KEY ?? readFileSync(`${process.env.HOME}/.rep-secrets/near-ai.key`, "utf8")).trim();
const BAZAAR = "bookerbob.testnet";
const SPIKE = "spike.bookerbob.testnet";
const dir = `fixtures/live/near-ai/models/${model.replace(/[^A-Za-z0-9.-]+/g, "_")}`;
mkdirSync(dir, { recursive: true });
const c = rpcClient(process.env.NEAR_RPC || "https://test.rpc.fastnear.com");
const link = (h) => `https://testnet.nearblocks.io/txns/${h}`;

// 1. report
const nonce = randomBytes(32).toString("hex");
const res = await fetch(`${API}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ed25519&nonce=${nonce}`, { headers: { Authorization: `Bearer ${KEY}`, "x-no-aliasing": "true" } });
const bytes = Buffer.from(await res.arrayBuffer());
if (!res.ok) throw new Error(`report HTTP ${res.status}`);
const report = JSON.parse(bytes);
const ma = report.model_attestations?.[0];
if (!/^[0-9a-f]{64}$/.test(ma?.signing_address ?? "")) throw new Error("no ed25519 model attestation");
writeFileSync(`${dir}/report.json`, bytes);
console.log(`1. ${model}: report with our nonce, signing key ${ma.signing_address.slice(0, 12)}..`);

// 2. collateral
execFileSync("cargo", ["run", "-q", "--manifest-path", "tools/tdx-collateral/Cargo.toml", "--", `${dir}/report.json`, `${dir}/collateral.json`], { stdio: ["ignore", "inherit", "inherit"] });
const col = JSON.parse(readFileSync(`${dir}/collateral.json`, "utf8"));
console.log(`2. collateral from Intel PCS, checked at ${col.checked_at_secs}`);

// 3. on-chain verification
const signer = "bookerbob-demo.testnet";
const tk = keyFromSeed(readFileSync(`${process.env.HOME}/.rep-secrets/bookerbob-testnet/treasury.seed`, "utf8"));
const call = (method, args, deposit = 0n) => send(c, { signer_id: signer, key: tk, receiver_id: SPIKE, actions: [{ type: "FunctionCall", method_name: method, args, gas: 300n * 10n ** 12n, deposit }] });
const s = await call("start", { quote_hex: ma.intel_quote, collateral_json: JSON.stringify(col.collateral) }, 10n ** 24n / 2n);
if (!s.ok) throw new Error(`start: ${s.error.slice(0, 200)}`);
const calls = [{ step: "start", tx: s.hash }];
const id = s.value;
let st;
for (;;) {
  st = await c.view(SPIKE, "verification", { id });
  if (st[0] === "verified") break;
  const r = await call("step", { id });
  calls.push({ step: st[0], tx: r.hash });
  if (!r.ok) throw new Error(`step ${st[0]}: ${r.error.slice(0, 200)}`);
}
const tcb = st[1].split(" ")[0];
console.log(`3. verified on chain in ${calls.length} calls: ${tcb}, verification ${id.slice(0, 12)}..`);

// 4. register (the bazaar's owner key is in the near-cli keychain)
const att = { model, nonce, report_hash: createHash("sha256").update(bytes).digest("hex"), tcb_status: tcb };
const o = spawnSync("near", ["contract", "call-function", "as-transaction", BAZAAR, "register_model_attestation_verified", "json-args", JSON.stringify({ signing_key: ma.signing_address, attestation: att, verification_id: id }), "prepaid-gas", "80.0 Tgas", "attached-deposit", "0 NEAR", "sign-as", BAZAAR, "network-config", "testnet", "sign-with-keychain", "send"], { encoding: "utf8" });
const out = `${o.stdout}${o.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
const tx = out.match(/Transaction ID: ([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1];
if (!tx || /panicked|Error/.test(out.split("Transaction ID")[1] ?? "")) throw new Error(`register: ${out.slice(-300)}`);
// The registration's callback lands after the tx; wait for the key to appear.
let reg = null;
for (let i = 0; i < 10 && !reg; i++) {
  reg = await c.view(BAZAAR, "model_attestation", { signing_key: ma.signing_address });
  if (!reg) await new Promise((ok) => setTimeout(ok, 2000));
}
if (!reg) throw new Error("the key is not registered after the callback");
console.log(`4. registered on ${BAZAAR} against verification ${id.slice(0, 12)}..: ${JSON.stringify(reg)}  ${link(tx)}`);
writeFileSync(`${dir}/run.json`, JSON.stringify({ model, signing_key: ma.signing_address, attestation: att, spike: SPIKE, verification_id: id, verification: st, calls, register_tx: tx }, null, 2) + "\n");
