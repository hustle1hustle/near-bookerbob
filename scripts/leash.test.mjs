import { test } from "node:test";
import assert from "node:assert/strict";
import { LOSER, OVER, mandateHash, mandateMessage, verifyRun } from "./leash.mjs";

const m = { agent: "a.testnet", owner_key: "ab", max_per_purchase: "5", max_total: "7", expires_at_ms: 9, round: null, nonce: 1 };

test("the signed string is the one core/src/mandate.rs builds", () => {
  assert.equal(mandateMessage(m), 'bookerbob/mandate/v1|["a.testnet","ab","5","7",9,null,1]');
});

const failed = (why) => ({ transaction_outcome: { outcome: { logs: [], status: {} } }, receipts_outcome: [{ outcome: { logs: [], status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: why } } } } } } }] });
const settled = (mandate) => ({ transaction_outcome: { outcome: { logs: [], status: {} } }, receipts_outcome: [{ outcome: { logs: [`EVENT_JSON:${JSON.stringify({ event: "settled", data: [{ mandate }] })}`], status: {} } }] });
const out = { bazaar: "b.testnet", tester: "t.testnet", price: "5", mandates: [m], txs: { over_limit: "o".repeat(44), non_winner: "n".repeat(44), settle: "s".repeat(44) } };
const tx = (s) => async (h) => (h === out.txs.over_limit ? failed(OVER) : h === out.txs.non_winner ? failed(LOSER) : s);

test("verify passes the recorded shape and fails a settle that names no mandate", async () => {
  assert.ok((await verifyRun(async () => "5", tx(settled(mandateHash(m))), out)).every(([ok]) => ok));
  assert.equal((await verifyRun(async () => "5", tx(settled(null)), out)).every(([ok]) => ok), false);
});
