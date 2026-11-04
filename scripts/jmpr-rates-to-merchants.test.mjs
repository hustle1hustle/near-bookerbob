import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyRates } from "./jmpr-rates-to-merchants.mjs";

const merchants = JSON.parse(readFileSync(new URL("../agents/merchants.json", import.meta.url)));
// SYNTHETIC samples in the accepted shapes. Not real rates.
const totals = { city: "lisbon", check_in: "2026-11-20", check_out: "2026-11-22", hotels: [{ name: "Sample A", total: "183.4", currency: "USD" }, { name: "Sample B", total: "99", currency: "USD" }] };
const nightly = { currency: "USD", nights: 3, hotels: [{ name: "Sample C", base_nightly: 170, elite_nightly: 197, elite_perks: ["Daily Breakfast"] }, { name: "Sample D", base_nightly: null, elite_nightly: 484, elite_perks: [] }] };
const h = (out, id) => out.find((m) => m.account.startsWith(`${id}.`));

test("stay totals set hotel base prices and keep discount rules", () => {
  const out = applyRates(merchants, totals);
  assert.equal(h(out, "h01").schedule.base_price, "183400000");
  assert.deepEqual(h(out, "h01").schedule.rules, h(merchants, "h01").schedule.rules);
  assert.equal(h(out, "h02").schedule.base_price, "99000000");
  assert.equal(h(out, "m01").schedule.base_price, "48000000");
});

test("nightly rates: base x nights, elite x nights only when there is no base", () => {
  const out = applyRates(merchants, nightly);
  assert.equal(h(out, "h01").schedule.base_price, "510000000");
  assert.match(h(out, "h01").persona, /base 170\/night x 3, incl\. tax/);
  assert.deepEqual(h(out, "h01").perks, ["Daily Breakfast"]);
  assert.equal(h(out, "h02").schedule.base_price, "1452000000");
  assert.match(h(out, "h02").persona, /elite 484\/night x 3, before tax/);
});

test("non-USD prices are refused, no exchange rate is invented", () => {
  assert.throws(() => applyRates(merchants, { ...totals, hotels: [{ name: "X", total: "100", currency: "EUR" }] }), /only USD/);
});
