import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { acceptPayment, adminFromEnv, fetchTx, handlerManifest, orderFields, PaymentError, readPayment, recordPaidOrder, HANDLER_NS } from "../src/near-usdc.mjs";

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
  assert.deepEqual(f.tags, ["bookerbob", "near-usdc"]);
  assert.equal(f.customAttributes.find((a) => a.key === "near_tx").value, "9fGx1eTvJ1nEKkuy3sXxF6gsmPvWXWJmUb5HpjB2kQwz");
  assert.equal((await recordPaidOrder([], f)).stub, true);
});

test("manifest names the handler under our namespace", () => {
  const m = handlerManifest({ network: "testnet", bazaar: "bookerbob.testnet", usdc: USDC, merchant: "m01.bookerbob.testnet" });
  assert.equal(m[HANDLER_NS][0].config.network, "near:testnet");
});

// ---------- demo token settle and the Shopify Admin API write ----------

const DUSDC = "bookerbob-dusdc.testnet";
function demoFixture() {
  const t = fixture();
  t.transaction.actions[0].FunctionCall.method_name = "settle_demo";
  for (const o of t.receipts_outcome) {
    o.outcome.logs = o.outcome.logs.map((l) => (l.includes('"event":"settled"') ? l.replace('"checkout_ref":"fixture-order-1"', '"checkout_ref":"fixture-order-1","token":"demo"') : l));
    if (o.outcome.executor_id === USDC) o.outcome.executor_id = DUSDC;
  }
  return t;
}

test("a settle_demo tx is read as dUSDC and labelled as a demo token", () => {
  const paid = readPayment(demoFixture(), { ...cfg, demoToken: DUSDC });
  assert.equal(paid.token, "dUSDC");
  const f = orderFields(paid, { network: "testnet" });
  assert.match(f.note, /dUSDC \(testnet demo token, no value; production uses Circle USDC\)/);
  assert.deepEqual(f.tags, ["bookerbob", "near-dusdc-demo", "testnet"]);
});

test("a settle_demo tx is refused without a demo token, or when the USDC transfer is claimed", () => {
  assert.throws(() => readPayment(demoFixture(), cfg), /no demo token configured/);
  assert.throws(() => readPayment(demoFixture(), { ...cfg, demoToken: "other.testnet" }), /dUSDC ft_transfer did not succeed/);
  const t = fixture();
  t.transaction.actions[0].FunctionCall.method_name = "settle_demo";
  assert.throws(() => readPayment(t, { ...cfg, demoToken: DUSDC }), /does not match the method/);
});

test("recordPaidOrder posts one paid order with the near_tx and never logs the token", async () => {
  const f = orderFields(readPayment(demoFixture(), { ...cfg, demoToken: DUSDC }), { network: "testnet" });
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return { ok: true, status: 201, json: async () => ({ order: { id: 42, name: "#1001", order_number: 1001 } }) };
  };
  const admin = adminFromEnv("SHOPIFY_STORE_DOMAIN=test-store.myshopify.com\nSHOPIFY_ADMIN_ACCESS_TOKEN=shpat_x\nSHOPIFY_ADMIN_API_VERSION=2025-07\n");
  const r = await recordPaidOrder([{ title: "m01 hoodie (BookerBob demo)" }], f, { admin, fetchImpl });
  assert.deepEqual(r, { id: 42, name: "#1001", order_number: 1001, admin_url: "https://test-store.myshopify.com/admin/orders/42" });
  assert.equal(seen.url, "https://test-store.myshopify.com/admin/api/2025-07/orders.json");
  assert.equal(seen.init.headers["X-Shopify-Access-Token"], "shpat_x");
  const o = seen.body.order;
  assert.equal(o.financial_status, "paid");
  assert.equal(o.line_items[0].price, "38.400000");
  assert.equal(o.note_attributes.find((a) => a.name === "near_tx").value, "9fGx1eTvJ1nEKkuy3sXxF6gsmPvWXWJmUb5HpjB2kQwz");
  assert.match(o.tags, /near-dusdc-demo/);
  assert.equal(o.send_receipt, false);
  assert.ok(!JSON.stringify(r).includes("shpat_x"));
});

test("Shopify errors and bad settings are reported, not swallowed", async () => {
  const f = orderFields(readPayment(fixture(), cfg), { network: "testnet" });
  const admin = { domain: "test-store.myshopify.com", token: "t", version: "2025-07" };
  await assert.rejects(recordPaidOrder([{ title: "x" }], f, { admin, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ errors: "forbidden" }) }) }), /403/);
  await assert.rejects(recordPaidOrder([{ title: "x" }], f, { admin: { ...admin, domain: "evil.com" } }), /myshopify\.com/);
  assert.throws(() => adminFromEnv("SHOPIFY_STORE_DOMAIN=x.myshopify.com\n"), /required/);
});
