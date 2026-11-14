// verifyRun of make outlayer-buy against the committed RPC snapshot (no network): the recorded run
// passes, and each tamper fails the line it should. The txs and views are the real testnet answers
// that make verify-live recorded (fixtures/live/rpc-snapshot/snapshot.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyRun } from "./outlayer-buy.mjs";

const root = new URL("../", import.meta.url);
const snap = JSON.parse(readFileSync(new URL("fixtures/live/rpc-snapshot/snapshot.json", root), "utf8")).responses;
const base = JSON.parse(readFileSync(new URL("fixtures/live/testnet-manifest.json", root), "utf8")).outlayer;
const R = () => structuredClone(base);

const rawSnap = async (h, s) => structuredClone(snap[`tx ${JSON.stringify({ tx_hash: h, sender_account_id: s, wait_until: "FINAL" })}`]?.result);
const viewSnap = async (a, m, x) => {
  const r = snap[`query ${JSON.stringify({ request_type: "call_function", finality: "final", account_id: a, method_name: m, args_base64: Buffer.from(JSON.stringify(x)).toString("base64") })}`];
  if (!r?.result?.result) throw new Error(`not in the snapshot: ${m}`);
  return JSON.parse(Buffer.from(r.result.result).toString() || "null");
};
/** The indexes of the failing lines. */
const failing = async (rec, view = viewSnap, raw = rawSnap) => (await verifyRun(view, raw, rec)).map(([ok], i) => (ok ? null : i)).filter((i) => i !== null);

const mutTx = (hash, f) => async (h, s) => {
  const t = await rawSnap(h, s);
  if (t && h === hash) f(t);
  return t;
};
const editArgs = (t, method, g) => {
  const walk = (acts) =>
    acts.forEach((a) => {
      if (a.FunctionCall?.method_name === method) {
        const x = JSON.parse(Buffer.from(a.FunctionCall.args, "base64"));
        g(x);
        a.FunctionCall.args = Buffer.from(JSON.stringify(x)).toString("base64");
      } else if (a.Delegate) walk(a.Delegate.delegate_action.actions.map((y) => y.NonDelegateAction ?? y));
    });
  walk(t.transaction.actions);
};
const editLogs = (t, f) => [t.transaction_outcome, ...t.receipts_outcome].forEach((o) => (o.outcome.logs = f(o.outcome.logs)));
const vmut = (f) => async (a, m, x) => {
  const v = await viewSnap(a, m, x);
  return m === "list_versions" ? f(v) : v;
};
const H = base.honest.txs.settle;
const K = base.cheat.txs.settle_attempt;
// Lines: 0 project and versions, 1 pubkey statement, 2 referees, 3 honest, 4 cheat.

test("the recorded run passes every line", async () => {
  assert.deepEqual(await failing(R()), []);
});

test("the honest settle is tied to this purchase", async () => {
  for (const [name, raw] of [
    ["amount", mutTx(H, (t) => editArgs(t, "settle_demo", (x) => (x.amount = "1")))],
    ["nullifier", mutTx(H, (t) => editArgs(t, "settle_demo", (x) => (x.nullifier = "00")))],
    ["merchant", mutTx(H, (t) => editArgs(t, "settle_demo", (x) => (x.merchant = "m02.bookerbob.testnet")))],
    ["settled event removed", mutTx(H, (t) => editLogs(t, (ls) => ls.filter((l) => !l.includes('"settled"'))))],
    ["ft_transfer removed", mutTx(H, (t) => editLogs(t, (ls) => ls.filter((l) => !l.includes('"ft_transfer"'))))],
    ["ft_transfer to another owner", mutTx(H, (t) => editLogs(t, (ls) => ls.map((l) => (l.includes('"ft_transfer"') ? l.replaceAll(base.honest.merchant, "evil.testnet") : l))))],
    ["settle_reverted", mutTx(H, (t) => editLogs(t, (ls) => [...ls, "settle_reverted"]))],
  ]) assert.deepEqual(await failing(R(), viewSnap, raw), [3], name);
  for (const [name, f] of [
    ["settle -> escrow tx", (r) => (r.honest.txs.settle = r.honest.txs.escrow)],
    ["settle -> cheat settle tx", (r) => (r.honest.txs.settle = r.cheat.txs.settle_attempt)],
    ["merchant", (r) => (r.honest.merchant = "m02.bookerbob.testnet")],
    ["price", (r) => (r.honest.price = "1")],
  ]) {
    const r = R();
    f(r);
    assert.deepEqual(await failing(r), [3], name);
  }
});

test("the cheat settle is tied to the cheat purchase and refused for the missing receipt", async () => {
  for (const [name, raw] of [
    ["nullifier", mutTx(K, (t) => editArgs(t, "settle_demo", (x) => (x.nullifier = "00")))],
    ["merchant", mutTx(K, (t) => editArgs(t, "settle_demo", (x) => (x.merchant = "m02.bookerbob.testnet")))],
    ["another failure", mutTx(K, (t) => Object.assign(t, JSON.parse(JSON.stringify(t).replaceAll("no referee receipt", "insufficient gas"))))],
  ]) assert.deepEqual(await failing(R(), viewSnap, raw), [4], name);
  for (const [name, f] of [
    ["settle -> honest settle tx", (r) => (r.cheat.txs.settle_attempt = r.honest.txs.settle)],
    ["settle -> its request_referee tx", (r) => (r.cheat.txs.settle_attempt = r.cheat.txs.request_referee)],
    ["merchant", (r) => (r.cheat.merchant = "m02.bookerbob.testnet")],
    ["referee path", (r) => (r.cheat.via = "bogus")],
  ]) {
    const r = R();
    f(r);
    assert.deepEqual(await failing(r), [4], name);
  }
});

test("list_versions holds only recorded builds and the active one is the recorded version", async () => {
  for (const [name, f] of [
    ["an unrecorded version", (v) => [...v, { ...v[0], wasm_hash: "ff".repeat(32), is_active: false }]],
    ["v0 active instead", (v) => v.map((x) => ({ ...x, is_active: x.wasm_hash === base.v0.wasm_sha256 }))],
    ["two active", (v) => v.map((x) => ({ ...x, is_active: true }))],
    ["inactive", (v) => v.map((x) => ({ ...x, is_active: false }))],
    ["other hash", (v) => v.map((x) => ({ ...x, wasm_hash: "ff".repeat(32) }))],
    ["null", () => null],
  ]) assert.deepEqual(await failing(R(), vmut(f)), [0], name);
});

test("the relay path fails a line instead of throwing on missing, unknown or wrong txs", async () => {
  for (const [name, f] of [
    ["missing", (r) => (r.honest.via = "relay")],
    ["unknown hashes", (r) => Object.assign(r.honest, { via: "relay", txs: { ...r.honest.txs, outlayer_resolve: "1".repeat(32), submit_referee_result: "1".repeat(32) } })],
    ["wrong txs", (r) => Object.assign(r.honest, { via: "relay", txs: { ...r.honest.txs, outlayer_resolve: r.honest.txs.escrow, submit_referee_result: r.honest.txs.escrow } })],
  ]) {
    const r = R();
    f(r);
    assert.deepEqual(await failing(r), [3], name);
  }
});

test("unknown tx hashes fail lines, never throw", async () => {
  const r = R();
  r.txs.pubkey = "1".repeat(32);
  r.honest.txs.settle = "1".repeat(32);
  r.cheat.txs.settle_attempt = "1".repeat(32);
  assert.deepEqual(await failing(r), [1, 3, 4]);
});

test("each pubkey run must have run its own version's wasm", async () => {
  const swap = R();
  [swap.txs.pubkey, swap.v0.pubkey_tx] = [swap.v0.pubkey_tx, swap.txs.pubkey];
  assert.deepEqual(await failing(swap), [1]);
  const other = R();
  other.v0.wasm_sha256 = other.wasm_sha256;
  // v0's real hash is then an unrecorded version on the project too.
  assert.deepEqual(await failing(other), [0, 1]);
});
