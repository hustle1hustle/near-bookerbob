#!/usr/bin/env node
// The evaluator inside OutLayer's TEE (docs/outlayer-eval.md). Testnet only.
//
//   node scripts/outlayer-eval.mjs                     the plan; sends nothing
//   node scripts/outlayer-eval.mjs <step> --go         one step (below), recorded in OUT
//   node scripts/outlayer-eval.mjs verify              the keyless check of OUT over public RPC
//
// Steps: project (create_project from the release asset), pubkey (the evaluator and seal keys,
// signed), register (register_issuer on the bazaar; queued for the anchor delay), execute
// (execute_anchor once the delay passed), buyers (two one-time implicit buyer accounts funded by
// bookerbob-demo.testnet, the demo treasury), accept (sent by bookerbob.testnet: the founder's signed-in GitHub presentation sealed to the TEE, asking
// to reveal nothing: a signed verdict), submit (buyer A submits it: the bazaar records it under the
// evaluator key), sybil (buyer B seals the same presentation: the TEE gives the same nullifier, the
// bazaar refuses it), refuse (the same presentation asking for github_builder: a signed refusal).
//
// The input of every run is sealed X25519 (worker/src/sealed.rs v0) to `seal_x25519`, a key whose
// secret exists only inside the project's TEE runs. OutLayer's input_data is public on chain: it
// holds ciphertext only. The plaintext (the presentation) is written to no file.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPublicKey, randomBytes, verify as edVerify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OUT = "fixtures/live/outlayer/eval.json";
const NET = "testnet-fastnear";
const RPC = "https://test.rpc.fastnear.com";
const SIGNER = "bookerbob.testnet";
const BAZAAR = "bookerbob.testnet";
const TREASURY = "bookerbob-demo.testnet";
const OUTLAYER = "outlayer.testnet";
const NAME = "bookerbob-evaluator";
export const PROJECT = `${SIGNER}/${NAME}`;
const URL_ = process.env.EVAL_WASM_URL ?? "https://github.com/hustle1hustle/near-bookerbob/releases/download/evaluator-v0/bookerbob-eval-outlayer.wasm";
export const WASM_SHA = process.env.EVAL_WASM_SHA ?? "a77f88c951a694a6fcbf91ee4e882d1a537f85abfeab6e1c3a096ccedebe65ba";
const LIMITS = { max_instructions: 10_000_000_000, max_memory_mb: 256, max_execution_seconds: 60 };
const CONTEXT = "bookerbob:v0:evaltee-github";
const PRESENTATION = "fixtures/live/prove-me/founder-github-owner.presentation";
const KEYS_TAG = "bookerbob/eval-keys/v0\0";
const REFUSAL_TAG = "bookerbob/eval-refusal/v0\0";
const VERDICT_TAG = "bookerbob/verdict/v0\0";
const KEYS_DIR = process.env.KEYS_DIR ?? `${process.env.HOME}/.rep-secrets/bookerbob-testnet/evaltee`;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const link = (h) => `https://testnet.nearblocks.io/txns/${h}`;

export function edOk(keyHex, msg, sigHex) {
  try {
    const pk = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(keyHex, "hex")]), format: "der", type: "spki" });
    return edVerify(null, Buffer.from(msg), pk, Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}

/** serde_json's compact form with keys in struct order is what the component signs; for a
 *  JSON.parse'd object the key order is preserved, so JSON.stringify reproduces it. */
const compact = (v) => JSON.stringify(v);

/** The envelope as serde_json writes the Rust struct (field order, `disclosure` skipped when
 *  absent): OutLayer hands a Json output back with its keys sorted, so the order is rebuilt here. */
export function envelopeJson(e) {
  const a = e.attestation;
  const o = { v: e.v, context: e.context, nullifier: e.nullifier, commitment: e.commitment, proof_hash: e.proof_hash, predicates: e.predicates, tier: e.tier, attestation: { model: a.model, tcb_status: a.tcb_status, report_hash: a.report_hash }, cnf: e.cnf, max_spend: e.max_spend, issued_at_ms: e.issued_at_ms, expires_at_ms: e.expires_at_ms };
  if (e.disclosure != null) o.disclosure = e.disclosure;
  return JSON.stringify(o);
}

/** The issuer signature exactly as submit_verdict checks it: ed25519 over sha256(tag || json). */
export function verdictOk(v) {
  const digest = createHash("sha256").update(Buffer.concat([Buffer.from(VERDICT_TAG), Buffer.from(envelopeJson(v.envelope))])).digest();
  return v.alg === "ed25519" && edOk(v.issuer_key, digest, v.signature);
}
export const refusalOk = (r) => edOk(r.key, Buffer.concat([Buffer.from(REFUSAL_TAG), Buffer.from(compact(r.refusal))]), r.signature);
export const keysOk = (p) => edOk(p.keys.evaluator_key, Buffer.concat([Buffer.from(KEYS_TAG), Buffer.from(compact(p.keys))]), p.signature);

const record = () => (existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { date: new Date().toISOString().slice(0, 10), project_id: PROJECT, contract: OUTLAYER, bazaar: BAZAAR, wasm_url: URL_, wasm_sha256: WASM_SHA, context: CONTEXT, presentation_sha256: sha(readFileSync(PRESENTATION)), txs: {} });
const save = (r) => {
  mkdirSync("fixtures/live/outlayer", { recursive: true });
  writeFileSync(OUT, JSON.stringify(r, null, 2) + "\n");
};
const tmpDir = "worker/outlayer-eval/target/go";
const tmp = (name, obj) => {
  mkdirSync(tmpDir, { recursive: true });
  const f = `${tmpDir}/${name}.json`;
  writeFileSync(f, JSON.stringify(obj), { mode: 0o600 });
  return f;
};

/** near-cli from bookerbob.testnet (keychain); returns the tx hash. */
function cli(args) {
  const o = spawnSync("near", [...args, "network-config", NET, "sign-with-keychain", "send"], { encoding: "utf8", maxBuffer: 64 << 20 });
  const text = `${o.stdout}${o.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  const hash = text.match(/Transaction ID: ([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1];
  console.log(`   ${o.status === 0 ? "ok" : "FAILED"} ${args[3] ?? args[0]}  ${hash ? link(hash) : text.slice(-400)}`);
  if (!hash) throw new Error("no tx hash");
  return hash;
}
const call = (contract, method, argsFile, deposit, gas = "300.0 Tgas") =>
  cli(["contract", "call-function", "as-transaction", contract, method, "file-args", argsFile, "prepaid-gas", gas, "attached-deposit", deposit, "sign-as", SIGNER]);

async function rpc() {
  const { rpcClient } = await import("../relayer/near.mjs");
  return rpcClient(process.env.NEAR_RPC || RPC);
}
const txOf = async (hash, sender) => (await (await rpc()).rpc("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" })).result;
const logsOf = (t) => (t ? [t.transaction_outcome, ...t.receipts_outcome].flatMap((o) => o.outcome.logs) : []);
const failOf = (t) => (t ? [t.transaction_outcome, ...t.receipts_outcome].map((o) => o.outcome.status.Failure).find(Boolean) ?? t.status.Failure : "unreadable");
const retOf = (t) => {
  try {
    return JSON.parse(Buffer.from(t?.status?.SuccessValue ?? "", "base64").toString() || "null");
  } catch {
    return null;
  }
};

/** OutLayer's resolve tx for a request id (when the yield callback timed out): by
 *  worker.outlayer.testnet, found through nearblocks, read over RPC. */
async function findResolve(requestId, sinceSec) {
  const client = await rpc();
  const seen = new Set();
  for (let round = 0; round < 24; round++) {
    let cursor = null;
    for (let page = 0; page < 4; page++) {
      const js = await (await fetch(`https://api-testnet.nearblocks.io/v1/account/worker.outlayer.testnet/txns?per_page=100&order=desc${cursor ? `&cursor=${cursor}` : ""}`)).json();
      const txs = js.txns ?? [];
      for (const t of txs) {
        if (!(t.actions?.[0]?.method ?? "").includes("resolve") || seen.has(t.transaction_hash) || Number(String(t.block_timestamp).slice(0, 10)) < sinceSec) continue;
        seen.add(t.transaction_hash);
        const r = await client.rpc("tx", { tx_hash: t.transaction_hash, sender_account_id: "worker.outlayer.testnet", wait_until: "FINAL" });
        for (const a of r.result?.transaction?.actions ?? []) {
          if (!a.FunctionCall) continue;
          const args = JSON.parse(Buffer.from(a.FunctionCall.args, "base64").toString());
          if (args.request_id === requestId) return { tx: t.transaction_hash, args };
        }
      }
      cursor = js.cursor;
      if (!txs.length || !cursor) break;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
    await new Promise((ok) => setTimeout(ok, 15000));
  }
  throw new Error(`no resolve tx for OutLayer request ${requestId}`);
}

const runArgs = (input) => ({ source: { Project: { project_id: PROJECT, version_key: null } }, resource_limits: LIMITS, input_data: JSON.stringify(input), response_format: "Json" });

/** One OutLayer run of the project, sent by bookerbob.testnet (`buyer` null: pubkey) or by the
 *  buyer itself; its output, from the tx's return value or (callback timed out) from OutLayer's
 *  resolve tx for the same request id. */
async function execute(r, key, input, buyer = null) {
  let sender = SIGNER;
  if (buyer) {
    const { send, NEAR } = await import("../relayer/near.mjs");
    const k = await buyerKey(buyer);
    sender = k.pub;
    const res = await send(await rpc(), { signer_id: k.pub, key: k, receiver_id: OUTLAYER, actions: [{ type: "FunctionCall", method_name: "request_execution", args: runArgs(input), gas: BigInt(process.env.RUN_TGAS ?? 150) * 10n ** 12n, deposit: NEAR / 10n }] });
    console.log(`   ${res.ok ? "ok" : "FAILED"} request_execution from buyer ${buyer} ${k.pub.slice(0, 12)}..  ${link(res.hash)}  ${res.ok ? "" : String(JSON.stringify(res.error)).slice(0, 600)}`);
    r.txs[key] = res.hash;
    (r.senders ??= {})[key] = k.pub;
  } else r.txs[key] = call(OUTLAYER, "request_execution", tmp(key, runArgs(input)), "0.1 NEAR");
  save(r);
  const t = await txOf(r.txs[key], sender);
  const ev = logsOf(t).find((l) => l.includes("execution_requested"));
  const rd = ev ? JSON.parse(JSON.parse(ev.slice(11)).data[0].request_data) : null;
  (r.request_ids ??= {})[key] = rd?.request_id ?? null;
  const val = retOf(t);
  if (val) {
    (r.via ??= {})[key] = "callback";
    return val;
  }
  if (!rd) throw new Error(`${key}: no execution_requested event; ${JSON.stringify(failOf(t)).slice(0, 300)}`);
  console.log(`   the callback timed out; reading OutLayer's resolve tx for request ${rd.request_id}`);
  const res = await findResolve(rd.request_id, Math.floor(rd.timestamp / 1e9));
  (r.via ??= {})[key] = "resolve";
  r.txs[`${key}_resolve`] = res.tx;
  // Two shapes of the worker's resolve call: {response: {..}} and the response fields inline.
  const resp = res.args.response ?? res.args;
  if (!resp.success) throw new Error(`${key}: the run failed: ${String(JSON.stringify(resp)).slice(0, 300)}`);
  return resp.output?.Json ?? JSON.parse(resp.output?.Text ?? "null");
}

/** The buyer's sealed input: the presentation and the envelope fields the buyer picks. */
function sealedInput(r, cnf, predicates) {
  const input = {
    context: CONTEXT,
    cnf,
    max_spend: "50000000",
    issued_at_ms: Date.now(),
    ttl_ms: 3_000_000,
    predicates,
    salt: randomBytes(32).toString("hex"),
    presentations: [readFileSync(PRESENTATION).toString("base64")],
  };
  // The plaintext lives in a 0600 file for the length of one CLI call, then is removed.
  const f = tmp(`plain-${randomBytes(4).toString("hex")}`, input);
  try {
    // The CLI prints {"sealed": {..}}; the caller wraps it once.
    return JSON.parse(execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", "seal-input", r.keys.seal_x25519, f], { encoding: "utf8" })).sealed;
  } finally {
    rmSync(f, { force: true });
  }
}

async function buyerKey(name) {
  const { keyFromSeed } = await import("../relayer/near.mjs");
  return keyFromSeed(readFileSync(join(KEYS_DIR, `${name}.seed`), "utf8"));
}
async function buyerCall(r, name, method, args, deposit, expectFail) {
  const { send } = await import("../relayer/near.mjs");
  const key = await buyerKey(name);
  const res = await send(await rpc(), { signer_id: key.pub, key, receiver_id: BAZAAR, actions: [{ type: "FunctionCall", method_name: method, args, gas: 100n * 10n ** 12n, deposit }] });
  const refused = !res.ok && (res.error ?? "").includes(expectFail ?? "\0");
  console.log(`   ${expectFail ? (refused ? "refused as expected" : "UNEXPECTED") : res.ok ? "ok" : "FAILED"} ${method} from ${name} ${key.pub.slice(0, 12)}..  ${link(res.hash)}  ${res.ok ? "" : String(res.error).slice(0, 160)}`);
  if (expectFail ? !refused : !res.ok) throw new Error(`${method}: ${res.ok ? "accepted" : res.error}`);
  return res.hash;
}

const MILLI = 10n ** 21n;
const steps = {
  project: async (r) => {
    if (WASM_SHA === "PENDING") throw new Error("set EVAL_WASM_SHA to the released build's sha256");
    const got = sha(Buffer.from(await (await fetch(URL_)).arrayBuffer()));
    if (got !== WASM_SHA) throw new Error(`${URL_} serves ${got}, expected ${WASM_SHA}`);
    r.txs.create_project = call(OUTLAYER, "create_project", tmp("create", { name: NAME, source: { WasmUrl: { url: URL_, hash: WASM_SHA, build_target: "wasm32-wasip2" } } }), "0.1 NEAR", "100.0 Tgas");
  },
  pubkey: async (r) => {
    const out = await execute(r, "pubkey", { cmd: "pubkey" });
    if (!keysOk(out)) throw new Error(`pubkey statement does not verify: ${JSON.stringify(out).slice(0, 300)}`);
    r.keys = out.keys;
    r.pubkey_out = out;
    console.log(`   evaluator_key ${r.keys.evaluator_key}\n   seal_x25519   ${r.keys.seal_x25519}`);
  },
  register: async (r) => {
    r.txs.register_issuer = call(BAZAAR, "register_issuer", tmp("register", { key_id: `ed25519:${r.keys.evaluator_key}`, label: `OutLayer TEE evaluator ${PROJECT}` }), "0 NEAR", "30.0 Tgas");
    const ev = logsOf(await txOf(r.txs.register_issuer, SIGNER)).find((l) => l.includes("anchor_queued"));
    r.anchor_id = ev ? JSON.parse(ev.slice(11)).data[0].id : null;
    console.log(`   ${r.anchor_id != null ? `queued as anchor ${r.anchor_id}; run 'execute --go' after the delay` : "applied at once (no anchor delay)"}`);
  },
  execute: async (r) => {
    r.txs.execute_anchor = call(BAZAAR, "execute_anchor", tmp("execute", { id: r.anchor_id }), "0 NEAR", "30.0 Tgas");
  },
  buyers: async (r) => {
    mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
    const { keyFromSeed } = await import("../relayer/near.mjs");
    r.buyers = {};
    for (const name of ["a", "b"]) {
      const f = join(KEYS_DIR, `${name}.seed`);
      if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString("hex"), { mode: 0o600 });
      const id = keyFromSeed(readFileSync(f, "utf8")).pub;
      r.buyers[name] = id;
      // A one-time implicit account, created by the demo treasury's transfer (as make demo-tester).
      const { send, NEAR } = await import("../relayer/near.mjs");
      const treasury = keyFromSeed(readFileSync(join(KEYS_DIR, "..", "treasury.seed"), "utf8"));
      const res = await send(await rpc(), { signer_id: TREASURY, key: treasury, receiver_id: id, actions: [{ type: "Transfer", deposit: (3n * NEAR) / 10n }] });
      console.log(`   ${res.ok ? "ok" : "FAILED"} fund buyer ${name} ${id.slice(0, 12)}.. from ${TREASURY}  ${link(res.hash)}`);
      if (!res.ok) throw new Error(`fund ${name}: ${res.error}`);
      r.txs[`fund_${name}`] = res.hash;
    }
  },
  accept: async (r) => {
    r.accept = await execute(r, "accept", { sealed: sealedInput(r, r.buyers.a, []) }, process.env.ACCEPT_FROM_OWNER ? null : "a");
    if (!verdictOk(r.accept)) throw new Error(`not a verdict under the evaluator key: ${JSON.stringify(r.accept).slice(0, 300)}`);
    console.log(`   signed verdict: nullifier ${r.accept.envelope.nullifier.slice(0, 12)}.., predicates [${r.accept.envelope.predicates}], tier ${r.accept.envelope.tier}`);
  },
  submit: async (r) => {
    r.txs.submit = await buyerCall(r, "a", "submit_verdict", { verdict: r.accept }, 50n * MILLI);
  },
  sybil: async (r) => {
    r.sybil = await execute(r, "sybil", { sealed: sealedInput(r, r.buyers.b, []) }, "b");
    if (!verdictOk(r.sybil)) throw new Error("sybil run did not return a verdict");
    if (r.sybil.envelope.nullifier !== r.accept.envelope.nullifier) throw new Error("the TEE gave buyer B another nullifier");
    console.log(`   the TEE gives buyer B the same nullifier ${r.sybil.envelope.nullifier.slice(0, 12)}..`);
    r.txs.sybil_submit = await buyerCall(r, "b", "submit_verdict", { verdict: r.sybil }, 50n * MILLI, "nullifier");
  },
  refuse: async (r) => {
    r.refuse = await execute(r, "refuse", { sealed: sealedInput(r, r.buyers.a, ["github_builder"]) }, "a");
    if (!r.refuse.refusal || !refusalOk(r.refuse)) throw new Error(`not a signed refusal: ${JSON.stringify(r.refuse).slice(0, 300)}`);
    console.log(`   signed refusal: ${r.refuse.refusal.reason}`);
  },
};

/** Keyless: [ok, text] lines over public RPC (`view(account, method, args)`, `raw(hash, sender)`). */
export async function verifyRun(view, raw, rec = JSON.parse(readFileSync(OUT, "utf8"))) {
  const lines = [];
  const tx = async (h, s) => {
    try {
      return h ? await raw(h, s) : null;
    } catch {
      return null;
    }
  };
  const fcOf = (t) => {
    const a = t?.transaction?.actions?.find((x) => x.FunctionCall)?.FunctionCall;
    return a ? { method: a.method_name, args: JSON.parse(Buffer.from(a.args, "base64").toString()), deposit: a.deposit } : null;
  };
  const by = (t, signer, receiver) => t?.transaction?.signer_id === signer && t?.transaction?.receiver_id === receiver;
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const evKey = `ed25519:${rec.keys?.evaluator_key}`;
  const A = rec.buyers?.a;
  const B = rec.buyers?.b;

  // The project: created by bookerbob.testnet from this URL and hash; the chain holds that build.
  const cp = await tx(rec.txs.create_project, SIGNER);
  const cpa = fcOf(cp)?.args;
  const p = await view(OUTLAYER, "get_project", { project_id: PROJECT }).catch(() => null);
  lines.push([by(cp, SIGNER, OUTLAYER) && fcOf(cp)?.method === "create_project" && cpa?.name === NAME && cpa?.source?.WasmUrl?.hash === rec.wasm_sha256 && cpa?.source?.WasmUrl?.url === rec.wasm_url && !!p && JSON.stringify(p).includes(rec.wasm_sha256), `create_project ${rec.txs.create_project?.slice(0, 8)}.. by ${SIGNER}: ${PROJECT} from ${rec.wasm_url.split("/").pop()} (${rec.wasm_sha256.slice(0, 12)}..), and the chain holds it`]);

  // Every run: who sent it, to which project, with which input, and the output OutLayer's worker
  // posted for that request id.
  const runs = { pubkey: SIGNER, accept: SIGNER, sybil: B, refuse: A };
  for (const [k, sender] of Object.entries(runs)) {
    const t = await tx(rec.txs[k], sender);
    const f = fcOf(t);
    const input = (() => {
      try {
        return JSON.parse(f?.args?.input_data);
      } catch {
        return null;
      }
    })();
    const shape = k === "pubkey" ? same(input, { cmd: "pubkey" }) : !!input?.sealed && Object.keys(input).length === 1 && Object.keys(input.sealed).sort().join() === "commitment,ct,epk,nonce,v";
    lines.push([by(t, sender, OUTLAYER) && f?.method === "request_execution" && f.args?.source?.Project?.project_id === PROJECT && shape, `${k}: request_execution by ${sender === SIGNER ? SIGNER : `buyer ${sender.slice(0, 8)}..`} of ${PROJECT}, input ${k === "pubkey" ? '{"cmd":"pubkey"}' : "sealed (ciphertext only)"}`]);
    const ev = logsOf(t).find((l) => l.includes("execution_requested"));
    const rid = ev ? JSON.parse(JSON.parse(ev.slice(11)).data[0].request_data).request_id : null;
    const res = await tx(rec.txs[`${k}_resolve`], "worker.outlayer.testnet");
    const ra = fcOf(res)?.args;
    const resp = ra?.response ?? ra;
    const recorded = k === "pubkey" ? rec.pubkey_out : rec[k];
    lines.push([by(res, "worker.outlayer.testnet", OUTLAYER) && rid != null && ra?.request_id === rid && rid === rec.request_ids?.[k] && !!resp?.success && same(resp.output?.Json, recorded), `${k}: the recorded output is what worker.outlayer.testnet posted for request ${rid}`]);
  }
  lines.push([!!rec.pubkey_out && keysOk(rec.pubkey_out) && same(rec.pubkey_out.keys, rec.keys), `the pubkey statement verifies under evaluator_key ${rec.keys?.evaluator_key?.slice(0, 12)}..; seal_x25519 ${rec.keys?.seal_x25519?.slice(0, 12)}..; pinned notaries ${rec.keys?.notary_keys?.map((k) => k.slice(0, 8)).join(", ")}`]);

  // The issuer registration: queued by the owner for exactly this key, applied by execute_anchor.
  const rg = await tx(rec.txs.register_issuer, SIGNER);
  const q = logsOf(rg).map((l) => (l.startsWith("EVENT_JSON:") ? JSON.parse(l.slice(11)) : null)).find((e) => e?.event === "anchor_queued");
  lines.push([by(rg, SIGNER, BAZAAR) && fcOf(rg)?.method === "register_issuer" && fcOf(rg)?.args?.key_id === evKey && q?.data?.[0]?.id === rec.anchor_id, `register_issuer ${rec.txs.register_issuer?.slice(0, 8)}.. by the owner for ${evKey.slice(0, 20)}.., queued as anchor ${rec.anchor_id}`]);
  const ex = await tx(rec.txs.execute_anchor, SIGNER);
  const reg = logsOf(ex).map((l) => (l.startsWith("EVENT_JSON:") ? JSON.parse(l.slice(11)) : null)).find((e) => e?.event === "issuer_registered");
  lines.push([by(ex, SIGNER, BAZAAR) && fcOf(ex)?.method === "execute_anchor" && fcOf(ex)?.args?.id === rec.anchor_id && reg?.data?.[0]?.key_id === evKey && !failOf(ex), `execute_anchor ${rec.txs.execute_anchor?.slice(0, 8)}..: anchor ${rec.anchor_id} applied, issuer_registered for that key`]);
  const issuers = await view(BAZAAR, "issuers", {}).catch(() => []);
  lines.push([issuers.some(([k]) => k === evKey), `${BAZAAR} lists the TEE evaluator key as an issuer now`]);

  // The buyers: funded by the demo treasury, and the ones that act.
  for (const [n, id] of [["a", A], ["b", B]]) {
    const t = await tx(rec.txs[`fund_${n}`], TREASURY);
    const tr = t?.transaction?.actions?.find((x) => x.Transfer);
    lines.push([by(t, TREASURY, id) && !!tr && !failOf(t), `buyer ${n} ${id?.slice(0, 8)}..: a one-time implicit account funded by ${TREASURY}`]);
  }

  // The verdict: signed by the registered key, for buyer A, in the recorded context; submitted by
  // buyer A with exactly these bytes; recorded under that key.
  const e = rec.accept?.envelope;
  lines.push([!!rec.accept && verdictOk(rec.accept) && rec.accept.issuer_key === rec.keys?.evaluator_key && e?.cnf === A && e?.context === rec.context && e?.predicates?.length === 0 && e?.attestation?.model === "outlayer:bookerbob-evaluator/v0", `accept: a verdict signed by the TEE key, cnf buyer A, context ${rec.context}, no predicate revealed`]);
  const sb = await tx(rec.txs.submit, A);
  lines.push([by(sb, A, BAZAAR) && fcOf(sb)?.method === "submit_verdict" && same(fcOf(sb)?.args?.verdict, rec.accept) && !failOf(sb), `submit_verdict ${rec.txs.submit?.slice(0, 8)}.. by buyer A with exactly the TEE's output`]);
  const v = await view(BAZAAR, "verdict", { nullifier: e?.nullifier }).catch(() => null);
  lines.push([v?.issuer === evKey && v?.agent === A && v?.context === rec.context, `${BAZAAR} records nullifier ${e?.nullifier?.slice(0, 12)}.. for buyer A under the TEE evaluator key`]);

  // The sybil: buyer B, same presentation, same nullifier, the TEE's exact output refused.
  const se = rec.sybil?.envelope;
  const sy = await tx(rec.txs.sybil_submit, B);
  lines.push([!!rec.sybil && verdictOk(rec.sybil) && se?.cnf === B && se?.context === rec.context && se?.nullifier === e?.nullifier && by(sy, B, BAZAAR) && fcOf(sy)?.method === "submit_verdict" && same(fcOf(sy)?.args?.verdict, rec.sybil) && /nullifier (pending|spent)/.test(JSON.stringify(failOf(sy))), `sybil: buyer B with the same GitHub account gets the same nullifier from the TEE; its submit_verdict is refused (nullifier pending)`]);

  // The refusal: signed by the registered key, for buyer A, in the recorded context.
  const rf = rec.refuse?.refusal;
  lines.push([!!rf && refusalOk(rec.refuse) && rec.refuse.key === rec.keys?.evaluator_key && rf.cnf === A && rf.context === rec.context && rf.reason === "github_builder is not proven by the presentation", `refuse: github_builder (3 years or more) refused for buyer A, signed by the TEE key; the account is 2 years old`]);
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [step, go] = process.argv.slice(2);
  if (step === "verify") {
    const client = await rpc();
    const lines = await verifyRun((a, m, args) => client.view(a, m, args), async (h, s) => (await client.rpc("tx", { tx_hash: h, sender_account_id: s, wait_until: "FINAL" })).result);
    for (const [ok, t] of lines) console.log(`${ok ? "PASS" : "FAIL"}  ${t}`);
    const bad = lines.filter(([ok]) => !ok).length;
    console.log(bad ? `FAIL  outlayer-eval: ${bad} of ${lines.length}` : `PASS  outlayer-eval: ${lines.length} checks`);
    process.exit(bad ? 1 : 0);
  }
  if (step === "snapshot") {
    // Every RPC answer `verify` reads, for the offline test (scripts/outlayer-eval.test.mjs).
    const client = await rpc();
    const snap = { note: "public RPC answers read by verifyRun, testnet, for the offline test", views: {}, txs: {} };
    await verifyRun(
      async (a, m, args) => (snap.views[`${a} ${m} ${JSON.stringify(args)}`] = await client.view(a, m, args)),
      async (h, s) => (snap.txs[h] = (await client.rpc("tx", { tx_hash: h, sender_account_id: s, wait_until: "FINAL" })).result),
    );
    writeFileSync("fixtures/live/outlayer/eval-rpc.json", JSON.stringify(snap) + "\n");
    console.log(`snapshot: ${Object.keys(snap.views).length} views, ${Object.keys(snap.txs).length} txs`);
    process.exit(0);
  }
  if (!steps[step] || go !== "--go") {
    console.log(`plan (testnet, sends nothing without --go): ${Object.keys(steps).join(" -> ")}\n  project ${PROJECT}, wasm ${URL_} (${WASM_SHA}), bazaar ${BAZAAR}, context ${CONTEXT}`);
    process.exit(step ? 2 : 0);
  }
  const r = record();
  console.log(`${step}:`);
  await steps[step](r);
  save(r);
}
