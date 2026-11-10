// node --test scripts/anchor.test.mjs : the anchor's pure parts (no network, no keys).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ARC, GENESIS, SOURCE, apply, calldataWords, canonical, chainOf, checkRecord, closed, compare, decodeLog, emptyState, eventsHash, headHash, keccak256, leaf, packSnapshot, roundRoot, stateHash, tamper, topicOf, unpackSnapshot } from "./anchor.mjs";

const fixture = (name) => new URL(`../fixtures/live/anchor/${name}`, import.meta.url);
const w = (v) => BigInt(v).toString(16).padStart(64, "0");
const addr = (n) => "0x" + n.toString(16).padStart(40, "0");
let counter = 0;
/** A synthetic log: indexed values go to topics, the rest to data, as the EVM lays them out. */
const log = (src, name, indexed, data, { round = 100, extra = [] } = {}) => ({
  block: 1000 + ++counter, ts: round * 300 + (counter % 300), index: counter % 7, tx: "0x" + w(counter), address: ARC.contracts[src],
  topics: [topicOf(src, name), ...indexed.map((v) => "0x" + w(v))], data: "0x" + data.map(w).join(""), extra,
});
const nearOf = (links) => links.map((l) => ({ prev: l.prev, root: l.root, meta: l.meta, head: l.head }));

/** Three rounds of a small market: a context with two members, a payment, a join, a review, a list. */
function market() {
  counter = 0;
  const n = (k) => "0x" + w(0xabc000 + k);
  return [
    log("seeds", "IssuerSet", [2], [0xbeef], { round: 100 }),
    log("semaphore", "GroupCreated", [0], [], { round: 100 }),
    log("seeds", "ContextAdded", [3, 2], [50, 0], { round: 100 }),
    log("semaphore", "MemberAdded", [0], [0, 111, 9001], { round: 100 }),
    log("seeds", "MemberAdded", [3], [111], { round: 100 }),
    log("semaphore", "MemberAdded", [0], [1, 222, 9002], { round: 100 }),
    log("seeds", "MemberAdded", [3], [222], { round: 100 }),
    log("market", "Settled", [100, 0xa1, 0xb1], [1000000, 77], { round: 101 }),
    log("semaphore", "GroupCreated", [1], [], { round: 101 }),
    log("semaphore", "MemberAdded", [1], [0, 333, 9003], { round: 101 }),
    log("market", "ReceiptRegistered", [0xb1, 100], [1], { round: 101 }),
    log("market", "Joined", [0xb1, 3, 100], [], { round: 103, extra: ["0x" + w(333), n(1), n(2), n(3)] }),
    log("market", "JoinClosed", [0xb1, 3, 100], [2, 1], { round: 103 }),
    log("market", "Reviewed", [0xb1, 3, 100], [5], { round: 103, extra: [n(4)] }),
    log("market", "RankSubmitted", [100, 3], [0x1234], { round: 103 }),
  ];
}

test("keccak-256 matches Ethereum's (empty input, an event topic, a multi-block input)", () => {
  assert.equal(keccak256(Buffer.alloc(0)).toString("hex"), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256(Buffer.from("Transfer(address,address,uint256)")).toString("hex"), "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  assert.equal(keccak256(Buffer.alloc(200, 7)).toString("hex"), "4143ef737e81b990c8b604140712d1b0667457ad90b65918a9fa319d00c5b361");
  // The topic of Semaphore's MemberAdded as Arc testnet logs it.
  assert.equal(topicOf("semaphore", "MemberAdded"), "0x19239b3f93cd10558aaf11423af70c77763bf54f52bcc75bfa74d4d13548cde9");
});

test("the head hash is the contract's (the vector in anchor/src/lib.rs)", () => {
  assert.equal(headHash(SOURCE, 0, GENESIS, "01".repeat(32), '{"round":7}'), "2df249c9c8fb11efc86a5dfb251df8503d3289b143bf911ddf5cbb2bee9d812f");
  assert.notEqual(headHash(SOURCE + "x", 0, GENESIS, "01".repeat(32), ""), headHash(SOURCE, 0, GENESIS, "01".repeat(32), "x"), "lengths are under the hash");
});

test("the round root and the log bytes follow the documented layout", () => {
  const l = { block: 5, ts: 1500, index: 2, tx: "0x" + "aa".repeat(32), address: ARC.contracts.market, topics: ["0x" + "bb".repeat(32)], data: "0x0102", extra: ["0x" + "cc".repeat(32)] };
  assert.equal(leaf(l).toString("hex"), "0000000000000005" + "00000000000005dc" + "00000002" + "aa".repeat(32) + ARC.contracts.market.slice(2) + "01" + "bb".repeat(32) + "00000002" + "0102" + "01" + "cc".repeat(32));
  assert.match(eventsHash([l]), /^[0-9a-f]{64}$/);
  assert.notEqual(roundRoot(SOURCE, 5, 1, "00".repeat(32), "11".repeat(32)), roundRoot(SOURCE, 6, 1, "00".repeat(32), "11".repeat(32)));
  assert.equal(canonical({ b: ["2", { z: "1", a: null }], a: "x" }), '{"a":"x","b":["2",{"a":null,"z":"1"}]}');
  assert.throws(() => canonical({ a: 1 }), /decimal strings/);
});

test("logs decode: indexed values, static data, dynamic arrays", () => {
  const d = decodeLog(log("market", "Settled", [9, 0xa1, 0xb1], [1000000, 77]));
  assert.deepEqual([d.src, d.name, d.args.epoch, d.args.payer, d.args.amount, d.args.intentHash], ["market", "Settled", "9", addr(0xa1), "1000000", "0x" + w(77)]);
  // LongList(uint32[] at, uint256[] values): two offsets, then each array as length + items.
  const long = log("market", "LongList", [9, 3], [0x40, 0xa0, 2, 4, 6, 2, 100, 200]);
  assert.deepEqual(decodeLog(long).args, { epoch: "9", contextId: "3", at: ["4", "6"], values: ["100", "200"] });
  const many = log("semaphore", "MembersAdded", [1], [0, 0x60, 9009, 2, 111, 222]);
  assert.deepEqual(decodeLog(many).args, { groupId: "1", startIndex: "0", identityCommitments: ["111", "222"], merkleTreeRoot: "9009" });
  assert.equal(decodeLog({ ...long, topics: ["0x" + "00".repeat(32)] }).name, null);
});

test("nullifiers come out of calldata, direct or through a wrapper, one call or several", () => {
  const proof = (k) => [20, 5000 + k, 7000 + k, 8000 + k, 9000 + k, 1, 2, 3, 4, 5, 6, 7, 8].map(w).join("");
  const selector = (sig) => keccak256(Buffer.from(sig)).subarray(0, 4).toString("hex");
  const P = "(uint256,uint256,uint256,uint256,uint256,uint256[8])";
  const join = selector(`join(address,uint256,uint256,uint256,${P},${P},${P})`) + [0xb1, 3, 100, 0].map(w).join("") + proof(1) + proof(2) + proof(3);
  assert.deepEqual(calldataWords("Joined", "0x" + join), ["0x" + w(8001), "0x" + w(7001), "0x" + w(7002), "0x" + w(7003)]);
  const review = (k) => selector(`review(address,uint256,${P})`) + [0xb1, 3].map(w).join("") + proof(k);
  assert.deepEqual(calldataWords("Reviewed", "0x" + review(4)), ["0x" + w(7004)]);
  // A wrapper: other bytes around two review calls.
  const wrapped = "0x" + "deadbeef" + w(64) + review(4) + w(0) + review(5);
  assert.deepEqual(calldataWords("Reviewed", wrapped, 1), ["0x" + w(7005)]);
  assert.throws(() => calldataWords("Reviewed", "0x" + join), /no review call/);
  assert.deepEqual(calldataWords("Settled", "0x"), []);
});

test("a market replays into groups, members, nullifiers and lists", () => {
  const { links, state, problems } = chainOf(market());
  assert.deepEqual(problems, []);
  assert.deepEqual(links.map((l) => [l.seq, l.round, l.count]), [[0, 100, 7], [1, 101, 4], [2, 103, 4]]);
  assert.deepEqual(state.groups["0"], { members: ["0x" + w(111), "0x" + w(222)], root: "0x" + w(9002) });
  assert.deepEqual(state.contexts["3"], { budget: "50", group: "0", issuer: "2", members: ["0x" + w(111), "0x" + w(222)] });
  assert.equal(state.nullifiers.length, 4);
  assert.deepEqual(state.joins[`${addr(0xb1)}|3|100`], { closed: { group: "2", members: "1" }, joined: "1", unlocked: "0" });
  assert.deepEqual(state.lists["100|3"], { hash: "0x" + w(0x1234), long: null });
  assert.deepEqual(state.paid["100"].settled, { amount: "1000000", count: "1" });
  // The chain: each head is the contract's hash over the previous one.
  assert.equal(links[0].prev, GENESIS);
  links.forEach((l, i) => assert.equal(l.head, headHash(SOURCE, i, i ? links[i - 1].head : GENESIS, l.root, l.meta)));
  assert.equal(links[2].state, stateHash(state));
  assert.equal(JSON.parse(links[1].meta).round, 101);
});

test("the replay names a state the market could not have produced", () => {
  const twice = market();
  twice.push({ ...twice.find((l) => decodeLog(l).name === "Reviewed"), block: 5000 });
  assert.match(chainOf(twice).problems[0].problem, /spent twice/);
  const skipped = market().filter((l) => !(decodeLog(l).src === "semaphore" && decodeLog(l).args.index === "0" && decodeLog(l).args.groupId === "0"));
  assert.match(chainOf(skipped).problems[0].problem, /member index 1, expected 0/);
  // A block whose timestamp falls in an earlier round than the block before it.
  const back = [...market(), log("market", "Settled", [100, 0xa1, 0xb1], [5, 78], { round: 101 })];
  assert.match(chainOf(back).problems.at(-1).problem, /earlier round/);
  const state = emptyState();
  assert.match(apply(state, { ...market()[0], topics: ["0x" + "12".repeat(32)] })[0], /unknown event/);
});

test("rebuild: an honest chain passes round by round", () => {
  const { links } = chainOf(market());
  const res = compare(links, nearOf(links));
  assert.equal(res.firstFail, null);
  assert.equal(res.lines.length, 3);
  assert.ok(res.lines.every((l) => l.startsWith("PASS  round ")));
  // NEAR behind Arc: the anchored rounds pass, the rest is pending.
  assert.deepEqual([compare(links, nearOf(links).slice(0, 2)).firstFail, compare(links, nearOf(links).slice(0, 2)).pending], [null, 1]);
});

test("rebuild: one changed, dropped or added log fails at its round, and every later head with it", () => {
  const honest = chainOf(market()).links;
  for (const round of [100, 101, 103]) {
    const res = compare(chainOf(tamper(market(), round).logs).links, nearOf(honest));
    assert.equal(res.firstFail, round, `one bit in round ${round}`);
    res.lines.forEach((line, i) => assert.equal(line.startsWith("FAIL"), honest[i].round >= round, line));
  }
  const dropped = market().filter((l) => decodeLog(l).name !== "Settled");
  assert.equal(compare(chainOf(dropped).links, nearOf(honest)).firstFail, 101);
  const added = [...market(), { ...log("market", "Settled", [100, 0xa1, 0xb1], [5, 78], { round: 101 }), block: 1011, index: 99 }];
  assert.equal(compare(chainOf(added).links, nearOf(honest)).firstFail, 101);
  // A whole round hidden from the rebuild: the next round sits where NEAR holds the hidden one.
  const hidden = market().filter((l) => Math.floor(l.ts / 300) !== 101);
  const res = compare(chainOf(hidden).links, nearOf(honest));
  assert.equal(res.firstFail, 103);
  assert.match(res.lines[1], /NEAR holds round 101 here/);
});

test("rebuild: a record that was rewritten after the fact does not recompute", () => {
  const { links } = chainOf(market());
  const near = nearOf(links);
  near[1] = { ...near[1], root: "ff".repeat(32) };
  const res = compare(links, near);
  assert.equal(res.firstFail, 101);
  assert.match(res.lines[1], /NEAR's own chain does not recompute/);
  // More rounds on NEAR than the foreign chain has logs for.
  assert.equal(compare(links.slice(0, 2), nearOf(links)).firstFail, "beyond");
});

test("only closed rounds are posted", () => {
  const { links } = chainOf(market());
  assert.deepEqual(closed(links, 103 * 300 + 10).map((l) => l.round), [100, 101]);
  assert.equal(closed(links, 104 * 300).length, 3);
});

test("the committed Arc snapshot rebuilds the committed chain and state", { skip: !existsSync(fixture("arc-logs.json")) }, () => {
  const snapshot = JSON.parse(readFileSync(fixture("arc-logs.json"), "utf8"));
  const chain = JSON.parse(readFileSync(fixture("chain.json"), "utf8"));
  const saved = JSON.parse(readFileSync(fixture("state.json"), "utf8"));
  assert.equal(snapshot.source, SOURCE);
  const got = unpackSnapshot(snapshot);
  assert.deepEqual(packSnapshot(got).logs, snapshot.logs);
  const { links, state, problems } = chainOf(got.logs);
  assert.deepEqual(problems, []);
  assert.deepEqual(links, chain.links);
  assert.equal(links.at(-1).head, chain.head);
  assert.equal(stateHash(state), saved.state_hash);
  assert.deepEqual(state, saved.state);
  assert.equal(compare(links, nearOf(chain.links)).firstFail, null);
  // One bit in any real round is caught at that round.
  for (const l of [links[0], links[links.length >> 1], links.at(-1)]) assert.equal(compare(chainOf(tamper(got.logs, l.round).logs).links, nearOf(chain.links)).firstFail, l.round);
});

test("the live record, when there is one, recomputes from the snapshot", { skip: !existsSync(fixture("run.json")) }, () => {
  const record = JSON.parse(readFileSync(fixture("run.json"), "utf8"));
  for (const [ok, text] of checkRecord(record, JSON.parse(readFileSync(fixture("arc-logs.json"), "utf8")))) assert.ok(ok, text);
});
