import { test } from "node:test";
import assert from "node:assert/strict";
import { bindHost, limiter } from "./serve.mjs";
import { parseAsk } from "../sdk/buy.mjs";

test("the relayer server binds localhost unless the founder's go is today's", () => {
  assert.equal(bindHost({}), "127.0.0.1");
  assert.throws(() => bindHost({ RELAYER_PUBLIC: "1" }, "2026-11-12"), /founder/);
  assert.throws(() => bindHost({ RELAYER_PUBLIC: "1", RELAYER_PUBLIC_GO: "2026-11-11" }, "2026-11-12"), /founder/);
  assert.equal(bindHost({ RELAYER_PUBLIC: "1", RELAYER_PUBLIC_GO: "2026-11-12" }, "2026-11-12"), "0.0.0.0");
});

test("one run per client per minute", () => {
  let t = 0;
  const ok = limiter(60_000, () => t);
  assert.equal(ok("a"), true);
  assert.equal(ok("a"), false);
  assert.equal(ok("b"), true);
  t = 60_000;
  assert.equal(ok("a"), true);
});

test("the ask is parsed into a category and a budget", () => {
  assert.deepEqual(parseAsk("2 nights Lisbon under 450"), { category: "hotel-lisbon", budget: 450, nights: 2 });
  assert.equal(parseAsk("a hoodie").category, "hoodie");
  assert.throws(() => parseAsk("a car"), /hotel|hoodie/);
});
