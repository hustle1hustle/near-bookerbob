import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyRates } from "./jmpr-rates-to-merchants.mjs";

const merchants = JSON.parse(readFileSync(new URL("../agents/merchants.json", import.meta.url)));
// SYNTHETIC sample in the shape the capture produces. Not real rates.
const sample = { source: "synthetic test sample", city: "lisbon", check_in: "2026-11-20", check_out: "2026-11-22", hotels: [{ name: "Sample Hotel A", total: "183.4", currency: "USD" }, { name: "Sample Hotel B", total: "99", currency: "USD" }] };

test("rates set hotel base prices and keep discount rules", () => {
  const out = applyRates(merchants, sample);
  const h01 = out.find((m) => m.account.startsWith("h01."));
  const before = merchants.find((m) => m.account.startsWith("h01."));
  assert.equal(h01.schedule.base_price, "183400000");
  assert.deepEqual(h01.schedule.rules, before.schedule.rules);
  assert.equal(out.find((m) => m.account.startsWith("h02.")).schedule.base_price, "99000000");
  assert.equal(out.find((m) => m.account.startsWith("h03.")).schedule.base_price, merchants.find((m) => m.account.startsWith("h03.")).schedule.base_price);
  assert.equal(out.find((m) => m.account.startsWith("m01.")).schedule.base_price, "48000000");
});

test("non-USD totals are refused, no exchange rate is invented", () => {
  assert.throws(() => applyRates(merchants, { ...sample, hotels: [{ name: "X", total: "100", currency: "EUR" }] }), /only USD/);
});
