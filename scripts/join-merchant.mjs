#!/usr/bin/env node
// `make join-merchant NAME=<name> [BASE=<usdc>] [DISCOUNT=<bps>]`: an outside merchant agent
// joins the open market on testnet with no owner approval: its own account, 100 dUSDC minted,
// `register_merchant` in the `open` category, a 10 dUSDC bond (ft_transfer_call, msg "bond")
// that approves it, then a sealed bid in the open round and its reveal after the deadline.
// dUSDC is a testnet demo token with no value; production bonds in Circle USDC.
//
//   node scripts/join-merchant.mjs join <name> [base_usdc] [discount_bps]   account, bond, approval
//   node scripts/join-merchant.mjs bid <name> <round_id>                    commit a sealed bid
//   node scripts/join-merchant.mjs reveal <name> <round_id>                 open it after the deadline
//   node scripts/join-merchant.mjs winner <round_id> <nullifier>            round_best_quote
// The open round itself is opened by the bazaar owner (open_round, category "open").
// Keys: KEYS_DIR/merchants/<account>.seed (outside the repo). Testnet only.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, guard } from "./demo-tester.mjs";
import { keyFromSeed, near, nearPublicKey, rpcClient, send } from "../relayer/near.mjs";
import { commitBidArgs, registerArgs, revealBidArgs, schedule } from "../sdk/merchant.mjs";

const TGAS = 10n ** 12n;
const MILLI = 10n ** 21n;
export const OPEN_BOND = 10_000_000n;
const fc = (method_name, args, deposit = 0n, gas = 100n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const link = (h) => `https://testnet.nearblocks.io/txns/${h}`;

export const merchantId = (c, name) => {
  if (!/^[a-z0-9-]{2,20}$/.test(name)) throw new Error("name: 2 to 20 of a-z 0-9 -");
  return `${name}.${c.treasury}`;
};

/** The merchant's schedule: base price, one discount for a proven world_id_human, a cap. */
export const openSchedule = (baseUsdc = 40, discountBps = 1000) => schedule({ basePrice: Math.round(baseUsdc * 1e6), rules: [{ predicate: "world_id_human", bps: discountBps }], capBps: discountBps });

async function main() {
  const c = config(process.env);
  const no = guard(c);
  if (no) {
    console.error(`refusing: ${no}`);
    process.exit(2);
  }
  const [cmd, a1, a2, a3] = process.argv.slice(2);
  const client = rpcClient(c.rpc);
  const dir = join(c.keysDir, "merchants");
  mkdirSync(dir, { recursive: true });
  const say = (step, r) => {
    console.log(`   ${r.ok ? "ok" : "FAILED"} ${step}  ${link(r.hash)}${r.ok ? "" : `\n   ${r.error}`}`);
    if (!r.ok) throw new Error(`${step}: ${r.error}`);
    return r;
  };
  if (cmd === "winner") {
    const q = await client.view(c.bazaar, "round_best_quote", { round_id: a1, nullifier: a2 });
    console.log(q ? `winner of ${a1}: ${q.merchant} at ${Number(q.quote.price) / 1e6}` : `no winner in ${a1}`);
    return;
  }
  const id = merchantId(c, a1);
  const seedPath = join(dir, `${id}.seed`);
  const statePath = join(dir, `${id}.json`);
  const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { merchant: id, txs: {} };
  const save = () => writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n", { mode: 0o600 });
  if (cmd === "join") {
    const treasury = keyFromSeed(readFileSync(join(c.keysDir, "treasury.seed"), "utf8"));
    let key;
    if (!(await client.account(id))) {
      const seed = randomBytes(32).toString("hex");
      writeFileSync(seedPath, seed + "\n", { mode: 0o600 });
      key = keyFromSeed(seed);
      st.txs.account = say(`create ${id} (0.2 NEAR, its own key ${nearPublicKey(key.pub)})`, await send(client, { signer_id: c.treasury, key: treasury, receiver_id: id, actions: [{ type: "CreateAccount" }, { type: "Transfer", deposit: near(0.2) }, { type: "AddKey", public_key_hex: key.pub, permission: "FullAccess" }] })).hash;
      save();
    } else key = keyFromSeed(readFileSync(seedPath, "utf8"));
    const me = (receiver_id, actions) => send(client, { signer_id: id, key, receiver_id, actions });
    if (!(await client.view(c.dusdc, "storage_balance_of", { account_id: id }))) st.txs.dusdc_storage = say("dUSDC storage_deposit", await me(c.dusdc, [fc("storage_deposit", {}, 1250n * 10n ** 18n, 30n * TGAS)])).hash;
    if (BigInt(await client.view(c.dusdc, "ft_balance_of", { account_id: id })) < OPEN_BOND) st.txs.mint = say("mint 100 dUSDC", await me(c.dusdc, [fc("mint", {}, 0n, 30n * TGAS)])).hash;
    st.schedule = openSchedule(Number(a2 ?? 40), Number(a3 ?? 1000));
    st.txs.register = say("register_merchant, category open", await me(c.bazaar, [fc("register_merchant", registerArgs(st.schedule, "open"), 20n * MILLI, 30n * TGAS)])).hash;
    const before = await client.view(c.bazaar, "merchant", { merchant: id });
    if (!before.approved) {
      const r = say("bond 10 dUSDC (ft_transfer_call msg bond)", await me(c.dusdc, [fc("ft_transfer_call", { receiver_id: c.bazaar, amount: String(OPEN_BOND), msg: "bond" }, 1n, 100n * TGAS)]));
      st.txs.bond = r.hash;
    }
    const after = await client.view(c.bazaar, "merchant", { merchant: id });
    st.approved = after.approved;
    save();
    console.log(`\n${id}: ${after.approved ? "approved by its bond, no owner step" : "NOT approved"}; schedule base ${Number(st.schedule.base_price) / 1e6}, ${st.schedule.rules[0].bps / 100}% off for world_id_human`);
    if (!after.approved) process.exit(1);
  } else if (cmd === "bid" || cmd === "reveal") {
    const key = keyFromSeed(readFileSync(seedPath, "utf8"));
    const me = (actions) => send(client, { signer_id: id, key, receiver_id: c.bazaar, actions });
    const round = a2;
    if (cmd === "bid") {
      st.salt = randomBytes(32).toString("hex");
      st.round = round;
      save();
      st.txs.commit = say(`commit_bid in ${round} (sealed: only a hash until the deadline)`, await me([fc("commit_bid", commitBidArgs(round, id, st.schedule, Buffer.from(st.salt, "hex")), 20n * MILLI, 30n * TGAS)])).hash;
    } else {
      // Reveal opens at the commit deadline: wait for it (node timer, no shell sleep).
      const r = await client.view(c.bazaar, "round", { round_id: round });
      const wait = r.commit_until_ms - Date.now() + 5000;
      if (wait > 0) {
        console.log(`   waiting ${Math.ceil(wait / 1000)} s for the commit deadline`);
        await new Promise((ok) => setTimeout(ok, wait));
      }
      st.txs.reveal = say(`reveal_bid in ${round}`, await me([fc("reveal_bid", revealBidArgs(round, st.schedule, Buffer.from(st.salt, "hex")), 20n * MILLI, 50n * TGAS)])).hash;
    }
    save();
  } else {
    console.error("usage: join-merchant.mjs join <name> [base_usdc] [discount_bps] | bid <name> <round> | reveal <name> <round> | winner <round> <nullifier>");
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`join-merchant: FAIL ${e.message}`); process.exit(1); });
