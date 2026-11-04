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
