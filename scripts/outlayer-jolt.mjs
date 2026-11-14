#!/usr/bin/env node
// Jolt verification inside OutLayer's TEE (docs/outlayer.md, "Jolt verification on OutLayer").
// Testnet only.
//
//   node scripts/outlayer-jolt.mjs                          the plan; sends nothing
//   node scripts/outlayer-jolt.mjs <step> --go              one step: project | pubkey | honest | forged | attest
//   node scripts/outlayer-jolt.mjs verify                   the keyless check of fixtures/live/outlayer/jolt.json
//
// The component (worker/outlayer-jolt) verifies a Jolt proof against a program it pins by hash and
// signs the verdict with its project's host key. `honest` sends the standing proof behind the
// bazaar's standing root (SOURCE: submit_graph_scores 8AmCe4FN..), `forged` the same proof with one byte
// flipped; `attest` hands the signed accept to the registry's attest_use, `attest-reject` the
// signed reject. Signs as bookerbob.testnet
// (near-cli keychain); each step records its tx in the record.
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const OUT = "fixtures/live/outlayer/jolt.json";
const NET = "testnet-fastnear";
const SIGNER = "bookerbob.testnet";
const OUTLAYER = "outlayer.testnet";
const NAME = "bookerbob-jolt-verify";
export const PROJECT = `${SIGNER}/${NAME}`;
const URL_ = "https://github.com/hustle1hustle/near-bookerbob/releases/download/jolt-verify-v0/bookerbob-jolt-verify-outlayer.wasm";
export const WASM_SHA = "cad8d2e12500315b9bef983b6983489d46b958f6be2784f18af1229c839fbb65";
export const PROGRAM = "c780ceabae4decfa59703a9988ab2483313c6c1d2f15c7c0ad8fc60255a5c3a5";
const SRC = "fixtures/live/outlayer/jolt/standing-live/";
// The bazaar's submit_graph_scores that posted this proof's root (sha256 of the proof in its args).
// The 10-event update of 2026-11-14 (the bazaar's root at the time of the run, 3b5db5e9..); the
// 8-event update before it (5jgLWwxz..) was verified first and stays in the record as history.
export const SOURCE = { bazaar: "bookerbob.testnet", tx: "8AmCe4FNKXafMqZpeohNEK51bAtDDTm27pPDS8rSWBDD", signer: "bookerbob-demo.testnet" };
const LIMITS = { max_instructions: 50_000_000_000, max_memory_mb: 512, max_execution_seconds: 120 };
const KEYS_TAG = "bookerbob/jolt-verify-keys/v0\0";
const TAG = "bookerbob/jolt-verify/v0\0";
const sha = (b) => createHash("sha256").update(b).digest("hex");

/** ed25519 over `msg` under the raw 32-byte hex key. */
export function edOk(keyHex, msg, sigHex) {
  try {
    const pk = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(keyHex, "hex")]), format: "der", type: "spki" });
    return edVerify(null, Buffer.from(msg), pk, Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}

const record = () => (existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { date: new Date().toISOString().slice(0, 10), project_id: PROJECT, contract: OUTLAYER, wasm_url: URL_, wasm_sha256: WASM_SHA, program_hash: PROGRAM, source: SOURCE, txs: {} });
const save = (r) => {
  mkdirSync("fixtures/live/outlayer", { recursive: true });
  writeFileSync(OUT, JSON.stringify(r, null, 2) + "\n");
};

/** near-cli sends from bookerbob.testnet (keychain); returns the tx hash. */
function send(contract, method, argsFile, deposit, gas = "300.0 Tgas") {
  const o = spawnSync("near", ["contract", "call-function", "as-transaction", contract, method, "file-args", argsFile, "prepaid-gas", gas, "attached-deposit", deposit, "sign-as", SIGNER, "network-config", NET, "sign-with-keychain", "send"], { encoding: "utf8", maxBuffer: 64 << 20 });
  const text = `${o.stdout}${o.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  const hash = text.match(/Transaction ID: ([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1];
  console.log(`   ${o.status === 0 ? "ok" : "FAILED"} ${method}  ${hash ? `https://testnet.nearblocks.io/txns/${hash}` : text.slice(-300)}`);
  if (!hash) throw new Error(`${method}: no tx hash`);
  return hash;
}

/** Signs with near-cli (display) and broadcasts over RPC, so a call the contract refuses still
 *  lands as a failed tx with a hash (near-cli does not send a call its simulation refuses). */
async function sendRefusable(contract, method, argsFile, gas = "50.0 Tgas") {
  const o = spawnSync("near", ["contract", "call-function", "as-transaction", contract, method, "file-args", argsFile, "prepaid-gas", gas, "attached-deposit", "0 NEAR", "sign-as", SIGNER, "network-config", NET, "sign-with-keychain", "display"], { encoding: "utf8", maxBuffer: 64 << 20 });
  const text = `${o.stdout}${o.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  const b64 = text.split("serialized as base64):")[1]?.trim().split(/\s/)[0];
  if (!b64) throw new Error(`could not sign ${method}: ${text.slice(-200)}`);
  const { rpcClient } = await import("../relayer/near.mjs");
  const r = await rpcClient("https://test.rpc.fastnear.com").rpc("send_tx", { signed_tx_base64: b64, wait_until: "FINAL" });
  const hash = r.result?.transaction?.hash;
  const fail = r.result ? [r.result.transaction_outcome, ...r.result.receipts_outcome].map((x) => x.outcome.status.Failure).find(Boolean) ?? r.result.status.Failure : r.error;
  console.log(`   ${fail ? "refused" : "ACCEPTED"} ${method}  https://testnet.nearblocks.io/txns/${hash}  ${JSON.stringify(fail ?? {}).slice(0, 160)}`);
  if (!hash) throw new Error(`${method}: no tx hash`);
  return hash;
}

const tmp = (name, obj) => {
  mkdirSync("worker/outlayer-jolt/target/go", { recursive: true });
  const f = `worker/outlayer-jolt/target/go/${name}.json`;
  writeFileSync(f, JSON.stringify(obj));
  return f;
};
const runArgs = (input) => ({ source: { Project: { project_id: PROJECT, version_key: null } }, resource_limits: LIMITS, input_data: JSON.stringify(input), response_format: "Json" });
const proofInput = (flip) => {
  const proof = Buffer.from(readFileSync(SRC + "proof.bin"));
  if (flip) proof[proof.length - 100] ^= 1;
  return { program_hash: PROGRAM, proof: proof.toString("base64"), io: readFileSync(SRC + "io_device.bin").toString("hex") };
};

/** A run's output: the tx's return value when OutLayer answered inside the yield window, else
 *  the output OutLayer's worker posted in its own resolve tx for that request (recorded). */
async function settleOutput(r, key) {
  const { rpcClient } = await import("../relayer/near.mjs");
  const t = (await rpcClient("https://test.rpc.fastnear.com").rpc("tx", { tx_hash: r.txs[key], sender_account_id: SIGNER, wait_until: "FINAL" })).result;
  if (Buffer.from(t.status.SuccessValue ?? "", "base64").toString() !== "null" && t.status.SuccessValue) {
    (r.via ??= {})[key] = "callback";
    return;
  }
  const ev = t.receipts_outcome.flatMap((o) => o.outcome.logs).find((l) => l.includes("execution_requested"));
  const rd = JSON.parse(JSON.parse(ev.slice(11)).data[0].request_data);
  console.log(`   the callback timed out; reading OutLayer's resolve tx for request ${rd.request_id}`);
  const { findResolve } = await import("./outlayer-buy.mjs");
  const res = await findResolve(rd.request_id, Math.floor(rd.timestamp / 1e9));
  (r.via ??= {})[key] = "resolve";
  r.txs[`${key}_resolve`] = res.tx;
  (r.request_ids ??= {})[key] = rd.request_id;
}

const steps = {
  project: async (r) => {
    const got = sha(Buffer.from(await (await fetch(URL_)).arrayBuffer()));
    if (got !== WASM_SHA) throw new Error(`${URL_} serves ${got}, expected ${WASM_SHA}`);
    r.txs.create_project = send(OUTLAYER, "create_project", tmp("create", { name: NAME, source: { WasmUrl: { url: URL_, hash: WASM_SHA, build_target: "wasm32-wasip2" } } }), "0.1 NEAR", "100.0 Tgas");
  },
  pubkey: async (r) => {
    r.txs.pubkey = send(OUTLAYER, "request_execution", tmp("pubkey", runArgs({ cmd: "pubkey" })), "0.05 NEAR");
    await settleOutput(r, "pubkey");
    const out = await outputOf(r, "pubkey", async (h, sn) => (await (await import("../relayer/near.mjs")).rpcClient("https://test.rpc.fastnear.com").rpc("tx", { tx_hash: h, sender_account_id: sn, wait_until: "FINAL" })).result);
    r.key = out?.keys?.jolt_verify_key ?? null;
    console.log(`   jolt_verify_key ${r.key}`);
  },
  // About 119 KB of input: OutLayer keeps it in state while pending and holds a storage deposit
  // for it, returned at settlement; 1 NEAR covers both.
  honest: async (r) => {
    r.txs.honest = send(OUTLAYER, "request_execution", tmp("honest", runArgs(proofInput(false))), "1 NEAR");
    await settleOutput(r, "honest");
  },
  forged: async (r) => {
    r.txs.forged = send(OUTLAYER, "request_execution", tmp("forged", runArgs(proofInput(true))), "1 NEAR");
    await settleOutput(r, "forged");
  },
  // The same gate, handed the signed reject of the forged proof: it must refuse it.
  "attest-reject": async (r) => {
    const out = await outputOf(r, "forged", async (h, s) => (await (await import("../relayer/near.mjs")).rpcClient("https://test.rpc.fastnear.com").rpc("tx", { tx_hash: h, sender_account_id: s, wait_until: "FINAL" })).result);
    r.txs.attest_reject = await sendRefusable(r.registry.account, "attest_use", tmp("attest-reject", { request_id: r.registry.request_id, verifier: r.registry.verifier, statement: JSON.stringify(out.statement), signature: out.signature }));
  },
  attest: async (r) => {
    const reg = process.env.REGISTRY;
    const name = process.env.VERIFIER_NAME;
    if (!reg || !name) throw new Error("REGISTRY=<account> VERIFIER_NAME=<name> are needed");
    const out = await outputOf(r, "honest", async (h, s) => (await (await import("../relayer/near.mjs")).rpcClient("https://test.rpc.fastnear.com").rpc("tx", { tx_hash: h, sender_account_id: s, wait_until: "FINAL" })).result);
    r.registry = { account: reg, verifier: name, request_id: process.env.REQUEST_ID || "standing-graph" };
    r.txs.attest_use = send(reg, "attest_use", tmp("attest", { request_id: r.registry.request_id, verifier: name, statement: JSON.stringify(out.statement), signature: out.signature }), "0 NEAR", "50.0 Tgas");
  },
};

/** The output of run `key`: the request tx's return value (callback), or the Json output in
 *  OutLayer's resolve tx, which must be by worker.outlayer.testnet to outlayer.testnet and name
 *  the request id the request tx's execution_requested event carries. Null when neither holds. */
export async function outputOf(rec, key, raw) {
  const get = async (h, s) => {
    try {
      const t = h ? await raw(h, s) : null;
      return t?.transaction ? t : null;
    } catch {
      return null;
    }
  };
  const t = await get(rec.txs[key], SIGNER);
  if (!t) return null;
  const val = (() => {
    try {
      return JSON.parse(Buffer.from(t.status.SuccessValue ?? "", "base64").toString() || "null");
    } catch {
      return null;
    }
  })();
  if (rec.via?.[key] !== "resolve") return val;
  const ev = [t.transaction_outcome, ...t.receipts_outcome].flatMap((o) => o.outcome.logs).find((l) => l.includes("execution_requested"));
  const rid = ev ? JSON.parse(JSON.parse(ev.slice(11)).data[0].request_data).request_id : null;
  const res = await get(rec.txs[`${key}_resolve`], "worker.outlayer.testnet");
  const fc = res?.transaction?.actions?.find((a) => a.FunctionCall)?.FunctionCall;
  if (!fc || res.transaction.signer_id !== "worker.outlayer.testnet" || res.transaction.receiver_id !== rec.contract) return null;
  const a = JSON.parse(Buffer.from(fc.args, "base64").toString());
  return rid != null && a.request_id === rid && a.response?.success ? a.response.output?.Json ?? null : null;
}

/** Keyless: [ok, text] lines. `view(account, method, args)`; `raw(hash, sender)` the tx result or null. */
export async function verifyRun(view, raw, rec = JSON.parse(readFileSync(OUT, "utf8"))) {
  const lines = [];
  const tx = async (h, s) => {
    try {
      const t = h ? await raw(h, s) : null;
      return t?.transaction ? t : null;
    } catch {
      return null;
    }
  };
  const logsOf = (t) => (t ? [t.transaction_outcome, ...t.receipts_outcome].flatMap((o) => o.outcome.logs) : []);
  const failOf = (t) => (t ? [t.transaction_outcome, ...t.receipts_outcome].map((o) => o.outcome.status.Failure).find(Boolean) ?? t.status.Failure : "unreadable");
  const ret = (t) => {
    try {
      return JSON.parse(Buffer.from(t?.status?.SuccessValue ?? "", "base64").toString() || "null");
    } catch {
      return null;
    }
  };
  const args = (t) => {
    const fc = t?.transaction?.actions?.find((a) => a.FunctionCall)?.FunctionCall;
    return fc ? JSON.parse(Buffer.from(fc.args, "base64").toString()) : null;
  };
  // The request asked for this project at this wasm: execution_requested names the hash (on the
  // callback path execution_completed does too).
  const ran = (t) => logsOf(t).some((l) => l.includes("execution_requested") && l.includes(rec.wasm_sha256) && l.includes(rec.project_id));
  const signedBy = (out, key) => out?.statement && typeof out.signature === "string" && edOk(key, TAG + JSON.stringify(out.statement), out.signature);

  const versions = (await view(rec.contract, "list_versions", { project_id: rec.project_id }).catch(() => null)) ?? [];
  lines.push([versions.length === 1 && versions[0].wasm_hash === rec.wasm_sha256 && versions[0].is_active, `project ${rec.project_id}: one version, wasm ${rec.wasm_sha256.slice(0, 12)}.., active`]);

  const pk = await tx(rec.txs.pubkey, SIGNER);
  const keys = await outputOf(rec, "pubkey", raw);
  const key = keys?.keys?.jolt_verify_key;
  const keysOk = key === rec.key && keys.keys.programs?.includes(rec.program_hash) && edOk(key, KEYS_TAG + JSON.stringify(keys.keys), keys.signature) && ran(pk);
  lines.push([Boolean(keysOk), `pubkey run on OutLayer: key ${String(rec.key).slice(0, 12)}.., pins program ${rec.program_hash.slice(0, 12)}.., statement signed by it`]);

  // Honest: the proof the bazaar's submit_graph_scores names, accepted and signed, its output the
  // root that submit posted.
  const [src, h] = await Promise.all([tx(rec.source.tx, rec.source.signer), tx(rec.txs.honest, SIGNER)]);
  const sa = args(src) ?? {};
  const hin = JSON.parse(args(h)?.input_data ?? "null") ?? {};
  const hout = await outputOf(rec, "honest", raw);
  const proofSha = hin.proof ? sha(Buffer.from(hin.proof, "base64")) : null;
  const io = hin.io ? Buffer.from(hin.io, "hex") : Buffer.alloc(0);
  const at = sa.root ? io.indexOf(Buffer.from(sa.root, "hex")) : -1;
  const outputIsRoot = at >= 0 && hout?.statement?.output_sha256 === sha(io.subarray(at, at + 64));
  const hs = hout?.statement ?? {};
  lines.push([
    ran(h) && signedBy(hout, rec.key) && hs.verdict === "accept" && hs.panic === false && hs.program_hash === rec.program_hash && sa.program_hash === rec.program_hash && proofSha === hs.proof_sha256 && proofSha === sa.proof_sha256 && outputIsRoot && !failOf(src),
    `honest: OutLayer verified the proof ${String(proofSha).slice(0, 12)}.. that ${rec.source.bazaar} submit_graph_scores names, under program ${rec.program_hash.slice(0, 12)}..; signed accept, its output is that submit's root ${String(sa.root).slice(0, 12)}..`,
  ]);
  const f = await tx(rec.txs.forged, SIGNER);
  const fout = await outputOf(rec, "forged", raw);
  const fin = JSON.parse(args(f)?.input_data ?? "null") ?? {};
  const fProof = fin.proof ? sha(Buffer.from(fin.proof, "base64")) : null;
  lines.push([ran(f) && signedBy(fout, rec.key) && fout.statement.verdict === "reject" && fProof === fout.statement.proof_sha256 && fProof !== proofSha, `forged: the same proof with one byte flipped, signed reject (${fout?.reason ?? "?"})`]);
  if (rec.txs.attest_use) {
    const a = await tx(rec.txs.attest_use, SIGNER);
    const aa = args(a) ?? {};
    const ok = !failOf(a) && aa.statement === JSON.stringify(hs) && aa.signature === hout?.signature && aa.verifier === rec.registry.verifier && a.transaction.receiver_id === rec.registry.account;
    const b = await tx(rec.txs.attest_reject, SIGNER);
    const ba = args(b) ?? {};
    const refused = Boolean(b) && JSON.stringify(failOf(b) ?? "").includes("not an accept") && ba.statement === JSON.stringify(fout?.statement ?? {}) && ba.signature === fout?.signature && b.transaction.receiver_id === rec.registry.account;
    lines.push([ok && refused, `consumer: ${rec.registry.account} attest_use took the signed accept for ${rec.registry.request_id} and refused the signed reject of the forged proof`]);
  }
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd] = process.argv.slice(2);
  if (cmd === "verify") {
    const { readers } = await import("./lib/rpc-fallback.mjs");
    const { view, raw } = readers("testnet");
    const lines = await verifyRun(view, raw);
    for (const [ok, t] of lines) console.log(`${ok ? "PASS" : "FAIL"}  ${t}`);
    process.exit(lines.every(([ok]) => ok) ? 0 : 1);
  } else if (steps[cmd] && process.argv.includes("--go")) {
    const r = record();
    await steps[cmd](r);
    save(r);
    console.log(`recorded in ${OUT}`);
  } else {
    console.log(`outlayer-jolt: testnet only, nothing sent without --go.\n project ${PROJECT}, wasm ${WASM_SHA}\n program ${PROGRAM}, proof ${SRC}\n steps: project, pubkey, honest, forged, attest (REGISTRY=.. VERIFIER_NAME=..), then verify`);
  }
}
