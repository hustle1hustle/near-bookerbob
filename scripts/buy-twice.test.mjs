import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { claimInputs, discounted, verifyRun } from "./buy-twice.mjs";

const f = JSON.parse(readFileSync("fixtures/semaphore/returning.json", "utf8"));
const T = 1_793_793_600_000;

test("the live script's scope and message are the ones the contract's fixture proofs carry", () => {
  const c = f.claims[0];
  const q = claimInputs(f.merchant, c.nullifier, T);
  assert.equal(q.epoch, f.epoch);
  assert.equal(BigInt(`0x${q.scope_hex}`).toString(), c.proof.scope);
  assert.equal(BigInt(`0x${q.message_hex}`).toString(), c.proof.message);
});

test("the discount rounds as the contract does", () => {
  assert.equal(discounted(151_200_000, 500), 143_640_000n);
  assert.equal(discounted(3, 500), 3n);
});

const outcome = (logs, failure) => ({ transaction_outcome: { outcome: { logs: [], status: {} } }, receipts_outcome: [{ outcome: { logs, status: failure ? { Failure: {} } : {} } }] });
const ev = (event, data) => `EVENT_JSON:${JSON.stringify({ event, data: [data] })}`;
const out = { bazaar: "b.testnet", tester: "t-000000.x.testnet", nullifier: "ab", bps: 500, receipt_price: "151200000", txs: { claim: "c".repeat(44), settle: "s".repeat(44) } };

test("verify passes a discounted settle and fails one at the receipt price", async () => {
  const run = async (amount) => verifyRun(async () => "Spent", async (h) => (h === out.txs.claim ? outcome([ev("returning_claimed", {})]) : outcome([ev("settled", { amount })])), out);
  assert.ok((await run("143640000")).every(([ok]) => ok));
  assert.equal((await run("151200000")).every(([ok]) => ok), false);
});
