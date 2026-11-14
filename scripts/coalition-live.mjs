#!/usr/bin/env node
// Coalitions on testnet (docs/coalitions.md): merchant agents admitted to a multi-leg job by
// their proven standing on the bazaar, held together by dUSDC bonds.
//
//   node scripts/coalition-live.mjs plan     the steps; reads and sends nothing
//   node scripts/coalition-live.mjs run      resumable: each step is skipped once recorded
//   node scripts/coalition-live.mjs verify   keyless: re-reads every recorded tx and view over public RPC
//
// What runs: the coalition contract (coalition/) is deployed to coalition.<treasury>, pointing at
// the bazaar. A lead opens job A (a hoodie leg and a hotel leg) and escrows its budget. m01 and h05,
// the two merchants in the bazaar's proven standing tree, join with their openings and post bonds;
// a stranger is refused twice (no proof; m01's proof from another account) and refunded. Job B
// asks for the top 50%: h05 (rank 2 of 2) is refused by the bazaar's in_top and refunded. A demo
// tester buys from m01 through the normal purchase path; m01 shows that purchase as its delivery.
// h05 does not deliver. After the deadline anyone finalizes: m01 gets its bond and its share of
// the budget, h05's bond is split between the lead and m01. The lead then hires m01 on the bazaar,
// so the completed job enters the graph.
//
// Testnet only. Our accounts sign with seeds in KEYS_DIR/coalition (outside the repo); m01 and h05
// sign with the near-cli keychain. Only public data is printed and recorded.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OUT = "fixtures/live/coalition/run.json";
export const REFUSE_NO_PROOF = "no standing proof";
export const REFUSE_LEAF = "the proof's leaf is not the sender";
export const REFUSE_LOW = "not in the top of the proven standing";
export const BOND = 5_000_000n;
export const BUDGET = 20_000_000n;
const TGAS = 10n ** 12n;
const MILLI = 10n ** 21n;
const fc = (method_name, args, deposit = 0n, gas = 100n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const link = (h) => `https://testnet.nearblocks.io/txns/${h}`;

/** The steps, in order (pure: the plan and the test). */
export function plan(c) {
  return [
    ["deploy", `create ${c.coalition}, deploy coalition/ (target/near/bookerbob_coalition.wasm), new(token ${c.dusdc}, bazaar ${c.bazaar}), register it with dUSDC`],
    ["accounts", "create a lead and a stranger account (treasury pays), register both with dUSDC, mint dUSDC"],
    ["proofs", "rebuild m01's and h05's openings from the public graph events; check the root equals the bazaar's standing_root"],
    ["job-a", `lead: open_job A (hoodie leg max 48, hotel leg max 450; bond ${Number(BOND) / 1e6}, budget ${Number(BUDGET) / 1e6} dUSDC, top 100%), fund it`],
    ["join", "m01 joins the hoodie leg, h05 the hotel leg: bond by ft_transfer_call with the opening; the coalition asks the bazaar in_top"],
    ["job-b", "lead: open_job B (one hotel leg, top 50%), fund it; a stranger joins its free leg with no proof, then with m01's proof; h05 joins: the bazaar's in_top says no. Each refused, each bond refunded"],
    ["purchase", "a demo tester buys from m01: verdict, referee receipt, escrow, settle_demo"],
    ["deliver", "m01: deliver(A, hoodie, the tester's nullifier): the coalition reads the bazaar's verdict record"],
    ["finalize", "after the deadline, anyone: finalize A (m01 paid, h05 slashed) and B (no member, budget back)"],
    ["hire", "the lead hires m01 on the bazaar: a Hire event in the graph"],
  ];
}

/** Every NEP-297 event in a raw tx outcome (all receipts, any executor). */
export const events = (t) =>
  [t.transaction_outcome, ...t.receipts_outcome]
    .flatMap((o) => o.outcome.logs)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice(11)));
const failure = (t) => JSON.stringify([t.transaction_outcome, ...t.receipts_outcome].map((o) => o.outcome.status.Failure).find(Boolean) ?? "");

export const STANDARD = "bookerbob-coalition";
const outcomesOf = (t) => [t.transaction_outcome, ...t.receipts_outcome];
/** The events `executor` logged under `standard`: a log from any other account does not count. */
export const eventsOf = (t, executor, standard) =>
  outcomesOf(t)
    .filter((o) => o.outcome.executor_id === executor)
    .flatMap((o) => o.outcome.logs)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => {
      try {
        return JSON.parse(l.slice(11));
      } catch {
        return null;
      }
    })
    .filter((e) => e?.standard === standard);
const kind = (t, executor, standard, name) => eventsOf(t, executor, standard).filter((e) => e.event === name).map((e) => e.data?.[0]);
/** The coalition's own events, the token's NEP-141 transfers, the bazaar's events. */
export const coal = (t, coalition, name) => kind(t, coalition, STANDARD, name);
export const fts = (t, token) => kind(t, token, "nep141", "ft_transfer");
export const baz = (t, bazaar, name) => kind(t, bazaar, "bookerbob", name);
/** The first action's call arguments, as JSON. */
export const callArgs = (t) => {
  const f = t.transaction?.actions?.[0]?.FunctionCall;
  try {
    return f ? JSON.parse(Buffer.from(f.args, "base64").toString()) : null;
  } catch {
    return null;
  }
};
/** A receipt run by `executor` that returned `true` (the bazaar's in_top answer). */
export const returnedTrue = (t, executor) => outcomesOf(t).some((o) => o.outcome.executor_id === executor && o.outcome.status?.SuccessValue === Buffer.from("true").toString("base64"));
/** The join message a member sent in its ft_transfer_call. */
export const joinMsg = (t) => {
  try {
    return JSON.parse(callArgs(t)?.msg ?? "null")?.join ?? null;
  } catch {
    return null;
  }
};

/** The relayed settle inside a demo purchase's settle tx: the inner delegate action. */
export const settleOf = (t) => {
  const direct = t?.transaction?.actions?.[0]?.FunctionCall;
  const d = direct ? { receiver_id: t.transaction.receiver_id, sender_id: t.transaction.signer_id, actions: [{ FunctionCall: direct }] } : t?.transaction?.actions?.[0]?.Delegate?.delegate_action;
  const f = d?.actions?.[0]?.FunctionCall;
  let args = null;
  try {
    args = f ? JSON.parse(Buffer.from(f.args, "base64").toString()) : null;
  } catch {
    args = null;
  }
  return { receiver: d?.receiver_id, sender: d?.sender_id, method: f?.method_name, args, ok: failure(t) === '""' };
};
/** A settle tx is settle_demo on `bazaar`, sent by `agent` (when given), for `nullifier`, and succeeded. */
export const isSettle = (t, bazaar, nullifier, agent) => {
  const x = settleOf(t);
  return x.ok && x.receiver === bazaar && x.method === "settle_demo" && x.args?.nullifier === nullifier && (!agent || x.sender === agent);
};
/** An account's code hash (base58 sha256) as hex, from view_account. */
export const codeHex = async (b58) => Buffer.from((await import("../relayer/near.mjs")).b58decode(b58)).toString("hex");

/** Per member: how many times a finalize event (on `coalition`) paid, slashed or released it. */
export function tally(finals, coalition) {
  const n = {};
  const bump = (m, k) => ((n[m] ??= { joined: 0, completed: 0, slashed: 0, released: 0 })[k]++, n[m].joined++);
  for (const t of finals) {
    const f = coal(t, coalition, "job_finalized")[0];
    for (const d of f?.delivered ?? []) bump(d.member, "completed");
    for (const d of f?.slashed ?? []) bump(d.member, "slashed");
    for (const d of f?.released ?? []) bump(d.member, "released");
  }
  return n;
}

/** Public check. `tx(hash, sender)` returns the raw RPC outcome; `view(account, method, args)`. */
export async function verifyRun(view, tx, out = JSON.parse(readFileSync(OUT, "utf8")), extraFinals = existsSync(JOBC) ? [JSON.parse(readFileSync(JOBC, "utf8")).txs?.finalize].filter(Boolean) : []) {
  const lines = [];
  const T = async (name) => tx(out.txs[name].hash, out.txs[name].signer);
  const ev = async (name, k) => coal(await T(name), out.coalition, k);
  const [m01, h05] = [out.members.m01, out.members.h05];
  for (const [name, m, leg] of [["join_m01", m01, 0], ["join_h05", h05, 1]]) {
    const t = await T(name);
    const j = coal(t, out.coalition, "joined")[0];
    lines.push([j?.member === m && j?.job === out.job_a && j?.leg === leg && returnedTrue(t, out.bazaar) && out.txs[name].signer === m, `${m.split(".")[0]} admitted to job ${out.job_a} by the bazaar's in_top, bond posted (${out.txs[name].hash.slice(0, 8)}..)`]);
  }
  for (const [name, why] of [["stranger_no_proof", REFUSE_NO_PROOF], ["stranger_wrong_leaf", REFUSE_LEAF], ["low_standing", REFUSE_LOW]]) {
    const t = await T(name);
    const r = coal(t, out.coalition, "join_refused")[0];
    const refund = fts(t, out.dusdc).find((e) => e.memo === "refund");
    lines.push([r?.job === out.job_b && String(r?.reason).includes(why) && refund?.amount === String(BOND) && failure(t) === '""', `refused on chain: ${why}; bond of ${Number(BOND) / 1e6} refunded (${out.txs[name].hash.slice(0, 8)}..)`]);
  }
  if (out.txs.leg_taken) {
    const r = (await ev("leg_taken", "join_refused"))[0];
    lines.push([r?.reason === "leg taken", `a join on a leg already held is refused: leg taken (${out.txs.leg_taken.hash.slice(0, 8)}..)`]);
  }
  const d = (await ev("deliver", "delivered"))[0];
  const v = await view(out.bazaar, "verdict", { nullifier: out.nullifier });
  lines.push([d?.job === out.job_a && d?.leg === 0 && d?.member === m01 && d?.nullifier === out.nullifier && v?.spent && v?.paid && v?.receipt?.merchant === m01, `m01 delivered with a spent bazaar purchase whose receipt names it (${Number(v?.receipt?.price) / 1e6} dUSDC, nullifier ${out.nullifier.slice(0, 10)}..)`]);
  const fin = await T("finalize_a");
  const f = coal(fin, out.coalition, "job_finalized")[0];
  const pays = fts(fin, out.dusdc).filter((p) => p.old_owner_id === undefined || p.old_owner_id === out.coalition);
  const paid = (to) => pays.filter((p) => p.new_owner_id === to).reduce((s, p) => s + BigInt(p.amount), 0n);
  const mine = f?.delivered?.[0];
  const ok = f?.job === out.job_a && f?.status === "failed" && f.slashed?.length === 1 && f.slashed[0].member === h05 && f.delivered?.length === 1 && mine?.member === m01 && paid(m01) === BigInt(mine.bond_back) + BigInt(mine.share) + BigInt(mine.from_slashed) && paid(out.lead) === BigInt(f.to_buyer) && paid(m01) + paid(out.lead) === BUDGET + 2n * BOND;
  lines.push([ok, `finalize: h05 slashed ${Number(BOND) / 1e6}; m01 paid ${Number(paid(m01)) / 1e6} (bond ${Number(mine?.bond_back) / 1e6}, budget share ${Number(mine?.share) / 1e6}, from the slashed bond ${Number(mine?.from_slashed) / 1e6}); the lead ${Number(paid(out.lead)) / 1e6}; sums to budget plus both bonds`]);
  const fb = (await ev("finalize_b", "job_finalized"))[0];
  lines.push([fb?.job === out.job_b && fb?.status === "failed" && fb?.to_buyer === out.budget_b && !fb?.delivered?.length && !fb?.slashed?.length, `job ${out.job_b}: no member admitted, the budget of ${Number(out.budget_b) / 1e6} back to the lead`]);
  // Exact member records: what every finalize on this account (A, B, and C when recorded) says.
  const finals = [fin, await T("finalize_b"), ...(await Promise.all(extraFinals.map((x) => tx(x.hash, x.signer))))];
  const want = tally(finals, out.coalition);
  const names = Object.keys(want);
  const got = await Promise.all(names.map((a) => view(out.coalition, "member", { account: a })));
  const exact = names.length > 0 && names.every((a, i) => got[i]?.completed === want[a].completed && got[i]?.slashed === want[a].slashed && got[i]?.joined === want[a].joined);
  lines.push([exact, `member records equal the ${finals.length} finalize events exactly: ${names.map((a, i) => `${a.split(".")[0]} joined ${got[i]?.joined}, completed ${got[i]?.completed}, slashed ${got[i]?.slashed}`).join("; ")}`]);
  const h = baz(await T("hire"), out.bazaar, "hired")[0];
  lines.push([h?.agent === out.lead && h?.sub_agent === m01, `the lead hired m01 on the bazaar: a Hire edge in the graph (${out.txs.hire.hash.slice(0, 8)}..)`]);
  return lines;
}

function nearCli(signer, receiver, method, args, deposit = "0 NEAR", gas = "100.0 Tgas") {
  // The CLI's testnet connections (its config.toml): a rate-limited one is swapped for the next.
  const nets = (process.env.NEAR_CLI_NETWORKS ?? "testnet,testnet-fastnear,testnet-lava").split(",");
  for (let i = 0; i < 10; i++) {
    const r = spawnSync("near", ["contract", "call-function", "as-transaction", receiver, method, "json-args", JSON.stringify(args), "prepaid-gas", gas, "attached-deposit", deposit, "sign-as", signer, "network-config", nets[i % nets.length], "sign-with-keychain", "send"], { encoding: "utf8" });
    const out = `${r.stdout}${r.stderr}`;
    const hash = out.match(/Transaction ID: ([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1];
    if (r.status === 0 && hash) return { ok: true, hash };
    if (/nonce|Failed to fetch access key|Too Many Requests|429|timeout|rate limit/i.test(out)) {
      // The CLI's default testnet RPC rate-limits: back off and try again.
      spawnSync("node", ["-e", `setTimeout(()=>{},${3000 * (i + 1)})`]);
      continue;
    }
    return { ok: false, hash, error: out.match(/Smart contract panicked: [^\n"]*/)?.[0] ?? out.slice(-400) };
  }
  return { ok: false, error: "retries exhausted" };
}

async function run(c) {
  const { keyFromSeed, rpcClient, send, near, nearPublicKey } = await import("../relayer/near.mjs");
  const client = rpcClient(c.rpc);
  const dir = join(c.keysDir, "coalition");
  mkdirSync(dir, { recursive: true });
  mkdirSync("fixtures/live/coalition", { recursive: true });
  const out = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { bazaar: c.bazaar, dusdc: c.dusdc, coalition: c.coalition, members: { m01: `m01.${c.bazaar}`, h05: `h05.${c.bazaar}` }, txs: {}, balances: {} };
  const save = () => writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  const treasury = keyFromSeed(readFileSync(join(c.keysDir, "treasury.seed"), "utf8"));
  const seedOf = (id) => {
    const p = join(dir, `${id}.seed`);
    if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    return keyFromSeed(readFileSync(p, "utf8"));
  };
  const record = (name, signer, r) => {
    console.log(`   ${r.ok ? "ok" : "FAILED"} ${name}  ${r.hash ? link(r.hash) : ""}${r.ok ? "" : `\n   ${r.error}`}`);
    if (!r.ok) throw new Error(`${name}: ${r.error}`);
    out.txs[name] = { hash: r.hash, signer };
    save();
    return r;
  };
  const sendAs = async (name, id, key, receiver_id, actions) => record(name, id, await send(client, { signer_id: id, key, receiver_id, actions }));
  const cli = (name, signer, receiver, method, args, deposit, gas) => record(name, signer, nearCli(signer, receiver, method, args, deposit, gas));
  const done = (name) => Boolean(out.txs[name]);
  const bal = async (a) => String(await client.view(c.dusdc, "ft_balance_of", { account_id: a }));
  const snapshot = async (when) => {
    out.balances[when] = {};
    for (const a of [out.lead, out.members.m01, out.members.h05, out.stranger, c.coalition].filter(Boolean)) out.balances[when][a] = await bal(a);
    save();
    console.log(`   dUSDC ${when}: ${Object.entries(out.balances[when]).map(([a, b]) => `${a.split(".")[0]} ${Number(b) / 1e6}`).join(", ")}`);
  };
  const step = (i, t) => console.log(`${i}. ${t}`);

  step(1, `deploy ${c.coalition}`);
  const ck = seedOf(c.coalition);
  if (!(await client.account(c.coalition))) {
    await sendAs("coalition_account", c.treasury, treasury, c.coalition, [{ type: "CreateAccount" }, { type: "Transfer", deposit: near(3) }, { type: "AddKey", public_key_hex: ck.pub, permission: "FullAccess" }]);
  }
  if (!done("deploy")) {
    const code = readFileSync("target/near/bookerbob_coalition.wasm");
    await sendAs("deploy", c.coalition, ck, c.coalition, [{ type: "DeployContract", code }, fc("new", { token: c.dusdc, bazaar: c.bazaar }, 0n, 30n * TGAS)]);
    out.wasm_sha256 = execFileSync("shasum", ["-a", "256", "target/near/bookerbob_coalition.wasm"], { encoding: "utf8" }).split(" ")[0];
    save();
  }
  if (!(await client.view(c.dusdc, "storage_balance_of", { account_id: c.coalition }))) await sendAs("coalition_dusdc_storage", c.treasury, treasury, c.dusdc, [fc("storage_deposit", { account_id: c.coalition, registration_only: true }, 1250n * 10n ** 18n, 30n * TGAS)]);

  step(2, "lead and stranger accounts");
  out.tag ??= randomBytes(2).toString("hex");
  out.lead ??= `cl-lead-${out.tag}.${c.treasury}`;
  out.stranger ??= `cl-stranger-${out.tag}.${c.treasury}`;
  save();
  const lead = seedOf(out.lead);
  const stranger = seedOf(out.stranger);
  for (const [id, key, fund, mint] of [[out.lead, lead, 0.5, 100_000_000n], [out.stranger, stranger, 0.2, 10_000_000n]]) {
    const role = id === out.lead ? "lead" : "stranger";
    if (!(await client.account(id))) await sendAs(`${role}_account`, c.treasury, treasury, id, [{ type: "CreateAccount" }, { type: "Transfer", deposit: near(fund) }, { type: "AddKey", public_key_hex: key.pub, permission: "FullAccess" }]);
    if (!(await client.view(c.dusdc, "storage_balance_of", { account_id: id }))) await sendAs(`${role}_dusdc_storage`, id, key, c.dusdc, [fc("storage_deposit", {}, 1250n * 10n ** 18n, 30n * TGAS)]);
    if (!done(`${role}_mint`)) await sendAs(`${role}_mint`, id, key, c.dusdc, [fc("mint", { amount: String(mint) }, 0n, 30n * TGAS)]);
    console.log(`   ${role} ${id} (key ${nearPublicKey(key.pub).slice(0, 16)}..)`);
  }

  step(3, "standing openings");
  const sp = JSON.parse(execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", "standing-proofs", c.graphInput], { encoding: "utf8" }));
  const [root, n] = await client.view(c.bazaar, "standing_root", {});
  if (sp.standing_root !== root) throw new Error(`the graph input's tree ${sp.standing_root.slice(0, 12)} is not the bazaar's ${root.slice(0, 12)}`);
  out.standing = { root, n, openings: sp.proofs };
  save();
  const opening = (m) => sp.proofs.find((p) => p.merchant === m) ?? (() => { throw new Error(`${m} is not in the proven tree`); })();
  console.log(`   standing root ${root.slice(0, 12)}.. n=${n}: ${sp.proofs.map((p) => `${p.merchant.split(".")[0]}#${p.rank}`).join(" ")}`);

  if (!out.balances.before) await snapshot("before");

  step(4, "job A");
  const leadCall = (name, receiver, method, args, deposit = 0n, gas = 100n * TGAS) => sendAs(name, out.lead, lead, receiver, [fc(method, args, deposit, gas)]);
  if (!done("open_a")) {
    out.deadline_a = Date.now() + Number(process.env.COALITION_MINUTES ?? 25) * 60_000;
    const r = await leadCall("open_a", c.coalition, "open_job", { legs: [{ category: "hoodie", max_price: "48000000" }, { category: "hotel", max_price: "450000000" }], bond: String(BOND), budget: String(BUDGET), min_top_pct: 100, deadline_ms: out.deadline_a }, 20n * MILLI, 30n * TGAS);
    out.job_a = r.value;
    save();
  }
  if (!done("fund_a")) await leadCall("fund_a", c.dusdc, "ft_transfer_call", { receiver_id: c.coalition, amount: String(BUDGET), msg: JSON.stringify({ fund: out.job_a }) }, 1n);

  step(5, "m01 and h05 join with their openings");
  for (const m of [out.members.m01, out.members.h05]) {
    // The merchants' accounts pay their own gas; the treasury tops up one that runs low.
    const a = await client.account(m);
    if (BigInt(a.amount) < near(0.3)) await sendAs(`topup_${m.split(".")[0]}`, c.treasury, treasury, m, [{ type: "Transfer", deposit: near(0.5) }]);
  }
  const joinArgs = (job, leg, price, proof) => ({ receiver_id: c.coalition, amount: String(BOND), msg: JSON.stringify({ join: { job, leg, price, proof } }) });
  if (!done("join_m01")) cli("join_m01", out.members.m01, c.dusdc, "ft_transfer_call", joinArgs(out.job_a, 0, "48000000", opening(out.members.m01)), "1 yoctoNEAR");
  if (!done("join_h05")) cli("join_h05", out.members.h05, c.dusdc, "ft_transfer_call", joinArgs(out.job_a, 1, "420000000", opening(out.members.h05)), "1 yoctoNEAR");
  const ja = await client.view(c.coalition, "job", { job: out.job_a });
  if (!ja.seats.every((s) => s && !s.pending)) throw new Error("a member was not admitted: see the join txs");

  step(6, "job B: top 50%; a stranger without standing, then h05");
  out.budget_b = "1000000";
  if (!done("open_b")) {
    const r = await leadCall("open_b", c.coalition, "open_job", { legs: [{ category: "hotel", max_price: "450000000" }], bond: String(BOND), budget: out.budget_b, min_top_pct: 50, deadline_ms: out.deadline_a }, 20n * MILLI, 30n * TGAS);
    out.job_b = r.value;
    save();
  }
  if (!done("fund_b")) await leadCall("fund_b", c.dusdc, "ft_transfer_call", { receiver_id: c.coalition, amount: out.budget_b, msg: JSON.stringify({ fund: out.job_b }) }, 1n);
  // The stranger tries B's free leg: once with no proof, once with m01's opening.
  if (!done("stranger_no_proof")) await sendAs("stranger_no_proof", out.stranger, stranger, c.dusdc, [fc("ft_transfer_call", joinArgs(out.job_b, 0, "40000000", null), 1n)]);
  if (!done("stranger_wrong_leaf")) await sendAs("stranger_wrong_leaf", out.stranger, stranger, c.dusdc, [fc("ft_transfer_call", joinArgs(out.job_b, 0, "40000000", opening(out.members.m01)), 1n)]);
  if (!done("low_standing")) cli("low_standing", out.members.h05, c.dusdc, "ft_transfer_call", joinArgs(out.job_b, 0, "420000000", opening(out.members.h05)), "1 yoctoNEAR");
  await snapshot("after_joins");

  step(7, "a buyer buys from m01 (the normal purchase path)");
  if (!out.nullifier) {
    const { Demo, config: demoConfig } = await import("./demo-tester.mjs");
    const d = new Demo({ ...demoConfig({ ...process.env, SHOPIFY_ENV_FILE: "/nonexistent" }), merchant: out.members.m01 });
    const rec = await d.run();
    Object.assign(out, { tester: rec.tester, nullifier: rec.nullifier, purchase_price: String(rec.price), purchase_txs: rec.txs });
    save();
  }

  step(8, "m01 delivers");
  if (!done("deliver")) cli("deliver", out.members.m01, c.coalition, "deliver", { job: out.job_a, leg: 0, nullifier: out.nullifier }, "0 NEAR", "60.0 Tgas");

  step(9, "finalize after the deadline");
  const wait = out.deadline_a - Date.now() + 5000;
  if (wait > 0 && !done("finalize_a")) {
    console.log(`   waiting ${Math.ceil(wait / 1000)} s for the deadline`);
    await new Promise((ok) => setTimeout(ok, wait));
  }
  if (!done("finalize_a")) await leadCall("finalize_a", c.coalition, "finalize", { job: out.job_a }, 0n, 100n * TGAS);
  if (!done("finalize_b")) await leadCall("finalize_b", c.coalition, "finalize", { job: out.job_b }, 0n, 100n * TGAS);
  await snapshot("after_finalize");

  step(10, "the lead hires m01 on the bazaar");
  if (!done("hire")) await leadCall("hire", c.bazaar, "hire", { sub_agent: out.members.m01 }, 10n * MILLI, 30n * TGAS);
  out.graph_root_after = await client.view(c.bazaar, "graph_root", {});
  out.date = new Date().toISOString().slice(0, 10);
  save();
  console.log(`\ncoalition-live: PASS  wrote ${OUT}`);
}

export const REPROVE = "fixtures/live/coalition/reprove.json";

/** Re-prove the standing over the live graph: the proven events (c.graphInput) plus every
 *  graph_event logged since, read from the txs that pushed them (the lead's hire, the released
 *  review rounds: `REPROVE_TXS=hash:signer,...`); a Jolt proof (zk/bin/bookerbob-zk), the
 *  worker's signature, submit_graph_scores. `reprove-finalize` after the challenge window. */
async function reprove(c, finalizeOnly) {
  const { keyFromSeed, rpcClient, send } = await import("../relayer/near.mjs");
  const client = rpcClient(c.rpc);
  const out = JSON.parse(readFileSync(OUT, "utf8"));
  if (!out.txs.hire) throw new Error("run first: the lead's hire is not recorded");
  const rp = existsSync(REPROVE) ? JSON.parse(readFileSync(REPROVE, "utf8")) : { txs: {} };
  const treasury = keyFromSeed(readFileSync(join(c.keysDir, "treasury.seed"), "utf8"));
  const save = () => writeFileSync(REPROVE, JSON.stringify(rp, null, 2) + "\n");
  const go = async (name, method, args, deposit) => {
    const r = await send(client, { signer_id: c.treasury, key: treasury, receiver_id: c.bazaar, actions: [fc(method, args, deposit, 150n * TGAS)] });
    console.log(`   ${r.ok ? "ok" : "FAILED"} ${name}  ${r.hash ? link(r.hash) : ""}${r.ok ? "" : `\n   ${r.error}`}`);
    if (!r.ok) throw new Error(`${name}: ${r.error}`);
    rp.txs[name] = { hash: r.hash, signer: c.treasury };
    save();
  };
  if (!finalizeOnly) {
    const [root, count] = await client.view(c.bazaar, "graph_root", {});
    const program = await client.view(c.bazaar, "graph_program", {});
    const prior = JSON.parse(readFileSync(c.graphInput, "utf8")).events.map((e) => Buffer.from(e).toString("hex"));
    const sources = [out.txs.hire, ...(process.env.REPROVE_TXS ?? "").split(",").filter(Boolean).map((x) => ({ hash: x.split(":")[0], signer: x.split(":")[1] }))];
    const logged = [];
    for (const t of sources) {
      const r = (await client.rpc("tx", { tx_hash: t.hash, sender_account_id: t.signer, wait_until: "FINAL" })).result;
      for (const e of events(r).filter((e) => e.event === "graph_event")) logged.push(e.data[0]);
    }
    logged.sort((x, y) => x.index - y.index);
    const evs = [...prior, ...logged.map((e) => e.event)];
    if (evs.length !== count || logged.some((e, i) => e.index !== prior.length + i + 1)) throw new Error(`the graph has ${count} events; the sources give ${evs.length} (${logged.map((e) => e.index)})`);
    const input = "fixtures/zk/standing-coalition-input.json";
    const proofDir = "zk/out/standing-coalition";
    execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", "graph-input", root, input, ...evs.map((e) => `hex:${e}`)], { stdio: "inherit" });
    console.log(`   proving the standing guest over ${count} graph events (Jolt)`);
    // The prover builds the guest from the zk/ workspace: run it there.
    for (const op of ["prove", "verify"]) execFileSync("bin/bookerbob-zk", [op, "standing", `../${input}`, proofDir.replace(/^zk\//, "")], { stdio: "inherit", cwd: "zk" });
    const res = JSON.parse(readFileSync(join(proofDir, "result.json"), "utf8"));
    if (res.program_hash !== program) throw new Error(`the prover's program ${String(res.program_hash).slice(0, 12)} is not the registered ${program.slice(0, 12)}`);
    const argsPath = join(c.keysDir, "coalition", "graph-args.json");
    execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", "graph-sign", c.keysDir, program, input, argsPath, join(proofDir, "proof.bin")], { stdio: "inherit" });
    const args = JSON.parse(readFileSync(argsPath, "utf8"));
    Object.assign(rp, { graph_root: root, events: count, sources, input, proof_dir: proofDir, proof_sha256: args.proof_sha256, program, merchants: args.merchants, prove_seconds: res.prove_seconds });
    save();
    await go("submit_graph_scores", "submit_graph_scores", args, 100n * MILLI);
    const p = await client.view(c.bazaar, "pending_graph_update", {});
    rp.scores_hash = p?.scores_hash;
    rp.challenge_until_ms = p ? p.submitted_ms + 300_000 : null;
    save();
    console.log("   pending; finalize after the challenge window: node scripts/coalition-live.mjs reprove-finalize");
    return;
  }
  await go("finalize_graph_scores", "finalize_graph_scores", {}, 0n);
  rp.standing_root = await client.view(c.bazaar, "standing_root", {});
  const sp = JSON.parse(execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", "standing-proofs", rp.input], { encoding: "utf8" }));
  if (sp.standing_root !== rp.standing_root[0]) throw new Error("the rebuilt tree is not the bazaar's");
  rp.ranks = sp.proofs.map((p) => [p.merchant, p.rank]);
  rp.openings = sp.proofs;
  save();
  console.log(`   proven standing root now ${rp.standing_root[0].slice(0, 12)}.., n=${rp.standing_root[1]}: ${rp.ranks.map(([m, r]) => `${m.split(".")[0]}#${r}`).join(" ")}`);
}

export const JOBC = "fixtures/live/coalition/job-c.json";

/** coalition/src/lib.rs `settle`, in BigInt: seats [member, price, delivered] -> payouts. */
export function split(budget, bond, seats) {
  const p = seats.reduce((a, s) => a + s[1], 0n);
  const d = seats.filter((s) => s[2]).reduce((a, s) => a + s[1], 0n);
  const slashed = bond * BigInt(seats.filter((s) => !s[2]).length);
  const toDeliverers = d > 0n ? slashed - slashed / 2n : 0n;
  const pay = {};
  let paid = 0n;
  for (const [m, price, ok] of seats) {
    if (!ok) continue;
    pay[m] = bond + (budget * price) / p + (toDeliverers * price) / d;
    paid += pay[m];
  }
  return { pay, buyer: budget + bond * BigInt(seats.length) - paid };
}

/** Job C: three legs, three members admitted at the new tree, all deliver, the pro-rata split.
 *  Resumable; it opens the job first (m02, not yet in the tree, is refused with no proof) and
 *  goes on to the joins only once the re-proved tree holds m02. */
async function jobC(c) {
  const { keyFromSeed, rpcClient, send } = await import("../relayer/near.mjs");
  const { buyFrom } = await import("./coalition-seed.mjs");
  const client = rpcClient(c.rpc);
  const run0 = JSON.parse(readFileSync(OUT, "utf8"));
  const m02 = `m02.${c.bazaar}`;
  const st = existsSync(JOBC) ? JSON.parse(readFileSync(JOBC, "utf8")) : { coalition: run0.coalition, bazaar: c.bazaar, lead: run0.lead, members: { m01: run0.members.m01, h05: run0.members.h05, m02 }, txs: {}, purchases: {}, balances: {} };
  const save = () => writeFileSync(JOBC, JSON.stringify(st, null, 2) + "\n");
  const lead = keyFromSeed(readFileSync(join(c.keysDir, "coalition", `${st.lead}.seed`), "utf8"));
  const record = (name, signer, r) => {
    console.log(`   ${r.ok ? "ok" : "FAILED"} ${name}  ${r.hash ? link(r.hash) : ""}${r.ok ? "" : `\n   ${r.error}`}`);
    if (!r.ok) throw new Error(`${name}: ${r.error}`);
    st.txs[name] = { hash: r.hash, signer };
    save();
    return r;
  };
  const leadCall = async (name, receiver, method, args, deposit = 0n, gas = 100n * TGAS) => record(name, st.lead, await send(client, { signer_id: st.lead, key: lead, receiver_id: receiver, actions: [fc(method, args, deposit, gas)] }));
  const cli = (name, signer, receiver, method, args, deposit, gas) => record(name, signer, nearCli(signer, receiver, method, args, deposit, gas));
  const done = (n) => Boolean(st.txs[n]);
  const legs = [["m01", "hoodie", "48000000", "48000000"], ["h05", "hotel", "450000000", "450000000"], ["m02", "hoodie", "45000000", "45000000"]];
  const snapshot = async (when) => {
    st.balances[when] = {};
    for (const a of [st.lead, ...Object.values(st.members), st.coalition]) st.balances[when][a] = String(await client.view(c.dusdc, "ft_balance_of", { account_id: a }));
    save();
    console.log(`   dUSDC ${when}: ${Object.entries(st.balances[when]).map(([a, b]) => `${a.split(".")[0]} ${Number(b) / 1e6}`).join(", ")}`);
  };
  const joinArgs = (leg, price, proof) => ({ receiver_id: st.coalition, amount: String(BOND), msg: JSON.stringify({ join: { job: st.job, leg, price, proof } }) });

  console.log("1. open job C (3 legs, top 100%) and fund it");
  st.budget = String(30_000_000n);
  st.no_show = "h05";
  if (!done("open")) {
    st.deadline_ms = Date.now() + Number(process.env.JOBC_MINUTES ?? 90) * 60_000;
    const r = await leadCall("open", st.coalition, "open_job", { legs: legs.map(([, cat, max]) => ({ category: cat, max_price: max })), bond: String(BOND), budget: st.budget, min_top_pct: 100, deadline_ms: st.deadline_ms }, 20n * MILLI, 30n * TGAS);
    st.job = r.value;
    save();
  }
  if (!done("fund")) await leadCall("fund", c.dusdc, "ft_transfer_call", { receiver_id: st.coalition, amount: st.budget, msg: JSON.stringify({ fund: st.job }) }, 1n);
  console.log("2. m02 before its seed: no leaf in the proven tree, so no proof");
  st.standing_before ??= await client.view(c.bazaar, "standing_root", {});
  if (!done("m02_before")) cli("m02_before", m02, c.dusdc, "ft_transfer_call", joinArgs(2, "45000000", null), "1 yoctoNEAR");
  save();

  console.log("3. the three members join at the re-proved tree");
  const rp = existsSync(REPROVE) ? JSON.parse(readFileSync(REPROVE, "utf8")) : null;
  const onChain = await client.view(c.bazaar, "standing_root", {});
  if (!rp?.openings || rp.standing_root?.[0] !== onChain[0] || !rp.openings.some((p) => p.merchant === m02)) {
    console.log("   waiting for the re-proved tree with m02 (coalition-seed, reviews, reprove, reprove-finalize); rerun jobc then");
    return;
  }
  st.standing_after = onChain;
  st.openings = rp.openings;
  for (const a of Object.values(st.members)) {
    const acct = await client.account(a);
    if (BigInt(acct.amount) < 3n * 10n ** 23n) record(`topup_${a.split(".")[0]}`, c.treasury, await send(client, { signer_id: c.treasury, key: keyFromSeed(readFileSync(join(c.keysDir, "treasury.seed"), "utf8")), receiver_id: a, actions: [{ type: "Transfer", deposit: 5n * 10n ** 23n }] }));
  }
  if (!st.balances.before) await snapshot("before");
  for (const [i, [name, , , quote]] of legs.entries()) {
    const m = st.members[name];
    if (!done(`join_${name}`)) cli(`join_${name}`, m, c.dusdc, "ft_transfer_call", joinArgs(i, quote, rp.openings.find((p) => p.merchant === m)), "1 yoctoNEAR");
  }
  const j = await client.view(st.coalition, "job", { job: st.job });
  if (!j.seats.every((x) => x && !x.pending)) throw new Error("not every member was admitted: see the join txs");

  console.log("4. m01 and m02 deliver through bazaar purchases; h05 does not show");
  for (const [i, [name]] of legs.entries()) {
    if (name === st.no_show) continue;
    const m = st.members[name];
    if (!st.purchases[name]) {
      st.purchases[name] = await buyFrom(m);
      save();
    }
    if (!done(`deliver_${name}`)) cli(`deliver_${name}`, m, st.coalition, "deliver", { job: st.job, leg: i, nullifier: st.purchases[name].nullifier }, "0 NEAR", "60.0 Tgas");
  }

  console.log("5. finalize after the deadline; the lead hires the members it had not hired");
  const wait = st.deadline_ms - Date.now() + 5000;
  if (wait > 0 && !done("finalize")) {
    console.log(`   waiting ${Math.ceil(wait / 1000)} s for the deadline`);
    await new Promise((ok) => setTimeout(ok, wait));
  }
  if (!done("finalize")) await leadCall("finalize", st.coalition, "finalize", { job: st.job }, 0n, 150n * TGAS);
  await snapshot("after_finalize");
  const hired = await client.view(c.bazaar, "hired", { agent: st.lead });
  for (const name of ["h05", "m02"]) if (!done(`hire_${name}`) && !hired.includes(st.members[name])) await leadCall(`hire_${name}`, c.bazaar, "hire", { sub_agent: st.members[name] }, 10n * MILLI, 30n * TGAS);
  st.date = new Date().toISOString().slice(0, 10);
  save();
  console.log(`\ncoalition-live jobc: PASS  wrote ${JOBC}`);
}

/** The re-proved tree's chain records: the seed publish, the submit, the finalize. */
async function provenTree(tx, rp, bazaar) {
  const seedSrc = rp.sources?.find((x) => x.hash.startsWith("G8acbKsm")) ?? rp.sources?.[1];
  const seed = await tx(seedSrc.hash, seedSrc.signer);
  const sub = await tx(rp.txs.submit_graph_scores.hash, rp.txs.submit_graph_scores.signer);
  const fin = await tx(rp.txs.finalize_graph_scores.hash, rp.txs.finalize_graph_scores.signer);
  return {
    seedSrc,
    published: baz(seed, bazaar, "reviews_published")[0],
    seedEvent: baz(seed, bazaar, "graph_event")[0],
    args: callArgs(sub),
    pending: baz(sub, bazaar, "graph_update_pending")[0],
    scores: baz(fin, bazaar, "graph_scores")[0],
  };
}

/** The standing tree the joins of jobs D and E opened to, pinned: the graph_scores event of this
 *  finalize_graph_scores tx set it (fixtures/live/coalition/reprove-live.json). */
export const LIVE_TREE = {
  finalize: "GSkXViv8a2Ho1K5iPxNZe9iwhHk9UjNbLZpSqeyn8MhR",
  signer: "bookerbob-demo.testnet",
  standing_root: "3b5db5e91745e01e7cc6b9dcfda9ddf2bd6341c9a9bd32bcfa350985f0df3a01",
  n: 3,
  proof_sha256: "5619f62dcf9d94b41c74cd67b9b0e8cf5fffc0583eb8bb7ed4acb9c1b59454d1",
  graph_root: "7f1bf041fef4c7bd32257e7ba2d8ef431df605b3dc991a0c3913a65432bee530",
};

/** zkcore/src/standing.rs `opens`, in JS: the proof's leaf and path hash up to `root` (hex). */
export function opens(root, p, context = "graph") {
  const h = (...parts) => createHash("sha256").update(Buffer.concat(parts.map((x) => (typeof x === "string" ? Buffer.from(x) : x)))).digest();
  const u32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const Z = Buffer.from([0]);
  if (!p || !Number.isInteger(p.rank) || !Number.isInteger(p.n) || p.rank < 1 || p.rank > p.n || !/^[0-9a-f]{64}$/.test(p.score_commit ?? "")) return false;
  let cur = h("bookerbob/standing-leaf/v1\x00", context, Z, p.merchant, Z, u32(p.rank), u32(p.n), Buffer.from(p.score_commit, "hex"));
  for (const [sib, left] of p.path ?? []) {
    if (!/^[0-9a-f]{64}$/.test(sib)) return false;
    const s2 = Buffer.from(sib, "hex");
    cur = left ? h("bookerbob/standing-node/v1\x00", s2, cur) : h("bookerbob/standing-node/v1\x00", cur, s2);
  }
  return cur.toString("hex") === root;
}

/** The pinned tree's chain record: the graph_scores event of its finalize tx, and the job's recorded root. */
async function liveTreeLine(tx, st) {
  const gs = baz(await tx(LIVE_TREE.finalize, LIVE_TREE.signer), st.bazaar, "graph_scores")[0];
  const ok = gs?.standing_root === LIVE_TREE.standing_root && gs?.proof_sha256 === LIVE_TREE.proof_sha256 && gs?.root === LIVE_TREE.graph_root && gs?.merchants === LIVE_TREE.n && st.standing?.[0] === LIVE_TREE.standing_root && st.standing?.[1] === LIVE_TREE.n;
  return [ok, `the joins' root ${LIVE_TREE.standing_root.slice(0, 8)}.. (pinned) is the one the graph_scores event of finalize_graph_scores ${LIVE_TREE.finalize.slice(0, 8)}.. set: Jolt proof ${LIVE_TREE.proof_sha256.slice(0, 12)}.. over graph ${LIVE_TREE.graph_root.slice(0, 8)}.., ${gs?.merchants} merchants; the record names the same root`];
}

/** One member's join on `coalition`: its event, the bazaar's in_top answer, the proof it sent,
 *  and that proof's path hashed up to `root`. */
async function joinCheck(tx, rec, coalition, bazaar, job, leg, member, n, root) {
  const t = await tx(rec.hash, rec.signer);
  const j = coal(t, coalition, "joined")[0];
  const msg = joinMsg(t);
  const ok = rec.signer === member && j?.job === job && j?.leg === leg && j?.member === member && returnedTrue(t, bazaar) && msg?.job === job && msg?.leg === leg && msg?.proof?.merchant === member && msg?.proof?.n === n && opens(root, msg?.proof);
  return { ok, rank: msg?.proof?.rank, joined: j };
}

/** Public check of job C and the re-proved tree. */
export async function verifyJobC(view, tx, st = JSON.parse(readFileSync(JOBC, "utf8")), rp = JSON.parse(readFileSync(REPROVE, "utf8")), account = null, run0 = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {}) {
  const lines = [];
  if (account) {
    const code = await codeHex((await account(st.coalition))?.code_hash ?? "");
    lines.push([code === run0.wasm_sha256, `${st.coalition} runs code sha256 ${code.slice(0, 12)}.. (view_account), the version 1 wasm recorded at its deploy`]);
  }
  const T = (name) => tx(st.txs[name].hash, st.txs[name].signer);
  const dusdc = st.dusdc ?? "bookerbob-dusdc.testnet";
  const m02 = st.members.m02;
  const bt = await T("m02_before");
  const before = coal(bt, st.coalition, "join_refused")[0];
  const refund = fts(bt, dusdc).find((e) => e.memo === "refund" && e.new_owner_id === m02);
  lines.push([
    before?.job === st.job && before?.leg === 2 && before?.member === m02 && String(before?.reason).includes(REFUSE_NO_PROOF) && joinMsg(bt)?.proof === null && refund?.amount === String(BOND) && st.standing_before?.[1] === 2,
    `m02 had no opening in the n=${st.standing_before?.[1]} tree, so it could present no proof and was refused; bond refunded (${st.txs.m02_before.hash.slice(0, 8)}..)`,
  ]);
  const p = await provenTree(tx, rp, st.bazaar);
  lines.push([
    p.published?.merchant === m02 && p.published?.ratings >= 5 && p.seedEvent?.index === rp.events && p.seedEvent?.root === rp.graph_root,
    `m02's seed: ${p.published?.ratings} paid sealed reviews released (${p.seedSrc.hash.slice(0, 8)}..), graph event ${p.seedEvent?.index}, whose root is the graph the Jolt proof covers`,
  ]);
  const sha = rp.proof_sha256;
  lines.push([
    p.args?.proof_sha256 === sha && p.args?.root === rp.graph_root && p.args?.program_hash === rp.program && p.pending?.proof_sha256 === sha && p.scores?.proof_sha256 === sha && p.scores?.root === rp.graph_root && p.scores?.merchants === 3 && p.scores?.standing_root === rp.standing_root?.[0],
    `the re-proved standing tree: the submit tx carries the Jolt proof sha256 ${sha.slice(0, 12)}.. over the graph of ${rp.events} events; the finalize's graph_scores event sets standing root ${String(p.scores?.standing_root).slice(0, 8)}.. with ${p.scores?.merchants} merchants`,
  ]);
  const quotes = { m01: 48_000_000n, h05: 450_000_000n, m02: 45_000_000n };
  const ranks = [];
  let joinsOk = st.standing_after?.[0] === p.scores?.standing_root && st.standing_after?.[1] === 3;
  for (const [leg, name] of ["m01", "h05", "m02"].entries()) {
    const r = await joinCheck(tx, st.txs[`join_${name}`], st.coalition, st.bazaar, st.job, leg, st.members[name], 3, p.scores?.standing_root);
    joinsOk &&= r.ok && BigInt(r.joined.price) === quotes[name];
    ranks.push(`${name}#${r.rank}`);
  }
  lines.push([joinsOk && ranks.join(" ") === "m01#1 h05#2 m02#3", `m01, h05 and m02 admitted to job ${st.job} by in_top (true in each join tx) with proofs at n=3 whose paths hash to root ${String(st.standing_after?.[0]).slice(0, 8)}..; ranks from the proofs the bazaar accepted: ${ranks.join(" ")}`]);
  for (const [leg, name] of ["m01", "h05", "m02"].entries()) {
    if (name === st.no_show) {
      lines.push([!st.txs[`deliver_${name}`], `${name} did not deliver`]);
      continue;
    }
    const d = coal(await T(`deliver_${name}`), st.coalition, "delivered")[0];
    const v = await view(st.bazaar, "verdict", { nullifier: st.purchases[name].nullifier });
    const agent = String(d?.buyer_agent);
    const settled = isSettle(await tx(st.purchases[name].txs.settle, st.relayer ?? "bookerbob-demo.testnet"), st.bazaar, st.purchases[name].nullifier, st.purchases[name].tester);
    lines.push([
      settled && d?.job === st.job && d?.leg === leg && d?.member === st.members[name] && d?.nullifier === st.purchases[name].nullifier && v?.spent && v?.paid && v?.receipt?.merchant === st.members[name] && v?.agent === agent && agent === st.purchases[name].tester,
      `${name} delivered leg ${leg} with a spent bazaar purchase priced ${Number(v?.receipt?.price) / 1e6}, bought by demo tester ${agent.slice(0, 8)}.. (the lead bought neither purchase; version 1 did not check the buyer)`,
    ]);
  }
  const fin = await T("finalize");
  const f = coal(fin, st.coalition, "job_finalized")[0];
  const pays = fts(fin, dusdc).filter((x) => x.old_owner_id === st.coalition);
  const got = (a) => pays.filter((x) => x.new_owner_id === a).reduce((s, x) => s + BigInt(x.amount), 0n);
  const want = split(BigInt(st.budget), BOND, ["m01", "h05", "m02"].map((n) => [st.members[n], quotes[n], n !== st.no_show]));
  const ok = f?.job === st.job && f?.status === "failed" && f.slashed?.length === 1 && f.slashed[0].member === st.members[st.no_show] && f.delivered?.length === 2 && Object.entries(want.pay).every(([a, x]) => got(a) === x) && got(st.lead) === want.buyer && got(st.members[st.no_show]) === 0n;
  lines.push([ok, `finalize: ${st.no_show} slashed ${Number(BOND) / 1e6}; ${Object.entries(want.pay).map(([a, x]) => `${a.split(".")[0]} ${Number(x) / 1e6}`).join(", ")} (bond, budget * quote / 543, part of the slashed bond); the lead ${Number(want.buyer) / 1e6} (the rest of the budget and half the slashed bond)`]);
  const hires = [];
  for (const name of ["h05", "m02"]) {
    const t = await T(`hire_${name}`);
    const h = baz(t, st.bazaar, "hired")[0];
    const g = baz(t, st.bazaar, "graph_event")[0];
    hires.push({ ok: h?.agent === st.lead && h?.sub_agent === st.members[name], index: g?.index });
  }
  lines.push([hires.every((h) => h.ok) && hires[0].index === rp.events + 1 && hires[1].index === rp.events + 2, `the lead hired h05 and m02 on the bazaar: graph events ${hires.map((h) => h.index).join(" and ")}, after the ${rp.events} the proof covers`]);
  return lines;
}

export const JOBD = "fixtures/live/coalition/job-d.json";
export const REPROVE_LIVE = "fixtures/live/coalition/reprove-live.json";

/** coalition/src/lib.rs `settle` (version 2), in BigInt: seats [member, price, outcome]. */
export function splitV2(budget, bond, seats) {
  const p = seats.reduce((a, s) => a + s[1], 0n);
  const d = seats.filter((s) => s[2] === "delivered").reduce((a, s) => a + s[1], 0n);
  const slashed = bond * BigInt(seats.filter((s) => s[2] === "no_show").length);
  const toDeliverers = d > 0n ? slashed - slashed / 2n : 0n;
  const pay = {};
  let paid = 0n;
  for (const [m, price, o] of seats) {
    if (o === "delivered") pay[m] = bond + (budget * price) / p + (toDeliverers * price) / d;
    else if (o === "released") pay[m] = bond;
    else continue;
    paid += pay[m];
  }
  return { pay, buyer: budget + bond * BigInt(seats.length) - paid };
}

const D_LEGS = [
  ["m01", "hoodie", "48000000", "delivered"],
  ["h05", "hotel-lisbon", "450000000", "no_show"],
  ["m02", "hoodie", "45000000", "delivered"],
];
const D_BUDGET = 30_000_000n;

/** Job D on coalition version 2 (resumable). The lead names three buyer agents (one-time
 *  implicit accounts made here) when it opens the job; each buys from one member through the
 *  demo purchase path, and the lead announces each purchase before it settles. h05's purchase is
 *  announced and never settled: h05 is the no-show. A fresh tester the job does not name buys
 *  from m02: the lead's announce of it is refused, and so is m02's deliver of it. */
async function jobD(c) {
  const { keyFromSeed, rpcClient, send, near } = await import("../relayer/near.mjs");
  const { buyFrom } = await import("./coalition-seed.mjs");
  const client = rpcClient(c.rpc);
  const run0 = JSON.parse(readFileSync(OUT, "utf8"));
  const dir = join(c.keysDir, "coalition");
  const st = existsSync(JOBD)
    ? JSON.parse(readFileSync(JOBD, "utf8"))
    : { coalition: c.coalitionV2, coalition_v1: run0.coalition, relayer: c.treasury, bazaar: c.bazaar, dusdc: c.dusdc, lead: run0.lead, members: Object.fromEntries(D_LEGS.map(([n]) => [n, `${n}.${c.bazaar}`])), buyers: {}, txs: {}, purchases: {}, balances: {} };
  const save = () => writeFileSync(JOBD, JSON.stringify(st, null, 2) + "\n");
  const treasury = keyFromSeed(readFileSync(join(c.keysDir, "treasury.seed"), "utf8"));
  const lead = keyFromSeed(readFileSync(join(dir, `${st.lead}.seed`), "utf8"));
  const seedFile = (name) => {
    const p = join(dir, name);
    if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    return readFileSync(p, "utf8").trim();
  };
  const record = (name, signer, r) => {
    console.log(`   ${r.ok ? "ok" : "FAILED"} ${name}  ${r.hash ? link(r.hash) : ""}${r.ok ? "" : `\n   ${r.error}`}`);
    if (!r.ok) throw new Error(`${name}: ${r.error}`);
    st.txs[name] = { hash: r.hash, signer };
    save();
    return r;
  };
  /** A call that must be refused on chain with `why`. */
  const refusedAs = (name, signer, r, why) => {
    const hit = !r.ok && r.hash && String(r.error).includes(why);
    console.log(`   ${hit ? "refused as expected" : "UNEXPECTED"} ${name}  ${r.hash ? link(r.hash) : ""}\n   ${r.error ?? "it went through"}`);
    if (!hit) throw new Error(`${name}: expected a refusal with "${why}"`);
    st.txs[name] = { hash: r.hash, signer, refused: why };
    save();
  };
  const leadSend = (receiver, method, args, deposit = 0n, gas = 100n * TGAS) => send(client, { signer_id: st.lead, key: lead, receiver_id: receiver, actions: [fc(method, args, deposit, gas)] });
  const leadCall = async (name, receiver, method, args, deposit, gas) => record(name, st.lead, await leadSend(receiver, method, args, deposit, gas));
  const cli = (name, signer, receiver, method, args, deposit, gas) => record(name, signer, nearCli(signer, receiver, method, args, deposit, gas));
  const done = (n) => Boolean(st.txs[n]);
  const snapshot = async (when) => {
    st.balances[when] = {};
    for (const a of [st.lead, ...Object.values(st.members), st.coalition]) st.balances[when][a] = String(await client.view(c.dusdc, "ft_balance_of", { account_id: a }));
    save();
    console.log(`   dUSDC ${when}: ${Object.entries(st.balances[when]).map(([a, b]) => `${a.split(".")[0]} ${Number(b) / 1e6}`).join(", ")}`);
  };

  console.log(`1. deploy coalition version 2 to ${st.coalition}`);
  const ck = keyFromSeed(seedFile(`${st.coalition}.seed`));
  if (!(await client.account(st.coalition))) record("coalition_account", c.treasury, await send(client, { signer_id: c.treasury, key: treasury, receiver_id: st.coalition, actions: [{ type: "CreateAccount" }, { type: "Transfer", deposit: near(3) }, { type: "AddKey", public_key_hex: ck.pub, permission: "FullAccess" }] }));
  if (!done("deploy")) {
    const code = readFileSync("target/near/bookerbob_coalition.wasm");
    record("deploy", st.coalition, await send(client, { signer_id: st.coalition, key: ck, receiver_id: st.coalition, actions: [{ type: "DeployContract", code }, fc("new", { token: c.dusdc, bazaar: c.bazaar }, 0n, 30n * TGAS)] }));
    st.wasm_sha256 = execFileSync("shasum", ["-a", "256", "target/near/bookerbob_coalition.wasm"], { encoding: "utf8" }).split(" ")[0];
    save();
  }
  if (!(await client.view(c.dusdc, "storage_balance_of", { account_id: st.coalition }))) record("coalition_dusdc_storage", c.treasury, await send(client, { signer_id: c.treasury, key: treasury, receiver_id: c.dusdc, actions: [fc("storage_deposit", { account_id: st.coalition, registration_only: true }, 1250n * 10n ** 18n, 30n * TGAS)] }));

  console.log("2. the lead's buyer agents: one-time implicit accounts, named before they buy");
  for (const [name] of D_LEGS) st.buyers[name] ??= keyFromSeed(seedFile(`jobd-agent-${name}.seed`)).pub;
  save();

  console.log("3. wait for the live standing tree");
  const sp = JSON.parse(execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", "standing-proofs", c.liveInput], { encoding: "utf8" }));
  const onChain = await client.view(c.bazaar, "standing_root", {});
  if (sp.standing_root !== onChain?.[0] || process.env.JOBD_JOIN !== "1") {
    console.log(`   the input's tree ${sp.standing_root.slice(0, 8)}.., the bazaar's ${String(onChain?.[0]).slice(0, 8)}..; joins wait for a match and JOBD_JOIN=1`);
    return;
  }

  console.log(`4. open job D (3 legs, top 100%, buyer agents named) and fund it`);
  st.budget = String(D_BUDGET);
  st.no_show = "h05";
  if (!done("open")) {
    st.deadline_ms = Date.now() + Number(process.env.JOBD_MINUTES ?? 35) * 60_000;
    const r = await leadCall("open", st.coalition, "open_job", { legs: D_LEGS.map(([, cat, max]) => ({ category: cat, max_price: max })), bond: String(BOND), budget: st.budget, min_top_pct: 100, deadline_ms: st.deadline_ms, buyers: D_LEGS.map(([n]) => st.buyers[n]) }, 20n * MILLI, 30n * TGAS);
    st.job = r.value;
    save();
  }
  if (!done("fund")) await leadCall("fund", c.dusdc, "ft_transfer_call", { receiver_id: st.coalition, amount: st.budget, msg: JSON.stringify({ fund: st.job }) }, 1n);

  console.log("5. the three members join with openings from the live tree");
  st.standing ??= onChain;
  st.openings ??= sp.proofs.filter((p) => Object.values(st.members).includes(p.merchant));
  save();
  for (const a of Object.values(st.members)) {
    const acct = await client.account(a);
    if (BigInt(acct.amount) < 3n * 10n ** 23n) record(`topup_${a.split(".")[0]}`, c.treasury, await send(client, { signer_id: c.treasury, key: treasury, receiver_id: a, actions: [{ type: "Transfer", deposit: 5n * 10n ** 23n }] }));
  }
  if (!st.balances.before) await snapshot("before");
  const joinArgs = (leg, price, proof) => ({ receiver_id: st.coalition, amount: String(BOND), msg: JSON.stringify({ join: { job: st.job, leg, price, proof } }) });
  for (const [i, [name, , quote]] of D_LEGS.entries()) {
    const m = st.members[name];
    if (!done(`join_${name}`)) cli(`join_${name}`, m, c.dusdc, "ft_transfer_call", joinArgs(i, quote, st.openings.find((p) => p.merchant === m)), "1 yoctoNEAR");
  }
  const j = await client.view(st.coalition, "job", { job: st.job });
  if (!j.seats.every((x) => x && !x.pending)) throw new Error("not every member was admitted: see the join txs");

  console.log("6. a tester the job does not name buys from m02: the announce and the deliver are refused");
  if (!st.purchases.forbidden) {
    const rec = await buyFrom(st.members.m02, process.env, {
      beforeSettle: async ({ rec: r }) => refusedAs("forbidden_announce", st.lead, await leadSend(st.coalition, "announce", { job: st.job, leg: 2, nullifier: r.nullifier }, 0n, 60n * TGAS), REFUSE_BUYER_JS),
    });
    st.purchases.forbidden = rec;
    save();
  }
  if (!done("forbidden_deliver")) {
    const args = { job: st.job, leg: 2, nullifier: st.purchases.forbidden.nullifier };
    const r = nearCli(st.members.m02, st.coalition, "deliver", args, "0 NEAR", "60.0 Tgas");
    // The CLI may print no tx id for a failed call; then the lead sends the same deliver (anyone may).
    if (r.hash) refusedAs("forbidden_deliver", st.members.m02, r, REFUSE_NOT_ANNOUNCED);
    else refusedAs("forbidden_deliver", st.lead, await leadSend(st.coalition, "deliver", args, 0n, 60n * TGAS), REFUSE_NOT_ANNOUNCED);
  }

  console.log("7. the named buyer agents buy; the lead announces each purchase before it settles; h05's is never settled");
  for (const [i, [name, , , outcome]] of D_LEGS.entries()) {
    if (st.purchases[name]?.nullifier && (outcome !== "delivered" || st.purchases[name].settled)) continue;
    const seed = seedFile(`jobd-agent-${name}.seed`);
    const hold = {};
    try {
      const rec = await buyFrom(st.members[name], process.env, {
        seed,
        beforeSettle: async ({ rec: r }) => {
          Object.assign(hold, { tester: r.tester, nullifier: r.nullifier, price: String(r.price), txs: { ...r.txs } });
          if (!done(`announce_${name}`)) await leadCall(`announce_${name}`, st.coalition, "announce", { job: st.job, leg: i, nullifier: r.nullifier }, 0n, 60n * TGAS);
          if (outcome !== "delivered") throw new Error("NO_SHOW");
        },
      });
      st.purchases[name] = { ...rec, settled: true };
    } catch (e) {
      if (e.message !== "NO_SHOW") throw e;
      st.purchases[name] = { ...hold, merchant: st.members[name], settled: false };
    }
    save();
  }

  console.log("8. m01 and m02 show their legs delivered");
  for (const [i, [name, , , outcome]] of D_LEGS.entries()) {
    if (outcome !== "delivered" || done(`deliver_${name}`)) continue;
    const args = { job: st.job, leg: i, nullifier: st.purchases[name].nullifier };
    const r = nearCli(st.members[name], st.coalition, "deliver", args, "0 NEAR", "60.0 Tgas");
    // The CLI's RPC can rate-limit past its retries; deliver is open to anyone, so the lead sends it then.
    if (r.ok || r.hash) record(`deliver_${name}`, st.members[name], r);
    else await leadCall(`deliver_${name}`, st.coalition, "deliver", args, 0n, 60n * TGAS);
  }

  console.log("9. finalize after the deadline");
  const wait = st.deadline_ms - Date.now() + 5000;
  if (wait > 0 && !done("finalize")) {
    console.log(`   waiting ${Math.ceil(wait / 1000)} s for the deadline`);
    await new Promise((ok) => setTimeout(ok, wait));
  }
  if (!done("finalize")) await leadCall("finalize", st.coalition, "finalize", { job: st.job }, 0n, 200n * TGAS);
  await snapshot("after_finalize");
  st.date = new Date().toISOString().slice(0, 10);
  save();
  console.log(`\ncoalition-live jobd: PASS  wrote ${JOBD}`);
}

const REFUSE_BUYER_JS = "the purchase's buyer agent is not allowed in this job";
const REFUSE_NOT_ANNOUNCED = "this purchase was not announced for this leg";

/** Public check of job D on version 2. `blockMs(hash)` gives a block's time, for the order. */
export async function verifyJobD(view, tx, blockMs, st = JSON.parse(readFileSync(JOBD, "utf8")), account = null) {
  const lines = [];
  const T = (name) => tx(st.txs[name].hash, st.txs[name].signer);
  const when = async (t) => blockMs(t.transaction_outcome.block_hash);
  const buyers = D_LEGS.map(([n]) => st.buyers[n]);
  const cfg = await view(st.coalition, "config", {});
  const dep = await T("deploy");
  const code = account ? await codeHex((await account(st.coalition))?.code_hash ?? "") : null;
  lines.push([code === st.wasm_sha256 && cfg?.version === "2.0.0" && cfg?.bazaar === st.bazaar && cfg?.token === st.dusdc && dep.transaction.actions.some((a) => a.DeployContract), `${st.coalition} runs code sha256 ${String(code).slice(0, 12)}.. (view_account), the version 2 wasm recorded at its deploy (${st.txs.deploy.hash.slice(0, 8)}..); config: bazaar ${cfg?.bazaar}, token ${cfg?.token}`]);
  lines.push(await liveTreeLine(tx, st));
  const open = await T("open");
  const o = coal(open, st.coalition, "job_opened")[0];
  const openMs = await when(open);
  lines.push([
    o?.job === st.job && o?.buyer === st.lead && JSON.stringify(o?.buyers) === JSON.stringify(buyers) && o?.legs?.map((l) => l.category).join() === D_LEGS.map((l) => l[1]).join() && o?.deadline_ms === st.deadline_ms,
    `the lead opened job ${st.job} naming ${buyers.length} buyer agents (one-time implicit accounts) and legs ${D_LEGS.map((l) => l[1]).join(", ")}`,
  ]);
  const ranks = [];
  let joinsOk = true;
  for (const [leg, [name, cat, quote]] of D_LEGS.entries()) {
    const r = await joinCheck(tx, st.txs[`join_${name}`], st.coalition, st.bazaar, st.job, leg, st.members[name], LIVE_TREE.n, LIVE_TREE.standing_root);
    joinsOk &&= r.ok && r.joined?.category === cat && r.joined?.price === quote;
    ranks.push(`${name}#${r.rank}`);
  }
  lines.push([joinsOk, `m01, h05 and m02 admitted by in_top (true in each join tx) with proofs at n=${LIVE_TREE.n} whose paths hash to the pinned root ${LIVE_TREE.standing_root.slice(0, 8)}.., ranks ${ranks.join(" ")}, each in its leg's bazaar category`]);
  const fa = await T("forbidden_announce");
  const fv = await view(st.bazaar, "verdict", { nullifier: st.purchases.forbidden.nullifier });
  lines.push([failure(fa).includes(REFUSE_BUYER_JS) && callArgs(fa)?.nullifier === st.purchases.forbidden.nullifier && callArgs(fa)?.job === st.job && fv?.receipt?.merchant === st.members.m02 && fv?.spent && !buyers.includes(fv?.agent) && !coal(fa, st.coalition, "announced").length, `refused on chain: a purchase from m02 by tester ${String(fv?.agent).slice(0, 8)}.., an account the job does not name: ${REFUSE_BUYER_JS} (${st.txs.forbidden_announce.hash.slice(0, 8)}..)`]);
  const fd = await T("forbidden_deliver");
  lines.push([failure(fd).includes(REFUSE_NOT_ANNOUNCED) && callArgs(fd)?.nullifier === st.purchases.forbidden.nullifier && callArgs(fd)?.job === st.job && !coal(fd, st.coalition, "delivered").length, `refused on chain: that purchase shown as leg 2's delivery (signed by ${st.txs.forbidden_deliver.signer.split(".")[0]}): ${REFUSE_NOT_ANNOUNCED} (${st.txs.forbidden_deliver.hash.slice(0, 8)}..)`]);
  const outcomes = [];
  for (const [leg, [name, , quote, outcome]] of D_LEGS.entries()) {
    const pu = st.purchases[name];
    const an = await T(`announce_${name}`);
    const a = coal(an, st.coalition, "announced")[0];
    const v = await view(st.bazaar, "verdict", { nullifier: pu.nullifier });
    const anMs = await when(an);
    const base = a?.job === st.job && a?.leg === leg && a?.member === st.members[name] && a?.nullifier === pu.nullifier && a?.buyer_agent === st.buyers[name] && v?.agent === st.buyers[name] && v?.receipt?.merchant === st.members[name] && BigInt(v?.receipt?.price ?? 0) <= BigInt(quote) && anMs > openMs;
    if (outcome === "delivered") {
      const settle = await tx(pu.txs.settle, st.relayer);
      const d = coal(await T(`deliver_${name}`), st.coalition, "delivered")[0];
      const ok = base && isSettle(settle, st.bazaar, pu.nullifier, st.buyers[name]) && (await when(settle)) > anMs && v?.spent && v?.paid && d?.job === st.job && d?.leg === leg && d?.member === st.members[name] && d?.nullifier === pu.nullifier && d?.buyer_agent === st.buyers[name];
      lines.push([ok, `${name}: its buyer agent's purchase (${Number(v?.receipt?.price) / 1e6} dUSDC) announced after the job opened and before it settled, then delivered (${st.txs[`deliver_${name}`].hash.slice(0, 8)}..)`]);
    } else {
      const ok = base && v?.spent === false && !st.txs[`deliver_${name}`];
      lines.push([ok, `${name}: its buyer agent's purchase announced (${st.txs[`announce_${name}`].hash.slice(0, 8)}..) and never settled: a no-show`]);
    }
    outcomes.push([st.members[name], BigInt(quote), outcome]);
  }
  const fin = await T("finalize");
  const f = coal(fin, st.coalition, "job_finalized")[0];
  const pays = fts(fin, st.dusdc).filter((x) => x.old_owner_id === st.coalition);
  const got = (a) => pays.filter((x) => x.new_owner_id === a).reduce((s, x) => s + BigInt(x.amount), 0n);
  const want = splitV2(BigInt(st.budget), BOND, outcomes);
  const ok = f?.job === st.job && f?.status === "failed" && f.slashed?.length === 1 && f.slashed[0].member === st.members.h05 && f.delivered?.length === 2 && f.released?.length === 0 && Object.entries(want.pay).every(([a, x]) => got(a) === x) && got(st.lead) === want.buyer && got(st.members.h05) === 0n && !coal(fin, st.coalition, "payout_failed").length;
  lines.push([ok, `finalize: h05 slashed ${Number(BOND) / 1e6}; ${Object.entries(want.pay).map(([a, x]) => `${a.split(".")[0]} ${Number(x) / 1e6}`).join(", ")}; the lead ${Number(want.buyer) / 1e6}; every transfer accepted`]);
  const want2 = tally([fin], st.coalition);
  const recs = await Promise.all(Object.keys(want2).map((a) => view(st.coalition, "member", { account: a })));
  lines.push([Object.keys(want2).length === 3 && Object.keys(want2).every((a, i) => recs[i]?.joined === want2[a].joined && recs[i]?.completed === want2[a].completed && recs[i]?.slashed === want2[a].slashed && recs[i]?.released === want2[a].released), `version 2 member records equal the finalize event exactly: ${Object.keys(want2).map((a, i) => `${a.split(".")[0]} completed ${recs[i]?.completed}, slashed ${recs[i]?.slashed}`).join("; ")}`]);
  return lines;
}

export const JOBE = "fixtures/live/coalition/job-e.json";
const REFUSE_NOT_AGENT = "the announcer is not the purchase's buyer agent";
const E_BUDGET = 20_000_000n;
const E_LEGS = [
  ["m01", "hoodie", "48000000"],
  ["h05", "hotel-lisbon", "450000000"],
];

/** coalition/src/lib.rs `settle` (version 3), in BigInt: a slash goes half to the buyer, half to the treasury. */
export function splitV3(budget, bond, seats) {
  const p = seats.reduce((a, s) => a + s[1], 0n);
  const slashed = bond * BigInt(seats.filter((s) => s[2] === "no_show").length);
  const treasury = slashed - slashed / 2n;
  const pay = {};
  let paid = treasury;
  for (const [m, price, o] of seats) {
    if (o === "delivered") pay[m] = bond + (budget * price) / p;
    else if (o === "released") pay[m] = bond;
    else continue;
    paid += pay[m];
  }
  return { pay, treasury, buyer: budget + bond * BigInt(seats.length) - paid };
}

/** Job E on coalition version 3 (resumable): the v2 griefs, live. Two named agents buy from m01.
 *  Agent a announces its purchase first; agent b tries to announce a's purchase (refused: not
 *  its agent), then announces its own, which never settles. a's purchase settles and delivers the
 *  leg (version 2 would have dropped it for b's). h05's leg: job D's h05 agent announces its
 *  purchase from job D, still unspent, and never settles it: h05 is slashed, half to the lead,
 *  half to the treasury. */
async function jobE(c) {
  const { keyFromSeed, rpcClient, send, near } = await import("../relayer/near.mjs");
  const { buyFrom } = await import("./coalition-seed.mjs");
  const client = rpcClient(c.rpc);
  const run0 = JSON.parse(readFileSync(OUT, "utf8"));
  const d0 = JSON.parse(readFileSync(JOBD, "utf8"));
  const dir = join(c.keysDir, "coalition");
  const st = existsSync(JOBE)
    ? JSON.parse(readFileSync(JOBE, "utf8"))
    : { coalition: c.coalitionV3, treasury: c.treasury, relayer: c.treasury, bazaar: c.bazaar, dusdc: c.dusdc, lead: run0.lead, members: Object.fromEntries(E_LEGS.map(([n]) => [n, `${n}.${c.bazaar}`])), buyers: {}, txs: {}, purchases: {}, balances: {} };
  const save = () => writeFileSync(JOBE, JSON.stringify(st, null, 2) + "\n");
  const treasury = keyFromSeed(readFileSync(join(c.keysDir, "treasury.seed"), "utf8"));
  const lead = keyFromSeed(readFileSync(join(dir, `${st.lead}.seed`), "utf8"));
  const seedFile = (name) => {
    const p = join(dir, name);
    if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    return readFileSync(p, "utf8").trim();
  };
  const record = (name, signer, r) => {
    console.log(`   ${r.ok ? "ok" : "FAILED"} ${name}  ${r.hash ? link(r.hash) : ""}${r.ok ? "" : `\n   ${r.error}`}`);
    if (!r.ok) throw new Error(`${name}: ${r.error}`);
    st.txs[name] = { hash: r.hash, signer };
    save();
    return r;
  };
  const refusedAs = (name, signer, r, why) => {
    const hit = !r.ok && r.hash && String(r.error).includes(why);
    console.log(`   ${hit ? "refused as expected" : "UNEXPECTED"} ${name}  ${r.hash ? link(r.hash) : ""}\n   ${r.error ?? "it went through"}`);
    if (!hit) throw new Error(`${name}: expected a refusal with "${why}"`);
    st.txs[name] = { hash: r.hash, signer, refused: why };
    save();
  };
  const done = (n) => Boolean(st.txs[n]);
  // JOBE_FRESH=1: the open job is set aside (it is finalized once its deadline passes, so every
  // bond and the budget go back) and a new job is opened with new agents.
  if (process.env.JOBE_FRESH === "1" && st.txs.open) {
    const keep = ["coalition_account", "deploy", "coalition_dusdc_storage"];
    (st.abandoned ??= []).push({ job: st.job, deadline_ms: st.deadline_ms, txs: Object.fromEntries(Object.entries(st.txs).filter(([k]) => !keep.includes(k))), buyers: st.buyers, why: process.env.JOBE_WHY ?? "" });
    st.txs = Object.fromEntries(Object.entries(st.txs).filter(([k]) => keep.includes(k)));
    for (const k of ["job", "deadline_ms", "standing", "openings"]) delete st[k];
    st.purchases = {};
    st.balances = {};
    st.round = (st.round ?? 1) + 1;
    save();
  }
  const tag = st.round > 1 ? `jobe${st.round}` : "jobe";
  const agents = { a: keyFromSeed(seedFile(`${tag}-agent-m01a.seed`)), b: keyFromSeed(seedFile(`${tag}-agent-m01b.seed`)), h: keyFromSeed(seedFile("jobd-agent-h05.seed")) };
  const buyersDir = join(dir, "buyers");
  mkdirSync(buyersDir, { recursive: true });
  const { issue } = await import("./model-buy.mjs");
  const nearAi = (base) => issue(client, c.bazaar, base, "fixtures/proofs.json", c.keysDir);
  const agentSend = (k, receiver, method, args, gas = 60n * TGAS) => send(client, { signer_id: agents[k].pub, key: agents[k], receiver_id: receiver, actions: [fc(method, args, 0n, gas)] });
  const leadCall = async (name, receiver, method, args, deposit = 0n, gas = 100n * TGAS) => record(name, st.lead, await send(client, { signer_id: st.lead, key: lead, receiver_id: receiver, actions: [fc(method, args, deposit, gas)] }));
  const snapshot = async (when) => {
    st.balances[when] = {};
    for (const a of [st.lead, ...Object.values(st.members), st.treasury, st.coalition]) st.balances[when][a] = String(await client.view(c.dusdc, "ft_balance_of", { account_id: a }));
    save();
    console.log(`   dUSDC ${when}: ${Object.entries(st.balances[when]).map(([a, b]) => `${a.split(".")[0]} ${Number(b) / 1e6}`).join(", ")}`);
  };

  console.log(`1. deploy coalition version 3 to ${st.coalition} (treasury ${st.treasury})`);
  const ck = keyFromSeed(seedFile(`${st.coalition}.seed`));
  if (!(await client.account(st.coalition))) record("coalition_account", c.treasury, await send(client, { signer_id: c.treasury, key: treasury, receiver_id: st.coalition, actions: [{ type: "CreateAccount" }, { type: "Transfer", deposit: near(3) }, { type: "AddKey", public_key_hex: ck.pub, permission: "FullAccess" }] }));
  if (!done("deploy")) {
    const code = readFileSync("target/near/bookerbob_coalition.wasm");
    record("deploy", st.coalition, await send(client, { signer_id: st.coalition, key: ck, receiver_id: st.coalition, actions: [{ type: "DeployContract", code }, fc("new", { token: c.dusdc, bazaar: c.bazaar, treasury: st.treasury }, 0n, 30n * TGAS)] }));
    st.wasm_sha256 = execFileSync("shasum", ["-a", "256", "target/near/bookerbob_coalition.wasm"], { encoding: "utf8" }).split(" ")[0];
    save();
  }
  if (!(await client.view(c.dusdc, "storage_balance_of", { account_id: st.coalition }))) record("coalition_dusdc_storage", c.treasury, await send(client, { signer_id: c.treasury, key: treasury, receiver_id: c.dusdc, actions: [fc("storage_deposit", { account_id: st.coalition, registration_only: true }, 1250n * 10n ** 18n, 30n * TGAS)] }));
  st.buyers = { m01a: agents.a.pub, m01b: agents.b.pub, h05: agents.h.pub };
  st.h05_purchase = { nullifier: d0.purchases.h05.nullifier, from: "job D", announced_in_d: d0.txs.announce_h05.hash };
  save();

  console.log("2. the live standing tree");
  const sp = JSON.parse(execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", "standing-proofs", c.liveInput], { encoding: "utf8" }));
  const onChain = await client.view(c.bazaar, "standing_root", {});
  if (sp.standing_root !== onChain?.[0]) throw new Error(`the input's tree ${sp.standing_root.slice(0, 8)} is not the bazaar's ${String(onChain?.[0]).slice(0, 8)}`);
  st.standing ??= onChain;
  st.openings ??= sp.proofs.filter((p) => Object.values(st.members).includes(p.merchant));
  save();

  console.log("3. open job E (hoodie leg for m01, hotel-lisbon leg for h05; three named agents) and fund it");
  st.budget = String(E_BUDGET);
  if (!done("open")) {
    st.deadline_ms = Date.now() + Number(process.env.JOBE_MINUTES ?? 20) * 60_000;
    const r = await leadCall("open", st.coalition, "open_job", { legs: E_LEGS.map(([, cat, max]) => ({ category: cat, max_price: max })), bond: String(BOND), budget: st.budget, min_top_pct: 100, deadline_ms: st.deadline_ms, buyers: Object.values(st.buyers) }, 20n * MILLI, 30n * TGAS);
    st.job = r.value;
    save();
  }
  if (!done("fund")) await leadCall("fund", c.dusdc, "ft_transfer_call", { receiver_id: st.coalition, amount: st.budget, msg: JSON.stringify({ fund: st.job }) }, 1n);

  console.log("4. m01 and h05 join");
  if (!st.balances.before) await snapshot("before");
  const joinArgs = (leg, price, proof) => ({ receiver_id: st.coalition, amount: String(BOND), msg: JSON.stringify({ join: { job: st.job, leg, price, proof } }) });
  for (const [i, [name, , quote]] of E_LEGS.entries()) {
    const m = st.members[name];
    for (let k = 0; k < 3 && !done(`join_${name}`); k++) {
      const r = nearCli(m, c.dusdc, "ft_transfer_call", joinArgs(i, quote, st.openings.find((p) => p.merchant === m)), "1 yoctoNEAR");
      if (r.ok) record(`join_${name}`, m, r);
      else if (r.hash) throw new Error(`join_${name}: ${r.error}`);
    }
    if (!done(`join_${name}`)) throw new Error(`join_${name}: the CLI never sent it`);
  }
  const j = await client.view(st.coalition, "job", { job: st.job });
  if (!j.seats.every((x) => x && !x.pending)) throw new Error("not every member was admitted: see the join txs");

  console.log("5. agent a buys from m01 and announces; agent b tries a's purchase, then announces its own and never settles; a settles");
  // Agent b: buys from m01 and never settles; tries to announce the h05 agent's purchase (refused:
  // not its agent), then announces its own on m01's leg.
  const agentB = async () => {
    if (!st.purchases.m01b) {
      const hold = {};
      try {
        await buyFrom(st.members.m01, process.env, {
          seed: seedFile(`${tag}-agent-m01b.seed`),
          testersDir: buyersDir,
          nearAi,
          beforeSettle: async ({ rec: rb }) => {
            Object.assign(hold, { tester: rb.tester, nullifier: rb.nullifier, price: String(rb.price), txs: { ...rb.txs }, settled: false, verdict_path: "near-ai" });
            throw new Error("NO_SETTLE");
          },
        });
      } catch (e) {
        if (e.message !== "NO_SETTLE") throw e;
      }
      st.purchases.m01b = hold;
      save();
    }
    if (!done("hijack_b")) refusedAs("hijack_b", agents.b.pub, await agentSend("b", st.coalition, "announce", { job: st.job, leg: 1, nullifier: st.h05_purchase.nullifier }), REFUSE_NOT_AGENT);
    if (!done("announce_b")) record("announce_b", agents.b.pub, await agentSend("b", st.coalition, "announce", { job: st.job, leg: 0, nullifier: st.purchases.m01b.nullifier }));
  };
  if (!st.purchases.m01a) {
    const rec = await buyFrom(st.members.m01, process.env, {
      seed: seedFile(`${tag}-agent-m01a.seed`),
      testersDir: buyersDir,
      nearAi,
      beforeSettle: async ({ rec: r }) => {
        st.purchases.m01a = { tester: r.tester, nullifier: r.nullifier, price: String(r.price), txs: { ...r.txs }, settled: false };
        save();
        if (!done("announce_a")) record("announce_a", agents.a.pub, await agentSend("a", st.coalition, "announce", { job: st.job, leg: 0, nullifier: r.nullifier }));
        await agentB();
      },
    });
    st.purchases.m01a = { ...rec, settled: true };
    save();
  } else if (!st.purchases.m01a.settled) {
    // Resumed after a's announce: b's part, then a settles its own purchase directly (it holds
    // the escrow and the referee receipt; the demo would relay the same call).
    await agentB();
    // A direct call prepays its gas (150 Tgas is 0.15 NEAR at the current price): the treasury tops the agent up.
    if (!done("topup_a")) record("topup_a", c.treasury, await send(client, { signer_id: c.treasury, key: treasury, receiver_id: agents.a.pub, actions: [{ type: "Transfer", deposit: near(0.1) }] }));
    const ref = `coal-e-${randomBytes(3).toString("hex")}`;
    const r = await agentSend("a", c.bazaar, "settle_demo", { nullifier: st.purchases.m01a.nullifier, merchant: st.members.m01, checkout_ref: ref, amount: st.purchases.m01a.price }, 150n * TGAS);
    console.log(`   ${r.ok ? "ok" : "FAILED"} settle_a  ${r.hash ? link(r.hash) : ""}${r.ok ? "" : `\n   ${r.error}`}`);
    if (!r.ok || r.logs.some((l) => l.includes("settle_reverted"))) throw new Error(`settle_a: ${r.error ?? "reverted"}`);
    st.purchases.m01a = { ...st.purchases.m01a, settled: true, checkout_ref: ref, txs: { ...(st.purchases.m01a.txs ?? {}), settle: r.hash }, settle_signer: agents.a.pub };
    save();
  }

  console.log("6. job D's h05 agent announces its unspent purchase from job D; it never settles");
  if (!done("announce_h05")) record("announce_h05", agents.h.pub, await agentSend("h", st.coalition, "announce", { job: st.job, leg: 1, nullifier: st.h05_purchase.nullifier }));

  console.log("7. m01 shows its leg delivered with a's purchase, the first one announced");
  if (!done("deliver_m01")) {
    const args = { job: st.job, leg: 0, nullifier: st.purchases.m01a.nullifier };
    const r = nearCli(st.members.m01, st.coalition, "deliver", args, "0 NEAR", "60.0 Tgas");
    if (r.ok || r.hash) record("deliver_m01", st.members.m01, r);
    else await leadCall("deliver_m01", st.coalition, "deliver", args, 0n, 60n * TGAS);
  }

  for (const ab of st.abandoned ?? []) {
    if (ab.txs.finalize || Date.now() < ab.deadline_ms) continue;
    const r = await send(client, { signer_id: st.lead, key: lead, receiver_id: st.coalition, actions: [fc("finalize", { job: ab.job }, 0n, 200n * TGAS)] });
    console.log(`   ${r.ok ? "ok" : "FAILED"} finalize the set-aside job ${ab.job}  ${r.hash ? link(r.hash) : ""}`);
    if (r.ok) ab.txs.finalize = { hash: r.hash, signer: st.lead };
    save();
  }

  console.log("8. finalize after the deadline");
  const wait = st.deadline_ms - Date.now() + 5000;
  if (wait > 0 && !done("finalize")) {
    console.log(`   waiting ${Math.ceil(wait / 1000)} s for the deadline`);
    await new Promise((ok) => setTimeout(ok, wait));
  }
  if (!done("finalize")) await leadCall("finalize", st.coalition, "finalize", { job: st.job }, 0n, 200n * TGAS);
  await snapshot("after_finalize");
  st.date = new Date().toISOString().slice(0, 10);
  save();
  console.log(`\ncoalition-live jobe: PASS  wrote ${JOBE}`);
}

/** Public check of job E on version 3. */
export async function verifyJobE(view, tx, blockMs, account, st = JSON.parse(readFileSync(JOBE, "utf8"))) {
  const lines = [];
  const T = (name) => tx(st.txs[name].hash, st.txs[name].signer);
  const when = async (t) => blockMs(t.transaction_outcome.block_hash);
  const cfg = await view(st.coalition, "config", {});
  const code = account ? await codeHex((await account(st.coalition))?.code_hash ?? "") : null;
  const dep = await T("deploy");
  const init = dep.transaction.actions.find((a) => a.FunctionCall)?.FunctionCall;
  const initArgs = init ? JSON.parse(Buffer.from(init.args, "base64").toString()) : null;
  const deployOk = st.txs.deploy.signer === st.coalition && dep.transaction.receiver_id === st.coalition && dep.transaction.actions.some((a) => a.DeployContract) && init?.method_name === "new" && initArgs?.treasury === st.treasury && initArgs?.bazaar === st.bazaar && initArgs?.token === st.dusdc && failure(dep) === '""';
  lines.push([code === st.wasm_sha256 && deployOk && cfg?.version === "3.0.0" && cfg?.treasury === st.treasury && cfg?.bazaar === st.bazaar && cfg?.token === st.dusdc, `${st.coalition} runs code sha256 ${String(code).slice(0, 12)}.. (view_account), the version 3 wasm recorded at its deploy (${st.txs.deploy.hash.slice(0, 8)}..: DeployContract and new with treasury ${initArgs?.treasury})`]);
  const open = await T("open");
  const o = coal(open, st.coalition, "job_opened")[0];
  const buyers = [st.buyers.m01a, st.buyers.m01b, st.buyers.h05];
  lines.push([o?.job === st.job && o?.buyer === st.lead && o?.deadline_ms === st.deadline_ms && JSON.stringify(o?.buyers) === JSON.stringify(buyers) && o?.legs?.map((l) => l.category).join() === E_LEGS.map((l) => l[1]).join(), `the lead opened job ${st.job} naming 3 buyer agents, legs ${E_LEGS.map((l) => l[1]).join(", ")}, deadline as recorded`]);
  lines.push(await liveTreeLine(tx, st));
  let joinsOk = true;
  const ranks = [];
  for (const [leg, [name, cat, quote]] of E_LEGS.entries()) {
    const r = await joinCheck(tx, st.txs[`join_${name}`], st.coalition, st.bazaar, st.job, leg, st.members[name], LIVE_TREE.n, LIVE_TREE.standing_root);
    joinsOk &&= r.ok && r.joined?.category === cat && r.joined?.price === quote;
    ranks.push(`${name}#${r.rank}`);
  }
  lines.push([joinsOk, `m01 and h05 admitted by in_top (true in each join tx) with proofs whose paths hash to the pinned root ${LIVE_TREE.standing_root.slice(0, 8)}.., ranks ${ranks.join(" ")}`]);
  const hj = await T("hijack_b");
  const dup = st.txs.dup_b ? await T("dup_b") : { transaction_outcome: { outcome: { status: {} } }, receipts_outcome: [] };
  lines.push([
    failure(hj).includes(REFUSE_NOT_AGENT) && st.txs.hijack_b.signer === st.buyers.m01b && callArgs(hj)?.nullifier === st.h05_purchase.nullifier && callArgs(hj)?.job === st.job && failure(dup).includes("purchase already announced in this job") && callArgs(dup)?.nullifier === st.purchases.m01a.nullifier && st.txs.dup_b?.signer === st.buyers.m01b,
    `refused on chain: named agent b announcing the h05 agent's purchase: ${REFUSE_NOT_AGENT} (${st.txs.hijack_b.hash.slice(0, 8)}..); b announcing a's purchase again: already announced in this job (${String(st.txs.dup_b?.hash).slice(0, 8)}..)`,
  ]);
  const [ta, tb] = [await T("announce_a"), await T("announce_b")];
  const [ea, eb] = [coal(ta, st.coalition, "announced")[0], coal(tb, st.coalition, "announced")[0]];
  const settle = await tx(st.purchases.m01a.txs.settle, st.purchases.m01a.settle_signer ?? st.relayer);
  const [ma, mb, ms] = [await when(ta), await when(tb), await when(settle)];
  const va = await view(st.bazaar, "verdict", { nullifier: st.purchases.m01a.nullifier });
  const vb = await view(st.bazaar, "verdict", { nullifier: st.purchases.m01b.nullifier });
  const annOk = ea?.leg === 0 && ea?.nullifier === st.purchases.m01a.nullifier && ea?.buyer_agent === st.buyers.m01a && st.txs.announce_a.signer === st.buyers.m01a && eb?.leg === 0 && eb?.nullifier === st.purchases.m01b.nullifier && eb?.buyer_agent === st.buyers.m01b && st.txs.announce_b.signer === st.buyers.m01b;
  lines.push([annOk && ma < mb && mb < ms && isSettle(settle, st.bazaar, st.purchases.m01a.nullifier, st.buyers.m01a) && va?.spent && vb?.spent === false, `leg 0 holds two announces, each by its own agent: a's (${st.txs.announce_a.hash.slice(0, 8)}..) then b's (${st.txs.announce_b.hash.slice(0, 8)}..); a's settled after both, b's never settled`]);
  const d = coal(await T("deliver_m01"), st.coalition, "delivered")[0];
  lines.push([d?.job === st.job && d?.leg === 0 && d?.member === st.members.m01 && d?.nullifier === st.purchases.m01a.nullifier && d?.buyer_agent === st.buyers.m01a && va?.paid, `m01 delivered leg 0 with a's purchase, the earlier announce (${st.txs.deliver_m01.hash.slice(0, 8)}..); version 2 had replaced it with b's`]);
  const th = await T("announce_h05");
  const eh = coal(th, st.coalition, "announced")[0];
  const vh = await view(st.bazaar, "verdict", { nullifier: st.h05_purchase.nullifier });
  lines.push([eh?.leg === 1 && eh?.member === st.members.h05 && eh?.nullifier === st.h05_purchase.nullifier && eh?.buyer_agent === st.buyers.h05 && st.txs.announce_h05.signer === st.buyers.h05 && vh?.spent === false && (await when(th)) > (await when(open)), `h05's leg: job D's h05 agent announced its unspent purchase (${st.txs.announce_h05.hash.slice(0, 8)}..); it never settled: a no-show`]);
  const fin = await T("finalize");
  const f = coal(fin, st.coalition, "job_finalized")[0];
  const pays = fts(fin, st.dusdc).filter((x) => x.old_owner_id === st.coalition);
  const got = (a) => pays.filter((x) => x.new_owner_id === a).reduce((s, x) => s + BigInt(x.amount), 0n);
  const want = splitV3(BigInt(st.budget), BOND, [[st.members.m01, 48_000_000n, "delivered"], [st.members.h05, 450_000_000n, "no_show"]]);
  const ok = f?.job === st.job && f?.status === "failed" && f.slashed?.length === 1 && f.slashed[0].member === st.members.h05 && f.delivered?.length === 1 && f.treasury === st.treasury && got(st.members.m01) === want.pay[st.members.m01] && got(st.lead) === want.buyer && got(st.treasury) === want.treasury && f.to_treasury === String(want.treasury) && got(st.members.h05) === 0n;
  lines.push([ok, `finalize: h05 slashed ${Number(BOND) / 1e6}, half to the lead and half to the treasury (${Number(want.treasury) / 1e6}); m01 ${Number(want.pay[st.members.m01]) / 1e6} (bond and budget share, nothing from the slash); the lead ${Number(want.buyer) / 1e6}`]);
  const finals = [fin];
  for (const ab of st.abandoned ?? []) {
    const t = await tx(ab.txs.finalize.hash, ab.txs.finalize.signer);
    const fa = coal(t, st.coalition, "job_finalized")[0];
    const paidA = fts(t, st.dusdc).filter((x) => x.old_owner_id === st.coalition);
    const back = (a) => paidA.filter((x) => x.new_owner_id === a).reduce((s2, x) => s2 + BigInt(x.amount), 0n);
    const okA = fa?.job === ab.job && fa?.delivered?.length === 0 && fa?.slashed?.length === 0 && fa?.released?.length === 2 && back(st.members.m01) === BOND && back(st.members.h05) === BOND && back(st.lead) === BigInt(st.budget);
    lines.push([okA, `the set-aside job ${ab.job} (no purchase announced: ${ab.why.split(":")[0]}) finalized with both members released: bonds back, the budget back to the lead`]);
    finals.push(t);
  }
  const want2 = tally(finals, st.coalition);
  const recs = await Promise.all(Object.keys(want2).map((a) => view(st.coalition, "member", { account: a })));
  lines.push([Object.keys(want2).length === 2 && Object.keys(want2).every((a, i) => recs[i]?.joined === want2[a].joined && recs[i]?.completed === want2[a].completed && recs[i]?.slashed === want2[a].slashed && recs[i]?.released === want2[a].released), `version 3 member records equal the finalize events exactly: ${Object.keys(want2).map((a, i) => `${a.split(".")[0]} completed ${recs[i]?.completed}, slashed ${recs[i]?.slashed}`).join("; ")}`]);
  return lines;
}

export function config(env) {
  const bazaar = env.BAZAAR_ACCOUNT_ID || "bookerbob.testnet";
  const treasury = env.DEMO_TREASURY_ID || "bookerbob-demo.testnet";
  return {
    rpc: env.NEAR_RPC || "https://test.rpc.fastnear.com",
    bazaar,
    treasury,
    dusdc: env.DUSDC_CONTRACT_ID || "bookerbob-dusdc.testnet",
    coalition: env.COALITION_ID || `coalition.${treasury}`,
    coalitionV2: env.COALITION_V2_ID || `coalition-v2.${treasury}`,
    coalitionV3: env.COALITION_V3_ID || `coalition-v3.${treasury}`,
    liveInput: env.LIVE_INPUT || "fixtures/zk/standing-live-input.json",
    keysDir: env.KEYS_DIR || join(process.env.HOME, ".rep-secrets", "bookerbob-testnet"),
    graphInput: env.GRAPH_INPUT || "fixtures/zk/standing-testnet-3-input.json",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = config(process.env);
  for (const a of [c.bazaar, c.treasury, c.dusdc, c.coalition, c.coalitionV2, c.coalitionV3]) if (!a.endsWith(".testnet")) throw new Error(`${a} is not a .testnet account`);
  const cmd = process.argv[2];
  if (cmd === "plan") {
    for (const [i, [id, t]] of plan(c).entries()) console.log(`${String(i + 1).padStart(2)}  ${id.padEnd(9)} ${t}`);
  } else if (cmd === "run") {
    await run(c).catch((e) => {
      console.error(`coalition-live: FAIL ${e.message}`);
      process.exit(1);
    });
  } else if (cmd === "reprove" || cmd === "reprove-finalize") {
    await reprove(c, cmd === "reprove-finalize").catch((e) => {
      console.error(`coalition-live ${cmd}: FAIL ${e.message}`);
      process.exit(1);
    });
  } else if (cmd === "jobc") {
    await jobC(c).catch((e) => {
      console.error(`coalition-live jobc: FAIL ${e.message}`);
      process.exit(1);
    });
  } else if (cmd === "jobd") {
    await jobD(c).catch((e) => {
      console.error(`coalition-live jobd: FAIL ${e.message}`);
      process.exit(1);
    });
  } else if (cmd === "jobe") {
    await jobE(c).catch((e) => {
      console.error(`coalition-live jobe: FAIL ${e.message}`);
      process.exit(1);
    });
  } else if (cmd === "verify") {
    if (!existsSync(OUT)) {
      console.log("coalition-live: not run live yet");
      process.exit(0);
    }
    const { rpcClient } = await import("../relayer/near.mjs");
    const client = rpcClient(c.rpc);
    const tx = async (h, s) => (await client.rpc("tx", { tx_hash: h, sender_account_id: s, wait_until: "FINAL" })).result;
    const v = (a, m, args) => client.view(a, m, args);
    const lines = await verifyRun(v, tx);
    const account = (a) => client.account(a);
    if (existsSync(JOBC) && existsSync(REPROVE) && JSON.parse(readFileSync(JOBC, "utf8")).txs?.finalize) lines.push(...(await verifyJobC(v, tx, undefined, undefined, account)));
    const blockMs = async (h) => Math.floor(Number((await client.rpc("block", { block_id: h })).result.header.timestamp) / 1e6);
    if (existsSync(JOBD) && JSON.parse(readFileSync(JOBD, "utf8")).txs?.finalize) lines.push(...(await verifyJobD(v, tx, blockMs, undefined, account)));
    if (existsSync(JOBE) && JSON.parse(readFileSync(JOBE, "utf8")).txs?.finalize) lines.push(...(await verifyJobE(v, tx, blockMs, account)));
    for (const [ok, t] of lines) console.log(`${ok ? "PASS" : "FAIL"}  ${t}`);
    process.exit(lines.every(([ok]) => ok) ? 0 : 1);
  } else {
    console.error("usage: coalition-live.mjs plan|run|reprove|reprove-finalize|jobc|jobd|jobe|verify");
    process.exit(2);
  }
}
