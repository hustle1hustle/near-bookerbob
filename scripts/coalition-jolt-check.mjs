#!/usr/bin/env node
// Keyless check (public RPC, no keys) that coalition version 4 admitted a member on a Jolt proof
// the locked on-chain verifier checked, and refused one whose verified proof is of another graph.
// Usage: node scripts/coalition-jolt-check.mjs   (reads fixtures/live/coalition-jolt/run.json)
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
const root = new URL("..", import.meta.url).pathname;
const st = JSON.parse(readFileSync(root + "fixtures/live/coalition-jolt/run.json", "utf8"));
const RPCS = process.env.NEAR_RPC ? [process.env.NEAR_RPC] : ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "https://archival-rpc.testnet.fastnear.com"];
const PROGRAM = "c780ceabae4decfa59703a9988ab2483313c6c1d2f15c7c0ad8fc60255a5c3a5";
const REFUSE_JOLT = "the verifier's job is not a verified standing proof of the bazaar's live standing root";
const sha = (b) => createHash("sha256").update(b).digest();
let fails = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fails++; };
async function rpc(method, params) {
  for (let i = 0; i < 12; i++) {
    try {
      const r = await fetch(RPCS[i % RPCS.length], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1500)); continue; }
      const j = await r.json();
      if (j.error && i < 11 && /UNKNOWN_TRANSACTION|garbage/i.test(JSON.stringify(j.error))) continue;
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 300));
      return j.result;
    } catch (e) { if (i === 11) throw e; await new Promise((s) => setTimeout(s, 1000)); }
  }
}
const view = async (a, m, args = {}) => JSON.parse(Buffer.from((await rpc("query", { request_type: "call_function", finality: "final", account_id: a, method_name: m, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") })).result).toString() || "null");
const tx = (h, signer) => rpc("EXPERIMENTAL_tx_status", { tx_hash: h, sender_account_id: signer, wait_until: "NONE" });
const events = (t, executor) => t.receipts_outcome.filter((r) => r.outcome.executor_id === executor).flatMap((r) => r.outcome.logs).filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)));
const ev = (t, executor, name) => events(t, executor).filter((e) => e.event === name).flatMap((e) => (Array.isArray(e.data) ? e.data : [e.data]));
const b58 = (buf) => { const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let n = BigInt("0x" + buf.toString("hex")), o = ""; while (n > 0n) { o = A[Number(n % 58n)] + o; n /= 58n; } return o; };
const trim = (b) => { let n = b.length; while (n > 0 && b[n - 1] === 0) n--; return b.subarray(0, n); };
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
// the verifier's statement for the standing program (zk/onchain/src/contract.rs, coalition/v4 standing_statement)
const statement = (inputs, outputs, proofSha) => sha(Buffer.concat([Buffer.from(PROGRAM, "hex"), le32(trim(inputs).length), trim(inputs), le32(trim(outputs).length), trim(outputs), Buffer.from([0]), Buffer.from(proofSha, "hex")])).toString("hex");
const joinMsg = (t) => { const a = JSON.parse(Buffer.from(t.transaction.actions[0].FunctionCall.args, "base64").toString()); return { ...a, msg: JSON.parse(a.msg) }; };
const returned = (t, executor, method) => t.receipts_outcome.filter((r) => r.outcome.executor_id === executor).map((r) => r.outcome.status.SuccessValue).filter((v) => v !== undefined);

const C = st.coalition;
console.log(`coalition version 4 ${C}: admission on a Jolt proof verified by ${st.verifier} (testnet, public RPC, no keys)`);
const acc = await rpc("query", { request_type: "view_account", finality: "final", account_id: C });
ok(acc.code_hash === b58(Buffer.from(st.wasm_sha256, "hex")), `${C} runs the recorded build (wasm sha256 ${st.wasm_sha256.slice(0, 16)}..)`);
const local = root + "coalition/v4/target/coalition_v4.wasm";
if (existsSync(local)) ok(sha(readFileSync(local)).toString("hex") === st.wasm_sha256, `the local build coalition/v4/target/coalition_v4.wasm is the same`);
const keys = await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: C });
ok(keys.keys.length === 0, `${C} has no access key: created without one, its code cannot change`);
const vkeys = await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: st.verifier });
ok(vkeys.keys.length === 0, `the verifier ${st.verifier} has no access key either`);
const cfg = await view(C, "config");
ok(cfg.verifier === st.verifier && cfg.program_hash === PROGRAM && cfg.bazaar === st.bazaar && cfg.treasury === st.treasury && cfg.token === st.dusdc && cfg.version === "4.0.0", `config: version ${cfg.version}, bazaar ${cfg.bazaar}, token ${cfg.token}, treasury ${cfg.treasury}, verifier ${cfg.verifier}, program ${cfg.program_hash.slice(0, 8)}..`);
// the account's creation: exactly CreateAccount, Transfer, DeployContract, new(...), no AddKey
const tc = await tx(st.txs.create_deploy.hash, st.txs.create_deploy.signer);
const acts = tc.transaction.actions;
const kinds = acts.map((a) => (typeof a === "string" ? a : Object.keys(a)[0]));
const newCall = acts.find((a) => a.FunctionCall)?.FunctionCall;
const newArgs = newCall && JSON.parse(Buffer.from(newCall.args, "base64").toString());
ok(tc.transaction.receiver_id === C && JSON.stringify(kinds) === JSON.stringify(["CreateAccount", "Transfer", "DeployContract", "FunctionCall"]) && newCall.method_name === "new" && "SuccessValue" in tc.status, `${C} was created in one tx with CreateAccount, Transfer, DeployContract, new: no AddKey (${st.txs.create_deploy.hash.slice(0, 8)}..)`);
ok(newArgs && newArgs.token === cfg.token && newArgs.bazaar === cfg.bazaar && newArgs.treasury === cfg.treasury && newArgs.verifier === cfg.verifier, `the new() args are the config: token, bazaar, treasury, verifier`);
// the verifier job the member names: 8 txs on the verifier, 7 advances
const vjob = await view(st.verifier, "status", { id: st.live_job });
const vlast = await tx(st.live_job_txs.at(-1), st.live_job_signer);
const vfin = vlast.receipts_outcome.filter((r) => r.outcome.executor_id === st.verifier).flatMap((r) => r.outcome.logs).filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11))).find((e) => e.event === "verified");
ok(vjob.advances === 7 && st.live_job_txs.length === 8 && vlast.transaction.receiver_id === st.verifier && vfin?.data.id === st.live_job && vfin?.data.statement === vjob.statement, `verifier job ${st.live_job}: submit + ${vjob.advances} advances, the last (${st.live_job_txs.at(-1).slice(0, 8)}..) emitted verified(id ${st.live_job}, statement ${vjob.statement.slice(0, 8)}..)`);
// open and fund, by the lead
const to = await tx(st.txs.open.hash, st.txs.open.signer);
const opened = ev(to, C, "job_opened")[0];
ok(to.transaction.signer_id === st.lead && to.transaction.receiver_id === C && opened?.job === st.job && opened?.deadline_ms === st.deadline_ms && opened?.min_top_pct === 100, `${st.lead} opened job ${st.job}: deadline ${new Date(st.deadline_ms).toISOString()}, min_top_pct 100 (${st.txs.open.hash.slice(0, 8)}..)`);
const tfu = await tx(st.txs.fund.hash, st.txs.fund.signer);
const funded = ev(tfu, C, "job_funded")[0];
ok(tfu.transaction.signer_id === st.lead && tfu.transaction.receiver_id === st.dusdc && funded?.job === st.job && funded?.buyer === st.lead, `${st.lead} funded job ${st.job} with ${funded?.budget} (dUSDC, ${st.txs.fund.hash.slice(0, 8)}..)`);
ok((await view(st.verifier, "program_hash")) === PROGRAM && (await view(st.bazaar, "graph_program")) === PROGRAM, `the verifier embeds and the bazaar registered the same standing program ${PROGRAM.slice(0, 8)}..`);

const [tree, n, scores, graph] = st.standing_root;
const outputs = Buffer.concat([Buffer.from(graph, "hex"), Buffer.from(scores, "hex")]);
const live = await view(st.bazaar, "standing_root");
console.log(`      bazaar standing_root at the joins: tree ${tree.slice(0, 8)}.., n ${n}, scores ${scores.slice(0, 8)}.., graph ${graph.slice(0, 8)}.. (now: ${JSON.stringify(live) === JSON.stringify(st.standing_root) ? "unchanged" : "changed since"})`);

// the admitted join
const tm = await tx(st.txs.join_m01_live.hash, st.txs.join_m01_live.signer);
const mm = joinMsg(tm);
const joined = ev(tm, C, "joined")[0];
const s4 = await view(st.verifier, "status", { id: mm.msg.join.standing_job });
const inputs4 = Buffer.from(mm.msg.join.standing_inputs, "base64");
const want4 = statement(inputs4, outputs, s4.proof_sha256);
ok(tm.transaction.signer_id === st.m01 && tm.transaction.receiver_id === st.dusdc && mm.receiver_id === C && mm.msg.join.job === st.job && mm.msg.join.standing_job === st.live_job && mm.msg.join.proof?.merchant === st.m01 && mm.msg.join.proof?.n === n, `m01 sent its bond to job ${st.job} with ft_transfer_call, naming verifier job ${mm.msg.join.standing_job} (${st.txs.join_m01_live.hash.slice(0, 8)}..)`);
ok(s4.status === "verified" && s4.panic === false, `verifier job ${mm.msg.join.standing_job} is verified on chain (8 txs on ${st.verifier}), proof ${s4.proof_sha256.slice(0, 12)}..`);
ok(s4.proof_sha256 === sha(readFileSync(root + "zk/onchain/live/proof.bin")).toString("hex"), `that proof is zk/onchain/live/proof.bin, the live standing proof behind the bazaar's tree`);
ok(want4 === s4.statement, `its statement re-derives here from the inputs m01 sent and the bazaar's graph root and scores hash: ${want4.slice(0, 16)}..`);
ok(joined && joined.member === st.m01 && joined.leg === 0 && joined.standing_job === mm.msg.join.standing_job && joined.statement === s4.statement && joined.standing_root === tree, `the coalition emitted joined(m01, leg 0, verifier job ${joined?.standing_job}, that statement, tree ${String(joined?.standing_root).slice(0, 8)}..)`);
ok(returned(tm, st.bazaar).includes(Buffer.from("true").toString("base64")), `the bazaar answered in_top = true for m01 in the same join`);

// the refused join
const th = await tx(st.txs.join_h05_old_root.hash, st.txs.join_h05_old_root.signer);
const hm = joinMsg(th);
const ref = ev(th, C, "join_refused")[0];
const s1 = await view(st.verifier, "status", { id: hm.msg.join.standing_job });
const inputs1 = Buffer.from(hm.msg.join.standing_inputs, "base64");
ok(th.transaction.signer_id === st.h05 && hm.receiver_id === C && hm.msg.join.job === st.job && hm.msg.join.standing_job === st.old_job && hm.msg.join.proof?.n === n, `h05 sent its bond to job ${st.job}, naming verifier job ${hm.msg.join.standing_job} (the recorded old job)`);
ok(s1.status === "verified", `h05 named verifier job ${hm.msg.join.standing_job}: also verified on chain, proof ${s1.proof_sha256.slice(0, 12)}.. (an older graph)`);
ok(statement(inputs1, outputs, s1.proof_sha256) !== s1.statement, `its statement does not open to the bazaar's live graph root and scores hash`);
ok(ref && ref.member === st.h05 && ref.reason === REFUSE_JOLT && ref.standing_job === hm.msg.join.standing_job, `the coalition refused h05: "${ref?.reason}" (${st.txs.join_h05_old_root.hash.slice(0, 8)}..)`);
const refunds = th.receipts_outcome.filter((r) => r.outcome.executor_id === st.dusdc).flatMap((r) => r.outcome.logs).filter((l) => l.includes("ft_transfer") && l.includes(st.h05) && l.includes("refund"));
ok(refunds.length > 0, `h05's bond came back (dUSDC ft_transfer memo refund)`);

const job = await view(C, "job", { job: st.job });
ok(job.seats[0]?.member === st.m01 && job.seats[1] === null, `job ${st.job}: leg 0 held by m01, leg 1 empty`);
if (st.txs.finalize) {
  const tf = await tx(st.txs.finalize.hash, st.txs.finalize.signer);
  const fin = ev(tf, C, "job_finalized")[0];
  const back = (who, amt) => tf.receipts_outcome.filter((r) => r.outcome.executor_id === st.dusdc).flatMap((r) => r.outcome.logs).some((l) => l.includes(`"new_owner_id":"${who}"`) && l.includes(`"amount":"${amt}"`));
  ok(fin && fin.job === st.job && fin.released?.[0]?.member === st.m01 && fin.slashed.length === 0 && fin.to_buyer === "2000000" && back(st.m01, "1000000") && back(st.lead, "2000000"), `job ${st.job} finalized with no purchase (status ${fin?.status}): m01's bond released and paid back, the 2 dUSDC budget back to the lead, nothing slashed (${st.txs.finalize.hash.slice(0, 8)}..)`);
}
console.log(fails ? `FAIL  coalition-jolt-check (${fails})` : "PASS  coalition-jolt-check");
process.exit(fails ? 1 : 0);
