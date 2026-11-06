import assert from "node:assert/strict";
import { test } from "node:test";
import { clientKey, fieldKey, sealTo } from "./lib/e2ee.mjs";
import { scan } from "./leak-keys.mjs";

const me = clientKey();
const answer = sealTo('{"predicates":["a","b"],"bind":"x"}', me.pubHex);
const reasoning = sealTo("the fact is 7", me.pubHex);
const body = { choices: [{ message: { content: answer, reasoning_content: reasoning } }] };
const key = fieldKey(answer, me.xSecret);

test("a committed client secret opens both fields and is reported", () => {
  const r = scan([{ source: "t", body, response_key: key }], new Map([[me.xSecret.toString("hex"), "HEAD"]]));
  assert.deepEqual(r.exposures.map((e) => e.field).sort(), ["content", "reasoning_content"]);
});

test("the disclosed field key opens its own field only", () => {
  const r = scan([{ source: "t", body, response_key: key }], new Map([[key, "HEAD"]]));
  assert.equal(r.disclosed, 1);
  assert.equal(r.exposures.length, 0);
});

test("a field key reused on the reasoning would be caught", () => {
  const r = scan([{ source: "t", body, response_key: key }], new Map([[fieldKey(reasoning, me.xSecret), "HEAD"]]));
  assert.deepEqual(r.exposures.map((e) => e.field), ["reasoning_content"]);
});

test("an answer naming more than the verdict is reported", () => {
  const r = scan([{ source: "t", body, response_key: key, revealed: ["a"] }], new Map());
  assert.deepEqual(r.extra, [{ source: "t", predicates: ["b"] }]);
  assert.equal(scan([{ source: "t", body, response_key: key, revealed: ["a", "b"] }], new Map()).extra.length, 0);
});

test("L10: the m01 headline price decodes to very few bit sets", async () => {
  const { decodeAmount } = await import("./leak-decode.mjs");
  const s = { base_price: "48000000", rules: [{ predicate: "c", bps: 1000 }, { predicate: "w", bps: 800 }, { predicate: "a", bps: 500 }], cap_bps: 2000, cohort: { predicate: "w", k_min: 5, bps: 500 } };
  const d = decodeAmount(s, "38400000");
  assert.equal(d.of, 8);
  assert.ok(d.sets.length <= 2 && d.sets.some((x) => x.length === 3), JSON.stringify(d.sets));
});

test("L10: a returning discount adds a bit the amount can decode to", async () => {
  const { decodeAmount } = await import("./leak-decode.mjs");
  const s = { base_price: "48000000", rules: [{ predicate: "c", bps: 1000 }], cap_bps: 2000 };
  assert.deepEqual(decodeAmount(s, "41040000", 500).sets, [["c", "returning"]]);
});
