#!/usr/bin/env node
// The community round: anyone bids blind as a merchant on NEAR testnet, on their own account
// and their own key. Needs Node 22 and this repo; no install, no wallet, no key of ours.
//
//   node scripts/community.mjs bid <name> <price>   a fresh account <name>.testnet from the public
//                                                   faucet (its key stays on your disk), 100 dUSDC
//                                                   minted, a 10 dUSDC bond, one sealed bid
//   node scripts/community.mjs reveal <name>        after the bid deadline: open your bid
//   node scripts/community.mjs board                who bid, who revealed, the prices, the winner
//   node scripts/community.mjs open <round> <bid_hours> <reveal_hours>   the bazaar owner only
//
// Bring your own account instead of a faucet one: JOIN_ACCOUNT=<you>.testnet
// JOIN_KEY_FILE=<near-cli credentials JSON or a hex seed file> in front of bid and reveal.
//
// The rules, all of them enforced by the contract at bookerbob.testnet:
// - before the bid deadline only a hash of your price is public; nobody can read it, us included
// - after the deadline you reveal; a price that does not match your hash is refused
// - the lowest revealed price wins the round's buyer
// - a bid that is never revealed costs 1 dUSDC of the bond and bars the account for 24 hours
// dUSDC is a testnet demo token with no value. Nothing here can take or pay real money.
// Your key and your bid's salt are in ~/.bookerbob-community/<name>.json: keep the file until
// you have revealed.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keyFromSeed, nearPublicKey, rpcClient, send } from "../relayer/near.mjs";
import { commitBidArgs, registerArgs, revealBidArgs, schedule, validate } from "../sdk/merchant.mjs";
import { ownAccount } from "./join-merchant.mjs";

const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const FAUCET = process.env.NEAR_FAUCET ?? "https://helper.nearprotocol.com/account";
const ROUND_FILE = "fixtures/live/community/round.json";
const HOME_DIR = process.env.COMMUNITY_DIR ?? join(homedir(), ".bookerbob-community");
const TGAS = 10n ** 12n;
const MILLI = 10n ** 21n;
const BOND = 10_000_000n;
const fc = (method_name, args, deposit = 0n, gas = 100n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const link = (h) => `https://testnet.nearblocks.io/txns/${h}`;
const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const left = (ms) => { const m = Math.max(0, Math.round((ms - Date.now()) / 60000)); return m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`; };

/** The round in play: COMMUNITY_ROUND and BAZAAR_ACCOUNT_ID, or the file written when it opened. */
export function roundConfig(env = process.env) {
  const file = existsSync(ROUND_FILE) ? JSON.parse(readFileSync(ROUND_FILE, "utf8")) : {};
  const c = { round: env.COMMUNITY_ROUND ?? file.round, bazaar: env.BAZAAR_ACCOUNT_ID ?? file.bazaar ?? "bookerbob.testnet", dusdc: env.DUSDC_CONTRACT_ID ?? file.dusdc ?? "bookerbob-dusdc.testnet" };
  for (const a of [c.bazaar, c.dusdc]) if (!a.endsWith(".testnet")) throw new Error(`${a} is not a .testnet account: this is testnet only`);
  if (!/testnet|test\.rpc/.test(RPC)) throw new Error(`RPC ${RPC} is not testnet`);
  return c;
}

/** A price like "33.5" as a flat schedule: the same price for every buyer. */
export function flatSchedule(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0.01 || n > 10000) throw new Error("price: a number from 0.01 to 10000, like 33.5");
  const s = schedule({ basePrice: Math.round(n * 1e6), rules: [], capBps: 0 });
  const bad = validate(s);
  if (bad) throw new Error(`price: ${bad}`);
  return s;
}

export const accountName = (name) => {
  if (!/^[a-z0-9][a-z0-9-]{3,30}[a-z0-9]$/.test(name ?? "")) throw new Error("name: 5 to 32 of a-z 0-9 -, like quiet-otter-7");
  return `${name}.testnet`;
};

async function main() {
  const [cmd, a1, a2, a3] = process.argv.slice(2);
  const c = roundConfig();
  const client = rpcClient(RPC);
  const say = (step, r) => {
    console.log(`   ${r.ok ? "ok" : "FAILED"} ${step}  ${link(r.hash)}${r.ok ? "" : `\n   ${r.error}`}`);
    if (!r.ok) throw new Error(`${step}: ${r.error}`);
    return r;
  };
  const roundInfo = async () => {
    if (!c.round) throw new Error("no round is open yet (fixtures/live/community/round.json is missing; pull the repo or set COMMUNITY_ROUND)");
    const r = await client.view(c.bazaar, "round", { round_id: c.round });
    if (!r) throw new Error(`round ${c.round} is not on ${c.bazaar}`);
    return r;
  };

  if (cmd === "open") {
    const [round, bidH, revealH] = [a1, Number(a2), Number(a3)];
    if (!round || !(bidH > 0) || !(revealH > 0)) throw new Error("open <round> <bid_hours> <reveal_hours>");
    const commit_until_ms = Date.now() + Math.round(bidH * 3600e3);
    const reveal_until_ms = commit_until_ms + Math.round(revealH * 3600e3);
    const o = spawnSync("near", ["contract", "call-function", "as-transaction", c.bazaar, "open_round", "json-args", JSON.stringify({ round_id: round, category: "open", commit_until_ms, reveal_until_ms }), "prepaid-gas", "30.0 Tgas", "attached-deposit", "0 NEAR", "sign-as", c.bazaar, "network-config", "testnet-fastnear", "sign-with-keychain", "send"], { encoding: "utf8" });
    const tx = `${o.stdout}${o.stderr}`.match(/Transaction ID: (\w+)/)?.[1];
    if (o.status !== 0 || !tx) throw new Error(`open_round failed: ${`${o.stdout}${o.stderr}`.slice(-300)}`);
    mkdirSync("fixtures/live/community", { recursive: true });
    writeFileSync(ROUND_FILE, JSON.stringify({ note: "the community round: anyone bids blind on their own testnet account and key (docs/community-round.md). dUSDC is a testnet demo token with no value.", round, bazaar: c.bazaar, dusdc: c.dusdc, commit_until_ms, reveal_until_ms, bids_close: when(commit_until_ms), reveals_close: when(reveal_until_ms), open_tx: tx }, null, 2) + "\n");
    writeFileSync("agents/community.json", readFileSync(ROUND_FILE, "utf8"));
    console.log(`   ok open_round ${round} on ${c.bazaar}  ${link(tx)}\n   bids until ${when(commit_until_ms)} UTC, reveals until ${when(reveal_until_ms)} UTC\n   wrote ${ROUND_FILE} and agents/community.json (the round page reads it): commit and push both so that a fresh clone finds the round`);
    return;
  }

  if (cmd === "board") {
    const r = await roundInfo();
    const now = Date.now();
    const phase = now < r.commit_until_ms ? `bids open for ${left(r.commit_until_ms)} more (until ${when(r.commit_until_ms)} UTC)` : now < r.reveal_until_ms ? `bids closed; reveals open for ${left(r.reveal_until_ms)} more (until ${when(r.reveal_until_ms)} UTC)` : "closed";
    console.log(`round ${c.round} on ${c.bazaar}: ${phase}\n${r.commits.length} sealed bids, ${r.revealed.length} revealed\n`);
    const rows = [];
    for (const [who, hash] of r.commits) {
      const shown = r.revealed.includes(who);
      const price = shown ? Number((await client.view(c.bazaar, "merchant", { merchant: who })).schedule.base_price) / 1e6 : null;
      rows.push({ who, hash, price });
    }
    rows.sort((x, y) => (x.price ?? Infinity) - (y.price ?? Infinity));
    for (const x of rows) console.log(`  ${x.who.padEnd(44)} ${x.price === null ? `sealed  ${x.hash.slice(0, 16)}..` : x.price.toFixed(2)}`);
    if (now >= r.reveal_until_ms) {
      const best = rows.find((x) => x.price !== null);
      const silent = rows.filter((x) => x.price === null).map((x) => x.who);
      console.log(`\n${best ? `lowest revealed price: ${best.who} at ${best.price.toFixed(2)}` : "no bid was revealed"}${silent.length ? `\nnever revealed (anyone may call mark_unrevealed within 24 hours of the deadline): ${silent.join(", ")}` : ""}`);
    }
    return;
  }

  if (cmd !== "bid" && cmd !== "reveal") {
    console.error("usage: community.mjs bid <name> <price> | reveal <name> | board | open <round> <bid_hours> <reveal_hours>");
    process.exit(2);
  }

  const own = ownAccount(process.env);
  const id = own ? own.id : accountName(a1);
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  const statePath = join(HOME_DIR, `${id}.json`);
  const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { account: id, txs: {} };
  const save = () => writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n", { mode: 0o600 });
  const r = await roundInfo();

  if (cmd === "bid") {
    const s = flatSchedule(a2);
    if (Date.now() >= r.commit_until_ms) throw new Error(`bids for ${c.round} closed at ${when(r.commit_until_ms)} UTC`);
    if (r.commits.some(([who]) => who === id)) throw new Error(`${id} already has a sealed bid in ${c.round}: one bid per account, and it cannot be changed`);
    let key;
    if (own) key = own.key;
    else if (st.seed) key = keyFromSeed(st.seed);
    else {
      if (await client.account(id)) throw new Error(`${id} is taken on testnet: pick another name`);
      st.seed = randomBytes(32).toString("hex");
      save();
      key = keyFromSeed(st.seed);
      const f = await fetch(FAUCET, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: nearPublicKey(key.pub) }) });
      if (!f.ok) throw new Error(`the testnet faucet refused to create ${id}: HTTP ${f.status} ${(await f.text()).slice(0, 160)}`);
      for (let i = 0; i < 20 && !(await client.account(id)); i++) await new Promise((ok) => setTimeout(ok, 1500));
      console.log(`   ok ${id} created by the public testnet faucet; its key is in ${statePath}`);
    }
    if (!(await client.account(id))) throw new Error(`${id} does not exist on testnet`);
    const me = (receiver_id, actions) => send(client, { signer_id: id, key, receiver_id, actions });
    if (!(await client.view(c.dusdc, "storage_balance_of", { account_id: id }))) st.txs.storage = say("dUSDC storage_deposit", await me(c.dusdc, [fc("storage_deposit", {}, 1250n * 10n ** 18n, 30n * TGAS)])).hash;
    const m0 = await client.view(c.bazaar, "merchant", { merchant: id });
    if (!m0?.approved && BigInt(await client.view(c.dusdc, "ft_balance_of", { account_id: id })) < BOND) st.txs.mint = say("mint 100 dUSDC (a test token, no value)", await me(c.dusdc, [fc("mint", {}, 0n, 30n * TGAS)])).hash;
    // The schedule registered now is a placeholder at the top of the range: the real price is
    // only in the sealed bid and replaces it at reveal.
    if (!m0) st.txs.register = say("register_merchant, category open", await me(c.bazaar, [fc("register_merchant", registerArgs(flatSchedule(10000), "open"), 20n * MILLI, 30n * TGAS)])).hash;
    if (!m0?.approved) st.txs.bond = say("bond 10 dUSDC: approved by the bond, no owner step", await me(c.dusdc, [fc("ft_transfer_call", { receiver_id: c.bazaar, amount: String(BOND), msg: "bond" }, 1n, 100n * TGAS)])).hash;
    if (!(await client.view(c.bazaar, "merchant", { merchant: id }))?.approved) throw new Error(`${id} was not approved by its bond`);
    st.round = c.round;
    st.schedule = s;
    st.salt = randomBytes(32).toString("hex");
    save();
    st.txs.commit = say(`sealed bid in ${c.round}: only a hash is public`, await me(c.bazaar, [fc("commit_bid", commitBidArgs(c.round, id, s, Buffer.from(st.salt, "hex")), 20n * MILLI, 30n * TGAS)])).hash;
    save();
    console.log(`\n${id}: your bid of ${Number(s.base_price) / 1e6} is sealed.\nCome back between ${when(r.commit_until_ms)} and ${when(r.reveal_until_ms)} UTC and run:\n   ${own ? "JOIN_ACCOUNT=... JOIN_KEY_FILE=... " : ""}node scripts/community.mjs reveal ${a1}\nKeep ${statePath}: without it the bid cannot be opened and the bond loses 1 dUSDC.`);
  } else {
    if (!st.salt || st.round !== c.round) throw new Error(`no sealed bid of ${id} for ${c.round} in ${statePath}`);
    if (r.revealed.includes(id)) return console.log(`${id} has already revealed in ${c.round}`);
    const now = Date.now();
    if (now < r.commit_until_ms) return console.log(`too early: bids are open for ${left(r.commit_until_ms)} more. Reveal between ${when(r.commit_until_ms)} and ${when(r.reveal_until_ms)} UTC.`);
    if (now >= r.reveal_until_ms) throw new Error(`reveals for ${c.round} closed at ${when(r.reveal_until_ms)} UTC`);
    const key = own ? own.key : keyFromSeed(st.seed);
    st.txs.reveal = say(`reveal_bid in ${c.round}: ${Number(st.schedule.base_price) / 1e6}`, await send(client, { signer_id: id, key, receiver_id: c.bazaar, actions: [fc("reveal_bid", revealBidArgs(c.round, st.schedule, Buffer.from(st.salt, "hex")), 20n * MILLI, 50n * TGAS)] })).hash;
    save();
    console.log(`\n${id}: revealed. The winner is known after ${when(r.reveal_until_ms)} UTC: node scripts/community.mjs board`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`community: ${e.message}`); process.exit(1); });
