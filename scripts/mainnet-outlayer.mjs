#!/usr/bin/env node
// The OutLayer referee on the mainnet bazaar (docs/keyless.md, "Mainnet"). Real money, small.
//
//   node scripts/mainnet-outlayer.mjs plan                     every tx and its cost; sends nothing
//   node scripts/mainnet-outlayer.mjs run --mainnet            BOOKERBOB_MAINNET_GO=<today>, founder's word
//   node scripts/mainnet-outlayer.mjs check                    keyless recheck of fixtures/mainnet/outlayer.json
//
// 1. the bazaar account creates the project bookerbob-referee on outlayer.near from the same public
//    release wasm as testnet v1 (its hash pinned in create_project)
// 2. the bazaar asks it {"cmd":"pubkey"}: the project's referee key and the X25519 seal key it
//    derives for the bazaar, signed by the referee key
// 3. set_outlayer(outlayer.near), register_referee(that key) (the mainnet anchor delay is 0)
// 4. one honest purchase: a NEAR AI verdict (as make mainnet-buy), the worker input sealed to the
//    project's key, request_referee, the receipt signed in the TEE, escrow and settle in USDC
// A spend guard stops the run if the bazaar and buyer together lose more than CAP_NEAR.
// The model whose key the mainnet bazaar registered (as scripts/mainnet-buy.mjs).
process.env.MODEL_BUY_MODEL ??= "deepseek-ai/DeepSeek-V4.1-Flash-1017";
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, randomBytes, verify as edVerify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keyFromSeed, rpcClient, send } from "../relayer/near.mjs";
import { OUTLAYER, statementOk } from "./outlayer-buy.mjs";

const RPC = process.env.NEAR_MAINNET_RPC ?? "https://rpc.mainnet.fastnear.com";
const ARCHIVE = process.env.NEAR_MAINNET_ARCHIVE ?? "https://archival-rpc.mainnet.fastnear.com";
const DIR = join(homedir(), ".rep-secrets", "bookerbob-mainnet");
const KEYS = join(DIR, "keys");
const BZ = JSON.parse(readFileSync("fixtures/mainnet/bazaar.json", "utf8"));
const USDC = BZ.usdc, REF = "v2.ref-finance.near", POOL = 4512;
const OL = "outlayer.near", WORKER = "worker.outlayer.near", NAME = "bookerbob-referee";
const PROJECT = `${BZ.bazaar}/${NAME}`;
const OUT = "fixtures/mainnet/outlayer.json";
const TGAS = 10n ** 12n, MILLI = 10n ** 21n, YOCTO = 10n ** 24n;
const CAP = BigInt(Math.round(Number(process.env.CAP_NEAR ?? "1") * 1000)) * MILLI;
const LIMITS = { max_instructions: 1_000_000_000, max_memory_mb: 128, max_execution_seconds: 60 };
const link = (h) => `https://nearblocks.io/txns/${h}`;
const fc = (method_name, args, deposit = 0n, gas = 50n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const cli = (args, opts = {}) => execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", ...args], { encoding: "utf8", ...opts }).trim();
const key = (n) => keyFromSeed(readFileSync(join(DIR, `${n}.seed`), "utf8"));
const events = (logs) => logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)));
const ev = (logs, name) => events(logs).find((e) => e.event === name)?.data?.[0];
const near = (y) => (Number(y / MILLI) / 1000).toFixed(3);

const STEPS = [
  ["create_project", `bazaar -> ${OL} create_project ${NAME}, wasm ${OUTLAYER.wasm_sha256.slice(0, 12)}.. (testnet v1 release URL)`, "0.1 NEAR attached, about 0.01 net"],
  ["pubkey", `bazaar -> ${OL} request_execution {"cmd":"pubkey"}`, "0.05 NEAR attached, about 0.007 net"],
  ["set_outlayer", `bazaar set_outlayer(${OL})`, "gas"],
  ["register_referee", "bazaar register_referee(the project's referee key) (anchor delay 0)", "gas"],
  ["usdc", "buyer: wrap and swap 0.30 NEAR to USDC on Ref pool 4512 if under the price", "0.30 NEAR"],
  ["verdict", "buyer: NEAR AI verdict (E2EE, TEE-signed), submit_near_ai_verdict", "0.05 NEAR storage, about $0.001 NEAR AI credit"],
  ["request_referee", "buyer -> bazaar request_referee, the input sealed to the project's seal key", "0.05 NEAR attached, about 0.007 net"],
  ["escrow+settle", "buyer: escrow the receipt price in USDC, settle to the round's lowest bidder", "about 0.95 USDC"],
];

async function balances(c, B, A) {
  const [b, a] = await Promise.all([c.account(B), c.account(A)]);
  return BigInt(b.amount) + BigInt(a.amount);
}

/** The worker's resolve tx for a request (mainnet nearblocks index), when a callback times out. */
async function findResolve(c, requestId, sinceSec) {
  const seen = new Set();
  for (let round = 0; round < 40; round++) {
    const js = await (await fetch(`https://api.nearblocks.io/v1/account/${WORKER}/txns?per_page=50&order=desc`)).json().catch(() => ({}));
    for (const t of js.txns ?? []) {
      const m = t.actions?.[0]?.method ?? "";
      if (!m.includes("resolve") || seen.has(t.transaction_hash) || Number(String(t.block_timestamp).slice(0, 10)) < sinceSec) continue;
      seen.add(t.transaction_hash);
      const r = await c.rpc("tx", { tx_hash: t.transaction_hash, sender_account_id: WORKER, wait_until: "FINAL" });
      for (const a of r.result?.transaction?.actions ?? []) {
        if (!a.FunctionCall) continue;
        const args = JSON.parse(Buffer.from(a.FunctionCall.args, "base64").toString());
        if (args.request_id === requestId) return { tx: t.transaction_hash, args };
      }
    }
    await new Promise((ok) => setTimeout(ok, 15000));
  }
  throw new Error(`no resolve tx for OutLayer request ${requestId}`);
}

async function run(c) {
  const today = new Date().toISOString().slice(0, 10);
  if (!process.argv.includes("--mainnet") || process.env.BOOKERBOB_MAINNET_GO !== today) throw new Error(`real money: --mainnet and BOOKERBOB_MAINNET_GO=${today}`);
  const B = BZ.bazaar, bz = key("bazaar"), buyer = key("buyer"), A = buyer.pub;
  const rec = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { note: "The OutLayer referee on the mainnet bazaar: a project on outlayer.near from the same public wasm as testnet v1, its TEE-derived referee key registered on the bazaar, and one purchase whose receipt that key signed. Check: node scripts/mainnet-outlayer.mjs check", network: "mainnet", bazaar: B, buyer: A, contract: OL, project_id: PROJECT, wasm_url: OUTLAYER.wasm_url, wasm_sha256: OUTLAYER.wasm_sha256, txs: {} };
  const save = () => writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
  rec.start_balance ??= String(await balances(c, B, A));
  save();
  const guard = async () => {
    const spent = BigInt(rec.start_balance) - (await balances(c, B, A));
    if (spent > CAP) throw new Error(`spend guard: ${near(spent)} NEAR spent, over the ${near(CAP)} cap`);
    return spent;
  };
  const tx = async (name, signer, k, receiver, actions) => {
    if (rec.txs[name]) {
      console.log(`skip ${name} (done)`);
      return null;
    }
    await guard();
    let r = await send(c, { signer_id: signer, key: k, receiver_id: receiver, actions });
    for (let i = 0; i < 40 && !r.ok && /timeout/i.test(String(r.error)) && r.hash; i++) {
      await new Promise((ok) => setTimeout(ok, 6000));
      const t = await c.rpc("tx", { tx_hash: r.hash, sender_account_id: signer, wait_until: "FINAL" });
      if (!t.error) {
        const { outcome } = await import("../relayer/near.mjs");
        r = { ...outcome(t), hash: r.hash };
      }
    }
    console.log(`${r.ok ? "ok  " : "FAIL"} ${name}  ${link(r.hash)}${r.ok ? "" : `  ${String(r.error).slice(0, 300)}`}`);
    if (!r.ok) throw new Error(`${name} failed`);
    rec.txs[name] = r.hash;
    save();
    return r;
  };
  // 1. the project
  if (!(await c.view(OL, "get_project", { project_id: PROJECT }).catch(() => null))) {
    await tx("create_project", B, bz, OL, [fc("create_project", { name: NAME, source: { WasmUrl: { url: OUTLAYER.wasm_url, hash: OUTLAYER.wasm_sha256, build_target: "wasm32-wasip2" } } }, 100n * MILLI, 100n * TGAS)]);
  }
  const project = await c.view(OL, "get_project", { project_id: PROJECT });
  rec.project_uuid = project?.uuid ?? project?.project_uuid ?? null;
  save();
  // 2. the keys
  if (!rec.keys) {
    const r = await tx("pubkey", B, bz, OL, [fc("request_execution", { source: { Project: { project_id: PROJECT, version_key: null } }, resource_limits: LIMITS, input_data: JSON.stringify({ cmd: "pubkey" }), response_format: "Json" }, 50n * MILLI, 300n * TGAS)]);
    let out = r?.value && typeof r.value === "object" ? r.value : null;
    if (!out) {
      const asked = ev(r.logs, "execution_requested");
      const rd = JSON.parse(asked.request_data);
      const res = await findResolve(c, rd.request_id, Math.floor(rd.timestamp / 1e9) - 5);
      rec.txs.pubkey_resolve = res.tx;
      out = res.args.response?.output?.Json ?? JSON.parse(res.args.response?.output?.Text ?? "null");
    }
    if (!out?.keys || !statementOk(out.keys, out.signature) || out.keys.seal_for !== B) throw new Error(`pubkey output not a statement for ${B}: ${JSON.stringify(out).slice(0, 300)}`);
    rec.keys = out.keys;
    rec.keys_signature = out.signature;
    save();
    console.log(`   referee_key ${out.keys.referee_key.slice(0, 12)}.., seal_x25519 ${out.keys.seal_x25519.slice(0, 12)}.. for ${B.slice(0, 12)}..`);
  }
  // 3. the bazaar
  // The bazaar has no view of its OutLayer account: tx() skips a step that is recorded as done.
  await tx("set_outlayer", B, bz, B, [fc("set_outlayer", { outlayer: OL })]);
  const refs = await c.view(B, "referees", {});
  if (!refs.some(([k]) => k === rec.keys.referee_key)) await tx("register_referee", B, bz, B, [fc("register_referee", { key_hex: rec.keys.referee_key, label: `OutLayer referee ${PROJECT} (host key, caller none)` })]);
  // 4. the purchase
  const winner = Object.entries(BZ.merchants).map(([n, m]) => ({ n, ...m }));
  const bids = await Promise.all(winner.map((m) => c.view(B, "round_bid", { round_id: BZ.round.id, merchant: m.account })));
  const low = winner.map((m, i) => ({ ...m, schedule: bids[i] })).sort((x, y) => Number(BigInt(x.schedule.base_price) - BigInt(y.schedule.base_price)))[0];
  rec.merchant = low.account;
  const live = join(DIR, "live-outlayer");
  mkdirSync(live, { recursive: true, mode: 0o700 });
  if (!rec.nullifier) {
    // A fresh, labelled synthetic nullifier: the buyer's earlier mainnet purchases spent theirs.
    rec.nullifier = cli(["sign-tester", KEYS, A, low.account, "bookerbob-mainnet", live], { env: { ...process.env, BOOKERBOB_NULLIFIER: randomBytes(32).toString("hex") } });
    save();
  }
  if (!rec.txs.verdict) {
    const { issue } = await import("./model-buy.mjs");
    const base = JSON.parse(readFileSync(join(live, "verdict.json"), "utf8")).envelope;
    base.predicates = base.predicates.filter((p) => p !== "world_id_human");
    const { envelope, proof, record } = await issue(c, B, base, "fixtures/proofs.json", KEYS);
    writeFileSync(join(live, "near-ai-verdict.json"), JSON.stringify({ envelope, proof }), { mode: 0o600 });
    rec.near_ai = record;
    save();
    await tx("verdict", A, buyer, B, [fc("submit_near_ai_verdict", { envelope, proof }, 50n * MILLI, 150n * TGAS)]);
  }
  const v = JSON.parse(readFileSync(join(live, "near-ai-verdict.json"), "utf8"));
  const q = await c.view(B, "quote", { merchant: low.account, nullifier: rec.nullifier });
  // USDC for the price
  const need = BigInt(q.price);
  if (BigInt(await c.view(USDC, "ft_balance_of", { account_id: A })) < need) {
    const amountIn = 300n * MILLI;
    const wbal = BigInt(await c.view("wrap.near", "ft_balance_of", { account_id: A }));
    if (wbal < amountIn) await tx("near_deposit", A, buyer, "wrap.near", [fc("near_deposit", {}, amountIn - wbal)]);
    const out = BigInt(await c.view(REF, "get_return", { pool_id: POOL, token_in: "wrap.near", amount_in: amountIn.toString(), token_out: USDC }));
    const min = (out * 97n) / 100n;
    console.log(`   swap 0.30 wNEAR for about ${Number(out) / 1e6} USDC (min ${Number(min) / 1e6})`);
    await tx("swap to USDC", A, buyer, "wrap.near", [fc("ft_transfer_call", { receiver_id: REF, amount: amountIn.toString(), msg: JSON.stringify({ force: 0, actions: [{ pool_id: POOL, token_in: "wrap.near", token_out: USDC, amount_in: amountIn.toString(), min_amount_out: min.toString() }] }) }, 1n, 180n * TGAS)]);
  }
  // the referee on OutLayer
  if (!rec.price) {
    const fx = join(live, "fixtures");
    mkdirSync(fx, { recursive: true });
    writeFileSync(join(fx, "merchants.json"), JSON.stringify([{ account: low.account, label: low.n, category: BZ.category, schedule: low.schedule }]));
    writeFileSync(join(fx, "proofs.json"), readFileSync("fixtures/proofs.json"));
    writeFileSync(join(fx, "claims-honest.json"), JSON.stringify(JSON.parse(readFileSync("fixtures/claims-honest.json", "utf8")).filter((x) => v.envelope.predicates.includes(x.line))));
    writeFileSync(join(live, "verdict-mainnet.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(live, "verdict.json"), "utf8")), envelope: v.envelope }));
    const input = cli(["worker-input", fx, join(live, "verdict-mainnet.json"), String(q?.cohort?.k ?? 0)]);
    const plain = join(live, "outlayer-input.json");
    writeFileSync(plain, input, { mode: 0o600 });
    const sealed = cli(["seal-input", rec.keys.seal_x25519, plain]);
    rec.sealed_input_sha256 = createHash("sha256").update(sealed).digest("hex");
    const r = await tx("request_referee", A, buyer, B, [fc("request_referee", { project_id: PROJECT, input_data: sealed }, 50n * MILLI, 300n * TGAS)]);
    let logs = r?.logs ?? [];
    rec.via = "callback";
    if (!ev(logs, "referee_receipt")) {
      const asked = ev(logs, "execution_requested");
      if (!asked) throw new Error(`request_referee did not reach OutLayer: ${JSON.stringify(events(logs))}`);
      const rd = JSON.parse(asked.request_data);
      rec.request_id = rd.request_id;
      const res = await findResolve(c, rd.request_id, Math.floor(rd.timestamp / 1e9) - 5);
      const result = JSON.parse(res.args.response?.output?.Text ?? "null");
      if (result?.worker_key !== rec.keys.referee_key) throw new Error(`the result is not signed by the project's key: ${JSON.stringify(result).slice(0, 200)}`);
      rec.txs.outlayer_resolve = res.tx;
      rec.via = "relay";
      const s = await tx("submit_referee_result", A, buyer, B, [fc("submit_referee_result", { result }, 0n, 100n * TGAS)]);
      logs = s.logs;
    }
    const stored = await c.view(B, "verdict", { nullifier: rec.nullifier });
    if (stored?.receipt?.referee !== rec.keys.referee_key) throw new Error(`no receipt from the OutLayer key: ${JSON.stringify(events(logs)).slice(0, 300)}`);
    if (String(stored.receipt.price) !== String(q.price)) throw new Error(`receipt price ${stored.receipt.price} differs from the quote ${q.price}`);
    rec.price = String(stored.receipt.price);
    rec.result_sha256 = stored.receipt.result_sha256;
    save();
    console.log(`   receipt from the OutLayer key: ${low.n} at ${Number(rec.price) / 1e6} USDC`);
  }
  await tx("escrow", A, buyer, USDC, [fc("ft_transfer_call", { receiver_id: B, amount: rec.price, msg: "" }, 1n, 100n * TGAS)]);
  rec.checkout_ref = rec.checkout_ref ?? `mainnet-outlayer-${Date.now()}`;
  save();
  await tx("settle", A, buyer, B, [fc("settle", { nullifier: rec.nullifier, merchant: low.account, checkout_ref: rec.checkout_ref, amount: rec.price }, 0n, 150n * TGAS)]);
  const spent = await guard();
  rec.spent_yocto = String(spent);
  rec.spent_near = (Number(spent / 10n ** 18n) / 1e6).toFixed(6);
  save();
  console.log(`   spent ${rec.spent_near} NEAR in all (bazaar + buyer, the swap included)`);
  await check(c);
}

const RESULT_TAG = Buffer.from("bookerbob/referee/v0\0");
const sha = (b) => createHash("sha256").update(b).digest("hex");
function edOk(keyHex, msg, sigHex) {
  try {
    const pk = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(keyHex, "hex")]), format: "der", type: "spki" });
    return edVerify(null, msg, pk, Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}

/** Keyless: every claim re-read from public mainnet RPC, the txs included. */
export async function checkLines(c, rec) {
  const lines = [];
  const txOf = async (h, s) => {
    try {
      const r = await c.rpc("EXPERIMENTAL_tx_status", { tx_hash: h, sender_account_id: s, wait_until: "FINAL" });
      if (r.error) console.error(`   rpc: ${h}: ${JSON.stringify(r.error).slice(0, 160)}`);
      return r.result?.transaction ? r.result : null;
    } catch (err) {
      console.error(`   rpc: ${h}: ${err.message.slice(0, 160)}`);
      return null;
    }
  };
  const outs = (t) => (t ? [t.transaction_outcome, ...t.receipts_outcome] : []);
  const failed = (t) => !t || outs(t).some((o) => o.outcome.status.Failure) || !("SuccessValue" in t.status);
  const evs = (t) => events(outs(t).flatMap((o) => o.outcome.logs));
  const argsOf = (t, method) => {
    const a = t?.transaction.actions.find((x) => x.FunctionCall?.method_name === method);
    return a ? JSON.parse(Buffer.from(a.FunctionCall.args, "base64").toString()) : null;
  };
  const value = (t) => {
    try {
      return JSON.parse(Buffer.from(t.status.SuccessValue, "base64").toString());
    } catch {
      return null;
    }
  };
  const [cp, pk, rr, vt, se] = await Promise.all([txOf(rec.txs.create_project, rec.bazaar), txOf(rec.txs.pubkey, rec.bazaar), txOf(rec.txs.request_referee, rec.buyer), txOf(rec.txs.verdict, rec.buyer), txOf(rec.txs.settle, rec.buyer)]);
  // The project: created from this URL and hash, one version, active.
  const project = await c.view(rec.contract, "get_project", { project_id: rec.project_id }).catch(() => null);
  const versions = (await c.view(rec.contract, "list_versions", { project_id: rec.project_id }).catch(() => null)) ?? [];
  const cpa = argsOf(cp, "create_project");
  const cpOk = !failed(cp) && cp.transaction.signer_id === rec.bazaar && cp.transaction.receiver_id === rec.contract && cpa?.source?.WasmUrl?.url === rec.wasm_url && cpa.source.WasmUrl.hash === rec.wasm_sha256;
  lines.push([cpOk && project?.uuid === rec.project_uuid && project.owner === rec.bazaar && versions.length === 1 && versions[0].wasm_hash === rec.wasm_sha256 && versions[0].is_active === true, `project ${rec.project_id.slice(0, 12)}../${rec.project_id.split("/")[1]} (${rec.project_uuid}) on ${rec.contract}, created by the bazaar from ${rec.wasm_url.split("/").slice(-2).join("/")} with hash ${rec.wasm_sha256.slice(0, 12)}..; one version, active`]);
  // The keys: the pubkey run's own return value is the recorded statement, signed by the referee key.
  const pv = value(pk);
  const pkDone = evs(pk).find((x) => x.event === "execution_completed")?.data?.[0];
  lines.push([!failed(pk) && JSON.stringify(pv) === JSON.stringify({ keys: rec.keys, signature: rec.keys_signature }) && statementOk(rec.keys, rec.keys_signature) && rec.keys.seal_for === rec.bazaar && JSON.stringify(pkDone?.code_source ?? {}).includes(rec.wasm_sha256), `pubkey run (wasm ${rec.wasm_sha256.slice(0, 12)}..) returned the recorded statement: referee_key ${rec.keys.referee_key.slice(0, 12)}.., seal key for the bazaar, signed by the referee key`]);
  const refs = await c.view(rec.bazaar, "referees", {});
  lines.push([refs.some(([k]) => k === rec.keys.referee_key), `the mainnet bazaar lists the OutLayer key among its referees (${refs.length} in all; the operator's f6fea996.. is the other)`]);
  // The verdict: a NEAR AI model verdict; the recorded request, response and attested predicates are the submitted ones.
  const nv = evs(vt).find((x) => x.event === "near_ai_verdict")?.data?.[0];
  const va = argsOf(vt, "submit_near_ai_verdict");
  const na = rec.near_ai ?? {};
  const respModel = (() => {
    try {
      return JSON.parse(va?.proof?.response ?? "").model ?? null;
    } catch {
      return null;
    }
  })();
  const naOk = respModel === na.model && va?.proof?.request_sha256 === na.request_sha256 && sha(va?.proof?.response ?? "") === na.response_sha256 && va.proof.chat_id === na.chat_id && va.proof.signing_key === na.signing_key
    && JSON.stringify([...(va.envelope?.predicates ?? [])].sort()) === JSON.stringify([...(na.attested ?? [])].sort()) && va.envelope.nullifier === rec.nullifier;
  lines.push([!failed(vt) && naOk && nv?.nullifier === rec.nullifier && nv.chat_id === na.chat_id && nv.signing_key === na.signing_key, `verdict: issued by ${respModel ?? "?"} under the NEAR AI model key ${String(nv?.signing_key).slice(0, 12)}.. (chat ${String(nv?.chat_id).slice(0, 18)}..), predicates [${(na.attested ?? []).join(", ")}] as submitted, request and response hashes as recorded`]);
  // The referee step: the sealed input ran this wasm on OutLayer; its output, signed by the project key,
  // came back through the bazaar's own callback and was stored as the receipt.
  const req = evs(rr).find((x) => x.event === "execution_requested")?.data?.[0];
  const rd = req ? JSON.parse(req.request_data) : {};
  const done = evs(rr).find((x) => x.event === "execution_completed")?.data?.[0];
  const cb = rr?.receipts?.find((x) => x.receipt.Action?.actions?.some((a) => a.FunctionCall?.method_name === "on_referee_result"));
  const cbOut = cb ? rr.receipts_outcome.find((o) => o.id === cb.receipt_id) : null;
  const cbTrue = cbOut && Buffer.from(cbOut.outcome.status.SuccessValue ?? "", "base64").toString() === "true" && cb.predecessor_id === rec.bazaar && cb.receiver_id === rec.bazaar;
  const olOut = rr?.receipts_outcome.map((o) => o.outcome.status.SuccessValue).filter(Boolean).map((v) => Buffer.from(v, "base64").toString()).map((x) => {
    try {
      const y = JSON.parse(x);
      return typeof y === "string" ? JSON.parse(y) : y;
    } catch {
      return null;
    }
  }).find((y) => y?.body && y.worker_key) ?? null;
  const msg = olOut ? Buffer.concat([RESULT_TAG, Buffer.from(JSON.stringify(olOut.body))]) : Buffer.alloc(0);
  const rcpt = evs(rr).find((x) => x.event === "referee_receipt")?.data?.[0];
  const refOk = !failed(rr) && cbTrue && rd.project_id === rec.project_id && rd.predecessor_id === rec.bazaar && sha(rd.input_data ?? "") === rec.sealed_input_sha256 && /^\{"sealed"/.test(rd.input_data ?? "")
    && JSON.stringify(done?.code_source ?? {}).includes(rec.wasm_sha256) && olOut?.worker_key === rec.keys.referee_key && edOk(rec.keys.referee_key, msg, olOut.signature)
    && sha(msg) === rec.result_sha256 && String(olOut.body.price) === rec.price && olOut.body.outcome === "receipt" && rcpt?.nullifier === rec.nullifier && rcpt.merchant === rec.merchant;
  lines.push([refOk, `request_referee: the sealed input ran wasm ${rec.wasm_sha256.slice(0, 12)}.. on OutLayer; the output, signed by the project key, came back through on_referee_result (true) as the receipt at ${Number(rec.price) / 1e6} USDC`]);
  // The purchase: the stored receipt, the settle event, the nullifier spent.
  const [v, st] = await Promise.all([c.view(rec.bazaar, "verdict", { nullifier: rec.nullifier }), c.view(rec.bazaar, "nullifier_status", { nullifier: rec.nullifier })]);
  const sd = evs(se).find((x) => x.event === "settled")?.data?.[0];
  const sa = argsOf(se, "settle");
  const setOk = !failed(se) && sd?.nullifier === rec.nullifier && sd.merchant === rec.merchant && String(sd.amount) === rec.price && sa?.checkout_ref === rec.checkout_ref && sa.nullifier === rec.nullifier
    && evs(se).some((x) => x.event === "ft_transfer" && x.data?.[0]?.old_owner_id === rec.bazaar && x.data[0].new_owner_id === rec.merchant && String(x.data[0].amount) === rec.price);
  lines.push([Boolean(setOk && v && String(v.issuer).startsWith("near-ai:") && v.receipt?.referee === rec.keys.referee_key && v.receipt.merchant === rec.merchant && v.receipt.result_sha256 === rec.result_sha256 && String(v.receipt.price) === rec.price && JSON.stringify(st).includes("Spent")), `settle: ${Number(rec.price) / 1e6} USDC to the round's lowest bidder under the OutLayer receipt, nullifier spent`]);
  // Every recorded tx: succeeded, from the right signer to the right receiver, the right method and args.
  const USDC_ = rec.usdc ?? USDC;
  const want = {
    create_project: [rec.bazaar, rec.contract, "create_project", (a) => a.name === rec.project_id.split("/")[1]],
    pubkey: [rec.bazaar, rec.contract, "request_execution", (a) => a.source?.Project?.project_id === rec.project_id && a.input_data === JSON.stringify({ cmd: "pubkey" })],
    set_outlayer: [rec.bazaar, rec.bazaar, "set_outlayer", (a) => a.outlayer === rec.contract],
    register_referee: [rec.bazaar, rec.bazaar, "register_referee", (a) => a.key_hex === rec.keys.referee_key],
    verdict: [rec.buyer, rec.bazaar, "submit_near_ai_verdict", (a) => a.envelope?.nullifier === rec.nullifier],
    near_deposit: [rec.buyer, "wrap.near", "near_deposit", () => true],
    "swap to USDC": [rec.buyer, "wrap.near", "ft_transfer_call", (a) => a.receiver_id === REF && JSON.parse(a.msg).actions?.[0]?.token_out === USDC_],
    request_referee: [rec.buyer, rec.bazaar, "request_referee", (a) => a.project_id === rec.project_id && sha(a.input_data) === rec.sealed_input_sha256],
    escrow: [rec.buyer, USDC_, "ft_transfer_call", (a) => a.receiver_id === rec.bazaar && String(a.amount) === rec.price],
    settle: [rec.buyer, rec.bazaar, "settle", (a) => a.nullifier === rec.nullifier && a.merchant === rec.merchant && String(a.amount) === rec.price && a.checkout_ref === rec.checkout_ref],
  };
  const names = Object.keys(want);
  const all = await Promise.all(names.map((k) => txOf(rec.txs[k], want[k][0])));
  const bad = names.filter((k, i) => {
    const t = all[i], [signer, receiver, method, argsOk] = want[k];
    const a = argsOf(t, method);
    return failed(t) || t.transaction.signer_id !== signer || t.transaction.receiver_id !== receiver || !a || !argsOk(a);
  });
  lines.push([bad.length === 0 && Object.keys(rec.txs).length === names.length, `all ${names.length} recorded txs succeeded, each from its signer to its receiver with the recorded method and args${bad.length ? ` (failed: ${bad.join(", ")})` : ""}`]);
  // The spend: bazaar + buyer balances at the two recorded heights, which bracket the run.
  let spendOk = false, spentNow = null;
  try {
    const [h0, h1] = [rec.spent_blocks?.[0], rec.spent_blocks?.[1]];
    const heightOf = async (t) => (await c.rpc("block", { block_id: t.transaction_outcome.block_hash })).result.header.height;
    const lastOf = async (t) => Math.max(...(await Promise.all([t.transaction_outcome, ...t.receipts_outcome].map(async (o) => (await c.rpc("block", { block_id: o.block_hash })).result.header.height))));
    const [cpH, seH] = await Promise.all([heightOf(all[0]), lastOf(all[names.indexOf("settle")])]);
    const bal = async (acct, h) => BigInt((await c.rpc("query", { request_type: "view_account", block_id: h, account_id: acct })).result.amount);
    const [b0, a0, b1, a1] = await Promise.all([bal(rec.bazaar, h0), bal(rec.buyer, h0), bal(rec.bazaar, h1), bal(rec.buyer, h1)]);
    spentNow = b0 + a0 - b1 - a1;
    spendOk = h0 < cpH && seH <= h1 && spentNow === BigInt(rec.spent_yocto) && String(b0 + a0) === rec.start_balance;
  } catch (err) {
    console.error(`   rpc: spend: ${err.message.slice(0, 160)}`);
  }
  lines.push([spendOk, `spent ${rec.spent_near} NEAR: bazaar + buyer balance at block ${rec.spent_blocks?.[0]} (before create_project) minus at ${rec.spent_blocks?.[1]} (after settle), read from the archive${spentNow != null && !spendOk ? ` (read ${spentNow})` : ""}`]);
  return lines;
}

async function check(c) {
  const rec = JSON.parse(readFileSync(OUT, "utf8"));
  // A public RPC that drops or rate-limits is a SKIP (exit 3), as make mainnet-check reads it.
  const NET = /RPC kept failing|fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|429|Too Many Requests|rate limit|timed out|socket hang up/i;
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => (errs.push(a.join(" ")), origErr(...a));
  let lines;
  try {
    lines = await checkLines(c, rec);
  } catch (err) {
    if (!NET.test(err.message)) throw err;
    console.log(`SKIP  mainnet-outlayer check: public mainnet RPC unreachable or rate-limited (${err.message.slice(0, 80)})`);
    process.exit(3);
  }
  for (const [ok, t] of lines) console.log(`${ok ? "PASS" : "FAIL"}  ${t}`);
  if (!lines.every(([ok]) => ok) && errs.some((e) => NET.test(e))) {
    console.log("SKIP  mainnet-outlayer check: a FAIL above follows a public RPC error; run again");
    process.exit(3);
  }
  if (process.env.VERBOSE) for (const [k, h] of Object.entries(rec.txs)) console.log(`      ${k}: ${link(h)}`);
  if (!lines.every(([ok]) => ok)) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd] = process.argv.slice(2);
  const c = rpcClient(RPC);
  if (cmd === "plan") {
    const B = BZ.bazaar, A = key("buyer").pub;
    const [b, a, usdc, refs] = await Promise.all([c.account(B), c.account(A), c.view(USDC, "ft_balance_of", { account_id: A }), c.view(B, "referees", {})]);
    console.log(`mainnet bazaar ${B.slice(0, 12)}.. ${near(BigInt(b.amount))} NEAR; buyer ${A.slice(0, 12)}.. ${near(BigInt(a.amount))} NEAR, ${Number(usdc) / 1e6} USDC; referees ${refs.length}; cap ${near(CAP)} NEAR`);
    console.log(`project: ${PROJECT}  exists: ${Boolean(await c.view(OL, "get_project", { project_id: PROJECT }).catch(() => null))}`);
    for (const [id, what, cost] of STEPS) console.log(`  ${id.padEnd(16)} ${what}  [${cost}]`);
  } else {
    await (cmd === "run" ? run(c) : cmd === "check" ? check(rpcClient(ARCHIVE)) : Promise.reject(new Error("usage: plan | run --mainnet | check"))).catch((e) => {
      console.error(`FAIL  ${e.message}`);
      process.exit(1);
    });
  }
}
