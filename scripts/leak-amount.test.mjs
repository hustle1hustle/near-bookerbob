import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { amountLeak, bucketAny, bucketCost, bucketedFile, checkBucketed, entropy, merchantChannel, swarmPrior, uniformPrior } from "./leak-amount.mjs";
import { payoutOf, sameAmount } from "./bucketed-buy.mjs";

const m01 = { base_price: "48000000", rules: [{ predicate: "claude_spender", bps: 1000 }, { predicate: "world_id_human", bps: 800 }, { predicate: "airbnb_frequent", bps: 500 }], cap_bps: 2000 };
const swarm = swarmPrior();
const priors = { swarm: () => swarm, uniform: uniformPrior };

test("entropy of a fair coin is 1 bit, of a sure thing 0", () => {
  assert.equal(entropy([0.5, 0.5]), 1);
  assert.equal(entropy([1]), 0);
});

test("m01 exact: every swarm set pays its own price, 2 bits per sale; 3 under the uniform prior", () => {
  assert.equal(amountLeak(m01, swarm).bits_leaked, 2);
  assert.equal(amountLeak(m01, uniformPrior(m01)).bits_leaked, 3);
  assert.equal(amountLeak(m01, swarm).h_bits_given_amount, 0);
});

test("m01 bucketed: one price for the swarm (0 bits), under 1 bit for the uniform prior, revenue kept", () => {
  const b = bucketAny(m01, swarm);
  assert.equal(b.cap_bps, 1475);
  assert.ok(b.rules.every((r) => r.bps === 1475));
  assert.equal(amountLeak(b, swarm).bits_leaked, 0);
  assert.ok(amountLeak(b, uniformPrior(b)).bits_leaked < 1);
  const c = bucketCost(m01, b, swarm);
  assert.equal(c.mean_delta, 0);
  assert.equal(c.worst.delta, 2520000);
  assert.deepEqual(checkBucketed({ of: "m01", design: "any", bound_bits: { swarm: 0, uniform: 1 }, schedule: b }, priors), []);
});

test("an exact schedule flagged bucketed fails its bound", () => {
  const f = checkBucketed({ of: "m01", design: "any", bound_bits: { swarm: 0, uniform: 1 }, schedule: m01 }, priors);
  assert.ok(f.some((x) => /design "any" needs one bps/.test(x)), f.join("; "));
  assert.ok(f.some((x) => /2\.000 bits per sale under the swarm prior, bound 0/.test(x)), f.join("; "));
});

test("a cohort line on a bucketed schedule is refused", () => {
  const b = { ...bucketAny(m01, swarm), cohort: { predicate: "world_id_human", k_min: 5, bps: 500 } };
  assert.match(checkBucketed({ of: "m01", design: "any", bound_bits: {}, schedule: b }, priors)[0], /cohort/);
});

test("the live claim: two or more bit sets, one amount", () => {
  assert.equal(sameAmount([{ paid: "1", revealed: ["a"] }, { paid: "1", revealed: ["a", "b"] }]).ok, true);
  assert.equal(sameAmount([{ paid: "1", revealed: ["a"] }, { paid: "2", revealed: ["a", "b"] }]).ok, false);
  assert.equal(sameAmount([{ paid: "1", revealed: ["a"] }, { paid: "1", revealed: ["a"] }]).ok, false);
});

test("bounds come from the design: a prior with a set holding no priced bit gives bound 1 and a leak above 0", () => {
  const prior = [{ bits: ["world_id_human"], p: 0.5 }, { bits: ["steam_veteran"], p: 0.5 }];
  const f = bucketedFile([{ account: "x.testnet", category: "hoodie", schedule: m01 }], prior);
  const e = f.merchants[0];
  assert.deepEqual(e.bound_bits, { swarm: 1, uniform: 1 });
  const l = amountLeak(e.schedule, prior).bits_leaked;
  assert.ok(l > 0 && l <= 1, String(l));
  assert.deepEqual(checkBucketed(e, { swarm: () => prior, uniform: uniformPrior }), []);
  // A hand-written bound of 0 under that prior fails; a bound above the design's fails too.
  assert.match(checkBucketed({ ...e, bound_bits: { swarm: 0, uniform: 1 } }, { swarm: () => prior })[0], /bound 0/);
  assert.match(checkBucketed({ ...e, bound_bits: { swarm: 2, uniform: 1 } }, {})[0], /above the design's 1/);
});

test("the cohort cost: m01's group price makes the worst set pay 10.25% of base more at k >= 5", () => {
  const c = bucketCost({ ...m01, cohort: { predicate: "world_id_human", k_min: 5, bps: 500 } }, bucketAny(m01, swarm), swarm);
  assert.equal(c.worst_cohort.delta, 4920000);
  assert.equal((100 * c.worst_cohort.delta) / 48000000, 10.25);
});

test("merchant choice: 1.5 bits in hoodie from the merchant name alone, untouched by the bucket", () => {
  const sales = JSON.parse(readFileSync(new URL("../fixtures/live/swarm/s1.json", import.meta.url))).purchases;
  const hoodie = merchantChannel(sales.filter((x) => x.category === "hoodie"));
  assert.equal(hoodie.merchant, 1.5);
  assert.equal(hoodie.merchant_amount, 2);
  const all = merchantChannel(sales);
  assert.equal(all.merchant, 0.75);
  assert.equal(all.amount_given_merchant, 1);
  // Same price for every sale at a merchant: the amount adds nothing given the merchant.
  assert.equal(merchantChannel(sales, () => "1").amount_given_merchant, 0);
});

test("the live check: an empty amount never passes, each amount must be the quote, payout is amount less fee", () => {
  assert.equal(sameAmount([{ paid: "", revealed: ["a"] }, { paid: "", revealed: ["a", "b"] }]).ok, false);
  const b = bucketAny(m01, swarm);
  const two = [{ paid: "40920000", revealed: ["world_id_human"] }, { paid: "40920000", revealed: ["airbnb_frequent", "claude_spender", "world_id_human"] }];
  assert.equal(sameAmount(two, b).ok, true);
  assert.equal(sameAmount(two.map((x) => ({ ...x, paid: "41000000" })), b).ok, false);
  assert.equal(sameAmount([{ paid: "40920000", revealed: [] }, ...two], b).quoted, false);
  assert.equal(payoutOf("40920000", 100), "40510800");
});
