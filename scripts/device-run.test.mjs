import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSpend, privacyProblems } from "./device-run.mjs";

const recv = '{"data":[{"total":10000,"status":"paid","created_ts":1790000000,"post_payment_credit_notes_amount":0},{"total":2000,"status":"paid","created_ts":1780000000},{"total":500,"status":"void","created_ts":1795000000}]}';

test("the fact is the latest paid invoice's total in whole USD", () => {
  assert.deepEqual(deriveSpend(recv), { monthly_spend_usd: 100, invoices: 3, latest_ts: 1790000000 });
  assert.throws(() => deriveSpend('{"total":1,"status":"void","created_ts":1}'), /no paid invoice/);
});

test("the privacy scan catches names, emails, tokens and cookies", () => {
  assert.deepEqual(privacyProblems(recv), []);
  assert.ok(privacyProblems('{"email":"a@b.com"}').length >= 1);
  assert.ok(privacyProblems("Cookie: sessionKey=abc").length >= 1);
  assert.ok(privacyProblems("Authorization: Bearer abcdefghijklmnop").length === 1);
  assert.ok(privacyProblems('{"name": "Max"}').length === 1);
});
