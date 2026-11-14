// The leak checks must catch a leak: each test plants one in a copy of the chain data and
// expects a failing line. Offline, no keys.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyse, isListed } from "./who-sees-what.mjs";
import { openField } from "./lib/e2ee.mjs";

const rec = JSON.parse(readFileSync("fixtures/mainnet/real-refusal.json", "utf8"));
const copy = JSON.parse(readFileSync("fixtures/mainnet/who-sees-what.json", "utf8"));
const proofs = JSON.parse(readFileSync("fixtures/proofs.json", "utf8"));
const capture = readFileSync("fixtures/live/near-ai/request.json", "utf8");
const failing = (lines) => lines.filter(([ok]) => !ok).map(([, , w]) => w);
const withArgs = (c, method, f) => { for (const t of Object.values(c.txs)) for (const a of t.actions) if (a.method === method) { const j = JSON.parse(a.args); f(j); a.args = JSON.stringify(j); } };
const sha = (b) => createHash("sha256").update(b).digest("hex");
const verdictAction = (c) => c.txs.verdict.actions.find((a) => a.method === "submit_near_ai_verdict");

test("the recorded purchase passes every check: 6 checks and the listed rows", () => {
  const lines = analyse(rec, copy, proofs, capture);
  assert.deepEqual(failing(lines), []);
  assert.equal(lines.filter((l) => !isListed(l)).length, 6);
});

test("an envelope whose predicates differ from the opened answer fails", () => {
  // The answer opens with the key on chain; it must name exactly the envelope's predicates.
  const c = structuredClone(copy);
  withArgs(c, "submit_near_ai_verdict", (j) => {
    const plain = openField(JSON.parse(j.proof.response).choices[0].message.content, Buffer.from(j.proof.response_key, "hex"));
    assert.ok(plain.includes("predicates"));
    j.envelope.predicates = ["github_builder"];
  });
  assert.ok(failing(analyse(rec, c, proofs, capture)).some((w) => w.includes("the model's answer")));
});

test("a fact in the referee's result is caught", () => {
  const c = structuredClone(copy);
  withArgs(c, "submit_referee_result", (j) => { j.note = `followers ${rec.facts[2].value}`; });
  assert.ok(failing(analyse(rec, c, proofs, capture)).some((w) => w.includes("FOUND")));
});

test("a fact in the verdict view is caught", () => {
  const c = structuredClone(copy);
  c.views.verdict = { ...c.views.verdict, memo: `"account_age_years":${rec.facts[0].value}` };
  assert.ok(failing(analyse(rec, c, proofs, capture)).some((w) => w.includes("FOUND")));
});

test("a missing referee tx or capture fails instead of passing silently", () => {
  const c = structuredClone(copy);
  delete c.txs.receipt;
  assert.ok(failing(analyse(rec, c, proofs, capture)).some((w) => w.includes("no submit_referee_result")));
  assert.ok(failing(analyse(rec, copy, proofs, null)).some((w) => w.includes("capture is missing")));
});

test("a plaintext message at the gateway is caught even with no fact string in it", () => {
  const req = JSON.parse(capture);
  req.messages[0].content = "you are a verdict model";
  assert.ok(failing(analyse(rec, copy, proofs, JSON.stringify(req))).some((w) => w.includes("NOT all sealed")));
});

test("a fact in a log is caught", () => {
  const c = structuredClone(copy);
  c.txs.settle.logs.push(`EVENT_JSON:{"note":"buyer has \\"public_repos\\":${rec.facts[1].value}"}`.replace(/\\"/g, '"'));
  assert.ok(failing(analyse(rec, c, proofs, capture)).some((w) => w.includes("FOUND")));
});

test("an unblinded proof_hash is brute-forced back to the true facts", () => {
  const c = structuredClone(copy);
  const a = verdictAction(c);
  const j = JSON.parse(a.args);
  const pres = sha(readFileSync(rec.presentation));
  j.envelope.proof_hash = sha(JSON.stringify({ facts: rec.facts.map((f, i) => ({ id: `F${6 + i}`, platform: f.platform, field: f.field, value: f.value, proof_ref: pres })) }));
  a.args = JSON.stringify(j);
  const bad = failing(analyse(rec, c, proofs, capture));
  assert.ok(bad.some((w) => w.includes(`FOUND ${rec.facts.map((f) => f.value).join(",")}`)), bad.join("\n"));
});

test("a plaintext fact in the gateway's request bytes is caught", () => {
  const bad = failing(analyse(rec, copy, proofs, capture.replace('"temperature"', '"trips_12m":7,"temperature"')));
  assert.ok(bad.some((w) => w.includes("trips_12m")));
});

test("plaintext reasoning on chain is caught, even without a field name in it", () => {
  const c = structuredClone(copy);
  withArgs(c, "submit_near_ai_verdict", (j) => {
    const r = JSON.parse(j.proof.response);
    r.choices[0].message.reasoning_content = "the account is two years old so refuse";
    j.proof.response = JSON.stringify(r);
  });
  assert.ok(failing(analyse(rec, c, proofs, capture)).some((w) => w.includes("NOT ciphertext")));
  const d = structuredClone(copy);
  withArgs(d, "submit_near_ai_verdict", (j) => {
    const r = JSON.parse(j.proof.response);
    r.choices[0].message.reasoning_content = Buffer.from("the account is two years old so refuse, the buyer has few repos and followers").toString("hex");
    j.proof.response = JSON.stringify(r);
  });
  assert.ok(failing(analyse(rec, d, proofs, capture)).some((w) => w.includes("NOT ciphertext")));
});

test("hex-encoded plaintext at the gateway and a real fact in the capture are caught", () => {
  const req = JSON.parse(capture);
  req.messages[1].content = Buffer.from("facts: the user has an old github account with many repos and followers, decide").toString("hex");
  assert.ok(failing(analyse(rec, copy, proofs, JSON.stringify(req))).some((w) => w.includes("NOT all sealed")));
  const planted = capture.replace('"temperature"', `"account_age_years":${rec.facts[0].value},"temperature"`);
  assert.ok(failing(analyse(rec, copy, proofs, planted)).some((w) => w.includes("FOUND")));
});

test("the listed rows are all there: 9", () => {
  assert.equal(analyse(rec, copy, proofs, capture).filter(isListed).length, 9);
});

test("a buyer that differs between the two mainnet records fails the account-link row", () => {
  const other = { ...JSON.parse(readFileSync("fixtures/mainnet/buy.json", "utf8")), buyer: "00".repeat(32) };
  assert.ok(failing(analyse(rec, copy, proofs, capture, other)).some((w) => w.includes("RECORDS DISAGREE")));
});
