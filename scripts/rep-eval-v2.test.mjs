import { test } from "node:test";
import assert from "node:assert/strict";
import { gradedReply, lowerCount, makeItem, prompt, RULES, TIERS, wilson } from "./rep-eval-v2.mjs";

test("a reply cut at the budget is no answer, whatever it ends with", () => {
  assert.equal(gradedReply({ finish: "length", reply: "so the answer is 2" }), "");
  assert.equal(gradedReply({ finish: "stop", reply: "2" }), "2");
});

test("items have the tier's shape and the prompt states every rule the referee applies", () => {
  for (const [t, { facts, claims }] of Object.entries(TIERS)) {
    const it = makeItem(t);
    assert.equal(it.proofs.facts.length, facts);
    assert.equal(it.claims.length, claims);
    const p = prompt(it);
    for (const [, f, m, l] of RULES) assert.ok(p.includes(`${l}: `) && p.includes(`${f} and value >= ${m}`));
    assert.match(p, /Reply with its number, or 0 if every claim holds/);
  }
});

test("the Wilson interval matches a worked value and the certified count sits under the score", () => {
  const [lo, hi] = wilson(96, 120);
  assert.ok(Math.abs(lo - 71.97) < 0.05 && Math.abs(hi - 86.18) < 0.05, `${lo} ${hi}`);
  assert.equal(lowerCount(96, 120), 86);
  assert.ok(wilson(120, 120)[0] < 100);
});
