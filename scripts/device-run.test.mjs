import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveTrips, privacyProblems, withRealUber, FIELD } from "./device-run.mjs";

// The shape of POST https://privacy.uber.com/api/getOrderCount (counts only).
const recv = 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{"status":"success","data":{"rider":{"count":137},"eats":{"count":12}}}';

test("the fact is data.rider.count, parsed from the JSON body only", () => {
  assert.deepEqual(deriveTrips(recv), { trips_lifetime: 137 });
  assert.throws(() => deriveTrips('HTTP/1.1 200 OK\r\n\r\n{"data":{"eats":{"count":9}}}'), /no data.rider.count/);
  assert.throws(() => deriveTrips('HTTP/1.1 200 OK\r\n\r\n{"data":{"rider":{"count":'), /not complete JSON/);
  assert.throws(() => deriveTrips("HTTP/1.1 403 Forbidden\r\n\r\n"), /no JSON body/);
});

test("the real fact replaces F4 under its own field and is never relabelled as trips_90d", () => {
  const proofs = JSON.parse(readFileSync("fixtures/proofs.json", "utf8"));
  const claims = JSON.parse(readFileSync("fixtures/claims-honest.json", "utf8"));
  const r = withRealUber(proofs, claims, 137, "ab".repeat(32));
  const f4 = r.proofs.facts.find((f) => f.id === "F4");
  assert.deepEqual([f4.platform, f4.field, f4.value, f4.proof_ref], ["uber", FIELD, 137, "ab".repeat(32)]);
  assert.ok(!JSON.stringify(r).includes('"trips_90d"'));
  assert.deepEqual(r.claims.at(-1).citations, [{ fact: "F4", field: FIELD, value: 137 }]);
  assert.equal(proofs.facts.find((f) => f.id === "F4").field, "trips_90d", "the fixture itself is untouched");
});

test("the privacy scan catches names, emails, tokens and cookies", () => {
  assert.deepEqual(privacyProblems(recv), []);
  assert.ok(privacyProblems('{"email":"a@b.com"}').length >= 1);
  assert.ok(privacyProblems("Cookie: sessionKey=abc").length >= 1);
  assert.ok(privacyProblems("set-cookie: sid=abc").length >= 1);
  assert.ok(privacyProblems("Authorization: Bearer abcdefghijklmnop").length === 1);
  assert.ok(privacyProblems('{"name": "Max"}').length === 1);
});
