import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LEVELS, verifyPublic } from "./rep-eval.mjs";

const pub = JSON.parse(readFileSync(new URL("../fixtures/live/eval/rep-eval.json", import.meta.url), "utf8"));

test("the committed REP Eval run verifies offline: signatures, answers hash, issuer signature, buckets", async () => {
  const lines = await verifyPublic(pub, null);
  assert.equal(lines.length, 3);
  assert.ok(lines.every(([ok]) => ok), lines.map(([, t]) => t).join("; "));
});

test("a tampered TEE signature or a raised score fails", async () => {
  const bad = structuredClone(pub);
  bad.models[0].answers[0].signature = "00".repeat(64);
  assert.equal((await verifyPublic(bad, null))[0][0], false);
  const raised = structuredClone(pub);
  raised.models[0].correct_vector = raised.models[0].correct_vector.map(() => true);
  assert.equal((await verifyPublic(raised, null))[0][0], false);
});

test("every level makes a question with an exact integer answer", () => {
  for (const [k, f] of Object.entries(LEVELS)) {
    const [q, a] = f();
    assert.match(q, /^Compute /, k);
    assert.equal(typeof a, "bigint", k);
  }
});
