import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { acceptPayment, fetchTx, handlerManifest, orderFields, PaymentError, readPayment, recordPaidOrder, HANDLER_NS } from "../src/near-usdc.mjs";

const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const cfg = { bazaar: "bookerbob.testnet", usdc: USDC };
const fixture = () => JSON.parse(readFileSync(new URL("../fixtures/tx-settled.synthetic.json", import.meta.url)));
const quote = { checkout_ref: "fixture-order-1", merchant: "m01.bookerbob.testnet", amount: "38400000" };

test("settled tx is read and accepted", () => {
  const paid = readPayment(fixture(), cfg);
  assert.equal(paid.amount, 38_400_000n);
  assert.equal(paid.merchant, "m01.bookerbob.testnet");
  assert.equal(acceptPayment(paid, quote), true);
});

test("tx to another contract is refused", () => {
  const t = fixture();
  t.transaction.receiver_id = "evil.testnet";
  assert.throws(() => readPayment(t, cfg), /not sent to the bazaar contract/);
});

test("tx calling another method is refused", () => {
  const t = fixture();
  t.transaction.actions[0].FunctionCall.method_name = "submit_verdict";
  assert.throws(() => readPayment(t, cfg), /does not call settle/);
});

test("settled event logged by another account is ignored", () => {
  const t = fixture();
  t.receipts_outcome[0].outcome.executor_id = "spoof.testnet";
  assert.throws(() => readPayment(t, cfg), /no settled event/);
});

test("failed USDC transfer is refused", () => {
  const t = fixture();
  t.receipts_outcome[1].outcome.status = { Failure: {} };
  assert.throws(() => readPayment(t, cfg), /ft_transfer did not succeed/);
});

test("reverted settle is refused", () => {
  const t = fixture();
  t.receipts_outcome[2].outcome.logs = ['EVENT_JSON:{"standard":"bookerbob","version":"0.1.0","event":"settle_reverted","data":[{}]}'];
  assert.throws(() => readPayment(t, cfg), /reverted/);
});

test("amount, merchant and checkout must match the quote", () => {
  const paid = readPayment(fixture(), cfg);
  assert.throws(() => acceptPayment(paid, { ...quote, amount: "1" }), /amount differs/);
  assert.throws(() => acceptPayment(paid, { ...quote, merchant: "m02.bookerbob.testnet" }), /another merchant/);
  assert.throws(() => acceptPayment(paid, { ...quote, checkout_ref: "other" }), /another checkout/);
});

test("a tx cannot pay two checkouts", () => {
  const paid = readPayment(fixture(), cfg);
  assert.throws(() => acceptPayment(paid, quote, { [paid.tx_hash]: "earlier-checkout" }), PaymentError);
});

test("bad tx hash is refused before any rpc call", async () => {
  await assert.rejects(fetchTx("0xdeadbeef", "a.testnet", { rpc: () => assert.fail("no rpc") }), /base58/);
});

test("order carries near_tx, checkout_ref and the near-usdc tag", async () => {
  const f = orderFields(readPayment(fixture(), cfg), { network: "testnet" });
  assert.match(f.note, /^Paid 38\.400000 USDC on NEAR testnet, tx 9fGx/);
  assert.deepEqual(f.tags, ["near-usdc"]);
  assert.equal(f.customAttributes.find((a) => a.key === "near_tx").value, "9fGx1eTvJ1nEKkuy3sXxF6gsmPvWXWJmUb5HpjB2kQwz");
  assert.equal((await recordPaidOrder([], f)).stub, true);
});

test("manifest names the handler under our namespace", () => {
  const m = handlerManifest({ network: "testnet", bazaar: "bookerbob.testnet", usdc: USDC, merchant: "m01.bookerbob.testnet" });
  assert.equal(m[HANDLER_NS][0].config.network, "near:testnet");
});
