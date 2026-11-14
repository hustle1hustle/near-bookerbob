// The keyless checks of the Jolt verifier on OutLayer (scripts/outlayer-jolt.mjs) and of the TDX
// attestation of our OutLayer runs (scripts/outlayer-attest.mjs), against the committed RPC
// snapshot (no network): the recorded runs pass, and each tamper fails the line it should.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyRun } from "./outlayer-jolt.mjs";
import { DIR, RUNS, tdReport, taskHash, verifyRuns } from "./outlayer-attest.mjs";

const root = new URL("../", import.meta.url);
const snap = JSON.parse(readFileSync(new URL("fixtures/live/rpc-snapshot/snapshot.json", root), "utf8")).responses;
const base = JSON.parse(readFileSync(new URL("fixtures/live/testnet-manifest.json", root), "utf8")).outlayer_jolt;
const R = () => structuredClone(base);
const raw = async (h, s) => structuredClone(snap[`tx ${JSON.stringify({ tx_hash: h, sender_account_id: s, wait_until: "FINAL" })}`]?.result);
const view = async (a, m, x) => {
  const r = snap[`query ${JSON.stringify({ request_type: "call_function", finality: "final", account_id: a, method_name: m, args_base64: Buffer.from(JSON.stringify(x)).toString("base64") })}`];
  if (!r?.result?.result) throw new Error(`not in the snapshot: ${m}`);
  return JSON.parse(Buffer.from(r.result.result).toString() || "null");
};
const failing = async (rec, v = view, rw = raw) => (await verifyRun(v, rw, rec)).map(([ok], i) => (ok ? null : i)).filter((i) => i !== null);
// Lines: 0 project, 1 pubkey, 2 honest, 3 forged, 4 consumer.

test("the recorded Jolt run passes every line", async () => {
  assert.deepEqual(await failing(R()), []);
});

test("Jolt: each tamper fails its line", async () => {
  const cases = [
    ["another wasm", (r) => (r.wasm_sha256 = "ff".repeat(32)), [0, 1, 2, 3]],
    ["another key", (r) => (r.key = "00".repeat(32)), [1, 2, 3]],
    ["another program", (r) => (r.program_hash = "ff".repeat(32)), [1, 2]],
    ["honest -> forged tx (the forged and consumer lines lose their reference too)", (r) => (r.txs.honest = r.txs.forged), [2, 3, 4]],
    ["another source submit", (r) => (r.source = { ...r.source, tx: r.history[0].source.tx }), [2]],
    ["forged -> honest tx", (r) => Object.assign(r, { txs: { ...r.txs, forged: r.txs.honest }, via: { ...r.via, forged: "callback" } }), [3, 4]],
    ["accept tx -> refused tx", (r) => (r.txs.attest_use = r.txs.attest_reject), [4]],
    ["refused tx -> accept tx", (r) => (r.txs.attest_reject = r.txs.attest_use), [4]],
    ["resolve from another request", (r) => (r.txs.forged_resolve = r.txs.pubkey_resolve), [3, 4]],
  ];
  for (const [name, f, want] of cases) {
    const r = R();
    f(r);
    assert.deepEqual(await failing(r), want, name);
  }
});

const records = (tx) => JSON.parse(readFileSync(new URL(`${DIR}${tx}.json`, root), "utf8"));
const dcap = JSON.parse(readFileSync(new URL(`${DIR}dcap.json`, root), "utf8"));
const attestFailing = async (rec = records, d = dcap, v = view) => (await verifyRuns(v, raw, rec, d)).map(([ok], i) => (ok ? null : i)).filter((i) => i !== null);

test("the attestation of the three runs passes, and the task hash is the quote's report_data", async () => {
  assert.deepEqual(await attestFailing(), []);
  for (const [, tx] of RUNS) assert.equal(tdReport(records(tx).tdx_quote).report_data.slice(0, 64), taskHash(records(tx)));
});

test("attestation: a changed field, a quote from another run, an unverified quote, unapproved measurements", async () => {
  const [tx0, tx1] = [RUNS[0][1], RUNS[1][1]];
  const edit = (tx, f) => (t) => {
    const r = records(t);
    if (t === tx) f(r);
    return r;
  };
  assert.deepEqual(await attestFailing(edit(tx0, (r) => (r.output_hash = "00".repeat(32)))), [0], "output hash");
  assert.deepEqual(await attestFailing(edit(tx0, (r) => (r.input_hash = "00".repeat(32)))), [0], "input hash");
  assert.deepEqual(await attestFailing(edit(tx0, (r) => (r.tdx_quote = records(tx1).tdx_quote))), [0], "another run's quote");
  // One byte outside the TD report (in the signature data): report_data still matches, but the
  // DCAP verification on record was started with other quote bytes.
  const flip700 = (r) => {
    const q = Buffer.from(r.tdx_quote, "base64");
    q[700] ^= 1;
    r.tdx_quote = q.toString("base64");
  };
  assert.deepEqual(await attestFailing(edit(tx0, flip700)), [0], "quote byte outside the report changed");
  const d = structuredClone(dcap);
  d.runs[tx0].id = d.runs[tx1].id;
  assert.deepEqual(await attestFailing(records, d), [0], "another run's DCAP verification");
  const noApprove = async (a, m, x) => (m === "is_measurements_approved" ? false : view(a, m, x));
  assert.deepEqual(await attestFailing(records, dcap, noApprove), [0, 1, 2, 3], "measurements not approved");
});
