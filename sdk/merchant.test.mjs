// Cross-checks the JS SDK against the Rust output in agents/board.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { bidCommitment, commitBidArgs, quote, registerArgs, registerCommand, revealBidArgs, schedule, validate } from "./merchant.mjs";

const root = new URL("../", import.meta.url);
const json = (p) => JSON.parse(readFileSync(new URL(p, root)));
const merchants = json("agents/merchants.json");
const board = json("agents/board.json");
const verdict = json("fixtures/verdict-ed25519.json");
const rows = board.categories.flatMap((c) => c.rows);
const salt = (account) => createHash("sha256").update(`bookerbob fixture bid salt v0|${account}`).digest();

test("every merchant config is valid", () => {
  for (const m of merchants) assert.equal(validate(m.schedule), null, m.account);
});

test("bid commitments match the Rust board for all 30 merchants", () => {
  assert.equal(merchants.length, 30);
  for (const m of merchants) {
    const row = rows.find((r) => r.merchant === m.account);
    assert.equal(bidCommitment(m.account, m.schedule, salt(m.account)), row.bid_commitment, m.account);
  }
});

test("quotes match the Rust board, group unlock included", () => {
  const k = (p) => (p === "world_id_human" ? board.buyer.cohort_k : 0);
  for (const m of merchants) {
    const row = rows.find((r) => r.merchant === m.account);
    const q = quote(m.schedule, verdict.envelope.predicates, k);
    assert.equal(q.price.toString(), row.price, m.account);
    assert.equal(q.discount_bps, row.discount_bps, m.account);
  }
});

test("invalid schedules are refused before they reach the chain", () => {
  assert.equal(validate(schedule({ basePrice: 1, capBps: 10001 })), "cap over 100%");
  assert.equal(validate(schedule({ basePrice: 1, capBps: 100, rules: [{ predicate: "marriott_platinum", bps: 1 }] })), "unknown predicate in schedule");
  assert.equal(validate(schedule({ basePrice: 1, capBps: 100, cohort: { predicate: "world_id_human", kMin: 3, bps: 100 } })), "cohort k_min below 5");
  assert.throws(() => registerArgs(schedule({ basePrice: 1, capBps: 0 }), "Bad Category"), /bad category/);
});

test("register command targets testnet and the merchant's own account", () => {
  const cmd = registerCommand({ bazaar: "bookerbob.testnet", merchant: "m31.bookerbob.testnet", s: schedule({ basePrice: 40_000_000, capBps: 1000, rules: [{ predicate: "claude_spender", bps: 1000 }] }), category: "hoodie" });
  assert.match(cmd, /register_merchant/);
  assert.match(cmd, /sign-as m31\.bookerbob\.testnet network-config testnet/);
});

test("commit and reveal args match the on-chain round on the board", () => {
  const m = merchants[0];
  const round = board.rounds.find((r) => r.category === m.category).round;
  const c = commitBidArgs(round, m.account, m.schedule, salt(m.account));
  assert.equal(c.round_id, "swarm-hoodie");
  assert.equal(c.commitment, rows.find((r) => r.merchant === m.account).bid_commitment);
  const r = revealBidArgs(round, m.schedule, salt(m.account));
  assert.equal(r.salt, salt(m.account).toString("hex"));
  assert.equal(JSON.stringify(r.schedule), JSON.stringify(JSON.parse(JSON.stringify(m.schedule))));
});
