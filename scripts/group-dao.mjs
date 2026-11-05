#!/usr/bin/env node
// A buying group with its own Sputnik treasury, live on testnet (panel round 3, action 8).
//
//   node scripts/group-dao.mjs run      6 hotel buyers, h05's 10% offer, the DAO, pledges,
//                                       a refund proposal, a release proposal
//
// Six fresh testers, each its own World person with a verdict, post sealed intents for a
// 3-night Lisbon stay and form one group (k counted over distinct persons). h05 offers the
// 10% tier. The relayer account creates `lisbon-g1.sputnikv2.testnet` from the Sputnik factory,
// its council the six members. A member binds the group to that DAO; every member pledges the
// tier price, which stays in the bazaar under the group. One member drops out: a DAO proposal
// refunds it. A direct release from a non-DAO account is refused. A second proposal pays h05
// the five standing pledges in one transfer. Members vote with their own keys. Testnet only.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { config, Demo, guard } from "./demo-tester.mjs";
import { keyFromSeed, near } from "../relayer/near.mjs";

const TGAS = 10n ** 12n;
const MILLI = 10n ** 21n;
const fc = (method_name, args, deposit = 0n, gas = 100n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const FACTORY = "sputnikv2.testnet";
const DAO_NAME = "lisbon-g1";
const DAO = `${DAO_NAME}.${FACTORY}`;
const N = 6;

const c = config(process.env);
const no = guard(c);
if (no) { console.error(`refusing: ${no}`); process.exit(2); }
const statePath = join(c.testersDir, "group-dao-state.json");
const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { dao: DAO, members: [], txs: {} };
const save = () => writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n", { mode: 0o600 });
const d = new Demo(c);
const merchant = `h05.${c.bazaar}`;
const testerKey = (id) => keyFromSeed(readFileSync(join(c.testersDir, id, "account.seed"), "utf8"));

async function vote(id, label, kind) {
  for (const [i, m] of st.members.slice(0, 4).entries()) {
    if (st.txs[`${label}_vote${i + 1}`]) continue;
    // A vote prepays 300 Tgas (0.3 NEAR at the testnet gas price): top the voter up first.
    const bal = BigInt((await d.client.account(m.tester)).amount);
    if (bal < near(0.5)) st.txs[`fund_${m.tester.slice(2, 8)}`] = (await d.direct(`fund voter ${m.tester.split(".")[0]} 0.5 NEAR (testnet)`, c.treasury, d.treasury, m.tester, [{ type: "Transfer", deposit: near(0.5) }])).hash;
    const r = await d.direct(`${m.tester.split(".")[0]} votes approve on ${label} (${i + 1} of 4 needed)`, m.tester, testerKey(m.tester), DAO, [fc("act_proposal", { id, action: "VoteApprove", proposal: kind }, 0n, 300n * TGAS)]);
    st.txs[`${label}_vote${i + 1}`] = r.hash;
    save();
  }
}

async function propose(label, method, args) {
  const kind = { FunctionCall: { receiver_id: c.bazaar, actions: [{ method_name: method, args: Buffer.from(JSON.stringify(args)).toString("base64"), deposit: "0", gas: String(150n * TGAS) }] } };
  if (st[`${label}_id`] != null) return vote(st[`${label}_id`], label, kind);
  const r = await d.direct(`propose ${label}`, c.treasury, d.treasury, DAO, [fc("add_proposal", { proposal: { description: `${label}: ${method} for group ${st.group.slice(0, 12)}`, kind } }, near(1), 50n * TGAS)]);
  st.txs[`${label}_proposal`] = r.hash;
  st[`${label}_id`] = r.value;
  save();
  await vote(r.value, label, kind);
}

async function main() {
  await d.preflight();
  // 1. Six hotel buyers post intents into one group.
  while (st.members.length < N) {
    console.log(`\n=== member ${st.members.length + 1} of ${N}`);
    const rec = await d.hotel(merchant, { group: true, category: "hotel-lisbon" });
    st.members.push({ tester: rec.tester, nullifier: rec.nullifier, receipt_price: String(rec.price), txs: rec.txs });
    st.group = rec.group;
    save();
  }
  const g = await d.client.view(c.bazaar, "buying_group", { group: st.group });
  console.log(`\ngroup ${st.group.slice(0, 12)}..: ${g.members.length} members, ${g.persons} distinct World persons`);
  // 2. h05 offers the 10% tier.
  if (!st.txs.offer) {
    const o = spawnSync("near", ["contract", "call-function", "as-transaction", c.bazaar, "offer_group", "json-args", JSON.stringify({ group: st.group, bps: 1000 }), "prepaid-gas", "50.0 Tgas", "attached-deposit", "0 NEAR", "sign-as", merchant, "network-config", "testnet", "sign-with-keychain", "send"], { encoding: "utf8" });
    st.txs.offer = `${o.stdout}${o.stderr}`.match(/Transaction ID: ([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1];
    if (o.status !== 0) throw new Error(`offer_group: ${(o.stdout + o.stderr).slice(-300)}`);
    save();
  }
  st.offer = (await d.client.view(c.bazaar, "buying_group", { group: st.group })).offer;
  console.log(`   ${merchant} offers ${st.offer[1] / 100}%: ${Number(st.offer[2]) / 1e6} dUSDC per member`);
  // 3. The group's DAO, its council the six members.
  if (!(await d.client.account(DAO))) {
    const args = Buffer.from(JSON.stringify({ config: { name: DAO_NAME, purpose: "Treasury of one BookerBob buying group (3 nights Lisbon, h05): only its proposals release or refund the pot", metadata: "" }, policy: st.members.map((m) => m.tester) })).toString("base64");
    st.txs.dao = (await d.direct(`create DAO ${DAO} (council: the ${N} members)`, c.treasury, d.treasury, FACTORY, [fc("create", { name: DAO_NAME, args }, near(6), 150n * TGAS)])).hash;
    save();
  }
  const pol = await d.client.view(DAO, "get_policy", {});
  console.log(`   DAO council ${pol.roles.find((r) => r.name === "council").kind.Group.length} members, threshold ${pol.default_vote_policy.threshold.join("/")}`);
  // 4. A member binds the group's treasury; 5. every member pledges.
  const m0 = { id: st.members[0].tester, key: testerKey(st.members[0].tester) };
  if (!st.txs.bind) { st.txs.bind = (await d.relay("bind_group_treasury", m0, c.bazaar, fc("bind_group_treasury", { group: st.group, dao: DAO }, 10n * MILLI))).hash; save(); }
  for (const m of st.members) {
    if (m.txs.pledge) continue;
    m.txs.pledge = (await d.relay("pledge_group_demo", { id: m.tester, key: testerKey(m.tester) }, c.bazaar, fc("pledge_group_demo", { nullifier: m.nullifier, checkout_ref: `g1-${m.tester.slice(2, 8)}`, amount: st.offer[2] }, 10n * MILLI, 150n * TGAS))).hash;
    save();
  }
  // 6. Without a proposal: a direct release is refused.
  if (!st.txs.direct_release_refused) {
    st.txs.direct_release_refused = (await d.direct("release_group called directly (not the DAO)", c.treasury, d.treasury, c.bazaar, [fc("release_group", { group: st.group }, 0n, 150n * TGAS)], { expectFail: "only the group's treasury DAO" })).hash;
    save();
  }
  // 7. The last member drops out: proposal one refunds it. 8. Proposal two pays h05.
  st.dropout = st.members.at(-1).tester;
  if (!st.txs.refund_vote4) await propose("refund", "refund_group", { group: st.group, nullifier: st.members.at(-1).nullifier });
  if (!st.txs.release_vote4) await propose("release", "release_group", { group: st.group });
  const t = await d.client.view(c.bazaar, "group_treasury", { group: st.group });
  st.result = { pledged: t.pledged.length, refunded: t.refunded.length, released: t.released };
  save();
  if (!t.released) throw new Error("the release proposal did not release the pot");
  console.log(`\ngroup-dao: PASS  ${t.pledged.length} pledged, ${t.refunded.length} refunded by proposal, the rest released to ${merchant} by proposal`);
}

if (process.argv[2] === "run") main().catch((e) => { console.error(`\ngroup-dao: FAIL ${e.message}`); process.exit(1); });
else { console.error("usage: group-dao.mjs run"); process.exit(2); }
