// Synthetic SignedDelegateAction tests (no network). The review args come from the
// committed Semaphore fixture, so the relayed call is the real one make verify runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { check, encodeDelegateAction, signableHash, NEP366_DISCRIMINANT } from "./relay.mjs";

const reviews = JSON.parse(readFileSync(new URL("../fixtures/semaphore/reviews.json", import.meta.url)));
const BAZAAR = "bookerbob.testnet";
const ctx = { bazaar: BAZAAR, block_height: 1000, max_deposit: "50000000000000000000000" };

function oneTimeKey(seedByte) {
  const seed = Buffer.alloc(32, seedByte);
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(12).toString("hex");
  return { priv, pub };
}

function delegate(over = {}, k = oneTimeKey(7)) {
  const e = reviews.proofs[0];
  const p = e.proof;
  const d = {
    sender_id: k.pub,
    receiver_id: BAZAAR,
    actions: [{
      type: "FunctionCall",
      method_name: "submit_review",
      args: { merchant: reviews.merchant, sealed: e.review.sealed, proof: { depth: p.merkleTreeDepth, merkle_root: p.merkleTreeRoot, nullifier: p.nullifier, points: p.points } },
      gas: 100_000_000_000_000,
      deposit: "10000000000000000000000",
    }],
    nonce: 1,
    max_block_height: 2000,
    public_key_hex: k.pub,
    ...over,
  };
  return { delegate_action: d, signature_hex: sign(null, signableHash(d), k.priv).toString("hex") };
}

test("discriminant is NEP-366's on-chain message type", () => {
  assert.equal(NEP366_DISCRIMINANT, 1073742190);
});

test("a one-time account's submit_review is accepted for relay", () => {
  assert.deepEqual(check(delegate(), ctx), { ok: true });
});

test("the encoding is stable borsh: lengths and the FunctionCall variant", () => {
  const d = delegate().delegate_action;
  const b = encodeDelegateAction(d);
  assert.equal(b.readUInt32LE(0), 64, "sender_id is the 64-char implicit account");
  const actionsAt = 4 + 64 + 4 + BAZAAR.length;
  assert.equal(b.readUInt32LE(actionsAt), 1);
  assert.equal(b[actionsAt + 4], 2, "FunctionCall is variant 2");
});

test("other methods, receivers, deposits and expired actions are refused", () => {
  const refused = (signed, why) => assert.match(check(signed, ctx).reason ?? "", why);
  const k = oneTimeKey(7);
  const base = delegate().delegate_action;
  refused(delegate({ actions: [{ ...base.actions[0], method_name: "withdraw" }] }, k), /not relayed/);
  refused(delegate({ receiver_id: "evil.testnet" }, k), /not the bazaar/);
  refused(delegate({ actions: [{ ...base.actions[0], deposit: "1000000000000000000000000" }] }, k), /cap/);
  refused(delegate({ max_block_height: 999 }, k), /expired/);
  refused(delegate({ sender_id: "buyer-agent.testnet" }, k), /one-time account/);
});

test("a tampered action or a foreign signature is refused", () => {
  const s = delegate();
  s.delegate_action.actions[0].args.sealed = "00".repeat(32);
  assert.equal(check(s, ctx).reason, "bad signature");
  const other = delegate({}, oneTimeKey(8));
  const mixed = { delegate_action: delegate().delegate_action, signature_hex: other.signature_hex };
  assert.equal(check(mixed, ctx).reason, "bad signature");
});

// ---------- demo policy ----------
import { checkDemo, DEMO_DAILY_ACTIONS } from "./relay.mjs";

const demoCtx = { bazaar: BAZAAR, dusdc: "bookerbob-dusdc.testnet", treasury: "bookerbob-demo.testnet", block_height: 1000 };
const TESTER = "t-a1b2c3.bookerbob-demo.testnet";

function demoDelegate(over = {}, action = {}, k = oneTimeKey(9)) {
  const d = {
    sender_id: TESTER,
    receiver_id: "bookerbob-dusdc.testnet",
    actions: [{ type: "FunctionCall", method_name: "ft_transfer_call", args: { receiver_id: BAZAAR, amount: "38400000", msg: "" }, gas: 100_000_000_000_000, deposit: "1", ...action }],
    nonce: 1,
    max_block_height: 2000,
    public_key_hex: k.pub,
    ...over,
  };
  return { delegate_action: d, signature_hex: sign(null, signableHash(d), k.priv).toString("hex") };
}

test("demo: a tester's escrow deposit and settle_demo are accepted", () => {
  assert.deepEqual(checkDemo(demoDelegate(), demoCtx), { ok: true });
  const settle = demoDelegate({ receiver_id: BAZAAR }, { method_name: "settle_demo", args: { nullifier: "aa", merchant: "m01.bookerbob.testnet", checkout_ref: "x", amount: "1" }, deposit: "0" });
  assert.deepEqual(checkDemo(settle, demoCtx), { ok: true });
});

test("demo: a tester's set_mandate is relayed", () => {
  assert.deepEqual(checkDemo(demoDelegate({ receiver_id: BAZAAR }, { method_name: "set_mandate", args: {}, deposit: String(10n ** 22n) }), demoCtx), { ok: true });
});

test("demo: a tester's claim_returning is relayed, its deposit capped", () => {
  const claim = (deposit) => demoDelegate({ receiver_id: BAZAAR }, { method_name: "claim_returning", args: { merchant: "m01.bookerbob.testnet", nullifier: "aa", proof: {} }, deposit });
  assert.deepEqual(checkDemo(claim(String(20n * 10n ** 21n)), demoCtx), { ok: true });
  assert.match(checkDemo(claim(String(21n * 10n ** 21n)), demoCtx).reason, /deposit over/);
});

test("demo: another receiver, method, sender, deposit or budget is refused", () => {
  const refused = (r, why) => assert.match(r.reason ?? "", why);
  refused(checkDemo(demoDelegate({ receiver_id: "usdc.testnet" }), demoCtx), /not the bazaar or dUSDC/);
  refused(checkDemo(demoDelegate({ receiver_id: BAZAAR }, { method_name: "withdraw_demo", deposit: "1" }), demoCtx), /not relayed/);
  refused(checkDemo(demoDelegate({ receiver_id: BAZAAR }, { method_name: "settle", deposit: "0" }), demoCtx), /not relayed/);
  refused(checkDemo(demoDelegate({ sender_id: "agent.bookerbob.testnet" }), demoCtx), /not a demo tester/);
  refused(checkDemo(demoDelegate({ sender_id: "t-a1b2c3.evil.testnet" }), demoCtx), /not a demo tester/);
  // make try: a one-time implicit tester, only when its id is its key and the treasury funded it
  const imp = demoDelegate();
  const hexId = imp.delegate_action.public_key_hex;
  const asImplicit = demoDelegate({ sender_id: hexId });
  refused(checkDemo(asImplicit, demoCtx), /not a demo tester/);
  assert.equal(checkDemo(asImplicit, { ...demoCtx, implicit: new Set([hexId]) }).ok, true);
  refused(checkDemo(demoDelegate({ sender_id: "ab".repeat(32) }), { ...demoCtx, implicit: new Set(["ab".repeat(32)]) }), /not a demo tester/);
  refused(checkDemo(demoDelegate({}, { deposit: "2" }), demoCtx), /demo cap/);
  refused(checkDemo(demoDelegate({}, { args: { receiver_id: "evil.testnet", amount: "1", msg: "" } }), demoCtx), /only to the bazaar/);
  refused(checkDemo(demoDelegate({ receiver_id: BAZAAR }, { method_name: "submit_verdict", deposit: "60000000000000000000000" }), demoCtx), /demo cap/);
  refused(checkDemo(demoDelegate({}, { gas: 400_000_000_000_000 }), demoCtx), /gas over/);
  refused(checkDemo(demoDelegate(), demoCtx, DEMO_DAILY_ACTIONS), /daily budget/);
  refused(checkDemo(demoDelegate({ max_block_height: 10 }), demoCtx), /expired/);
  const s = demoDelegate();
  s.delegate_action.actions[0].args.amount = "1";
  refused(checkDemo(s, demoCtx), /bad signature/);
});

test("demo: the review policy is unchanged (a tester cannot use it)", () => {
  assert.match(check(demoDelegate({ receiver_id: BAZAAR }, { method_name: "submit_review", deposit: "0" }), ctx).reason, /one-time account/);
});
