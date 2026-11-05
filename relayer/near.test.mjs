// Offline checks of the transaction encoding (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify, createHash } from "node:crypto";
import { b58decode, b58encode, encodeAction, encodeTransaction, keyFromSeed, nearPublicKey, signTransaction, near } from "./near.mjs";

const key = keyFromSeed("07".repeat(32));

test("base58 round-trips, leading zeros kept", () => {
  for (const hex of ["00000102", "ff", "0000", "1234567890abcdef"]) assert.equal(b58decode(b58encode(Buffer.from(hex, "hex"))).toString("hex"), hex);
  assert.match(nearPublicKey(key.pub), /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
});

test("action variants and layouts", () => {
  assert.deepEqual([...encodeAction({ type: "CreateAccount" })], [0]);
  const t = encodeAction({ type: "Transfer", deposit: near(0.1) });
  assert.equal(t[0], 3);
  assert.equal(t.length, 17);
  assert.equal(t.readBigUInt64LE(1) + (t.readBigUInt64LE(9) << 64n), 10n ** 23n);
  const full = encodeAction({ type: "AddKey", public_key_hex: key.pub, permission: "FullAccess" });
  assert.equal(full[0], 5);
  assert.equal(full[1], 0, "ed25519 key type");
  assert.equal(full.length, 1 + 33 + 8 + 1);
  assert.equal(full.at(-1), 1, "FullAccess");
  const fc = encodeAction({ type: "AddKey", public_key_hex: key.pub, permission: { allowance: null, receiver_id: "b.testnet", method_names: ["settle_demo"] } });
  assert.equal(fc[42], 0, "FunctionCall permission");
  assert.equal(fc[43], 0, "no allowance");
  const del = encodeAction({ type: "DeleteKey", public_key_hex: key.pub });
  assert.deepEqual([del[0], del[1], del.length], [6, 0, 1 + 33], "DeleteKey: variant 6, ed25519 key");
});

test("a signed transaction verifies over sha256 of its borsh body", () => {
  const tx = { signer_id: "a.testnet", public_key_hex: key.pub, nonce: 5n, receiver_id: "b.testnet", block_hash: Buffer.alloc(32, 1), actions: [{ type: "Transfer", deposit: 1n }] };
  const { signed, hash } = signTransaction(tx, key);
  const body = encodeTransaction(tx);
  assert.equal(signed.subarray(0, body.length).toString("hex"), body.toString("hex"));
  assert.equal(signed[body.length], 0);
  const digest = createHash("sha256").update(body).digest();
  assert.equal(hash, b58encode(digest));
  const spki = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(key.pub, "hex")]), format: "der", type: "spki" });
  assert.ok(verify(null, digest, spki, signed.subarray(body.length + 1)));
});
