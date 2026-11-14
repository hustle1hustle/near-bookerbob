#!/usr/bin/env node
// The NEAR AI model's TDX quote verified on chain on mainnet: the same resumable dcap-qvl verifier
// as spike.bookerbob.testnet (byte-identical wasm, read from that account) on a fresh implicit
// mainnet account; start then step until verified, on the quote and Intel PCS collateral already
// in fixtures/live/near-ai/models/<model>/; then on the mainnet bazaar (owner calls, no redeploy)
// set_quote_verifier and register_model_attestation_verified for the model key.
//   node scripts/mainnet-dcap.mjs run --mainnet     BOOKERBOB_MAINNET_GO=<today>; stops above 8 NEAR spent
//   node scripts/mainnet-dcap.mjs check             keyless: the verification and the bazaar's record
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { b58decode, b58encode, keyFromSeed, rpcClient, send } from "../relayer/near.mjs";

const RPC = process.env.NEAR_MAINNET_RPC ?? "https://rpc.mainnet.fastnear.com";
const MODEL_DIR = "fixtures/live/near-ai/models/deepseek-ai_DeepSeek-V4.1-Flash-1017";
const BZ = JSON.parse(readFileSync("fixtures/mainnet/bazaar.json", "utf8"));
const OUT = "fixtures/mainnet/dcap.json";
const TGAS = 10n ** 12n, NEAR = 10n ** 24n;
const CAP = 8n * NEAR;
const link = (h) => `https://nearblocks.io/txns/${h}`;
const fc = (method_name, args, deposit = 0n, gas = 300n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });

function dcapKey() {
  const d = join(homedir(), ".rep-secrets", "bookerbob-mainnet", "dcap");
  const f = readdirSync(d).find((x) => x.endsWith(".json"));
  const j = JSON.parse(readFileSync(join(d, f), "utf8"));
  const k = keyFromSeed(Buffer.from(b58decode(j.private_key.replace("ed25519:", ""))).subarray(0, 32).toString("hex"));
  if (k.pub !== j.account_id) throw new Error("the DCAP key does not match its implicit account");
  return { id: j.account_id, key: k };
}

async function run(c) {
  const today = new Date().toISOString().slice(0, 10);
  if (!process.argv.includes("--mainnet") || process.env.BOOKERBOB_MAINNET_GO !== today) throw new Error(`real money: --mainnet and BOOKERBOB_MAINNET_GO=${today}`);
  const { id: V, key } = dcapKey();
  const bz = keyFromSeed(readFileSync(join(homedir(), ".rep-secrets", "bookerbob-mainnet", "bazaar.seed"), "utf8"));
  const B = BZ.bazaar;
  const bal = async () => BigInt((await c.rpc("query", { request_type: "view_account", finality: "final", account_id: V })).result.amount);
  const start = await bal();
  const rec = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { note: "The NEAR AI model's TDX quote verified on chain on mainnet by the same dcap-qvl verifier as spike.bookerbob.testnet (byte-identical wasm), then the mainnet bazaar's quote verifier set to it and the model key registered against that verification. Check: node scripts/mainnet-dcap.mjs check", network: "mainnet", verifier: V, bazaar: B, model_dir: MODEL_DIR, balance_before: start.toString(), txs: {} };
  const save = () => writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
  const spent = async () => { const s = start - (await bal()); if (s > CAP) throw new Error(`spent ${Number(s) / 1e24} NEAR, over the 8 NEAR cap: stop`); return s; };
  const tx = async (name, signer, k, receiver, actions) => {
    if (rec.txs[name]) return console.log(`skip ${name} (done)`);
    const r = await send(c, { signer_id: signer, key: k, receiver_id: receiver, actions });
    console.log(`${r.ok ? "ok  " : "FAIL"} ${name}  ${link(r.hash)}${r.ok ? "" : `  ${String(r.error).slice(0, 300)}`}`);
    if (!r.ok) throw new Error(`${name} failed`);
    rec.txs[name] = r.hash; save(); await spent();
    return r;
  };
  // 1. the verifier: the exact bytes spike.bookerbob.testnet runs
  const t = rpcClient("https://test.rpc.fastnear.com");
  const code = Buffer.from((await t.rpc("query", { request_type: "view_code", finality: "final", account_id: "spike.bookerbob.testnet" })).result.code_base64, "base64");
  rec.code_hash = b58encode(createHash("sha256").update(code).digest()); save();
  console.log(`verifier wasm: ${code.length} bytes, code hash ${rec.code_hash} (spike.bookerbob.testnet's)`);
  await tx("deploy verifier", V, key, V, [{ type: "DeployContract", code }]);
  // 2. the quote: start, then step until verified
  const report = JSON.parse(readFileSync(join(MODEL_DIR, "report.json"), "utf8"));
  const col = JSON.parse(readFileSync(join(MODEL_DIR, "collateral.json"), "utf8")).collateral;
  const reg = JSON.parse(readFileSync(join(MODEL_DIR, "run.json"), "utf8"));
  const ma = report.model_attestations.find((x) => x.signing_address === reg.signing_key) ?? report.model_attestations[0];
  if (!rec.verification_id) {
    const r = await tx("start", V, key, V, [fc("start", { quote_hex: ma.intel_quote, collateral_json: JSON.stringify(col) }, NEAR / 2n)]);
    rec.verification_id = r.value; save();
    if (!/^[0-9a-f]{64}$/.test(String(rec.verification_id))) throw new Error(`start returned ${r.value}`);
  }
  for (let i = 0; i < 6; i++) {
    const st = await c.view(V, "verification", { id: rec.verification_id });
    if (st[0] === "verified") { rec.verification = st; save(); break; }
    await tx(`step ${st[0]}`, V, key, V, [fc("step", { id: rec.verification_id })]);
  }
  if (!rec.verification) throw new Error("not verified after the steps");
  console.log(`   verified: ${rec.verification[1]?.slice(0, 80)}`);
  // 3. the bazaar: the quote verifier, then the model key against this verification
  await tx("set_quote_verifier", B, bz, B, [fc("set_quote_verifier", { verifier: V }, 0n, 30n * TGAS)]);
  await tx("register_model_attestation_verified", B, bz, B, [fc("register_model_attestation_verified", { signing_key: reg.signing_key, attestation: reg.attestation, verification_id: rec.verification_id }, 0n, 100n * TGAS)]);
  rec.spent_near = (Number(await spent()) / 1e24).toFixed(4); rec.balance_after = (await bal()).toString(); save();
  await check(c);
}

async function check(c) {
  const rec = JSON.parse(readFileSync(OUT, "utf8"));
  const st = await c.view(rec.verifier, "verification", { id: rec.verification_id });
  const qv = await c.view(rec.bazaar, "quote_verifier", {});
  const reg = JSON.parse(readFileSync(join(rec.model_dir, "run.json"), "utf8"));
  const att = await c.view(rec.bazaar, "model_attestation", { signing_key: reg.signing_key });
  const acct = (await c.rpc("query", { request_type: "view_account", finality: "final", account_id: rec.verifier })).result;
  const ok = st?.[0] === "verified" && String(st[1]).includes(reg.signing_key) && qv === rec.verifier && att && acct.code_hash === rec.code_hash;
  console.log(`${ok ? "PASS" : "FAIL"}  mainnet DCAP: the model's TDX quote verified on chain by ${rec.verifier.slice(0, 12)}.. (code ${acct.code_hash.slice(0, 10)}.., spike.bookerbob.testnet's), ${String(st?.[1]).split(" ")[0]}; the bazaar's quote verifier is it; the model key ${reg.signing_key.slice(0, 12)}.. registered (${att?.tcb_status})`);
  for (const [k, h] of Object.entries(rec.txs)) console.log(`      ${k}: ${link(h)}`);
  if (!ok) process.exit(1);
}

const [cmd] = process.argv.slice(2);
const c = rpcClient(RPC);
await (cmd === "run" ? run(c) : cmd === "check" ? check(c) : Promise.reject(new Error("usage: run --mainnet | check"))).catch((e) => { console.error(`FAIL  ${e.message}`); process.exit(1); });
