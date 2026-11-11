import { test } from "node:test";
import assert from "node:assert/strict";
import { CATEGORIES, MEASURED, SETS, txsFromLog, assertPublic, buildRecord, clean, parseArgs, planOf, recordProblems, sampleTxs, slotsFor } from "./swarm-run.mjs";

const hex = (c) => c.repeat(64);
const tx = (c) => c.repeat(44);
const count = (xs, f) => xs.filter(f).length;

/** A private state as `run` keeps it, with the things that must never reach the record. */
function state() {
  return {
    tag: "t1",
    bazaar: "bookerbob.testnet",
    dusdc: "bookerbob-dusdc.testnet",
    treasury_id: "bookerbob-demo.testnet",
    created_ms: 1_800_000_000_000,
    updated_ms: 1_800_000_600_000,
    params: { rounds: 1, buyers: 3, commitMin: 5, revealMin: 5 },
    wall_ms: 600_000,
    near_ai: { calls: 2, failed: 1, usd: 0.0021, prompt_tokens: 900, completion_tokens: 400 },
    treasury: { spent_yocto: String(4n * 10n ** 22n), topups: [] },
    rounds: {
      1: {
        n: 1,
        blind_tag: "t1-r1",
        ready: true,
        seconds: 610,
        cats: {
          hoodie: { round_id: "t1-r1-hoodie", open_tx: tx("A"), commits: 22, reveals: 22, revealed: Array.from({ length: 22 }, (_, i) => `m${i}.bookerbob.testnet`), commit_until_ms: 1, reveal_until_ms: 2 },
          "hotel-lisbon": { round_id: "t1-r1-hotel-lisbon", open_tx: tx("B"), commits: 8, reveals: 8, revealed: Array.from({ length: 8 }, (_, i) => `h${i}.bookerbob.testnet`), commit_until_ms: 1, reveal_until_ms: 2 },
        },
        replay: { nullifier: hex("1"), tx: tx("R") },
      },
    },
    slots: [
      { i: 0, round: 1, category: "hoodie", set: 0, status: "settled", attempts: [{ at: "x", buyer: hex("a") }], rec: { buyer: hex("a"), nullifier: hex("1"), merchant: "m01.bookerbob.testnet", price: "36000000", round_id: "t1-r1-hoodie", model: "z-ai/glm-5.3-flash", chat_id: "c".repeat(32), seconds: 50, dir: "implicit-abcdef", txs: { account: tx("C"), settle: tx("S"), replay: tx("R"), review_join: tx("J") } } },
      { i: 1, round: 1, category: "hotel-lisbon", set: 0, status: "settled", attempts: [{ at: "x" }], rec: { buyer: hex("b"), nullifier: hex("2"), merchant: "h05.bookerbob.testnet", price: "408000000", round_id: "t1-r1-hotel-lisbon", model: "z-ai/glm-5.3-flash", chat_id: "d".repeat(32), seconds: 55, txs: { settle: tx("T") } } },
      { i: 2, round: 1, category: "hoodie", set: 0, status: "failed", attempts: [{ at: "x", buyer: hex("c"), step: "mint (relayed)", error: `read /Users/someone/.rep-secrets/bookerbob-testnet/referee.seed: sender ${hex("c")} refused` }] },
    ],
  };
}

test("arguments: a tag blind-round accepts, whole numbers, known options", () => {
  const a = parseArgs(["run", "pilot1", "--rounds", "1", "--buyers", "6"]);
  assert.deepEqual([a.cmd, a.tag, a.rounds, a.buyers, a.sweep, a.faucet], ["run", "pilot1", 1, 6, true, true]);
  assert.equal(parseArgs(["plan", "x", "--rounds", "2", "--buyers", "9", "--no-sweep", "--no-faucet"]).sweep, false);
  // <tag>-r<nn> must fit blind-round's 24 characters.
  assert.ok(`${"a".repeat(18)}-r99`.length <= 24);
  for (const bad of [["run", "Bad"], ["run", "a".repeat(19)], ["go", "x"], ["run", "x", "--rounds", "0"], ["run", "x", "--rounds", "1.5"], ["run", "x", "--what"], ["run", "x", "--rounds", "3", "--buyers", "2"], ["run", "x", "--rounds", "1", "--buyers", "5", "--sets", "9"]]) assert.throws(() => parseArgs(bad));
});

test("the pilot: one round, 3 hoodie and 3 hotel buyers on one bit set", () => {
  const s = slotsFor({ rounds: 1, buyers: 6 });
  assert.equal(s.length, 6);
  assert.equal(count(s, (x) => x.category === "hoodie"), 3);
  assert.equal(count(s, (x) => x.category === "hotel-lisbon"), 3);
  assert.deepEqual([...new Set(s.map((x) => x.set))], [0]);
});

test("buyers split evenly over rounds and categories, and no bit set has under 5 buyers", () => {
  for (const [rounds, buyers] of [[1, 6], [2, 9], [3, 20], [4, 23], [8, 120], [10, 150], [7, 41], [5, 10], [9, 200]]) {
    const s = slotsFor({ rounds, buyers });
    assert.equal(s.length, buyers);
    assert.deepEqual(s.map((x) => x.i), Array.from({ length: buyers }, (_, i) => i));
    const perRound = Array.from({ length: rounds }, (_, r) => count(s, (x) => x.round === r + 1));
    assert.ok(Math.max(...perRound) - Math.min(...perRound) <= 1, `rounds level for ${rounds}/${buyers}`);
    for (let r = 1; r <= rounds; r++) {
      const [a, b] = CATEGORIES.map((c) => count(s, (x) => x.round === r && x.category === c));
      assert.ok(Math.abs(a - b) <= 1, `categories level in round ${r} of ${rounds}/${buyers}`);
    }
    const sets = [...new Set(s.map((x) => x.set))];
    assert.ok(sets.length <= SETS.length && sets.length >= 1);
    if (sets.length > 1) for (const k of sets) assert.ok(count(s, (x) => x.set === k) >= 5, `set ${k} has at least 5 of ${buyers}`);
  }
  assert.equal(new Set(slotsFor({ rounds: 8, buyers: 120 }).map((x) => x.set)).size, 4);
  assert.equal(new Set(slotsFor({ rounds: 1, buyers: 4, sets: 4 }).map((x) => x.set)).size, 4);
});

test("every bit set is sorted known predicates, each with one claim citing a fact that proves it", () => {
  const RULES = { airbnb_frequent: ["airbnb", "trips_12m", 3], booking_genius: ["booking", "genius_level", 2], claude_spender: ["anthropic", "monthly_spend_usd", 20], github_builder: ["github", "account_age_years", 3], steam_veteran: ["steam", "account_age_years", 5], uber_regular: ["uber", "trips_90d", 10], world_id_human: ["world_id", "verified", 1] };
  assert.equal(new Set(SETS.map((s) => s.name)).size, SETS.length);
  for (const s of SETS) {
    assert.deepEqual(s.predicates, [...s.predicates].sort());
    assert.deepEqual(s.claims.map((c) => c.line).sort(), s.predicates);
    for (const c of s.claims) {
      const [platform, field, min] = RULES[c.line];
      const f = s.facts.find((x) => x.id === c.citations[0].fact);
      assert.deepEqual([f.platform, f.field, f.value >= min, c.citations[0].value], [platform, field, true, f.value]);
    }
    for (const f of s.facts) assert.match(f.proof_ref, /^[0-9a-f]{64}$/);
  }
});

test("planning arithmetic: bids, model calls, NEAR and time", () => {
  const p = planOf({ rounds: 8, buyers: 120, commitMin: 5, revealMin: 5, concurrency: 3 });
  assert.equal(p.sealed_bids, 240);
  assert.equal(p.reveals, 240);
  assert.equal(p.near_ai_calls, 120);
  assert.equal(p.near_ai_usd, Math.round(120 * MEASURED.nearAiUsdPerBuyer * 1e6) / 1e6);
  assert.equal(p.treasury_near, Math.round(120 * MEASURED.nearNetPerBuyer * 1e6) / 1e6);
  assert.equal(planOf({ rounds: 8, buyers: 120, commitMin: 5, revealMin: 5, sweep: false }).treasury_near, Math.round(120 * MEASURED.nearGrossPerBuyer * 1e6) / 1e6);
  assert.deepEqual(p.per_round.map((r) => r.buyers), Array(8).fill(15));
  assert.equal(Object.values(p.bit_sets).reduce((a, b) => a + b, 0), 120);
  // The first buyers cannot start before the first round's reveal deadline.
  const one = planOf({ rounds: 1, buyers: 6, commitMin: 5, revealMin: 5 });
  assert.equal(one.est_minutes, Math.ceil((600 + 6 * MEASURED.buyerSeconds) / 60));
  // Later rounds are prepared while earlier buyers buy: the time is not the plain sum.
  assert.ok(p.est_minutes < (8 * 600 + 120 * MEASURED.buyerSeconds) / 60);
  assert.ok(p.est_minutes >= Math.ceil((600 + 120 * MEASURED.buyerSeconds) / 60));
});

test("the record's shape and totals", () => {
  const rec = buildRecord(state());
  assert.deepEqual(Object.keys(rec), ["note", "tag", "network", "bazaar", "dusdc", "relayer", "explorer", "started_at", "updated_at", "complete", "dusdc_registrations", "stopped", "plan", "rounds", "purchases", "failures", "totals"]);
  assert.deepEqual(rec.totals, {
    merchant_agents: 30,
    buyer_agents: 3,
    rounds: 1,
    sealed_bids: 30,
    reveals: 30,
    model_verdicts: 2,
    purchases_settled: 2,
    dusdc_volume: "444.00",
    refused_replays: 1,
    failures: 1,
    failures_first_pass: 1,
    retried_ok: 0,
    failures_final: 1,
    near_ai_calls: 3,
    near_ai_cost_usd: 0.0021,
    near_ai_cost_basis: "token usage in each answer at the model's listed price",
    treasury_near_spent: 0.04,
    faucet_near: 0,
    wall_time_s: 600,
  });
  assert.deepEqual(Object.keys(rec.purchases[0]), ["round", "round_id", "category", "bit_set", "predicates", "buyer", "nullifier", "merchant", "price", "model", "chat_id", "seconds", "retried", "txs"]);
  assert.deepEqual(rec.rounds[0].categories.map((c) => [c.round_id, c.commits, c.reveals]), [["t1-r1-hoodie", 22, 22], ["t1-r1-hotel-lisbon", 8, 8]]);
  assert.deepEqual(rec.rounds[0].replay, { nullifier: hex("1"), tx: tx("R"), refused: "nullifier spent" });
  // Only the known tx names are copied.
  assert.deepEqual(Object.keys(rec.purchases[0].txs), ["account", "settle", "replay"]);
  assert.deepEqual(recordProblems(rec), []);
  assertPublic(rec);
  const off = structuredClone(rec);
  off.totals.sealed_bids = 31;
  off.purchases[1].nullifier = off.purchases[0].nullifier;
  assert.equal(recordProblems(off).length, 2);
});

test("nothing private reaches the record", () => {
  const st = state();
  // Private things the state holds or could hold.
  st.rounds[1].bids = { "m01.bookerbob.testnet": { salt: hex("5") } };
  st.slots[0].rec.seed = hex("9");
  st.slots[0].rec.facts = SETS[0].facts;
  st.slots[0].rec.txs.secret = hex("8");
  st.treasury.topups.push({ account: "bbswarm-x.testnet", tx: tx("F"), near: 9.95, seed: hex("7") });
  const rec = buildRecord(st);
  const text = JSON.stringify(rec);
  for (const leak of [hex("5"), hex("9"), hex("8"), hex("7"), "implicit-abcdef", "proof_ref", "/Users/", ".rep-secrets", "referee.seed"]) assert.ok(!text.includes(leak), `${leak} is not in the record`);
  // The failed buyer's error keeps its meaning and loses the path and the full account id.
  assert.equal(rec.failures[0].error, `read <keys dir> sender ${"c".repeat(12)}.. refused`);
  assert.equal(rec.failures[0].buyer, hex("c"));
  assertPublic(rec);
});

test("assertPublic refuses a secret-looking field, an unknown field, a stray 32-byte value or a key path", () => {
  const good = () => buildRecord(state());
  const refuse = (change, why) => {
    const r = good();
    change(r);
    assert.throws(() => assertPublic(r), why);
  };
  for (const k of ["seed", "account_seed", "salt", "secret", "private_key", "token", "response_key", "signing_key", "evaluator_sig", "facts", "proofs", "api_key", "key", "dir"]) refuse((r) => (r.purchases[0][k] = "x"), /not a field of the public record/);
  refuse((r) => (r.purchases[0].anything_else = 1), /not a field of the public record/);
  refuse((r) => (r.totals.extra = { seed: "x" }), /not a field of the public record/);
  refuse((r) => (r.purchases[0].txs.seed = tx("Z")), /not a field of the public record/);
  refuse((r) => (r.purchases[0].merchant = hex("e")), /32-byte hex/);
  refuse((r) => (r.purchases[0].chat_id = hex("e")), /32-byte hex/);
  refuse((r) => (r.rounds[0].categories[0].open_tx = hex("e")), /32-byte hex/);
  refuse((r) => (r.failures[0].error = `seed ${hex("e")} leaked`), /looks like a key/);
  refuse((r) => (r.failures[0].error = "read /Users/x/.rep-secrets/near-ai.key"), /looks like a key/);
  refuse((r) => (r.note = "Bearer abc"), /looks like a key/);
  refuse((r) => r.purchases[0].predicates.push("sk-abcdefghijklmnopqrstuv"), /looks like a key/);
  assertPublic(good());
});

test("clean: one short line, no home path, no full 32-byte value", () => {
  const out = clean(`a\n  b ${hex("f")} ${"x".repeat(400)}`);
  assert.ok(out.startsWith(`a b ${"f".repeat(12)}.. `));
  assert.equal(out.length, 240);
  assert.equal(clean(undefined), "");
});

test("verify samples at most 25 txs: every replay, then settles spread over the run", () => {
  const rec = buildRecord(state());
  assert.deepEqual(sampleTxs(rec).map((t) => t.kind), ["replay", "settle", "settle"]);
  const big = structuredClone(rec);
  big.rounds = Array.from({ length: 20 }, (_, i) => ({ ...rec.rounds[0], n: i + 1 }));
  big.purchases = Array.from({ length: 300 }, (_, i) => ({ ...rec.purchases[0], nullifier: String(i).padStart(64, "0"), txs: { settle: `S${i}` } }));
  const s = sampleTxs(big, 25);
  assert.equal(s.length, 25);
  assert.equal(count(s, (t) => t.kind === "replay"), 12);
  const settles = s.filter((t) => t.kind === "settle").map((t) => Number(t.hash.slice(1)));
  assert.equal(new Set(settles).size, 13);
  assert.ok(settles.at(-1) > 250 && settles[0] === 0);
});

test("a buyer that failed and was settled on retry is a purchase marked retried, and both passes show in the totals", () => {
  const st = state();
  const s = st.slots[2];
  s.attempts.push({ at: "y", buyer: hex("c"), resumed: "settle_demo" });
  Object.assign(s, { status: "settled", moved_from: 1, round: 1, rec: { buyer: hex("c"), nullifier: hex("3"), merchant: "m02.bookerbob.testnet", price: "37800000", round_id: "t1-r1-hoodie", model: "z-ai/glm-5.3-flash", chat_id: "e".repeat(32), txs: { settle: tx("U") } } });
  st.registered = [{ merchant: "m02.bookerbob.testnet", tx: tx("G") }];
  const rec = buildRecord(st);
  assert.deepEqual([rec.totals.purchases_settled, rec.totals.failures, rec.totals.failures_first_pass, rec.totals.retried_ok, rec.totals.failures_final, rec.totals.model_verdicts, rec.totals.buyer_agents], [3, 1, 1, 1, 0, 2, 3]);
  assert.deepEqual(rec.purchases.map((p) => p.retried), [false, false, true]);
  assert.equal(rec.purchases[2].first_round, 1);
  assert.equal(rec.failures[0].retried, true);
  assert.deepEqual(rec.dusdc_registrations, [{ merchant: "m02.bookerbob.testnet", tx: tx("G") }]);
  assert.deepEqual(recordProblems(rec), []);
  assertPublic(rec);
});

test("an earlier log gives a failed buyer's txs back, and only its own", () => {
  const h = (c) => c.repeat(44);
  const log = [`[r1 b003 hoodie]    ok mint (relayed)  https://testnet.nearblocks.io/txns/${h("M")}`, `[r1 b003 hoodie]    ok submit_near_ai_verdict (relayed)  https://testnet.nearblocks.io/txns/${h("V")}`, `[r1 b003 hoodie]    FAILED settle_demo (relayed)  https://testnet.nearblocks.io/txns/${h("X")}`, `[r1 b004 hotel]    ok mint (relayed)  https://testnet.nearblocks.io/txns/${h("N")}`, `[r1 b003 hoodie]    ok something else  https://testnet.nearblocks.io/txns/${h("Q")}`].join("\n");
  assert.deepEqual(txsFromLog(log, { i: 2, round: 1, category: "hoodie" }), { mint: h("M"), verdict: h("V") });
  assert.deepEqual(parseArgs(["retry", "s1", "--log", "x.log"]).log, "x.log");
});
