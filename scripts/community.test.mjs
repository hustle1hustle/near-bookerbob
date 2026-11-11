import { test } from "node:test";
import assert from "node:assert/strict";
import { accountName, flatSchedule, roundConfig } from "./community.mjs";
import { commitBidArgs, revealBidArgs, validate } from "../sdk/merchant.mjs";

test("a community price is a flat schedule the contract accepts", () => {
  const s = flatSchedule("33.5");
  assert.equal(validate(s), null);
  assert.deepEqual(s, { base_price: "33500000", rules: [], cap_bps: 0 });
  for (const bad of ["0", "-1", "abc", "10001", undefined]) assert.throws(() => flatSchedule(bad), /price/);
});

test("names become top-level testnet accounts and odd names are refused", () => {
  assert.equal(accountName("quiet-otter-7"), "quiet-otter-7.testnet");
  for (const bad of ["ab", "Has-Caps", "dot.name", "-lead", "trail-", undefined]) assert.throws(() => accountName(bad), /name/);
});

test("the sealed bid hides the price and the same salt opens it", () => {
  const s = flatSchedule(29);
  const salt = Buffer.alloc(32, 7);
  const c = commitBidArgs("r1", "quiet-otter-7.testnet", s, salt);
  assert.match(c.commitment, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(c).includes("29000000"));
  assert.notEqual(c.commitment, commitBidArgs("r1", "quiet-otter-7.testnet", flatSchedule(29.01), salt).commitment);
  assert.equal(revealBidArgs("r1", s, salt).schedule.base_price, "29000000");
});

test("only testnet accounts are accepted", () => {
  assert.throws(() => roundConfig({ BAZAAR_ACCOUNT_ID: "bookerbob.near" }), /testnet/);
  assert.equal(roundConfig({ COMMUNITY_ROUND: "x", BAZAAR_ACCOUNT_ID: "b.testnet", DUSDC_CONTRACT_ID: "d.testnet" }).round, "x");
});
