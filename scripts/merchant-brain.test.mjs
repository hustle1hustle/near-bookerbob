// The code-side bounds on a model merchant's answer (scripts/merchant-brain.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { clamp, historyFor, priceFor } from "./merchant-brain.mjs";

const SETS = [["airbnb_frequent", "claude_spender", "world_id_human"], ["airbnb_frequent", "booking_genius", "world_id_human"]];

test("priceFor follows the contract: matching bps, capped", () => {
  const s = { base_price: 50_000_000, rules: [{ predicate: "airbnb_frequent", bps: 3000 }, { predicate: "world_id_human", bps: 3000 }], cap_bps: 4000 };
  assert.equal(priceFor(s, SETS[0]), 30_000_000);
  assert.equal(priceFor(s, ["claude_spender"]), 50_000_000);
});

test("a model answer that would sell under cost is clamped up to cost", () => {
  const s = clamp({ base_price: 30, discounts: { airbnb_frequent: 3000, claude_spender: 3000, world_id_human: 3000 }, cap_bps: 9000 }, { cost: 25 }, SETS);
  assert.ok(s.cap_bps <= 4000, "cap at most 40%");
  assert.ok(s.rules.every((r) => r.bps <= 3000), "at most 30% a bit");
  for (const bits of SETS) assert.ok(priceFor(s, bits) >= 25_000_000, `no sale under cost for ${bits}`);
});

test("base price stays within 20 and 80 and junk becomes no discount", () => {
  assert.equal(clamp({ base_price: 500 }, { cost: 10 }, SETS).base_price, 80_000_000);
  assert.equal(clamp({ base_price: 1 }, { cost: 10 }, SETS).base_price, 20_000_000);
  assert.deepEqual(clamp({ base_price: 40, discounts: { airbnb_frequent: "lots", unknown_bit: 500 } }, { cost: 10 }, SETS).rules, []);
});

test("the history a merchant reads is the last two rounds, public fields only", () => {
  const rounds = { 1: { decisions: { "m02.bookerbob.testnet": { schedule: { base_price: 40_000_000, rules: [], cap_bps: 0 } } } }, 2: { decisions: {} }, 3: { decisions: {} } };
  const h = historyFor(4, rounds, [{ round: 3, merchant: "m02.bookerbob.testnet", price: "40000000", predicates: SETS[0] }]);
  assert.deepEqual(h.map((x) => x.round), [2, 3]);
  assert.deepEqual(h[1].sales, [{ winner: "m02", price: 40, buyer_bits: SETS[0] }]);
});

test("a disclosed decision re-derives to its bid, and a changed bid or byte is caught", async () => {
  const { rederive } = await import("./merchant-brain.mjs");
  const { clientKey, fieldKey, sealTo, sha } = await import("./lib/e2ee.mjs");
  const me = clientKey();
  const answer = { base_price: 40, discounts: { airbnb_frequent: 1000, world_id_human: 1000 }, cap_bps: 2000, why: "test" };
  const content = sealTo(JSON.stringify(answer), me.pubHex);
  const req = Buffer.from('{"sealed":"request"}');
  const res = Buffer.from(JSON.stringify({ id: "chat-1", choices: [{ message: { content } }] }));
  const bid = clamp(answer, { cost: 25 }, SETS);
  const d = {
    unit_cost: 25, bit_sets: SETS, signed_text: `m:${sha(req)}:${sha(res)}`,
    request_b64: req.toString("base64"), response_b64: res.toString("base64"), answer_key: fieldKey(content, me.xSecret),
    bid: { base_price: String(bid.base_price), cap_bps: bid.cap_bps, rules: bid.rules },
  };
  assert.equal(rederive(d), null);
  assert.equal(rederive({ ...d, bid: { ...d.bid, base_price: "39000000" } }), "the clamped answer is not the bid");
  assert.equal(rederive({ ...d, response_b64: Buffer.from(res.toString().replace("chat-1", "chat-2")).toString("base64") }), "bytes do not match the signed hashes");
  assert.equal(rederive({ ...d, answer_key: undefined }), "not disclosed");
});
