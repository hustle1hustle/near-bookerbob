import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BOND, BUDGET, REFUSE_LEAF, REFUSE_LOW, REFUSE_NO_PROOF, config, plan, verifyRun } from "./coalition-live.mjs";

// Raw RPC outcomes: each receipt has an executor; events carry a standard.
const STD = { c: "bookerbob-coalition", ft: "nep141", b: "bookerbob" };
const ev = (std, event, data) => `EVENT_JSON:${JSON.stringify({ standard: STD[std], event, data: [data] })}`;
const rc = (executor_id, logs = [], status = {}) => ({ outcome: { executor_id, logs, status } });
const tx = (args, ...receipts) => ({ transaction: { actions: [{ FunctionCall: { args: Buffer.from(JSON.stringify(args ?? {})).toString("base64") } }] }, transaction_outcome: rc("signer.testnet"), receipts_outcome: receipts });
const TRUE = { SuccessValue: Buffer.from("true").toString("base64") };
const m01 = "m01.b.testnet";
const h05 = "h05.b.testnet";
const lead = "lead.testnet";
const C = "c.testnet";
const B = "b.testnet";
const D = "d.testnet";
const h = (c) => c.repeat(44);
const names = ["join_m01", "join_h05", "stranger_no_proof", "stranger_wrong_leaf", "low_standing", "deliver", "finalize_a", "finalize_b", "hire"];
const signers = { join_m01: m01, join_h05: h05 };
const out = {
  bazaar: B,
  dusdc: D,
  coalition: C,
  members: { m01, h05 },
  lead,
  job_a: 0,
  job_b: 1,
  budget_b: "1000000",
  nullifier: "ab".repeat(32),
  txs: Object.fromEntries(names.map((k, i) => [k, { hash: h(String.fromCharCode(65 + i)), signer: signers[k] ?? "s.testnet" }])),
};
const refusal = (why) => tx(null, rc(C, [ev("c", "join_refused", { job: 1, reason: why })]), rc(D, [ev("ft", "ft_transfer", { memo: "refund", amount: String(BOND) })]));
// m01: bond 5 + budget share 20*48/468 + its part of h05's slashed bond; the lead the rest.
const share = (BUDGET * 48n) / 468n;
const fromSlashed = BOND - BOND / 2n;
const m01Paid = BOND + share + fromSlashed;
const leadPaid = BUDGET + 2n * BOND - m01Paid;
const pay = (to, amount) => ev("ft", "ft_transfer", { old_owner_id: C, new_owner_id: to, amount: String(amount) });
const finA = (m01Amount, executor = C) =>
  tx(
    null,
    rc(executor, [ev("c", "job_finalized", { job: 0, status: "failed", to_buyer: String(leadPaid), slashed: [{ member: h05, bond_lost: String(BOND) }], delivered: [{ member: m01, bond_back: String(BOND), share: String(share), from_slashed: String(fromSlashed) }] })]),
    rc(D, [pay(m01, m01Amount), pay(lead, leadPaid)]),
  );
const outcomes = (finalizeA) => ({
  [out.txs.join_m01.hash]: tx(null, rc(B, [], TRUE), rc(C, [ev("c", "joined", { member: m01, job: 0, leg: 0 })])),
  [out.txs.join_h05.hash]: tx(null, rc(B, [], TRUE), rc(C, [ev("c", "joined", { member: h05, job: 0, leg: 1 })])),
  [out.txs.stranger_no_proof.hash]: refusal(REFUSE_NO_PROOF),
  [out.txs.stranger_wrong_leaf.hash]: refusal(REFUSE_LEAF),
  [out.txs.low_standing.hash]: refusal(`${REFUSE_LOW} 50%`),
  [out.txs.deliver.hash]: tx(null, rc(C, [ev("c", "delivered", { job: 0, leg: 0, member: m01, nullifier: out.nullifier })])),
  [out.txs.finalize_a.hash]: finalizeA,
  [out.txs.finalize_b.hash]: tx(null, rc(C, [ev("c", "job_finalized", { job: 1, status: "failed", to_buyer: "1000000", delivered: [], slashed: [] })])),
  [out.txs.hire.hash]: tx(null, rc(B, [ev("b", "hired", { agent: lead, sub_agent: m01 })])),
});
const view = async (a, m, args) =>
  m === "verdict" ? { spent: true, paid: true, receipt: { merchant: m01, price: "36000000" } } : m === "member" ? (args.account === m01 ? { joined: 1, completed: 1, slashed: 0 } : { joined: 1, completed: 0, slashed: 1 }) : null;

test("verify passes the recorded shape", async () => {
  const o = outcomes(finA(m01Paid));
  const lines = await verifyRun(view, async (hash) => o[hash], out, []);
  assert.equal(lines.length, 10);
  assert.ok(lines.every(([ok]) => ok), lines.filter(([ok]) => !ok).map(([, s]) => s).join("\n"));
});

test("verify fails when the payout does not match the finalize event", async () => {
  const o = outcomes(finA(m01Paid - 1n));
  const lines = await verifyRun(view, async (hash) => o[hash], out, []);
  assert.equal(lines.every(([ok]) => ok), false);
});

test("verify ignores a coalition event logged by another account", async () => {
  const o = outcomes(finA(m01Paid, "fake.testnet"));
  const lines = await verifyRun(view, async (hash) => o[hash], out, []);
  assert.equal(lines.every(([ok]) => ok), false);
});

test("verify asserts the member records exactly", async () => {
  const o = outcomes(finA(m01Paid));
  const loose = async (a, m, args) => (m === "member" ? { joined: 2, completed: 2, slashed: 1 } : view(a, m, args));
  const lines = await verifyRun(loose, async (hash) => o[hash], out, []);
  assert.equal(lines.every(([ok]) => ok), false);
});

test("job D: the v2 split releases an unoffered seat and slashes a no-show", async () => {
  const { splitV2 } = await import("./coalition-live.mjs");
  const w = splitV2(30_000_000n, BOND, [["a", 48_000_000n, "delivered"], ["b", 450_000_000n, "no_show"], ["c", 45_000_000n, "delivered"]]);
  assert.equal(w.buyer + w.pay.a + w.pay.c, 30_000_000n + 3n * BOND);
  const r = splitV2(30_000_000n, BOND, [["a", 40n, "delivered"], ["b", 40n, "released"]]);
  assert.equal(r.pay.b, BOND);
  assert.equal(r.pay.a, BOND + 15_000_000n);
  assert.equal(r.buyer, 15_000_000n);
});

test("the plan names every step and stays on testnet accounts", () => {
  const c = config({});
  assert.deepEqual(plan(c).map(([id]) => id), ["deploy", "accounts", "proofs", "job-a", "join", "job-b", "purchase", "deliver", "finalize", "hire"]);
  for (const a of [c.bazaar, c.treasury, c.dusdc, c.coalition]) assert.ok(a.endsWith(".testnet"));
});

test("job E: the v3 split sends half of a slash to the treasury and none to the deliverers", async () => {
  const { splitV3 } = await import("./coalition-live.mjs");
  const w = splitV3(20_000_000n, BOND, [["m01", 48_000_000n, "delivered"], ["h05", 450_000_000n, "no_show"]]);
  assert.equal(w.pay.m01, BOND + 1_927_710n);
  assert.equal(w.treasury, BOND - BOND / 2n);
  assert.equal(w.buyer + w.pay.m01 + w.treasury, 20_000_000n + 2n * BOND);
});

test("MED3: a settle tx counts only as settle_demo on the bazaar for the recorded nullifier", async () => {
  const { isSettle } = await import("./coalition-live.mjs");
  const relayed = (method, nullifier, receiver = B, sender = "agent.testnet") => ({
    transaction: { signer_id: "relayer.testnet", receiver_id: sender, actions: [{ Delegate: { delegate_action: { sender_id: sender, receiver_id: receiver, actions: [{ FunctionCall: { method_name: method, args: Buffer.from(JSON.stringify({ nullifier })).toString("base64") } }] } } }] },
    transaction_outcome: rc("relayer.testnet"),
    receipts_outcome: [],
  });
  assert.ok(isSettle(relayed("settle_demo", "n1"), B, "n1", "agent.testnet"));
  assert.equal(isSettle(relayed("settle_demo", "n2"), B, "n1", "agent.testnet"), false);
  assert.equal(isSettle(relayed("submit_verdict", "n1"), B, "n1", "agent.testnet"), false);
  assert.equal(isSettle(relayed("settle_demo", "n1", "other.testnet"), B, "n1", "agent.testnet"), false);
  assert.equal(isSettle(relayed("settle_demo", "n1", B, "someone.testnet"), B, "n1", "agent.testnet"), false);
  const direct = { transaction: { signer_id: "agent.testnet", receiver_id: B, actions: [{ FunctionCall: { method_name: "settle_demo", args: Buffer.from(JSON.stringify({ nullifier: "n1" })).toString("base64") } }] }, transaction_outcome: rc("agent.testnet"), receipts_outcome: [rc(B, [], { Failure: { x: 1 } })] };
  assert.equal(isSettle(direct, B, "n1", "agent.testnet"), false, "a failed settle does not count");
});

test("standing proofs: the recorded openings hash to the pinned root, a changed root or path does not", async () => {
  const { opens, LIVE_TREE } = await import("./coalition-live.mjs");
  const st = JSON.parse(readFileSync("fixtures/live/coalition/job-e.json", "utf8"));
  assert.ok(st.openings.length >= 2 && st.openings.every((p) => opens(LIVE_TREE.standing_root, p)));
  const p = st.openings[0];
  assert.equal(opens("4f537c5500d92e78ee0cd7438c4a9a890d60adfe9da6e4dc8bfff05a3ff853ac", p), false);
  assert.equal(opens(LIVE_TREE.standing_root, { ...p, rank: p.rank + 1 }), false);
  assert.equal(opens(LIVE_TREE.standing_root, { ...p, path: p.path.map(([s, l]) => [s, !l]) }), false);
});

test("MED1 tamper: job E with its root swapped and the tree pointed at the job C finalize (hvuk8t1f) fails", async () => {
  const { verifyJobE } = await import("./coalition-live.mjs");
  const st = JSON.parse(readFileSync("fixtures/live/coalition/job-e.json", "utf8"));
  st.standing = ["4f537c5500d92e78ee0cd7438c4a9a890d60adfe9da6e4dc8bfff05a3ff853ac", 3];
  st.live_tree_finalize = "hvuk8t1f5eo9vAV9wGKEBakh8JWhsLpmbv66gU3dUJ1";
  // Every tx answers with job C's graph_scores event (root 4f537c55), as if the record pointed there.
  const gs = { standard: "bookerbob", event: "graph_scores", data: [{ standing_root: st.standing[0], root: "64843eb79acfc008121facd9125ee2c2767ef08962be872dd4dadfbc6c1966d2", proof_sha256: "3016edd8812438f586cc5543a99403d0c4d06e20f8c89ea9fdf41b9942b96c66", merchants: 3 }] };
  const fake = { transaction: { actions: [], receiver_id: B }, transaction_outcome: rc("x.testnet"), receipts_outcome: [rc(B, [`EVENT_JSON:${JSON.stringify(gs)}`])] };
  const lines = await verifyJobE(async () => null, async () => fake, async () => 0, null, st);
  const root = lines.find(([, t]) => t.includes("the joins' root"));
  assert.equal(root[0], false);
  assert.equal(lines.every(([ok]) => ok), false);
});
