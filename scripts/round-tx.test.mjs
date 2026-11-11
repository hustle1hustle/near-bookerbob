import { test } from "node:test";
import assert from "node:assert/strict";
import * as web from "../agents/round-tx.js";
import { b58decode, b58encode, encodeTransaction, keyFromSeed, nearPublicKey, signTransaction } from "../relayer/near.mjs";
import { bidCommitment, registerArgs, revealBidArgs, schedule } from "../sdk/merchant.mjs";
import { flatSchedule } from "./community.mjs";

const seed = "0b".repeat(32);
const key = keyFromSeed(seed);

test("the page's key is the key node makes from the same seed", async () => {
  assert.equal(await web.publicKeyHex(seed), key.pub);
  assert.equal(web.nearPublicKey(key.pub), nearPublicKey(key.pub));
  const sk = web.nearSecretKey(seed, key.pub);
  assert.equal(Buffer.from(b58decode(sk.slice(8))).subarray(0, 32).toString("hex"), seed);
  assert.equal(web.b58encode(Uint8Array.of(0, 0, 7, 255)), b58encode(Buffer.from([0, 0, 7, 255])));
  assert.deepEqual([...web.b58decode("11Abc9")], [...b58decode("11Abc9")]);
});

test("the page signs the same transaction bytes and the same hash as the relayer code", async () => {
  const s = flatSchedule(33.5);
  const args = registerArgs(s, "open");
  const block_hash = Buffer.alloc(32, 9);
  const t = { signer_id: "quiet-otter-7.testnet", public_key_hex: key.pub, nonce: 277000000000123n, receiver_id: "bookerbob.testnet", block_hash };
  const node = signTransaction({ ...t, actions: [{ type: "FunctionCall", method_name: "register_merchant", args, gas: 30n * 10n ** 12n, deposit: 20n * 10n ** 21n }, { type: "FunctionCall", method_name: "x", args: {}, gas: 1n, deposit: 0n }] }, key);
  const page = await web.signTransaction({ ...t, block_hash: new Uint8Array(block_hash), actions: [web.call("register_merchant", args, 20n * 10n ** 21n, 30n), { method_name: "x", args: {}, gas: 1n, deposit: 0n }] }, seed);
  assert.equal(Buffer.from(page.signed).toString("hex"), node.signed.toString("hex"));
  assert.equal(page.hash, node.hash);
  assert.equal(Buffer.from(web.encodeTransaction({ ...t, block_hash: new Uint8Array(block_hash), actions: [] })).toString("hex"), encodeTransaction({ ...t, actions: [] }).toString("hex"));
});

test("the page's sealed bid is the SDK's commitment and its schedule is the SDK's", async () => {
  const salt = "5a".repeat(32);
  for (const p of [0.01, 29, 33.5, 10000]) {
    const s = web.flatSchedule(p);
    assert.deepEqual(s, flatSchedule(p));
    assert.deepEqual(s, schedule({ basePrice: Math.round(p * 1e6), rules: [], capBps: 0 }));
    assert.equal(await web.bidCommitment("quiet-otter-7.testnet", s, salt), bidCommitment("quiet-otter-7.testnet", s, Buffer.from(salt, "hex")));
    assert.deepEqual(revealBidArgs("r", s, Buffer.from(salt, "hex")).schedule, s);
  }
  assert.throws(() => web.flatSchedule("0"), /price/);
});
