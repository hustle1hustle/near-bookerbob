import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { action, parseAsk, plan } from "./buy.mjs";

const merchants = JSON.parse(readFileSync(new URL("../agents/merchants.json", import.meta.url), "utf8"));
const board = JSON.parse(readFileSync(new URL("../agents/board.json", import.meta.url), "utf8"));

test("a_hotel_ask_never_buys_a_hoodie", () => {
  for (const ask of ["3 nights Lisbon under 450", "hotel in lisbon", "3 nights lisbon under 100", "2 nights Lisbon under 450"]) {
    const p = plan(parseAsk(ask), merchants);
    assert.equal(p.ask.category, "hotel-lisbon");
    assert.ok(p.bids.length === 8 && p.bids.every((b) => /^h0[1-8]\./.test(b.merchant)), ask);
    assert.notEqual(action(p).run, "hoodie-demo", ask);
  }
  const p = plan(parseAsk("3 nights Lisbon under 450"), merchants);
  assert.equal(p.winner.merchant, "h05.bookerbob.testnet");
  assert.equal(p.winner.price, 408);
  assert.deepEqual(action(p), { run: "hotel-demo", merchant: "h05.bookerbob.testnet", why: "live testnet purchase from h05.bookerbob.testnet" });
});

test("a hotel ask with no bid under the budget is refused", () => {
  const p = plan(parseAsk("3 nights Lisbon under 300"), merchants);
  assert.equal(p.outcome, "refused");
  assert.match(p.reason, /no bid fits a budget of 300; the cheapest is h05 at 408.00/);
  assert.equal(action(p).run, null);
});

test("a stay the hotel bids do not cover is refused, not repriced", () => {
  const p = plan(parseAsk("2 nights Lisbon under 450"), merchants);
  assert.equal(p.outcome, "refused");
  assert.match(p.reason, /3-night stay/);
});

test("hotel prices equal the Rust board's for the same revealed bits", () => {
  const rows = board.categories.find((c) => c.category === "hotel-lisbon").rows;
  const p = plan(parseAsk("hotel lisbon"), merchants, undefined, () => board.buyer.cohort_k);
  for (const r of rows) assert.equal(p.bids.find((b) => b.merchant === r.merchant).price, Number(r.price) / 1e6, r.merchant);
});

test("a hoodie ask plans hoodies and runs the live demo only for the demo merchant", () => {
  const p = plan(parseAsk("a hoodie under 40"), merchants);
  assert.ok(p.bids.every((b) => /^m\d\d\./.test(b.merchant)));
  assert.equal(p.winner.merchant, "m01.bookerbob.testnet");
  assert.equal(action(p).run, "hoodie-demo");
  assert.equal(action(plan(parseAsk("a hoodie under 5"), merchants)).run, null);
});
