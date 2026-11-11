import { test } from "node:test";
import assert from "node:assert/strict";
import { keyFromFile, merchantId, openSchedule, ownAccount } from "./join-merchant.mjs";
import { b58encode, keyFromSeed } from "../relayer/near.mjs";
import { config } from "./demo-tester.mjs";
import { validate, commitBidArgs } from "../sdk/merchant.mjs";

const c = config({ KEYS_DIR: "/nonexistent" });

test("outside merchants live under the treasury and names are checked", () => {
  assert.equal(merchantId(c, "acme"), "acme.bookerbob-demo.testnet");
  assert.throws(() => merchantId(c, "Acme!"), /name/);
});

test("the open schedule is valid and its sealed bid is deterministic", () => {
  const s = openSchedule(40, 1000);
  assert.equal(validate(s), null);
  assert.equal(s.base_price, "40000000");
  const a = commitBidArgs("o1", "acme.bookerbob-demo.testnet", s, Buffer.alloc(32, 1));
  assert.match(a.commitment, /^[0-9a-f]{64}$/);
  assert.equal(a.commitment, commitBidArgs("o1", "acme.bookerbob-demo.testnet", s, Buffer.alloc(32, 1)).commitment);
});

test("an outsider brings an own account and key: near-cli credentials or a hex seed", () => {
  const seed = "07".repeat(32);
  const k = keyFromSeed(seed);
  const sk = "ed25519:" + b58encode(Buffer.concat([Buffer.from(seed, "hex"), Buffer.from(k.pub, "hex")]));
  assert.equal(keyFromFile(JSON.stringify({ account_id: "x.testnet", private_key: sk })).pub, k.pub);
  assert.equal(keyFromFile(seed + "\n").pub, k.pub);
  assert.throws(() => keyFromFile('{"private_key":"secp256k1:abc"}'), /ed25519/);
  assert.equal(ownAccount({}), null);
  assert.throws(() => ownAccount({ JOIN_ACCOUNT: "x.near", JOIN_KEY_FILE: "/k" }), /testnet/);
  assert.throws(() => ownAccount({ JOIN_ACCOUNT: "x.testnet" }), /JOIN_KEY_FILE/);
});
