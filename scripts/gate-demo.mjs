#!/usr/bin/env node
// Verdict Gate on testnet (gate.bookerbob.testnet, gate/src/lib.rs): two Sputnik DAOs consume
// BookerBob verdicts as role membership. Each DAO opts in with a proposal of its own
// (`set_rule`); then a buyer from the testnet demo joins with the verdict it already holds.
//
//   node scripts/gate-demo.mjs setup     create the two DAOs (gate role in their policy), set rules
//   node scripts/gate-demo.mjs join      two buyers join; three refusals (another agent's
//                                        verdict, a reused verdict, a missing predicate)
// Testnet only. Council key: KEYS_DIR/dao/ops.seed. State: KEYS_DIR/gate/state.json.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./demo-tester.mjs";
import { keyFromSeed, rpcClient, send } from "../relayer/near.mjs";

const TGAS = 10n ** 12n;
const c = config(process.env);
const client = rpcClient(c.rpc);
const GATE = "gate.bookerbob.testnet";
const OPS = "bookerbob-dao-ops.testnet";
const FACTORY = "sputnikv2.testnet";
export const CONSUMERS = [
  { name: "lisbon-travellers", role: "traveller", predicate: "airbnb_frequent", context: "bookerbob:v0:demo-hoodie", purpose: "Travellers who proved frequent stays, without showing them" },
  { name: "one-human", role: "human", predicate: "world_id_human", context: null, purpose: "One human, one agent: membership for World-bound agents only" },
];
const dir = join(c.keysDir, "gate");
mkdirSync(dir, { recursive: true });
const statePath = join(dir, "state.json");
const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { txs: {} };
const save = () => writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n", { mode: 0o600 });
const ops = keyFromSeed(readFileSync(join(c.keysDir, "dao", "ops.seed"), "utf8"));
const fc = (method_name, args, deposit = 0n, gas = 100n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const link = (h) => `https://testnet.nearblocks.io/txns/${h}`;
const dao = (x) => `${x.name}.${FACTORY}`;

/** A consumer DAO's policy: our ops council, plus a gate role that may only propose and approve AddMemberToRole. */
export function policy(x) {
  return {
    roles: [
      { name: "council", kind: { Group: [OPS] }, permissions: ["*:*"], vote_policy: {} },
      { name: "gate", kind: { Group: [GATE] }, permissions: ["add_member_to_role:AddProposal", "add_member_to_role:VoteApprove"], vote_policy: {} },
      { name: x.role, kind: { Group: [] }, permissions: [], vote_policy: {} },
    ],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
    proposal_bond: "0",
    proposal_period: "604800000000000",
    bounty_bond: "100000000000000000000000",
    bounty_forgiveness_period: "604800000000000",
  };
}

async function tx(label, signer, key, receiver, actions, expectFail) {
  const r = await send(client, { signer_id: signer, key, receiver_id: receiver, actions });
  if (expectFail) {
    const refused = !r.ok && r.error?.includes(expectFail);
    console.log(`   ${refused ? "refused as expected" : "UNEXPECTED"}: ${label} (${expectFail})  ${link(r.hash)}`);
    if (!refused) throw new Error(`${label}: expected "${expectFail}", got ${r.ok ? "success" : r.error}`);
    return r;
  }
  console.log(`   ${r.ok ? "ok" : "FAILED"} ${label}  ${link(r.hash)}`);
  if (!r.ok) throw new Error(`${label}: ${r.error}`);
  return r;
}

async function setup() {
  for (const x of CONSUMERS) {
    if (!(await client.account(dao(x)))) {
      const args = Buffer.from(JSON.stringify({ config: { name: x.name, purpose: x.purpose, metadata: "" }, policy: policy(x) })).toString("base64");
      const o = spawnSync("near", ["contract", "call-function", "as-transaction", FACTORY, "create", "json-args", JSON.stringify({ name: x.name, args }), "prepaid-gas", "150.0 Tgas", "attached-deposit", "6 NEAR", "sign-as", c.bazaar, "network-config", "testnet", "sign-with-keychain", "send"], { encoding: "utf8" });
      const h = `${o.stdout}${o.stderr}`.match(/Transaction ID: ([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1];
      if (!h || !(await client.account(dao(x)))) throw new Error(`create ${dao(x)} failed: ${`${o.stdout}${o.stderr}`.slice(-300)}`);
      st.txs[`create_${x.name}`] = h;
      console.log(`   ok create ${dao(x)} (gate role may only propose and approve AddMemberToRole)  ${link(h)}`);
      save();
    }
    if (!(await client.view(GATE, "rule", { dao: dao(x), role: x.role }))) {
      const inner = Buffer.from(JSON.stringify({ role: x.role, predicate: x.predicate, context: x.context, bond: "0" })).toString("base64");
      const kind = { FunctionCall: { receiver_id: GATE, actions: [{ method_name: "set_rule", args: inner, deposit: "10000000000000000000000", gas: String(30n * TGAS) }] } };
      const p = await tx(`${x.name}: council proposes set_rule(${x.role} <- ${x.predicate})`, OPS, ops, dao(x), [fc("add_proposal", { proposal: { description: `Admit to ${x.role} any agent whose BookerBob verdict reveals ${x.predicate}`, kind } }, 0n, 50n * TGAS)]);
      st.txs[`propose_${x.name}`] = p.hash;
      st.txs[`vote_${x.name}`] = (await tx(`${x.name}: council approves proposal ${p.value}, the DAO calls the gate itself`, OPS, ops, dao(x), [fc("act_proposal", { id: p.value, action: "VoteApprove", proposal: kind }, 0n, 200n * TGAS)])).hash;
      save();
    }
    console.log(`   ${dao(x)}: rule ${JSON.stringify(await client.view(GATE, "rule", { dao: dao(x), role: x.role }))}`);
  }
}

const testerKey = (id) => keyFromSeed(readFileSync(join(c.testersDir, id, "account.seed"), "utf8"));
const roleMembers = async (x) => (await client.view(dao(x), "get_policy", {})).roles.find((r) => r.name === x.role).kind.Group;

async function joinAll() {
  const m = JSON.parse(readFileSync("fixtures/live/testnet-manifest.json", "utf8"));
  // Plain (not sealed) single buyers: their verdicts reveal airbnb_frequent, claude_spender and world_id_human.
  const plain = m.testers.filter((t) => !t.sealed && t.merchant === `m01.${c.bazaar}`);
  const [a, b] = plain;
  const join_ = (who, x, nullifier) => [fc("join", { dao: dao(x), role: x.role, nullifier }, 0n, 290n * TGAS)];
  st.joins = st.joins ?? {};
  // 290 Tgas prepaid costs about 0.29 NEAR up front (most comes back): the treasury tops up.
  const treasury = keyFromSeed(readFileSync(join(c.keysDir, "treasury.seed"), "utf8"));
  const sealedBuyer = m.testers.find((t) => t.sealed && !t.prove_me);
  for (const t of [a, b, sealedBuyer].filter(Boolean)) {
    const bal = BigInt((await client.account(t.tester)).amount);
    if (bal < 450n * 10n ** 21n) st.txs[`fund_${t.tester.split(".")[0]}`] = (await tx(`fund ${t.tester.split(".")[0]} 0.4 NEAR for gas`, c.treasury, treasury, t.tester, [{ type: "Transfer", deposit: 400n * 10n ** 21n }])).hash;
  }
  for (const [t, x] of [[a, CONSUMERS[0]], [b, CONSUMERS[1]]]) {
    if (!(await roleMembers(x)).includes(t.tester)) st.joins[`${x.name}`] = { tester: t.tester, tx: (await tx(`${t.tester.split(".")[0]} joins ${x.name} as ${x.role} with its verdict`, t.tester, testerKey(t.tester), GATE, join_(t.tester, x, t.nullifier))).hash };
    console.log(`   ${dao(x)} ${x.role}: ${(await roleMembers(x)).join(", ")}`);
    save();
  }
  // Refusals: another agent's verdict; the same verdict twice; a role whose predicate it lacks is shown by a sealed verdict.
  const victim = plain[2];
  st.txs.refuse_thief = (await tx(`${b.tester.split(".")[0]} tries ${victim.tester.split(".")[0]}'s unused verdict`, b.tester, testerKey(b.tester), GATE, join_(b.tester, CONSUMERS[0], victim.nullifier), "the verdict belongs to another agent")).hash;
  st.txs.refuse_reuse = (await tx(`${a.tester.split(".")[0]} joins ${CONSUMERS[0].name} again with the same verdict`, a.tester, testerKey(a.tester), GATE, join_(a.tester, CONSUMERS[0], a.nullifier), "already admitted")).hash;
  const sealed = m.testers.find((t) => t.sealed && !t.prove_me);
  if (sealed) st.txs.refuse_sealed = (await tx(`${sealed.tester.split(".")[0]} (sealed verdict) tries ${CONSUMERS[1].name}`, sealed.tester, testerKey(sealed.tester), GATE, join_(sealed.tester, CONSUMERS[1], sealed.nullifier), "a sealed verdict reveals no predicate")).hash;
  save();
  const refusals = { refuse_thief: { tx: st.txs.refuse_thief, signer: b.tester, reason: "the verdict belongs to another agent" }, refuse_reuse: { tx: st.txs.refuse_reuse, signer: a.tester, reason: "this verdict already admitted an agent to this role" }, ...(sealed ? { refuse_sealed: { tx: st.txs.refuse_sealed, signer: sealed.tester, reason: "a sealed verdict reveals no predicate on chain" } } : {}) };
  const pub = { refusals, gate: GATE, bazaar: c.bazaar, consumers: await Promise.all(CONSUMERS.map(async (x) => ({ dao: dao(x), role: x.role, predicate: x.predicate, context: x.context, members: await roleMembers(x) }))), txs: st.txs, joins: st.joins };
  mkdirSync("fixtures/live/gate", { recursive: true });
  writeFileSync("fixtures/live/gate/run.json", JSON.stringify(pub, null, 2) + "\n");
  console.log("\ngate: PASS  fixtures/live/gate/run.json");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  (cmd === "setup" ? setup() : cmd === "join" ? joinAll() : Promise.reject(new Error("usage: gate-demo.mjs setup | join"))).catch((e) => {
    console.error(`gate: FAIL ${e.message}`);
    process.exit(1);
  });
}
