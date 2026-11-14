import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { encodeRecord, decodeRecord, epochRoot, head, b58encode, GENESIS, order, chain, epochs } from "./format.mjs";
import { encodePost, decodePost, outcomesOf } from "./anchor.mjs";

const E = 3600n * 10n ** 9n;
const mk = (h, idx, json, r = 7) => encodeRecord({ height: h, ts: 5n * E + 1n, receipt: b58encode(Buffer.alloc(32, r)), index: idx, executor: "a.test", json });

test("the shared vector matches the contract (anchor-open/src/tests.rs)", () => {
  const recs = [mk(100, 0, "{}"), mk(100, 1, '{"x":1}')];
  assert.equal(recs[0].toString("hex"), "0100000000000000640000105ef39b20010707070707070707070707070707070707070707070707070707070707070707000006612e74657374000000027b7d");
  const { events, root } = epochRoot("s", 5, recs);
  assert.equal(events, "ede4c4ace28a90713e9538c2169437a56db939e371df29812d4175abafbccf2f");
  assert.equal(root, "d21237daccafdd75cdc9be0ca26ab1137cab97fc702ec53272e003891a857a25");
  assert.equal(head("p.test", "s", 0, GENESIS, root), "e40b3efb65bdd1dadea051c0a0d7323b3d29729dd297db26b10599097055a4ec");
});

test("a record and a post round-trip", () => {
  const r = mk(9, 3, '{"standard":"x"}');
  const d = decodeRecord(r);
  assert.deepEqual([d.height, d.index, d.executor, d.json], [9, 3, "a.test", '{"standard":"x"}']);
  assert.deepEqual(encodeRecord(d), r);
  const p = { source: "near:testnet:bookerbob", seq: 4, prev: "ab".repeat(32), epoch: 5, records: [r, mk(10, 0, "{}")] };
  assert.deepEqual(decodePost(encodePost(p)), p);
});

test("order is height, receipt bytes, log index", () => {
  const a = { height: 1, receipt: b58encode(Buffer.alloc(32, 9)), index: 0 };
  const b = { height: 2, receipt: b58encode(Buffer.alloc(32, 1)), index: 0 };
  const c = { height: 2, receipt: b58encode(Buffer.alloc(32, 1)), index: 1 };
  assert.deepEqual([c, b, a].sort(order), [a, b, c]);
});

test("outcomes: a slash is an unsatisfied event and earned leaves the bond out", () => {
  const ev = (executor, json) => decodeRecord(encodeRecord({ height: 1, ts: 1n, receipt: b58encode(Buffer.alloc(32, 1)), index: 0, executor, json: JSON.stringify(json) }));
  const c = "coalition.bookerbob-demo.testnet";
  const o = outcomesOf([
    ev(c, { standard: "bookerbob-coalition", event: "joined", data: [{ job: 0, member: "m.t" }] }),
    ev(c, { standard: "bookerbob-coalition", event: "joined", data: [{ job: 0, member: "h.t" }] }),
    ev(c, { standard: "bookerbob-coalition", event: "job_finalized", data: [{ job: 0, delivered: [{ member: "m.t", bond_back: "5", share: "2", from_slashed: "1" }], slashed: [{ member: "h.t", bond_lost: "5" }] }] }),
  ]);
  assert.deepEqual([o.accounts["m.t"].completed, o.accounts["m.t"].earned, o.accounts["h.t"].slashed, o.accounts["h.t"].lost], [1, "3", 1, "5"]);
  assert.deepEqual(o.unsatisfied.map((u) => [u.kind, u.account]), [["slashed", "h.t"]]);
});

test("the committed chain is what the committed txs give", { skip: !existsSync("fixtures/live/econ/txs.json") }, () => {
  const c = JSON.parse(readFileSync("fixtures/live/econ/chain.json", "utf8"));
  const links = chain(c.poster, c.source, epochs(JSON.parse(readFileSync("fixtures/live/econ/txs.json", "utf8")).txs));
  c.links.forEach((l, i) => assert.equal(links[i].head, l.head, `seq ${i}`));
});
