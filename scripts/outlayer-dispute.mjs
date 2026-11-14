#!/usr/bin/env node
// `make outlayer-dispute`: the dispute arbiter runs on OutLayer (docs/keyless.md). Testnet. Historical:
// `run` and `again` need arbiter_threshold 1, and the bazaar runs at 2 since 2026-11-14; `verify` stays.
//
//   node scripts/outlayer-dispute.mjs run     one demo-tester purchase whose buyer adds a claim its
//                                             proofs do not carry (the F9 cheat). REP's own testnet
//                                             referee key (2f99..) signs a receipt for it anyway: it
//                                             stands in for a compromised referee, and the bazaar
//                                             stores the receipt because it trusts the key. The
//                                             dispute input goes to the OutLayer project sealed to
//                                             its key; the project's arbiter host key re-runs the
//                                             referee and signs `overturned`; anyone relays it with
//                                             submit_dispute_decision; the receipt is cleared and
//                                             settle_demo is refused. Writes fixtures/live/outlayer/dispute.json.
//   node scripts/outlayer-dispute.mjs verify  the keyless check of that record over public RPC
//
// Keys: the treasury, tester and testnet referee seeds in KEYS_DIR (as make demo-tester), and the
// near-cli keychain for bookerbob.testnet (it calls OutLayer, so the seal key is the one the
// project derives for the bazaar). Only public data is written.
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUTLAYER } from "./outlayer-buy.mjs";

export const OUT = "fixtures/live/outlayer/dispute.json";
/** REP's testnet referee key: the one that signs the forged receipt (registered 2026-11-04). */
export const REP_REFEREE = "2f99e90f7ca11c6d014a7bde2cb02e8a4105c8340ae3cc62f10be0dc8eba3751";
const TGAS = 10n ** 12n;
const RESULT_TAG = Buffer.from("bookerbob/referee/v0\0");
const DISPUTE_TAG = Buffer.from("bookerbob/dispute/v0\0");
const LIMITS = { max_instructions: 1_000_000_000, max_memory_mb: 128, max_execution_seconds: 60 };
const fc = (method_name, args, deposit = 0n, gas = 100n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const events = (logs) => logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)));
const ev = (logs, name) => events(logs).find((e) => e.event === name)?.data?.[0];
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
/** The first Failure in a tx result (the tx or any receipt), or null; an unreadable tx fails. */
const failOf = (t) => (t?.transaction ? [t.transaction_outcome, ...t.receipts_outcome].map((o) => o.outcome.status.Failure).find(Boolean) ?? t.status?.Failure ?? null : "tx unreadable");

const pubOf = (hex) => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(hex, "hex")]), format: "der", type: "spki" });
/** ed25519 over TAG || json(body); serde writes fields in struct order, and JSON.parse keeps it. */
export const edOk = (tag, body, keyHex, sigHex) => {
  try {
    return edVerify(null, Buffer.concat([tag, Buffer.from(JSON.stringify(body))]), pubOf(keyHex), Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
};
function signWithSeed(seedHex, msg) {
  const k = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
  return edSign(null, msg, k).toString("hex");
}

const runOut = (cmd, opts = {}) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
  if (r.status !== 0) throw new Error(`${cmd.slice(0, 6).join(" ")}: ${(r.stderr || r.stdout || "").slice(-600)}`);
  return r.stdout;
};

/** OutLayer's resolve tx for a request, from the worker's account (same as outlayer-buy.mjs). */
async function findResolve(client, requestId, sinceSec) {
  const seen = new Set();
  for (let round = 0; round < 40; round++) {
    const js = await (await fetch("https://api-testnet.nearblocks.io/v1/account/worker.outlayer.testnet/txns?per_page=50&order=desc")).json().catch(() => ({}));
    for (const t of js.txns ?? []) {
      const m = t.actions?.[0]?.method ?? "";
      if (!m.includes("resolve") || seen.has(t.transaction_hash) || Number(String(t.block_timestamp).slice(0, 10)) < sinceSec) continue;
      seen.add(t.transaction_hash);
      const r = await client.rpc("tx", { tx_hash: t.transaction_hash, sender_account_id: "worker.outlayer.testnet", wait_until: "FINAL" });
      for (const a of r.result?.transaction?.actions ?? []) {
        if (!a.FunctionCall) continue;
        const args = JSON.parse(Buffer.from(a.FunctionCall.args, "base64").toString());
        if (args.request_id === requestId) return { tx: t.transaction_hash, args, failure: failOf(r.result) };
      }
    }
    await new Promise((ok) => setTimeout(ok, 15000));
  }
  throw new Error(`no resolve tx for OutLayer request ${requestId}`);
}

/** demo-tester's referee hook: the forged receipt, then the dispute on OutLayer. */
function forgedThenDispute(record) {
  return async ({ input, rec, tester, live, q, d }) => {
    const c = d.c;
    const obj = JSON.parse(input);
    obj.claims = JSON.parse(readFileSync("fixtures/claims-cheat.json", "utf8"));
    // The honest run of REP's referee refuses the cheat; the compromised key signs a receipt.
    const seed = readFileSync(join(c.keysDir, "referee.seed"), "utf8").trim();
    const refused = JSON.parse(runOut(["cargo", "run", "-q", "-p", "bookerbob-referee-worker"], { input: JSON.stringify(obj), env: { ...process.env, REFEREE_SIGNING_SEED: seed } }));
    if (refused.body.outcome !== "refused" || refused.worker_key !== REP_REFEREE) throw new Error(`expected REP's referee to refuse the cheat: ${JSON.stringify(refused.body).slice(0, 200)}`);
    const e = { tester: rec.tester, nullifier: rec.nullifier, merchant: c.merchant, honest_refusal: refused.body.detail, txs: { ...rec.txs } };
    record.dispute = e;
    const forged = await forgeAndSeal({ d, tester, live, base: refused, detail: "forged", e });
    const verdict = JSON.parse(readFileSync(join(live, "verdict.json"), "utf8"));
    const argsFile = await sealDispute({ d, live, obj, verdict, forged, e });
    return continueDispute({ d, tester, rec, e, argsFile, q, price: refused.body.price });
  };
}

/** bookerbob.testnet calls OutLayer (near-cli keychain); returns the tx hash. */
function requestExecution(argsFile, bazaar) {
    const cli = spawnSync("near", ["contract", "call-function", "as-transaction", OUTLAYER.contract, "request_execution", "file-args", argsFile, "prepaid-gas", "300.0 Tgas", "attached-deposit", "0.05 NEAR", "sign-as", bazaar, "network-config", "testnet", "sign-with-keychain", "send"], { encoding: "utf8", maxBuffer: 64 << 20 });
    const out = `${cli.stdout}\n${cli.stderr}`;
    const hash = out.match(/transactions\/([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1];
    if (!hash) throw new Error(`request_execution: no tx hash: ${out.slice(-400)}`);
    return hash;
}

/** OutLayer's request for the dispute, retried until its resolve tx succeeds on chain (a resolve
 *  that lands after the yield window fails with "Execution request not found", although the
 *  worker posted its output). Each failed attempt is kept in `e.timeouts`. Then the decision is
 *  relayed and settle is tried. */
async function continueDispute({ d, tester, rec, e, argsFile, firstHash, q, price }) {
  const c = d.c;
  const tries = Number(process.env.DISPUTE_TRIES ?? 4);
  let res = null;
  e.timeouts ??= [];
  for (let i = 0; i < tries && !res; i++) {
    const hash = i === 0 && firstHash ? firstHash : requestExecution(argsFile, c.bazaar);
    const rt = await d.client.rpc("tx", { tx_hash: hash, sender_account_id: c.bazaar, wait_until: "FINAL" });
    if (rt.error) throw new Error(`request tx ${hash}: ${JSON.stringify(rt.error).slice(0, 200)}`);
    const logs = (rt.result?.receipts_outcome ?? []).flatMap((o) => o.outcome.logs);
    const asked = ev(logs, "execution_requested");
    if (!asked) throw new Error(`request_execution ${hash} did not reach OutLayer`);
    const rd = JSON.parse(asked.request_data);
    console.log(`   request_execution (dispute, sealed) ${hash}  request ${rd.request_id}`);
    const got = await findResolve(d.client, rd.request_id, Math.floor(rd.timestamp / 1e9) - 5);
    const reqFail = failOf(rt.result);
    if (got.failure || reqFail) {
      e.timeouts.push({ request_execution: hash, request_id: rd.request_id, outlayer_resolve: got.tx, resolve_failure: JSON.stringify(got.failure ?? null).slice(0, 200), request_failure: JSON.stringify(reqFail ?? null).slice(0, 200) });
      console.log(`   OutLayer's resolve ${got.tx} failed on chain (${JSON.stringify(got.failure ?? reqFail).slice(0, 120)}): the request timed out; again`);
      continue;
    }
    e.txs.request_execution = hash;
    e.request_id = rd.request_id;
    res = got;
  }
  if (!res) throw new Error(`no OutLayer resolve succeeded in ${tries} tries`);
  const text = res.args.response?.output?.Text;
  if (!res.args.response?.success || !text) throw new Error(`OutLayer request ${e.request_id} failed: ${JSON.stringify(res.args.response).slice(0, 300)}`);
  const decision = JSON.parse(text);
  e.txs.outlayer_resolve = res.tx;
  e.outlayer = { instructions: res.args.response.resources_used?.instructions, time_ms: res.args.response.resources_used?.time_ms };
  if (decision.arbiter_key !== OUTLAYER.keys.arbiter_key) throw new Error(`the decision is signed by ${decision.arbiter_key}, not the project's arbiter key`);
  if (decision.body.decision !== "overturned") throw new Error(`the arbiter did not overturn: ${JSON.stringify(decision.body)}`);
  e.decision = decision.body.decision;
  e.reasons = decision.body.reasons;
  console.log(`   OutLayer's arbiter signed overturned (resolve ${res.tx} succeeded): ${decision.body.reasons.join("; ")}`);
  // Anyone relays it. The demo relayer does not relay this method; the treasury sends it (only the
  // arbiter's signature counts).
  const r = await d.direct("submit_dispute_decision (the OutLayer output)", c.treasury, d.treasury, c.bazaar, [fc("submit_dispute_decision", { decision }, 0n, 100n * TGAS)]);
  e.txs.submit_dispute_decision = r.hash;
  if (!ev(r.logs, "dispute_overturned")) throw new Error(`no dispute_overturned: ${r.error ?? JSON.stringify(events(r.logs))}`);
  const after = await d.client.view(c.bazaar, "verdict", { nullifier: rec.nullifier });
  if (after.receipt) throw new Error("the receipt is still stored");
  const { delegateFor, send } = await import("../relayer/near.mjs");
  const signed = await delegateFor(d.client, { sender_id: tester.id, key: tester.key, receiver_id: c.bazaar, actions: [fc("settle_demo", { nullifier: rec.nullifier, merchant: c.merchant, checkout_ref: `dispute-${rec.tester.slice(0, 6)}-${Date.now() % 1e6}`, amount: String(q?.price ?? price) }, 0n, 150n * TGAS)] });
  const st = await send(d.client, { signer_id: c.treasury, key: d.treasury, receiver_id: tester.id, actions: [{ type: "Delegate", ...signed }] });
  e.txs.settle_attempt = st.hash ?? null;
  if (!String(st.error ?? "").includes("no referee receipt")) throw new Error(`settle_demo was not refused for the cleared receipt: ${st.error ?? "it succeeded"}`);
  console.log(`   settle_demo refused: no referee receipt for this quote  https://testnet.nearblocks.io/txns/${st.hash}`);
  return { stop: true };
}

/** Sign a forged receipt with REP's testnet referee seed, store it, and seal the dispute input. */
async function forgeAndSeal({ d, tester, live, base, detail, e }) {
  const c = d.c;
  const seed = readFileSync(join(c.keysDir, "referee.seed"), "utf8").trim();
  const forged = { ...base, body: { ...base.body, outcome: "receipt", detail } };
  forged.signature = signWithSeed(seed, Buffer.concat([RESULT_TAG, Buffer.from(JSON.stringify(forged.body))]));
  const s = await d.relay("submit_referee_result (the forged receipt, the operator's referee key)", tester, c.bazaar, fc("submit_referee_result", { result: forged }, 0n, 100n * TGAS));
  e.txs.forged_receipt = s.hash;
  if (!ev(s.logs, "referee_receipt")) throw new Error(`the forged receipt was not stored: ${s.error ?? JSON.stringify(events(s.logs))}`);
  const stored = await d.client.view(c.bazaar, "verdict", { nullifier: e.nullifier });
  e.forged_result_sha256 = stored.receipt.result_sha256;
  console.log(`   the bazaar stored the operator's forged receipt (it trusts the key): result ${e.forged_result_sha256.slice(0, 12)}..`);
  return forged;
}

async function sealDispute({ d, live, obj, verdict, forged, e }) {
  const c = d.c;
  const issuer_keys = (await d.client.view(c.bazaar, "issuers", {})).map(([k]) => k);
  const referee_keys = (await d.client.view(c.bazaar, "referees", {})).map(([k]) => k);
  const dispute = { v: 0, verdict, result: forged, schedule: obj.schedule, claims: obj.claims, proofs: obj.proofs, cohort_k: obj.cohort_k ?? 0, issuer_keys, referee_keys, ...(obj.salt && { salt: obj.salt }) };
  const plain = join(live, "outlayer-dispute-input.json");
  writeFileSync(plain, JSON.stringify(dispute), { mode: 0o600 });
  const sealed = runOut(["cargo", "run", "-q", "-p", "bookerbob-cli", "--", "seal-input", OUTLAYER.keys.seal_x25519, plain]).trim();
  e.sealed_input_sha256 = sha256(sealed);
  // bookerbob.testnet calls OutLayer itself, so the module opens the input with the seal key it
  // derives for that caller (seal_for in the pubkey statement).
  const argsFile = join(live, "outlayer-dispute-args.json");
  writeFileSync(argsFile, JSON.stringify({ source: { Project: { project_id: OUTLAYER.project_id, version_key: null } }, resource_limits: LIMITS, input_data: sealed, response_format: "Text" }));
  return argsFile;
}

export async function run() {
  const { config, Demo } = await import("./demo-tester.mjs");
  const c = config(process.env);
  if (!c.bazaar.endsWith(".testnet")) throw new Error("testnet only");
  const d = new Demo(c);
  const arbs = await d.client.view(c.bazaar, "arbiter_threshold", {});
  // Historical: the recorded run was made at threshold 1. Since 2026-11-14 the threshold is 2, so a
  // new run would need our arbiter's signature as well (submit_dispute_decisions); not built here.
  if (Number(arbs) !== 1) throw new Error(`arbiter_threshold is ${arbs}: this run relays one decision (submit_dispute_decision); the recorded run is historical (docs/keyless.md)`);
  const record = { date: new Date().toISOString().slice(0, 10), bazaar: c.bazaar, treasury: c.treasury, contract: OUTLAYER.contract, project_id: OUTLAYER.project_id, project_uuid: OUTLAYER.project_uuid, arbiter_key: OUTLAYER.keys.arbiter_key, rep_referee: REP_REFEREE };
  await d.run({ referee: forgedThenDispute(record), skipFinish: true });
  mkdirSync("fixtures/live/outlayer", { recursive: true });
  writeFileSync(OUT, JSON.stringify(record, null, 2) + "\n");
  console.log(`\nwrote ${OUT}`);
}

/** again <tester dir>: a second forged receipt (another `detail`, so another result hash) on the
 *  same unspent verdict, and the dispute again. The earlier record moves to `first_run`. */
async function again(dirName) {
  const { config, Demo } = await import("./demo-tester.mjs");
  const { keyFromSeed } = await import("../relayer/near.mjs");
  const c = config(process.env);
  const d = new Demo(c);
  await d.preflight();
  const dir = join(c.testersDir, dirName);
  const live = join(dir, "live");
  const key = keyFromSeed(readFileSync(join(dir, "account.seed"), "utf8").trim());
  const tester = { id: key.pub, key };
  (d.implicit ??= new Set()).add(tester.id);
  const prev = JSON.parse(readFileSync(join(live, "outlayer-dispute-input.json"), "utf8"));
  const record = JSON.parse(readFileSync(OUT, "utf8"));
  const v = await d.client.view(c.bazaar, "verdict", { nullifier: prev.result.body.nullifier });
  if (!v || v.spent || v.receipt) throw new Error("the verdict must be unspent and without a receipt");
  if (record.dispute?.nullifier === prev.result.body.nullifier && !record.first_run) record.first_run = record.dispute;
  const rec = { tester: tester.id, nullifier: prev.result.body.nullifier };
  const e = { tester: tester.id, nullifier: rec.nullifier, merchant: c.merchant, honest_refusal: record.first_run?.honest_refusal ?? record.dispute?.honest_refusal, txs: {} };
  record.dispute = e;
  const forged = await forgeAndSeal({ d, tester, live, base: prev.result, detail: `forged-${Date.now() % 1e6}`, e });
  const argsFile = await sealDispute({ d, live, obj: prev, verdict: prev.verdict, forged, e });
  try {
    await continueDispute({ d, tester, rec, e, argsFile, q: null, price: forged.body.price });
  } finally {
    writeFileSync(OUT, JSON.stringify(record, null, 2) + "\n");
    console.log(`\nwrote ${OUT}`);
  }
}

/** Keyless: [ok, text] lines from public RPC. `arbiterKey` pins the key the record must name
 *  (the manifest's OutLayer block, else the pubkey statement in outlayer-buy.mjs); `height(blockHash)`
 *  gives a block's height, for the order of the txs. */
export async function verifyRun(view, raw, rec = JSON.parse(readFileSync(OUT, "utf8")), arbiterKey = OUTLAYER.keys.arbiter_key, height = null) {
  const lines = [];
  const tx = async (h, s) => {
    if (!h) return null;
    try {
      const t = await raw(h, s);
      if (!t?.transaction) console.error(`   rpc: tx ${h} (${s}) unreadable: ${JSON.stringify(t ?? null).slice(0, 160)}`);
      return t?.transaction ? t : null;
    } catch (err) {
      console.error(`   rpc: tx ${h} (${s}): ${err.message.slice(0, 160)}`);
      return null;
    }
  };
  const logsOf = (t) => (t ? [t.transaction_outcome, ...t.receipts_outcome].flatMap((o) => o.outcome.logs) : []);
  const calls = (t) => {
    if (!t) return [];
    const walk = (acts) => acts.flatMap((a) => (a.FunctionCall ? [{ method: a.FunctionCall.method_name, args: JSON.parse(Buffer.from(a.FunctionCall.args, "base64").toString() || "{}") }] : a.Delegate ? walk(a.Delegate.delegate_action.actions.map((x) => x.NonDelegateAction ?? x)) : []));
    return walk(t.transaction.actions);
  };
  const delegateSender = (t) => t?.transaction.actions.find((a) => a.Delegate)?.Delegate.delegate_action.sender_id ?? null;
  const evs = (t) => events(logsOf(t));
  const e = rec.dispute;
  const pinned = rec.arbiter_key === arbiterKey;
  // The anchor: queued as id 3 (kind arbiter, this key), then executed after the timelock.
  const [qTx, xTx] = await Promise.all([tx(rec.anchor?.queued, rec.bazaar), tx(rec.anchor?.executed, rec.bazaar)]);
  const queued = evs(qTx).find((x) => x.event === "anchor_queued")?.data?.[0];
  const reg = evs(xTx).find((x) => x.event === "arbiter_registered")?.data?.[0];
  const anchorOk = pinned && !failOf(qTx) && !failOf(xTx) && queued?.id === rec.anchor.id && queued.kind === "arbiter" && queued.args?.key_hex === arbiterKey
    && reg?.key === arbiterKey && reg.timelock === rec.anchor.id && calls(xTx).some((x) => x.method === "execute_anchor" && x.args.id === rec.anchor.id);
  lines.push([Boolean(anchorOk), `${rec.bazaar} registered the OutLayer arbiter key ${arbiterKey.slice(0, 12)}.. through the anchor timelock (anchor ${rec.anchor?.id} queued, then executed)`]);
  const [forgedTx, reqTx, resTx, subTx, setTx, v] = await Promise.all([
    tx(e.txs.forged_receipt, rec.treasury),
    tx(e.txs.request_execution, rec.bazaar),
    tx(e.txs.outlayer_resolve, "worker.outlayer.testnet"),
    tx(e.txs.submit_dispute_decision, rec.treasury),
    tx(e.txs.settle_attempt, rec.treasury),
    view(rec.bazaar, "verdict", { nullifier: e.nullifier }),
  ]);
  // The forged receipt: signed by the operator's testnet referee key, for the cheat at this merchant, sent by the tester, stored.
  const forged = calls(forgedTx).find((x) => x.method === "submit_referee_result")?.args.result;
  const forgedHash = forged ? sha256(Buffer.concat([RESULT_TAG, Buffer.from(JSON.stringify(forged.body))])) : null;
  const forgedOk = forgedHash === e.forged_result_sha256 && forged.worker_key === rec.rep_referee && forged.body.outcome === "receipt" && forged.body.nullifier === e.nullifier && forged.body.merchant === e.merchant
    && forgedTx.transaction.receiver_id === e.tester && delegateSender(forgedTx) === e.tester
    && edOk(RESULT_TAG, forged.body, forged.worker_key, forged.signature) && !failOf(forgedTx) && evs(forgedTx).some((x) => x.event === "referee_receipt" && x.data?.[0]?.nullifier === e.nullifier);
  lines.push([Boolean(forgedOk), `a receipt for the cheat signed by the operator's testnet referee key ${rec.rep_referee.slice(0, 12)}.. was stored (the bazaar trusts that key)`]);
  // The dispute went to OutLayer, sealed, from the bazaar account; the request tx succeeded.
  const asked = evs(reqTx).find((x) => x.event === "execution_requested")?.data?.[0];
  const rd = asked ? JSON.parse(asked.request_data) : {};
  const project = await view(rec.contract, "get_project", { project_id: rec.project_id });
  const toProject = !failOf(reqTx) && rd.project_id === rec.project_id && rd.predecessor_id === rec.bazaar && rd.request_id === e.request_id && /^\{"sealed"/.test(rd.input_data ?? "") && sha256(rd.input_data) === e.sealed_input_sha256;
  lines.push([Boolean(toProject && project?.uuid === rec.project_uuid), `OutLayer was called directly with the sealed dispute input: project ${rec.project_id} (${rec.project_uuid}), request ${e.request_id}, the request tx succeeded`]);
  // OutLayer's worker resolved the request on chain (no Failure) with a decision signed by the arbiter key.
  const ra = calls(resTx)[0]?.args ?? {};
  const out = ra.response?.output?.Text ? JSON.parse(ra.response.output.Text) : null;
  const ru = ra.response?.resources_used ?? {};
  const fromWorker = !failOf(resTx) && resTx.transaction.signer_id === "worker.outlayer.testnet" && resTx.transaction.receiver_id === rec.contract && ra.request_id === e.request_id && ra.response?.success === true
    && ru.instructions === e.outlayer?.instructions && ru.time_ms === e.outlayer?.time_ms;
  // The request tx itself returned the module's output (a timed-out request returns no output).
  const reqOut = (() => {
    try {
      const v1 = JSON.parse(Buffer.from(reqTx?.status?.SuccessValue ?? "", "base64").toString());
      return typeof v1 === "string" ? JSON.parse(v1) : v1;
    } catch {
      return null;
    }
  })();
  const decOk = JSON.stringify(reqOut) === JSON.stringify(out) && e.decision === out?.body?.decision && (out?.body?.reasons?.[0] ?? "").endsWith(e.honest_refusal ?? "\u0000")
    && out?.arbiter_key === arbiterKey && out.body.decision === "overturned" && out.body.nullifier === e.nullifier
    && out.body.referee_result_sha256 === e.forged_result_sha256 && JSON.stringify(out.body.reasons) === JSON.stringify(e.reasons) && edOk(DISPUTE_TAG, out.body, out.arbiter_key, out.signature);
  lines.push([Boolean(fromWorker && decOk), `OutLayer's worker resolved the request on chain with overturned, signed by the project's arbiter key ${arbiterKey.slice(0, 12)}.. (${out?.body?.reasons?.[0] ?? "?"})`]);
  // Relayed as is; the bazaar cleared the receipt; the tester's settle refused; no receipt today.
  const relayed = JSON.stringify(calls(subTx).find((x) => x.method === "submit_dispute_decision")?.args.decision) === JSON.stringify(out) && !failOf(subTx) && evs(subTx).some((x) => x.event === "dispute_overturned" && x.data?.[0]?.nullifier === e.nullifier);
  const scall = calls(setTx).find((x) => x.method === "settle_demo");
  const blocked = scall?.args.nullifier === e.nullifier && scall.args.merchant === e.merchant && setTx.transaction.receiver_id === e.tester && delegateSender(setTx) === e.tester && JSON.stringify(failOf(setTx) ?? "").includes("no referee receipt");
  lines.push([Boolean(relayed && blocked && v && !v.receipt && !v.spent), `the decision, relayed unchanged, cleared the receipt (dispute_overturned); the tester's settle_demo at ${e.merchant.split(".")[0]} refused (no referee receipt); the verdict holds no receipt and is unspent`]);
  // Order: forged receipt < request < resolve < relay < settle, by block height.
  let ordered = false, hs = [];
  try {
    hs = height ? await Promise.all([forgedTx, reqTx, resTx, subTx, setTx].map((t) => (t ? height(t.transaction_outcome.block_hash) : null))) : [];
    ordered = hs.length === 5 && hs.every((h, i) => Number.isInteger(h) && (i === 0 || h > hs[i - 1]));
  } catch (err) {
    console.error(`   rpc: block heights: ${err.message.slice(0, 160)}`);
  }
  lines.push([ordered, `in block order: forged receipt, request, resolve, relay, settle (${hs.join(" < ") || "heights unread"})`]);
  // The first run is kept as a timeout: its resolve tx failed on chain.
  {
    const r1 = await tx(rec.first_run?.txs?.outlayer_resolve, "worker.outlayer.testnet");
    const f1 = JSON.stringify(failOf(r1) ?? "");
    lines.push([Boolean(r1 && f1.includes("Execution request not found")), `the first run, kept as a timeout: OutLayer's resolve ${String(rec.first_run?.txs?.outlayer_resolve).slice(0, 8)}.. failed on chain (Execution request not found)`]);
  }
  return lines;
}

/** Keyless: the arbiter keys from every recorded registration tx, the threshold tx, and the live
 *  threshold. The contract has no view of the arbiter set: the txs come from the nearblocks index. */
export async function verifyArbiters(view, raw, rec = JSON.parse(readFileSync(OUT, "utf8"))) {
  const lines = [];
  const keys = new Set();
  let read = 0;
  for (const h of rec.arbiter_registrations ?? []) {
    try {
      const t = await raw(h, rec.bazaar);
      if (!t?.transaction || failOf(t) || t.transaction.receiver_id !== rec.bazaar) continue;
      const regs = events([t.transaction_outcome, ...t.receipts_outcome].flatMap((o) => o.outcome.logs)).filter((x) => x.event === "arbiter_registered");
      if (!regs.length) continue;
      read++;
      for (const x of regs) keys.add(x.data[0].key);
    } catch (err) {
      console.error(`   rpc: tx ${h}: ${err.message.slice(0, 160)}`);
    }
  }
  const want = [rec.arbiter_key, "b5df0fa0976651cfe0dfce09e887224729e930472b992436023bb9ad8e75698b"].sort();
  const setOk = (rec.arbiter_registrations ?? []).length === 6 && new Set(rec.arbiter_registrations).size === 6 && read === 6 && JSON.stringify([...keys].sort()) === JSON.stringify(want);
  lines.push([setOk, `the ${read} arbiter_registered txs the index lists name 2 keys: the operator's b5df0fa0.. and the OutLayer key ${rec.arbiter_key.slice(0, 12)}.. (the contract has no view of the set)`]);
  const t = Number(await view(rec.bazaar, "arbiter_threshold", {}));
  let tt = null;
  try {
    tt = rec.threshold_tx ? await raw(rec.threshold_tx, rec.bazaar) : null;
  } catch (err) {
    console.error(`   rpc: tx ${rec.threshold_tx}: ${err.message.slice(0, 160)}`);
  }
  const set = tt?.transaction ? events([tt.transaction_outcome, ...tt.receipts_outcome].flatMap((o) => o.outcome.logs)).find((x) => x.event === "arbiter_threshold_set")?.data?.[0] : null;
  const want2 = Number(rec.arbiter_threshold ?? 1);
  const tcall = tt?.transaction?.actions?.find((a) => a.FunctionCall)?.FunctionCall;
  const tOk = Boolean(rec.threshold_tx) && tt?.transaction?.receiver_id === rec.bazaar && tcall?.method_name === "set_arbiter_threshold" && JSON.parse(Buffer.from(tcall.args, "base64").toString()).n === want2 && set?.n === want2 && !failOf(tt);
  lines.push([t === want2 && tOk, `arbiter_threshold on ${rec.bazaar} is ${t} (recorded ${want2}${rec.threshold_tx ? `, set in ${rec.threshold_tx.slice(0, 8)}..` : ""}): every dispute decision needs ${t} distinct registered arbiter signatures`]);
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] ?? "verify";
  if (cmd === "run") {
    run().catch((e) => {
      console.error(`\noutlayer-dispute: FAIL ${e.message}`);
      process.exit(1);
    });
  } else if (cmd === "again") {
    // again <tester dir under KEYS_DIR/testers>: the dispute once more on that tester's verdict.
    again(process.argv[3]).catch((e) => {
      console.error(`\noutlayer-dispute: FAIL ${e.message}`);
      process.exit(1);
    });
  } else if (cmd === "verify") {
    if (!existsSync(OUT)) {
      console.error(`no ${OUT}: run first`);
      process.exit(1);
    }
    const { rpcClient } = await import("../relayer/near.mjs");
    const client = rpcClient(process.env.NEAR_RPC || "https://archival-rpc.testnet.fastnear.com");
    const raw = async (h, s) => (await client.rpc("tx", { tx_hash: h, sender_account_id: s, wait_until: "FINAL" })).result;
    const view = (a, m, x) => client.view(a, m, x);
    const height = async (h) => (await client.rpc("block", { block_id: h })).result.header.height;
    // A public RPC that drops or rate-limits is a SKIP (exit 3), as in make mainnet-check, not a failure.
    const NET = /RPC kept failing|fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|429|Too Many Requests|rate limit|timed out|socket hang up/i;
    const errs = [];
    const origErr = console.error;
    console.error = (...a) => (errs.push(a.join(" ")), origErr(...a));
    let lines;
    try {
      lines = [...(await verifyRun(view, raw, undefined, undefined, height)), ...(await verifyArbiters(view, raw))];
    } catch (err) {
      if (!NET.test(err.message)) throw err;
      console.log(`SKIP  outlayer-dispute verify: public testnet RPC unreachable or rate-limited (${err.message.slice(0, 80)})`);
      process.exit(3);
    }
    for (const [ok, t] of lines) console.log(`${ok ? "PASS" : "FAIL"}  ${t}`);
    if (!lines.every(([ok]) => ok) && errs.some((e) => NET.test(e))) {
      console.log("SKIP  outlayer-dispute verify: a FAIL above follows a public RPC error; run again");
      process.exit(3);
    }
    process.exit(lines.every(([ok]) => ok) ? 0 : 1);
  } else {
    console.error("usage: outlayer-dispute.mjs run | again <tester dir> | verify");
    process.exit(2);
  }
}
