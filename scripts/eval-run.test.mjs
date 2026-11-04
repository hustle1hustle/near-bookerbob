import { test } from "node:test";
import assert from "node:assert/strict";
import { certificateJson, itemHash, merkleRoot, parseAnswer } from "./eval-run.mjs";

test("the set root commits to every salted item", () => {
  const items = [{ question: "q1", answer: 1, salt: "a" }, { question: "q2", answer: 2, salt: "b" }, { question: "q3", answer: 3, salt: "c" }];
  const r = merkleRoot(items.map(itemHash));
  assert.match(r, /^[0-9a-f]{64}$/);
  items[1].answer = 22;
  assert.notEqual(merkleRoot(items.map(itemHash)), r);
});

test("the answer is the last integer in the reply", () => {
  assert.equal(parseAnswer("Let me think. 37 * 43 = 1591, minus 5 is 1586."), 1586);
  assert.equal(parseAnswer("1,586"), 1586);
  assert.equal(parseAnswer("no idea"), null);
});

test("the certificate JSON has the contract's field order", () => {
  const j = certificateJson({ issued_at_ms: 1, answers_hash: "h", score_bucket: 80, correct: 17, n: 20, set_root: "r", subject: "m", v: 0 });
  assert.equal(j, '{"v":0,"subject":"m","set_root":"r","n":20,"correct":17,"score_bucket":80,"answers_hash":"h","issued_at_ms":1}');
});
