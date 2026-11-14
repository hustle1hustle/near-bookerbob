// Offline: scripts/outlayer-eval.mjs `verifyRun` over the committed RPC snapshot
// (fixtures/live/outlayer/eval-rpc.json, written by `node scripts/outlayer-eval.mjs snapshot`),
// then each recorded fact tampered: every tamper must turn a check to FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { OUT, verifyRun } from "./outlayer-eval.mjs";

const snap = JSON.parse(readFileSync("fixtures/live/outlayer/eval-rpc.json", "utf8"));
const rec = JSON.parse(readFileSync(OUT, "utf8"));
const view = async (a, m, args) => {
  const k = `${a} ${m} ${JSON.stringify(args)}`;
  if (!(k in snap.views)) throw new Error(`no snapshot for ${k}`);
  return snap.views[k];
};
const raw = async (h) => snap.txs[h] ?? null;
const fails = async (r, s = snap) => (await verifyRun(view, async (h) => s.txs[h] ?? null, r)).filter(([ok]) => !ok).map(([, t]) => t);

test("the recorded live run verifies from the snapshot", async () => {
  const lines = await verifyRun(view, raw, rec);
  assert.equal(lines.length, 20);
  assert.deepEqual(lines.filter(([ok]) => !ok), []);
});

test("tampering any recorded fact fails a check", async () => {
  const clone = () => JSON.parse(JSON.stringify(rec));
  const cases = {
    "a predicate added to the verdict": (r) => r.accept.envelope.predicates.push("github_builder"),
    "another evaluator key": (r) => (r.keys.evaluator_key = "00".repeat(32)),
    "another refusal reason": (r) => (r.refuse.refusal.reason = "ok"),
    "a different sybil nullifier": (r) => (r.sybil.envelope.nullifier = "11".repeat(32)),
    "another wasm": (r) => (r.wasm_sha256 = "22".repeat(32)),
    "the accept pointed at another run": (r) => (r.txs.accept = r.txs.refuse),
    "buyers swapped": (r) => ([r.buyers.a, r.buyers.b] = [r.buyers.b, r.buyers.a]),
    "another anchor id": (r) => (r.anchor_id = 4),
    "another context": (r) => (r.context = "bookerbob:v0:demo-hoodie"),
    "another seal key": (r) => (r.keys.seal_x25519 = "33".repeat(32)),
    "another request id": (r) => (r.request_ids.sybil = 1),
    "the submit pointed at the sybil's tx": (r) => (r.txs.submit = r.txs.sybil_submit),
    "another wasm url": (r) => (r.wasm_url = "https://example.com/x.wasm"),
  };
  for (const [name, f] of Object.entries(cases)) {
    const r = clone();
    f(r);
    assert.ok((await fails(r)).length > 0, name);
  }
});
