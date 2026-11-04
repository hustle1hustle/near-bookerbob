import { test } from "node:test";
import assert from "node:assert/strict";
import { merchantId, openSchedule } from "./join-merchant.mjs";
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
