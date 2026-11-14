#!/usr/bin/env node
// `make outlayer-buy`: the referee runs on OutLayer (docs/outlayer.md, "The live run"). Testnet.
//
//   node scripts/outlayer-buy.mjs run      two demo-tester purchases whose referee step is
//                                          request_referee: the input sealed to the key the
//                                          OutLayer project derives in its TEE, the signed result
//                                          back through on_referee_result.
//                                          honest: receipt stored, escrow, settle_demo pays m01.
//                                          cheat: the buyer's model adds a claim its proofs do not
//                                          carry; OutLayer's referee refuses, no receipt, settle_demo
//                                          is refused. Writes fixtures/live/outlayer/run.json.
//   node scripts/outlayer-buy.mjs verify   the keyless check of that record over public RPC
//
// Keys: the treasury seed and tester seeds in KEYS_DIR (as make demo-tester). Only public data
// is written: accounts, nullifiers, tx hashes, keys, hashes. The plaintext worker input stays in
// the tester's live/ directory (mode 600).
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OUT = "fixtures/live/outlayer/run.json";
const TGAS = 10n ** 12n;
const fc = (method_name, args, deposit = 0n, gas = 100n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const events = (logs) => logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)));
const ev = (logs, name) => events(logs).find((e) => e.event === name)?.data?.[0];

/** The OutLayer project and what its pubkey run printed (public; re-checked by verify). */
export const OUTLAYER = {
  contract: "outlayer.testnet",
  project_id: "bookerbob.testnet/bookerbob-referee",
  project_uuid: "p000000000000018b",
  // The active version: the referee code of 1d39cd6, built at a fixed path (worker/outlayer/build.sh),
  // so any checkout rebuilds this hash (rustc 1.96.0, macOS arm64).
  wasm_url: "https://github.com/hustle1hustle/near-bookerbob/releases/download/outlayer-referee-v1/bookerbob-referee-outlayer.wasm",
  wasm_sha256: "6fca1eaa09b2c1ca583a6914bdff7256d73a3d9f4469bd55f1eb00446be8dbb6",
  source_commit: "hustle1hustle/near-bookerbob 1d39cd6 worker/outlayer with the fixed-path worker/outlayer/build.sh (release outlayer-referee-v1 carries it), rustc 1.96.0",
  // The first version, the same code built in the checkout (its hash depends on the checkout path);
  // kept on the project, inactive.
  v0: { wasm_url: "https://github.com/hustle1hustle/near-bookerbob/releases/download/outlayer-referee-v0/bookerbob-referee-outlayer.wasm", wasm_sha256: "45af89f93de0e3e4949dafa142e3137429db7fd81a981468f5bbeb0c161a8329", pubkey_tx: "9d8SVnxGHRPoYmHgR9QYoFezQXXTi2FwCutd9Eb14eYC" },
  keys: {
    arbiter_key: "1617391412d7e8cae76179deb8c1d35397a904594ac8884dd59600da59040e4a",
    referee_key: "5863e39dcd923d485c4d01784e84ca4c3b5ffae79c893baf933919ccf547feca",
    seal_for: "bookerbob.testnet",
    seal_pq1_sha256: "681aa672106d30148920520303edea9e007f15c8357b1fddcf5388ac2d131fe2",
    seal_x25519: "4af85c301e224911657e773db0708f70d8954a73e1a21968de1a81338143877e",
  },
  keys_signature: "dd32bed4405545b1c375f531d8436b66d44b93f200451b83b181af5bfb40ad9aadab51b241a1cdc67144b8f86ad161f1a494a4a330f0e4ca883dc3476be4470f",
  txs: {
    create_project: "GBX3r8Bumwfa3w4AfUkUkZWeAoLAwdn45GNee6evm7nG",
    pubkey: "4rA7TU2zGTjSnWBL1N2N8hNMSfhC2SQDdP6CpBPzLcxF",
    add_version_v1: "EJAJDoaDSpfagqVUwaCbXaPGxYQaqLFVppHB1c74gtvL",
    sealkey_failed: "8qhMH4wLTVgnecabEKgUqLA47xTE1GKSLFbMB6zLmRqW",
    set_outlayer: "AFfTUsJWvSb3jy2Bpb329ArkfhbKPdDzWUbwXXyjLSrf",
    register_referee_queued: "BbSSa4CB4NKfur9P9W2ZHeZg6RnEBoyroaneeWCDf3Jp",
    register_referee_executed: "429EVoXJzWJjfNLYbGQ8Y4edxxyHxNq69KKJxRg6D48e",
  },
};

/** The pubkey statement: "bookerbob/referee-keys/v0\0" || json(keys), keys in sorted order (serde_json). */
export function statementOk(keys, signatureHex) {
  const sorted = Object.fromEntries(Object.keys(keys).sort().map((k) => [k, keys[k]]));
  const msg = Buffer.concat([Buffer.from("bookerbob/referee-keys/v0\0"), Buffer.from(JSON.stringify(sorted))]);
  const pk = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(keys.referee_key, "hex")]), format: "der", type: "spki" });
  return edVerify(null, msg, pk, Buffer.from(signatureHex, "hex"));
}

/** Sends from the treasury; a request that waits on OutLayer (yield/resume) can outlast the RPC's
 *  wait, so a timeout is followed by polling the tx until it is final. */
async function sendWait(d, receiver_id, actions, label) {
  const { send } = await import("../relayer/near.mjs");
  const { outcome } = await import("../relayer/near.mjs");
  let r = await send(d.client, { signer_id: d.c.treasury, key: d.treasury, receiver_id, actions });
  for (let i = 0; i < 40 && r.error && /TIMEOUT|timeout|Timeout/.test(r.error) && r.hash; i++) {
    await new Promise((ok) => setTimeout(ok, 6000));
    const t = await d.client.rpc("tx", { tx_hash: r.hash, sender_account_id: d.c.treasury, wait_until: "FINAL" });
    if (!t.error) r = { ...outcome(t), hash: r.hash };
  }
  console.log(`   ${r.ok ? "ok" : "FAILED"} ${label}  https://testnet.nearblocks.io/txns/${r.hash}`);
  return r;
}

/** OutLayer's worker answers a request with resolve_execution (or submit_execution_output_and_resolve)
 *  from worker.outlayer.testnet; its args carry request_id and the module's output. Found through the
 *  nearblocks index (newest first), then read from RPC. Polls up to 8 minutes. */
export async function findResolve(requestId, sinceSec) {
  const { rpcClient } = await import("../relayer/near.mjs");
  const client = rpcClient(process.env.NEAR_RPC || "https://test.rpc.fastnear.com");
  const seen = new Set();
  for (let round = 0; round < 32; round++) {
    let cursor = null;
    for (let page = 0; page < 6; page++) {
      const u = `https://api-testnet.nearblocks.io/v1/account/worker.outlayer.testnet/txns?per_page=100&order=desc${cursor ? `&cursor=${cursor}` : ""}`;
      const js = await (await fetch(u)).json();
      const txs = js.txns ?? [];
      for (const t of txs) {
        const m = t.actions?.[0]?.method ?? "";
        if (!m.includes("resolve") || seen.has(t.transaction_hash) || Number(String(t.block_timestamp).slice(0, 10)) < sinceSec) continue;
        seen.add(t.transaction_hash);
        const r = await client.rpc("tx", { tx_hash: t.transaction_hash, sender_account_id: "worker.outlayer.testnet", wait_until: "FINAL" });
        for (const a of r.result?.transaction?.actions ?? []) {
          if (!a.FunctionCall) continue;
          const args = JSON.parse(Buffer.from(a.FunctionCall.args, "base64").toString());
          if (args.request_id === requestId) return { tx: t.transaction_hash, args };
        }
      }
      cursor = js.cursor;
      if (!txs.length || !cursor || Number(String(txs.at(-1).block_timestamp).slice(0, 10)) < sinceSec) break;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
    await new Promise((ok) => setTimeout(ok, 15000));
  }
  throw new Error(`no resolve tx for OutLayer request ${requestId}`);
}

const runOut = (cmd, opts = {}) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
  if (r.status !== 0) throw new Error(`${cmd.slice(0, 6).join(" ")}: ${(r.stderr || r.stdout || "").slice(-400)}`);
  return r.stdout;
};

/** demo-tester's referee hook: seal the worker input to the project's key, request_referee. */
function outlayerReferee(kind, record) {
  return async ({ input, rec, tester, live, q, d }) => {
    const obj = JSON.parse(input);
    if (kind === "cheat") obj.claims = JSON.parse(readFileSync("fixtures/claims-cheat.json", "utf8"));
    const plain = join(live, `outlayer-input-${kind}.json`);
    writeFileSync(plain, JSON.stringify(obj), { mode: 0o600 });
    // v0 (X25519): the pq1 key is longer than one OutLayer output (the sealkey run failed), so
    // the live run seals to seal_x25519, which the pubkey statement carries under the referee key.
    const sealed = runOut(["cargo", "run", "-q", "-p", "bookerbob-cli", "--", "seal-input", OUTLAYER.keys.seal_x25519, plain]).trim();
    const near = (await import("../relayer/near.mjs")).near;
    const r = await sendWait(d, d.c.bazaar, [fc("request_referee", { project_id: OUTLAYER.project_id, input_data: sealed }, near(0.05), 300n * TGAS)], `request_referee (${kind}) through OutLayer`);
    const asked = ev(r.logs, "execution_requested");
    const request_id = asked ? JSON.parse(asked.request_data).request_id : null;
    const entry = { tester: rec.tester, nullifier: rec.nullifier, merchant: d.c.merchant, request_id, txs: { ...rec.txs, request_referee: r.hash }, sealed_input_sha256: createHash("sha256").update(sealed).digest("hex") };
    record[kind] = entry;
    // Path 1: OutLayer resumed the yield in time, on_referee_result applied the result.
    let logs = r.logs;
    entry.via = "callback";
    if (!ev(logs, "referee_receipt") && !ev(logs, "receipt_refused")) {
      // Path 2: the yield timed out before OutLayer's worker answered (testnet load, 2026-11-14:
      // 180 to 250 s against a 200-block window). The worker still posts the signed result on
      // chain in its resolve_execution tx; anyone may relay it with submit_referee_result, and the
      // contract checks the same signature under the same registered key.
      if (request_id == null) throw new Error(`request_referee did not reach OutLayer: ${r.error}`);
      console.log(`   the callback timed out (${JSON.stringify(events(logs).map((e) => e.event))}); reading OutLayer's resolve tx for request ${request_id}`);
      const res = await findResolve(request_id, asked ? Math.floor(JSON.parse(asked.request_data).timestamp / 1e9) : 0);
      const out = res.args.response?.output?.Text;
      if (!res.args.response?.success || !out) throw new Error(`OutLayer request ${request_id} failed: ${res.args.response?.error}`);
      const result = JSON.parse(out);
      if (result.worker_key !== OUTLAYER.keys.referee_key) throw new Error(`the result is signed by ${result.worker_key}, not the project's key`);
      entry.via = "relay";
      entry.txs.outlayer_resolve = res.tx;
      entry.outlayer = { instructions: res.args.response.resources_used?.instructions, time_ms: res.args.response.resources_used?.time_ms };
      const s = await d.relay("submit_referee_result (the OutLayer output)", tester, d.c.bazaar, fc("submit_referee_result", { result }, 0n, 100n * TGAS));
      entry.txs.submit_referee_result = s.hash;
      logs = s.logs;
    }
    if (kind === "honest") {
      const got = ev(logs, "referee_receipt");
      if (!got || got.nullifier !== rec.nullifier) throw new Error(`no referee_receipt: ${JSON.stringify(events(logs).map((e) => e.event))}`);
      const v = await d.client.view(d.c.bazaar, "verdict", { nullifier: rec.nullifier });
      if (v?.receipt?.referee !== OUTLAYER.keys.referee_key) throw new Error(`the stored receipt is not signed by the OutLayer key: ${v?.receipt?.referee}`);
      if (q && String(v.receipt.price) !== String(q.price)) throw new Error(`receipt price ${v.receipt.price} differs from the quote ${q.price}`);
      entry.price = String(v.receipt.price);
      entry.receipt_hash = v.receipt.receipt_hash;
      entry.result_sha256 = v.receipt.result_sha256;
      return { price: entry.price };
    }
    const refused = ev(logs, "receipt_refused");
    if (!refused) throw new Error(`the cheat was not refused: ${JSON.stringify(events(logs).map((e) => e.event))}`);
    entry.refused = refused.reason;
    console.log(`   OutLayer referee refused: ${refused.reason}`);
    // Settle without a receipt (relayed as every demo settle): take_payment stops it first.
    const { delegateFor, outcome } = await import("../relayer/near.mjs");
    const signed = await delegateFor(d.client, { sender_id: tester.id, key: tester.key, receiver_id: d.c.bazaar, actions: [fc("settle_demo", { nullifier: rec.nullifier, merchant: d.c.merchant, checkout_ref: `cheat-${rec.tester.slice(0, 6)}`, amount: String(q?.price ?? "0") }, 0n, 150n * TGAS)] });
    const s = await sendWait(d, tester.id, [{ type: "Delegate", ...signed }], "settle_demo without a receipt (relayed)");
    void outcome;
    const blocked = String(s.error ?? "").includes("no referee receipt");
    entry.settle_refused = blocked ? "no referee receipt for this quote" : null;
    entry.txs.settle_attempt = s.hash ?? null;
    if (!blocked) throw new Error(`settle_demo was not refused for the missing receipt: ${s.error ?? "it succeeded"}`);
    console.log(`   settle_demo refused: no referee receipt for this quote`);
    return { stop: true };
  };
}

export async function run() {
  const { config, Demo } = await import("./demo-tester.mjs");
  const c = config(process.env);
  if (!c.bazaar.endsWith(".testnet")) throw new Error("testnet only");
  const record = { date: new Date().toISOString().slice(0, 10), bazaar: c.bazaar, treasury: c.treasury, ...OUTLAYER };
  // The legs first run on v0 stay in the record (their buys are spent; the ledger lists them).
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
  if (prev?.v0?.runs) record.v0 = { ...record.v0, runs: prev.v0.runs };
  const refs = await new Demo(c).client.view(c.bazaar, "referees", {});
  if (!refs.some(([k]) => k === OUTLAYER.keys.referee_key)) throw new Error("the OutLayer referee key is not registered on the bazaar yet (execute_anchor)");
  for (const kind of ["honest", "cheat"]) {
    console.log(`\n== ${kind}`);
    const d = new Demo(c);
    await d.run({ referee: outlayerReferee(kind, record), skipFinish: true });
    if (kind === "honest") record.honest.txs = { ...record.honest.txs, ...JSON.parse(readFileSync(join(c.testersDir, `${record.honest.tester}.json`), "utf8")).txs };
  }
  mkdirSync("fixtures/live/outlayer", { recursive: true });
  writeFileSync(OUT, JSON.stringify(record, null, 2) + "\n");
  console.log(`\nwrote ${OUT}`);
}

/** Keyless: [ok, text] lines from public RPC. `view(account, method, args)`, `raw(hash, sender)` the tx result. */
export async function verifyRun(view, raw, rec = JSON.parse(readFileSync(OUT, "utf8"))) {
  const lines = [];
  // An unknown or unreadable hash reads as null, and every check on a null tx fails (never throws).
  const tx = async (h, s) => {
    try {
      const t = h ? await raw(h, s) : null;
      return t?.transaction ? t : null;
    } catch {
      return null;
    }
  };
  const logsOf = (t) => (t ? [t.transaction_outcome, ...t.receipts_outcome].flatMap((o) => o.outcome.logs) : []);
  const failOf = (t) => (t ? [t.transaction_outcome, ...t.receipts_outcome].map((o) => o.outcome.status.Failure).find(Boolean) ?? t.status.Failure : "tx unreadable");
  /** Every FunctionCall in the tx as {method, args}, delegated actions included. */
  const calls = (t) => {
    if (!t) return [];
    const walk = (acts) => acts.flatMap((a) => (a.FunctionCall ? [{ method: a.FunctionCall.method_name, args: JSON.parse(Buffer.from(a.FunctionCall.args, "base64").toString() || "{}") }] : a.Delegate ? walk(a.Delegate.delegate_action.actions.map((x) => x.NonDelegateAction ?? x)) : []));
    return walk(t.transaction.actions);
  };
  const eventsOf = (t) => logsOf(t).filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)));
  const project = await view(rec.contract, "get_project", { project_id: rec.project_id });
  const active = JSON.stringify(project ?? {});
  const versions = (await view(rec.contract, "list_versions", { project_id: rec.project_id })) ?? [];
  // Every version is one of the recorded builds, and the one active version is the recorded one.
  const known = new Set([rec.wasm_sha256, rec.v0?.wasm_sha256].filter(Boolean));
  const activeOnes = versions.filter((v) => v.is_active);
  const pinned = versions.length > 0 && versions.every((v) => known.has(v.wasm_hash)) && activeOnes.length === 1 && activeOnes[0].wasm_hash === rec.wasm_sha256;
  lines.push([active.includes(rec.wasm_sha256) && active.includes(rec.project_uuid) && pinned, `project ${rec.project_id} (${rec.project_uuid}): ${versions.length} version(s), all recorded builds; the active one is wasm ${rec.wasm_sha256.slice(0, 12)}..`]);
  /** A pubkey run: it printed the recorded keys under a statement signed by referee_key, and OutLayer ran `hash`. */
  const pubkeyRun = async (hash, wasm) => {
    const pk = await tx(hash, rec.keys.seal_for);
    const out = pk ? JSON.parse(Buffer.from(pk.status.SuccessValue ?? "", "base64").toString() || "null") : null;
    const same = out?.keys && typeof out.signature === "string" && JSON.stringify(Object.entries(out.keys).sort()) === JSON.stringify(Object.entries(rec.keys).sort());
    const ran = logsOf(pk).some((l) => l.includes("execution_completed") && l.includes(wasm) && l.includes('"success":true'));
    return Boolean(same && statementOk(out.keys, out.signature) && ran);
  };

  const v1Keys = await pubkeyRun(rec.txs.pubkey, rec.wasm_sha256);
  const v0Keys = rec.v0 ? await pubkeyRun(rec.v0.pubkey_tx, rec.v0.wasm_sha256) : true;
  lines.push([v1Keys && v0Keys, `pubkey runs on OutLayer${rec.v0 ? " of both versions" : ""} printed referee_key ${rec.keys.referee_key.slice(0, 12)}.. (the project's key, the same across builds), statement signed by it`]);
  const refs = await view(rec.bazaar, "referees", {});
  lines.push([(refs ?? []).some(([k]) => k === rec.keys.referee_key), `${rec.bazaar} lists the OutLayer key among its referees`]);
  /** The referee step of one purchase: request_referee reached OutLayer for this project's wasm, and
   *  the signed result came back through the callback, or from OutLayer's resolve tx by relay. */
  const refereeStep = async (e, want) => {
    const req = await tx(e.txs.request_referee, rec.treasury);
    const rl = logsOf(req);
    const asked = rl.map((l) => (l.startsWith("EVENT_JSON:") ? JSON.parse(l.slice(11)) : null)).find((x) => x?.event === "execution_requested")?.data?.[0];
    const rd = asked ? JSON.parse(asked.request_data) : {};
    const toProject = rd.project_id === rec.project_id && JSON.stringify(rd.code_source ?? {}).includes(rec.wasm_sha256) && rd.predecessor_id === rec.bazaar && rd.request_id === e.request_id && /^\{"sealed"/.test(rd.input_data ?? "");
    const ran = rl.some((l) => l.includes("execution_completed") && l.includes(rec.wasm_sha256) && l.includes('"success":true'));
    if (e.via === "callback") return [toProject && ran && rl.some((l) => l.includes(`"${want}"`) && l.includes(e.nullifier)), "callback"];
    if (e.via !== "relay" || !e.txs.outlayer_resolve || !e.txs.submit_referee_result) return [false, `unknown referee path ${e.via}`];
    let res, sub;
    try {
      [res, sub] = await Promise.all([tx(e.txs.outlayer_resolve, "worker.outlayer.testnet"), tx(e.txs.submit_referee_result, rec.treasury)]);
    } catch (err) {
      return [false, `relay txs unreadable: ${err.message.slice(0, 80)}`];
    }
    if (!res || !sub) return [false, "relay txs unreadable"];
    const fcArgs = (t) => calls(t).map((c) => c.args);
    const ra = fcArgs(res)[0] ?? {};
    const out = ra.response?.output?.Text ? JSON.parse(ra.response.output.Text) : null;
    const fromWorker = res.transaction.signer_id === "worker.outlayer.testnet" && res.transaction.receiver_id === rec.contract && ra.request_id === e.request_id && out?.worker_key === rec.keys.referee_key;
    const relayed = JSON.stringify(fcArgs(sub)[0]?.result) === JSON.stringify(out) && !failOf(sub) && logsOf(sub).some((l) => l.includes(`"${want}"`) && l.includes(e.nullifier));
    return [toProject && fromWorker && relayed, `relayed from OutLayer's resolve tx for request ${e.request_id}`];
  };
  // Honest: OutLayer's result stored as the receipt, and the settle paid under it.
  const h = rec.honest;
  const [hv, hset, [hOk, hHow]] = await Promise.all([view(rec.bazaar, "verdict", { nullifier: h.nullifier }), tx(h.txs.settle, rec.treasury), refereeStep(h, "referee_receipt")]);
  // The settle is this purchase's: settle_demo for this nullifier, merchant and price, a `settled`
  // event for the nullifier, and a dUSDC ft_transfer from the bazaar to the merchant.
  const hcall = calls(hset).find((c) => c.method === "settle_demo");
  const hev = eventsOf(hset);
  const settled = !failOf(hset) && !logsOf(hset).some((l) => l.includes("settle_reverted"))
    && hcall?.args.nullifier === h.nullifier && hcall.args.merchant === h.merchant && String(hcall.args.amount) === h.price
    && hev.some((e) => e.event === "settled" && e.data?.[0]?.nullifier === h.nullifier && e.data[0].merchant === h.merchant)
    && hev.some((e) => e.event === "ft_transfer" && e.data?.[0]?.old_owner_id === rec.bazaar && e.data[0].new_owner_id === h.merchant && BigInt(e.data[0].amount) > 0n);
  lines.push([hOk && hv?.receipt?.referee === rec.keys.referee_key && hv.receipt.result_sha256 === h.result_sha256 && String(hv.receipt.price) === h.price && hv.spent && settled, `honest: the sealed input went to OutLayer through request_referee, the result signed by its key (${hHow}) is the stored receipt at ${Number(h.price) / 1e6} dUSDC, and settle_demo paid ${h.merchant.split(".")[0]} under it`]);
  // Cheat: refused by OutLayer's referee, nothing stored, settle refused.
  const k = rec.cheat;
  const [kv, kset, [kOk, kHow]] = await Promise.all([view(rec.bazaar, "verdict", { nullifier: k.nullifier }), tx(k.txs.settle_attempt, rec.treasury), refereeStep(k, "receipt_refused")]);
  const kcall = calls(kset).find((c) => c.method === "settle_demo");
  const blocked = kcall?.args.nullifier === k.nullifier && kcall.args.merchant === k.merchant && JSON.stringify(failOf(kset) ?? "").includes("no referee receipt");
  lines.push([kOk && kv && !kv.receipt && !kv.spent && blocked, `cheat: OutLayer's referee refused it (${k.refused}; ${kHow}), no receipt stored, settle_demo refused (no referee receipt)`]);
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] ?? "verify";
  if (cmd === "run") {
    run().catch((e) => {
      console.error(`\noutlayer-buy: FAIL ${e.message}`);
      process.exit(1);
    });
  } else if (cmd === "verify") {
    const { readers } = await import("./lib/rpc-fallback.mjs");
    const { view, raw } = readers("testnet");
    const lines = await verifyRun(view, raw);
    for (const [ok, t] of lines) console.log(`${ok ? "PASS" : "FAIL"}  ${t}`);
    process.exit(lines.every(([ok]) => ok) ? 0 : 1);
  } else {
    console.error("usage: outlayer-buy.mjs run|verify");
    process.exit(2);
  }
}
