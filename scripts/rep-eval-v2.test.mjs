import { test } from "node:test";
import assert from "node:assert/strict";
import { gradedReply, makeItem, prompt, RULES, TIERS } from "./rep-eval-v2.mjs";

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
