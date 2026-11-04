// Synthetic payments against a fake facilitator. No network, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHandler, requirements } from "./verdict-read.mjs";

const N = "1e".repeat(32);
const req = requirements({ payTo: "bookerbob.testnet" });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const payment = (over = {}) => b64({ x402Version: 2, resource: { url: "x" }, accepted: { ...req, ...over }, payload: { signedDelegateAction: "synthetic" } });

async function start({ valid = true, settles = true, verdict = { record: { tier: "gold" } } } = {}) {
  const calls = [];
  const facilitator = {
    verify: async (p, r) => (calls.push(["verify", p, r]), valid ? { isValid: true, payer: "agent.testnet" } : { isValid: false, invalidReason: "insufficient_funds" }),
    settle: async () => (calls.push(["settle"]), settles ? { success: true, transaction: "SyntheticTx111", network: "near:testnet", payer: "agent.testnet" } : { success: false, errorReason: "expired" }),
  };
  const srv = createServer(createHandler({ facilitator, readVerdict: async (n) => (n === N ? verdict : null), req }));
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { calls, base, close: () => srv.close() };
}

const decode = (h) => JSON.parse(Buffer.from(h, "base64").toString());

test("no payment returns 402 with v2 requirements for USDC on near:testnet", async () => {
  const s = await start();
  try {
    const r = await fetch(`${s.base}/verdict/${N}`);
    assert.equal(r.status, 402);
    const pr = decode(r.headers.get("payment-required"));
    assert.equal(pr.x402Version, 2);
    assert.deepEqual(pr.accepts[0], { scheme: "exact", network: "near:testnet", amount: "10000", asset: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af", payTo: "bookerbob.testnet", maxTimeoutSeconds: 60, extra: {} });
  } finally {
    s.close();
  }
});

test("valid payment is verified, the verdict is read, then settled", async () => {
  const s = await start();
  try {
    const r = await fetch(`${s.base}/verdict/${N}`, { headers: { "PAYMENT-SIGNATURE": payment() } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).record.tier, "gold");
    assert.equal(decode(r.headers.get("payment-response")).transaction, "SyntheticTx111");
    assert.deepEqual(s.calls.map((c) => c[0]), ["verify", "settle"]);
  } finally {
    s.close();
  }
});

test("payment for a smaller amount or another payee is refused before the facilitator", async () => {
  const s = await start();
  try {
    for (const over of [{ amount: "1" }, { payTo: "evil.testnet" }, { network: "near:mainnet" }]) {
      const r = await fetch(`${s.base}/verdict/${N}`, { headers: { "PAYMENT-SIGNATURE": payment(over) } });
      assert.equal(r.status, 402);
    }
    assert.equal(s.calls.length, 0);
  } finally {
    s.close();
  }
});

test("facilitator rejection returns 402 with its reason", async () => {
  const s = await start({ valid: false });
  try {
    const r = await fetch(`${s.base}/verdict/${N}`, { headers: { "PAYMENT-SIGNATURE": payment() } });
    assert.equal(r.status, 402);
    assert.match(decode(r.headers.get("payment-required")).error, /insufficient_funds/);
  } finally {
    s.close();
  }
});

test("the same payment cannot buy two reads", async () => {
  const s = await start();
  try {
    const h = payment();
    assert.equal((await fetch(`${s.base}/verdict/${N}`, { headers: { "PAYMENT-SIGNATURE": h } })).status, 200);
    const again = await fetch(`${s.base}/verdict/${N}`, { headers: { "PAYMENT-SIGNATURE": h } });
    assert.equal(again.status, 402);
    assert.match(decode(again.headers.get("payment-required")).error, /already used/);
  } finally {
    s.close();
  }
});

test("unknown nullifier is a 404 and is not settled", async () => {
  const s = await start();
  try {
    const r = await fetch(`${s.base}/verdict/${"ab".repeat(32)}`, { headers: { "PAYMENT-SIGNATURE": payment() } });
    assert.equal(r.status, 404);
    assert.deepEqual(s.calls.map((c) => c[0]), ["verify"]);
  } finally {
    s.close();
  }
});

test("failed settlement returns 402 and no verdict", async () => {
  const s = await start({ settles: false });
  try {
    const r = await fetch(`${s.base}/verdict/${N}`, { headers: { "PAYMENT-SIGNATURE": payment() } });
    assert.equal(r.status, 402);
  } finally {
    s.close();
  }
});
