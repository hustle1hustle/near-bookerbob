#!/usr/bin/env node
// Keyless check of the on-chain Jolt verification (testnet, public RPC, no keys):
// the verifier contract's embedded program is the standing program the bazaar registered, each
// recorded job ends as recorded, its proof and claim are the local files, its statement hash
// re-derives here, the deployed code is the recorded build, and every tx of each job is bound to
// it (submit with this proof and claim, then advance(id), with the contract's own events).
// Usage: node scripts/jolt-onchain-check.mjs   (NEAR_RPC=<url> to choose the RPC)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
// --mainnet: the same wasm on NEAR mainnet (zk/onchain/onchain-run-mainnet.json), its key kept.
const MAINNET = process.argv.includes("--mainnet");
const TESTNET_RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "https://archival-rpc.testnet.fastnear.com"];
const MAINNET_RPCS = ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org", "https://archival-rpc.mainnet.fastnear.com"];
const RPCS = process.env.NEAR_RPC ? [process.env.NEAR_RPC] : MAINNET ? MAINNET_RPCS : TESTNET_RPCS;
const run = JSON.parse(readFileSync(new URL(MAINNET ? "../zk/onchain/onchain-run-mainnet.json" : "../zk/onchain/onchain-run.json", import.meta.url)));
const root = new URL("..", import.meta.url).pathname;
const sha = (b) => createHash("sha256").update(b).digest();
let fails = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fails++; };
async function rpc(method, params, urls = RPCS) {
  for (let i = 0; i < 12; i++) {
    const url = urls[i % urls.length];
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1500)); continue; }
      const j = await r.json();
      if (j.error && /UNKNOWN_TRANSACTION|not found|garbage/i.test(JSON.stringify(j.error)) && i < 11) continue;
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 300));
      return j.result;
    } catch (e) { if (i === 11) throw e; await new Promise((s) => setTimeout(s, 1000)); }
  }
}
const view = async (acct, method, args = {}, urls = RPCS) => {
  const r = await rpc("query", { request_type: "call_function", finality: "final", account_id: acct, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") }, urls);
  return JSON.parse(Buffer.from(r.result).toString());
};
// the statement formula, as in zk/onchain/src/contract.rs
function statement(io, proofSha) {
  const trim = (b) => { let n = b.length; while (n > 0 && b[n - 1] === 0) n--; return b.subarray(0, n); };
  const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const { inputs, outputs, panic } = io;
  const i = trim(inputs), o = trim(outputs);
  return sha(Buffer.concat([Buffer.from(PROGRAM, "hex"), le32(i.length), i, le32(o.length), o, Buffer.from([panic ? 1 : 0]), proofSha])).toString("hex");
}
// JoltDevice, arkworks compressed: inputs Vec<u8>, trusted_advice, untrusted_advice, outputs, panic, ...
// (u64 little-endian lengths); only inputs, outputs and panic are needed here.
function readIo(b) {
  let p = 0;
  const vec = () => { const n = Number(b.readBigUInt64LE(p)); p += 8; const v = b.subarray(p, p + n); p += n; return v; };
  const inputs = vec(); vec(); vec(); const outputs = vec(); const panic = b[p] === 1;
  return { inputs, outputs, panic };
}
const PROGRAM = "c780ceabae4decfa59703a9988ab2483313c6c1d2f15c7c0ad8fc60255a5c3a5";
const C = run.contract;
console.log(`on-chain Jolt verifier ${C} (${MAINNET ? "mainnet" : "testnet"}), public RPC, no keys`);
const ph = await view(C, "program_hash");
ok(ph === PROGRAM, `verifier's embedded program hash ${ph.slice(0, 16)}.. is the standing program`);
const reg = await view("bookerbob.testnet", "graph_program", {}, TESTNET_RPCS);
ok(reg === ph, `the bazaar's registered graph_program (bookerbob.testnet) is the same hash`);
const acc = await rpc("query", { request_type: "view_account", finality: "final", account_id: C });
const b58 = (buf) => { const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let n = BigInt("0x" + buf.toString("hex")), o = ""; while (n > 0n) { o = A[Number(n % 58n)] + o; n /= 58n; } return o; };
ok(acc.code_hash === b58(Buffer.from(run.wasm_sha256, "hex")), `contract code is the recorded build (wasm sha256 ${run.wasm_sha256.slice(0, 16)}.., code hash ${acc.code_hash})`);
try {
  const local = readFileSync(root + "zk/onchain/target/jolt_onchain.wasm");
  ok(sha(local).toString("hex") === run.wasm_sha256, `local build zk/onchain/target/jolt_onchain.wasm has the same sha256`);
} catch { console.log("      (no local build at zk/onchain/target/jolt_onchain.wasm: `zk/onchain/scripts/build.sh` makes one)"); }
const keys = await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: C });
const full = keys.keys.filter((k) => k.access_key.permission === "FullAccess").length;
if (MAINNET) {
  const tv = await rpc("query", { request_type: "view_account", finality: "final", account_id: "verifier.bookerbob-jolt-a.testnet" }, TESTNET_RPCS);
  ok(acc.code_hash === tv.code_hash, `the mainnet code hash is the locked testnet verifier's (verifier.bookerbob-jolt-a.testnet, ${tv.code_hash.slice(0, 8)}..)`);
  ok(C === Buffer.from(C, "hex").toString("hex") && C.length === 64, `${C.slice(0, 12)}.. is an implicit account (its id is its ed25519 public key)`);
  // the staged deploy: the loader, the code in chunks that reassemble to the recorded wasm, deploy(sha256)
  const T = (h) => rpc("EXPERIMENTAL_tx_status", { tx_hash: h, sender_account_id: C, wait_until: "NONE" });
  const tl = await T(run.txs.loader);
  const lact = tl.transaction.actions[0];
  ok(tl.transaction.receiver_id === C && tl.transaction.actions.length === 1 && lact.DeployContract && "SuccessValue" in tl.status, `the loader deployed onto ${C.slice(0, 8)}.. (${run.txs.loader.slice(0, 8)}.., code sha256 ${sha(Buffer.from(lact.DeployContract.code, "base64")).toString("hex").slice(0, 12)}..)`);
  const parts = [];
  let chunksOk = true;
  for (const h of run.txs.chunks) {
    const t = await T(h);
    const f = t.transaction.actions[0]?.FunctionCall;
    chunksOk &&= t.transaction.receiver_id === C && t.transaction.actions.length === 1 && f?.method_name === "put" && "SuccessValue" in t.status;
    parts.push(Buffer.from(f.args, "base64"));
  }
  const whole = Buffer.concat(parts);
  ok(chunksOk && sha(whole).toString("hex") === run.wasm_sha256, `${run.txs.chunks.length} put txs carried ${whole.length} bytes whose sha256 is the recorded wasm ${run.wasm_sha256.slice(0, 12)}..`);
  const td = await T(run.txs.deploy);
  const df = td.transaction.actions[0]?.FunctionCall;
  const deployed = td.receipts_outcome.some((r) => r.outcome.executor_id === C && r.outcome.logs.some((l) => l === `deploying ${whole.length} bytes`));
  ok(td.transaction.receiver_id === C && df?.method_name === "deploy" && Buffer.from(df.args, "base64").toString("hex") === run.wasm_sha256 && deployed && "SuccessValue" in td.status, `deploy(${run.wasm_sha256.slice(0, 12)}..): the loader checked the sha256 and deployed ${whole.length} bytes onto itself (${run.txs.deploy.slice(0, 8)}..)`);
  console.log(`      access keys: ${keys.keys.length} (${full} full-access, kept on purpose: the ~36 NEAR of code storage is reclaimed after judging; the testnet copy is the locked one)`);
} else if (run.lock_tx) ok(keys.keys.length === 0, `${C} has no access keys (deleted in ${run.lock_tx.slice(0, 8)}..): the code is permanent`);
else console.log(`      access keys on ${C}: ${keys.keys.length} (${full} full-access: the holder can redeploy the code)`);
console.log(`      pin: ${await view(C, "jolt_pin")}`);
const events = (logs) => logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)));
for (const j of run.jobs) {
  const st = await view(C, "status", { id: j.id });
  const proof = readFileSync(root + j.proof), ioBytes = readFileSync(root + j.io);
  const io = readIo(ioBytes);
  const proofSha = sha(proof).toString("hex"), ioSha = sha(ioBytes).toString("hex");
  ok(st && st.status === j.expect, `job ${j.id} (${j.what}): ${st && st.status}`);
  ok(st.proof_sha256 === proofSha && st.io_sha256 === ioSha, `job ${j.id}: proof and claim on chain are ${j.proof} and ${j.io}`);
  ok(st.statement === statement(io, sha(proof)), `job ${j.id}: statement ${st.statement.slice(0, 16)}.. re-derived here`);
  const trimmed = (b) => { let n = b.length; while (n > 0 && b[n - 1] === 0) n--; return b.subarray(0, n); };
  ok(st.outputs_sha256 === sha(trimmed(io.outputs)).toString("hex"), `job ${j.id}: outputs_sha256 is sha256 of the claim's outputs`);
  ok(j.txs.length === st.advances + 1 && j.txs.length >= 2, `job ${j.id}: ${j.txs.length} txs = submit + ${st.advances} advances`);
  let gas = 0n, adv = [], bound = true, first, last;
  for (const [k, h] of j.txs.entries()) {
    const t = await rpc("EXPERIMENTAL_tx_status", { tx_hash: h, sender_account_id: run.signer || C, wait_until: "NONE" });
    if (!("SuccessValue" in t.status)) { ok(false, `job ${j.id}: tx ${h} failed`); bound = false; continue; }
    const acts = t.transaction.actions;
    const fc = acts.length === 1 && acts[0].FunctionCall;
    const method = k === 0 ? "submit" : "advance";
    if (t.transaction.receiver_id !== C || !fc || fc.method_name !== method) { bound = false; console.log(`      tx ${h}: not a ${method} call on ${C}`); continue; }
    const args = JSON.parse(Buffer.from(fc.args, "base64").toString());
    if (k === 0 && (sha(Buffer.from(args.proof, "base64")).toString("hex") !== proofSha || sha(Buffer.from(args.io, "base64")).toString("hex") !== ioSha)) { bound = false; console.log(`      tx ${h}: submit args are not the job's proof and claim`); }
    if (k > 0 && args.id !== j.id) { bound = false; console.log(`      tx ${h}: advance of job ${args.id}`); }
    const logs = t.receipts_outcome.filter((r) => r.outcome.executor_id === C).flatMap((r) => r.outcome.logs);
    if (k === 0) first = events(logs);
    if (k === j.txs.length - 1) last = events(logs);
    adv.push(...logs.filter((l) => l.startsWith("advance")));
    gas += BigInt(t.transaction_outcome.outcome.gas_burnt) + t.receipts_outcome.reduce((a, r) => a + BigInt(r.outcome.gas_burnt), 0n);
  }
  ok(bound, `job ${j.id}: every tx is a call on ${C}: submit with this proof and claim, then advance(${j.id})`);
  const sub = first && first.find((e) => e.event === "submitted");
  ok(sub && sub.data.id === j.id && sub.data.statement === st.statement, `job ${j.id}: the submit tx emitted submitted(id ${j.id}, the statement)`);
  const fin = last && last.find((e) => e.event === "verified" || e.event === "refused");
  ok(fin && fin.data.id === j.id && fin.data.status === st.status && fin.data.statement === st.statement, `job ${j.id}: the last tx emitted ${fin && fin.event}(id ${j.id}, the status, the statement)`);
  if (j.expect === "verified") {
    const res = JSON.parse(readFileSync(root + j.result));
    const want = Buffer.from(res.output.flat());
    ok(Buffer.from(fin.data.outputs_b64, "base64").equals(want), `job ${j.id}: the verified outputs are the standing result (${want.toString("hex").slice(0, 16)}..)`);
  }
  console.log(`      ${(Number(gas) / 1e15).toFixed(2)} PGas burnt over ${j.txs.length} txs`);
  for (const l of adv) console.log(`      ${l}`);
}
console.log(fails ? `FAIL  jolt-onchain-check (${fails})` : "PASS  jolt-onchain-check");
process.exit(fails ? 1 : 0);
