#!/usr/bin/env node
// The TDX attestation of our OutLayer runs (docs/outlayer.md, "Attestation"). Keyless, testnet.
//
//   node scripts/outlayer-attest.mjs fetch     save OutLayer's attestation record of each run in
//                                             fixtures/live/outlayer/attest/<tx>.json (public API)
//   node scripts/outlayer-attest.mjs verify    re-derive, from the saved records and public RPC
//
// For each run: the record is the one OutLayer published for that tx (testnet-api.outlayer.ai
// /attestations/by-tx/<tx>); its request id, project, caller and wasm hash are the ones the tx's
// execution_requested event carries; its input_hash is sha256 of the input_data the tx sent; its
// output_hash is sha256 of the output the run returned (the callback's return value); the task
// hash of those fields (the preimage rule of out-layer/outlayer-verify, crates/verify-core/src/
// preimage.rs, format V1) is report_data[0..32] of the record's TDX quote, and report_data[32..64]
// is zero; and the quote's MRTD and RTMR0..3 are an approved worker build on OutLayer's register
// contract (worker.outlayer.testnet `is_measurements_approved`). The quote's Intel signature chain
// is checked separately (scripts/outlayer-attest.mjs does not; see the docs).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const DIR = "fixtures/live/outlayer/attest/";
/** Per network: OutLayer's attestation API, its register contract (approved measurements, Intel
 *  collateral) and a public RPC. Mainnet is read only: its quote is verified on our testnet DCAP
 *  verifier (quote verification does not depend on the chain), so nothing here spends mainnet NEAR. */
export const NET = {
  testnet: { api: "https://testnet-api.outlayer.ai", register: "worker.outlayer.testnet", rpc: "https://test.rpc.fastnear.com" },
  mainnet: { api: "https://api.outlayer.ai", register: "worker.outlayer.near", rpc: "https://rpc.mainnet.fastnear.com" },
};
const REGISTER = NET.testnet.register;

/** The runs whose attestation we check: [label, tx, signer, wasm sha256, response format]. */
export const RUNS = [
  ["referee v1, honest purchase", "Gsc2QdbZrWKHCXGCcRCabac3deSHizzfAfwtTRD1MbUv", "bookerbob-demo.testnet", "6fca1eaa09b2c1ca583a6914bdff7256d73a3d9f4469bd55f1eb00446be8dbb6"],
  ["referee v1, cheat refused", "3FbtcCH8Y9ZA7hwzCrkTS76Fy4PDioDwhavw6U2nQGJ6", "bookerbob-demo.testnet", "6fca1eaa09b2c1ca583a6914bdff7256d73a3d9f4469bd55f1eb00446be8dbb6"],
  ["Jolt verifier, the standing proof behind the live root", "D7yPc1vuqoqznbs2smmLiZN9pJrpLHKSTSusNGAFFvFW", "bookerbob.testnet", "cad8d2e12500315b9bef983b6983489d46b958f6be2784f18af1229c839fbb65"],
  // The arbiter on OutLayer (docs/keyless.md): a dispute run, a direct request_execution by
  // bookerbob.testnet (no callback). Its output is the request tx's return value, or the one in
  // OutLayer's resolve tx for the same request id (7th field).
  ["referee v1, a dispute decided by the arbiter key", "AjfwNan6WZ5vSgrfw8FSSnrLebzTnUba6vGYP34xKwXh", "bookerbob.testnet", "6fca1eaa09b2c1ca583a6914bdff7256d73a3d9f4469bd55f1eb00446be8dbb6", "testnet", null, "AEuiNjB97413UQ99vhhHaXna4Yv9iFkyPseKq61DUan4"],
  // The mainnet bazaar's OutLayer referee (outlayer.near, the same v1 wasm): its purchase's request.
  ["MAINNET referee, the purchase on outlayer.near", "AWeGAm2uAYnV3Hz8Hz5mbYHMacPNYoHDov39Kt8bDD7V", "a361f2956eea3a29c0986c92173a9c2861065521d7ee07b7e6b0f576b7bc2042", "6fca1eaa09b2c1ca583a6914bdff7256d73a3d9f4469bd55f1eb00446be8dbb6", "mainnet"],
];
const netOf = (run) => run[4] ?? "testnet";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const i64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};

/** outlayer-verify's task hash, format V1 (records after 2026-01-30). */
export function taskHash(a) {
  const parts = [Buffer.from(a.task_type), i64le(a.task_id)];
  for (const f of [a.repo_url, a.commit_hash, a.build_target, a.wasm_hash, a.input_hash]) if (f != null) parts.push(Buffer.from(f));
  parts.push(Buffer.from(a.output_hash));
  if (a.block_height != null) parts.push(u64le(a.block_height));
  for (const f of [a.caller_account_id, a.project_id, a.secrets_ref]) if (f != null) parts.push(Buffer.from(f));
  parts.push(i64le(a.timestamp));
  if (a.attached_usd != null) parts.push(Buffer.from(String(a.attached_usd)));
  return sha(Buffer.concat(parts));
}

/** The TD report fields of a TDX v4 quote (48-byte header, then the 584-byte TD report body). */
export function tdReport(quoteB64) {
  const q = Buffer.from(quoteB64, "base64");
  const body = 48;
  const at = (off, len) => q.subarray(body + off, body + off + len).toString("hex");
  return { version: q.readUInt16LE(0), tee_type: q.readUInt32LE(4), mrtd: at(136, 48), rtmr0: at(328, 48), rtmr1: at(376, 48), rtmr2: at(424, 48), rtmr3: at(472, 48), report_data: at(520, 64), bytes: q.length };
}

/** sha256 of compact JSON with keys sorted (the worker's serialization of a Json output). */
const sortedJson = (v) => (Array.isArray(v) ? `[${v.map(sortedJson).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(v[k])}`).join(",")}}` : JSON.stringify(v));

export const SPIKE = "spike.bookerbob.testnet";
// The verifier's code, pinned: this code hash and no access keys (locked), so no one can replace it.
export const SPIKE_CODE_HASH = "7ZabqCJbiNVMiXxyv2YNDm6LxP951LcuhysKHvFC5oaR";
export const DCAP = `${DIR}dcap.json`;

/** Our on-chain DCAP verifier (tools/dcap-spike) on each run's quote, with the Intel collateral
 *  OutLayer's register contract publishes (get_collaterals; the one whose FMSPC fits verifies).
 *  Signs as the demo treasury; 0.5 testnet NEAR storage per verification. Writes dcap.json. */
export async function dcap() {
  const { keyFromSeed, rpcClient, send } = await import("../relayer/near.mjs");
  const c = rpcClient(process.env.NEAR_RPC || "https://test.rpc.fastnear.com");
  const signer = "bookerbob-demo.testnet";
  const key = keyFromSeed(readFileSync(`${process.env.HOME}/.rep-secrets/bookerbob-testnet/treasury.seed`, "utf8"));
  const call = async (method, args, deposit = 0n) => {
    const r = await send(c, { signer_id: signer, key, receiver_id: SPIKE, actions: [{ type: "FunctionCall", method_name: method, args, gas: 300n * 10n ** 12n, deposit }] });
    console.log(`   ${r.ok ? "ok" : "FAILED"} ${method}  https://testnet.nearblocks.io/txns/${r.hash}${r.ok ? "" : `  ${(r.error ?? "").slice(0, 160)}`}`);
    return r;
  };
  const colsOf = async (net) => JSON.parse(Buffer.from((await rpcClient(NET[net].rpc).rpc("query", { request_type: "call_function", finality: "final", account_id: NET[net].register, method_name: "get_collaterals", args_base64: Buffer.from("{}").toString("base64") })).result.result).toString());
  const out = existsSync(DCAP) ? JSON.parse(readFileSync(DCAP, "utf8")) : { spike: SPIKE, collateral_source: `${REGISTER} get_collaterals`, runs: {} };
  for (const run of RUNS) {
    const [label, tx] = run;
    if (out.runs[tx]?.verification?.[0] === "verified") continue;
    const cols = await colsOf(netOf(run));
    const a = JSON.parse(readFileSync(`${DIR}${tx}.json`, "utf8"));
    const quoteHex = Buffer.from(a.tdx_quote, "base64").toString("hex");
    for (const [i, col] of cols.entries()) {
      console.log(`${label}: collateral ${i}`);
      const s = await call("start", { quote_hex: quoteHex, collateral_json: col }, 10n ** 24n / 2n);
      if (!s.ok) continue;
      const id = s.value;
      const txs = [s.hash];
      let st;
      for (;;) {
        st = await c.view(SPIKE, "verification", { id });
        if (st[0] === "verified") break;
        const r = await call("step", { id });
        txs.push(r.hash);
        if (!r.ok) break;
      }
      if (st[0] === "verified") {
        out.runs[tx] = { label, network: netOf(run), collateral_source: `${NET[netOf(run)].register} get_collaterals`, id, collateral_index: i, collateral_sha256: sha(Buffer.from(col)), txs, verification: st };
        console.log(`   verified: ${st[1]?.slice(0, 80)}`);
        break;
      }
    }
    writeFileSync(DCAP, JSON.stringify(out, null, 2) + "\n");
  }
}

export async function fetchAll() {
  mkdirSync(DIR, { recursive: true });
  for (const run of RUNS) {
    const tx = run[1];
    const r = await fetch(`${NET[netOf(run)].api}/attestations/by-tx/${tx}`);
    if (!r.ok) throw new Error(`${tx}: HTTP ${r.status}`);
    writeFileSync(`${DIR}${tx}.json`, JSON.stringify(await r.json(), null, 1) + "\n");
    console.log(`saved ${DIR}${tx}.json`);
  }
}

/** Keyless: [ok, text] lines. `raw(hash, sender)` the tx result; `view(account, method, args)`. */
export async function verifyRuns(view, raw, records = (tx) => JSON.parse(readFileSync(`${DIR}${tx}.json`, "utf8")), dcapRec = existsSync(DCAP) ? JSON.parse(readFileSync(DCAP, "utf8")) : { runs: {} }, mainnet = null, spikeAccount = null) {
  const lines = [];
  // `spikeAccount()` -> {code_hash, keys}: the verifier is the pinned code and has no access key.
  if (spikeAccount) {
    const acc = await spikeAccount().catch(() => null);
    lines.push([acc?.code_hash === SPIKE_CODE_HASH && acc.keys === 0, `${dcapRec.spike ?? SPIKE}: code hash ${String(acc?.code_hash).slice(0, 8)}.. (pinned ${SPIKE_CODE_HASH.slice(0, 8)}..), ${acc?.keys ?? "?"} access keys (locked)`]);
  }
  const spikeView = view;
  const spikeRaw = raw;
  for (const run of RUNS) {
    const [label, tx, signer, wasm, , , resolveTx] = run;
    // Mainnet runs need mainnet reads; without them (make verify-live is testnet) they are skipped.
    if (netOf(run) === "mainnet" && !mainnet) continue;
    const { view: nview, raw: nraw } = netOf(run) === "mainnet" ? mainnet : { view, raw };
    const register = NET[netOf(run)].register;
    let a;
    try {
      a = records(tx);
    } catch {
      lines.push([false, `${label}: no attestation record`]);
      continue;
    }
    const t = await nraw(tx, signer).catch(() => null);
    const logs = t ? [t.transaction_outcome, ...t.receipts_outcome].flatMap((o) => o.outcome.logs) : [];
    const ev = logs.find((l) => l.includes('"execution_requested"'));
    const rd = ev ? JSON.parse(JSON.parse(ev.slice(11)).data[0].request_data) : {};
    // input_data as OutLayer received it: in the event, or, over its 10 KB threshold, the
    // request_execution args of the receipt that carried it.
    let input = rd.input_data;
    if (!input && t) {
      const walk = (acts) => acts.flatMap((x) => (x.FunctionCall ? [x.FunctionCall] : x.Delegate ? walk(x.Delegate.delegate_action.actions.map((y) => y.NonDelegateAction ?? y)) : []));
      const fc = walk(t.transaction.actions).find((f) => f.method_name === "request_execution");
      input = fc ? JSON.parse(Buffer.from(fc.args, "base64").toString()).input_data : null;
    }
    const ret = t?.status?.SuccessValue != null ? Buffer.from(t.status.SuccessValue, "base64").toString() : null;
    const fields = a.transaction_hash === tx && a.request_id === rd.request_id && a.project_id === rd.project_id && a.caller_account_id === rd.sender_id && a.wasm_hash === wasm && a.executed_wasm_sha256 === wasm;
    const inOk = input != null && a.input_hash === sha(Buffer.from(input));
    // The output: a Json run returns the parsed object (hashed with sorted keys); a Text run the
    // module's stdout as one JSON string, which the bazaar's callback received.
    let outOk = false;
    if (ret) {
      try {
        const v = JSON.parse(ret);
        outOk = a.output_hash === sha(Buffer.from(sortedJson(v))) || (typeof v === "string" && a.output_hash === sha(Buffer.from(v)));
      } catch {
        outOk = false;
      }
    }
    // Through request_referee the callback is the bazaar's on_referee_result, whose return value is
    // a bool; the module's output is what OutLayer's on_execution_response resumed it with.
    if (!outOk && t) {
      for (const o of t.receipts_outcome) {
        const sv = o.outcome.status?.SuccessValue;
        if (!sv) continue;
        try {
          const v = JSON.parse(Buffer.from(sv, "base64").toString());
          if (a.output_hash === sha(Buffer.from(sortedJson(v))) || (typeof v === "string" && a.output_hash === sha(Buffer.from(v)))) outOk = true;
        } catch {
          // not JSON
        }
      }
    }
    // A run whose callback timed out: the output OutLayer's worker posted in its resolve tx, by
    // worker.outlayer.<net> to the OutLayer contract, for this request id.
    if (!outOk && resolveTx) {
      const res = await nraw(resolveTx, `worker.outlayer.${netOf(run) === "mainnet" ? "near" : "testnet"}`).catch(() => null);
      const fc = res?.transaction?.actions?.find((x) => x.FunctionCall)?.FunctionCall;
      const ra = fc ? JSON.parse(Buffer.from(fc.args, "base64").toString()) : {};
      const o = ra.response?.output;
      if (ra.request_id === rd.request_id && ra.response?.success && o) {
        if (o.Json !== undefined) outOk = a.output_hash === sha(Buffer.from(sortedJson(o.Json)));
        else if (typeof o.Text === "string") outOk = a.output_hash === sha(Buffer.from(o.Text));
      }
    }
    const td = a.tdx_quote ? tdReport(a.tdx_quote) : null;
    const bound = td && td.report_data.slice(0, 64) === taskHash(a) && /^0+$/.test(td.report_data.slice(64));
    let approved = false;
    if (td) approved = (await nview(register, "is_measurements_approved", { measurements: { mrtd: td.mrtd, rtmr0: td.rtmr0, rtmr1: td.rtmr1, rtmr2: td.rtmr2, rtmr3: td.rtmr3 } }).catch(() => null)) === true;
    // The quote's Intel signature chain, on chain: our DCAP verifier's finalized record for it,
    // whose report_data is this quote's (so the task hash above) and TCB status UpToDate.
    const d = dcapRec.runs?.[tx];
    const v = d ? await spikeView(dcapRec.spike ?? SPIKE, "verification", { id: d.id }).catch(() => null) : null;
    const [tcb, rdata] = (v?.[1] ?? "").split(" ");
    // ...and that verification is of THIS quote: its start tx (to the verifier, method start) carried
    // exactly these quote bytes and returned this verification id.
    let sameQuote = false;
    if (d?.txs?.[0]) {
      const st = await spikeRaw(d.txs[0], d.signer ?? "bookerbob-demo.testnet").catch(() => null);
      const fc = st?.transaction?.actions?.find((x) => x.FunctionCall)?.FunctionCall;
      const sargs = fc ? JSON.parse(Buffer.from(fc.args, "base64").toString()) : {};
      const sval = st?.status?.SuccessValue ? JSON.parse(Buffer.from(st.status.SuccessValue, "base64").toString()) : null;
      sameQuote = st?.transaction?.receiver_id === (dcapRec.spike ?? SPIKE) && fc?.method_name === "start" && sargs.quote_hex === Buffer.from(a.tdx_quote, "base64").toString("hex") && sval === d.id;
    }
    const intel = v?.[0] === "verified" && td && rdata === td.report_data && tcb === "UpToDate" && sameQuote;
    lines.push([Boolean(fields && inOk && outOk && bound && approved && intel), `${label}: OutLayer request ${a.request_id}, wasm ${wasm.slice(0, 8)}.., ${a.project_id}; input and output hashes match the tx; task hash ${taskHash(a).slice(0, 12)}.. is the quote's report_data; the quote verified on ${dcapRec.spike ?? SPIKE} (${tcb || "not verified"}); MRTD ${td?.mrtd.slice(0, 12)}.. approved on ${register}: ${approved}`]);
  }
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] ?? "verify";
  if (cmd === "fetch") await fetchAll();
  else if (cmd === "dcap") await dcap();
  else if (cmd === "verify") {
    const { readers } = await import("./lib/rpc-fallback.mjs");
    const t = readers("testnet");
    const { rpcClient } = await import("../relayer/near.mjs");
    const c = rpcClient(process.env.NEAR_RPC || "https://test.rpc.fastnear.com");
    const spikeAccount = async () => {
      const a = (await c.rpc("query", { request_type: "view_account", finality: "final", account_id: SPIKE })).result;
      const k = (await c.rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: SPIKE })).result;
      return { code_hash: a.code_hash, keys: k.keys.length };
    };
    const lines = await verifyRuns(t.view, t.raw, undefined, undefined, readers("mainnet"), spikeAccount);
    for (const [ok, t] of lines) console.log(`${ok ? "PASS" : "FAIL"}  ${t}`);
    process.exit(lines.every(([ok]) => ok) ? 0 : 1);
  }
}
