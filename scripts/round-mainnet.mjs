#!/usr/bin/env node
// The open round on NEAR mainnet (round mainnet-open-1), on the mainnet bazaar of
// scripts/mainnet-bazaar.mjs. Anyone bids with their own NEAR account and key: register in the
// round's category, get approved by BookerBob's watcher (no bond: the 10 USDC bond lane of the
// `open` category stays on testnet, see docs/round-mainnet.md), commit a sealed bid before the bid
// deadline, reveal after it. Our two merchant agents bid too. The lowest revealed price wins, and
// our buyer pays it in real Circle USDC against a NEAR AI verdict and a referee receipt.
//
//   node scripts/round-mainnet.mjs open --mainnet     owner: a function-call key for the watcher
//                                                     (open_round, approve_merchant; capped
//                                                     allowance), then open_round
//   node scripts/round-mainnet.mjs agents --mainnet   our two agents commit sealed bids
//   node scripts/round-mainnet.mjs watch --mainnet    approve registrations while bids are open;
//                                                     after the deadline our agents reveal and the
//                                                     time-locked reveals from the page are opened
//                                                     and relayed
//   node scripts/round-mainnet.mjs settle --mainnet   after reveals close: the buyer pays the winner
//   node scripts/round-mainnet.mjs bid <price>        a stranger, from a terminal:
//   node scripts/round-mainnet.mjs reveal                 JOIN_ACCOUNT=<you>.near JOIN_KEY_FILE=<file>
//   node scripts/round-mainnet.mjs board              keyless: who bid, who revealed, the prices
//   node scripts/round-mainnet.mjs check              keyless: re-read fixtures/mainnet/round.json
// Real money: every signing command except bid and reveal needs --mainnet and
// BOOKERBOB_MAINNET_GO=<today>.
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { keyFromSeed, nearPublicKey, rpcClient, send } from "../relayer/near.mjs";
import { bidCommitment } from "../sdk/merchant.mjs";
import { keyFromFile } from "./join-merchant.mjs";

const RPC = process.env.NEAR_MAINNET_RPC ?? "https://rpc.mainnet.fastnear.com";
const NB = "https://api.nearblocks.io/v3";
const BZ = JSON.parse(readFileSync("fixtures/mainnet/bazaar.json", "utf8"));
const B = BZ.bazaar, USDC = BZ.usdc, CATEGORY = BZ.category;
const OUT = "fixtures/mainnet/round.json";
const PAGE = "agents/round-mainnet.json";
const ROUND = process.env.MAINNET_ROUND ?? "mainnet-open-1";
const DIR = join(homedir(), ".rep-secrets", "bookerbob-mainnet");
const KEYS = join(DIR, "keys");
const TGAS = 10n ** 12n, MILLI = 10n ** 21n, NEAR = 10n ** 24n;
// The watcher's key may burn at most this much gas on the bazaar's account, enforced by NEAR.
const WATCHER_ALLOWANCE = 100n * MILLI;
// The buyer's budget: what it holds in USDC. Our agents bid inside it, so whoever wins, the price
// is at most our agents' lowest bid and the buyer can pay it.
const MAX_PRICE = 0.23;
const RELAYER_FUND = 50n * MILLI;
const BUYER_FLOOR = 400n * MILLI;
// At most this many approvals, and only for accounts that already registered with USDC (so a
// winner can be paid, and slots cost the filler a storage deposit).
const MAX_APPROVALS = 60;
const link = (h) => `https://nearblocks.io/txns/${h}`;
const fc = (method_name, args, deposit = 0n, gas = 50n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const seedKey = (n, make = false) => {
  const f = join(DIR, `${n}.seed`);
  if (!existsSync(f)) { if (!make) throw new Error(`no key ${f}`); writeFileSync(f, randomBytes(32).toString("hex") + "\n", { mode: 0o600 }); }
  return keyFromSeed(readFileSync(f, "utf8"));
};
const flat = (price) => {
  const n = Number(price);
  if (!Number.isFinite(n) || n < 0.01 || n > MAX_PRICE) throw new Error(`price: a number of USDC from 0.01 to ${MAX_PRICE}, like 0.15`);
  return { base_price: String(Math.round(n * 1e6)), rules: [], cap_bps: 0 };
};
const load = () => (existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null);
const gate = () => {
  const today = new Date().toISOString().slice(0, 10);
  if (!process.argv.includes("--mainnet") || process.env.BOOKERBOB_MAINNET_GO !== today) throw new Error(`real money: --mainnet and BOOKERBOB_MAINNET_GO=${today}`);
};

function recorder(rec) {
  const save = () => writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
  const tx = async (c, name, signer, key, receiver, actions) => {
    if (rec.txs[name]) { console.log(`skip ${name} (done)`); return { ok: true, hash: rec.txs[name] }; }
    const r = await send(c, { signer_id: signer, key, receiver_id: receiver, actions });
    console.log(`${r.ok ? "ok  " : "FAIL"} ${name}  ${link(r.hash)}${r.ok ? "" : `  ${String(r.error).slice(0, 300)}`}`);
    if (r.ok) { rec.txs[name] = r.hash; save(); }
    return r;
  };
  return { save, tx };
}

async function open(c) {
  gate();
  if (load()) throw new Error(`${OUT} exists: the round is open already`);
  const [closeIso, revealIso] = process.argv.slice(3).filter((x) => !x.startsWith("--"));
  const commit_until_ms = Date.parse(closeIso ?? "2026-11-14T21:30:00Z");
  const reveal_until_ms = Date.parse(revealIso ?? "2026-11-14T22:30:00Z");
  if (!(Date.now() < commit_until_ms && commit_until_ms < reveal_until_ms)) throw new Error("bad deadlines");
  const bz = seedKey("bazaar"), w = seedKey("watcher", true);
  const rec = {
    note: "The open round on NEAR mainnet: anyone bids with their own account and key. Accounts register in the round's category and BookerBob's watcher approves each one (a function-call key on the bazaar limited to open_round and approve_merchant); the 10 USDC bond lane of the open category stays on testnet. Sealed bids, revealed after the deadline, the lowest price wins, and our buyer pays it in Circle USDC. Check: node scripts/round-mainnet.mjs check",
    network: "mainnet", bazaar: B, usdc: USDC, round: ROUND, category: CATEGORY, commit_until_ms, reveal_until_ms,
    bids_close: when(commit_until_ms), reveals_close: when(reveal_until_ms), max_price_usdc: MAX_PRICE,
    watcher_key: nearPublicKey(w.pub), ours: Object.fromEntries(Object.values(BZ.merchants).map((m) => [m.account, "ours"])),
    agents: {}, approved: {}, reveals: {}, txs: {},
  };
  const { save, tx } = recorder(rec);
  save();
  const r1 = await tx(c, "add watcher key", B, bz, B, [{ type: "AddKey", public_key_hex: w.pub, permission: { allowance: WATCHER_ALLOWANCE, receiver_id: B, method_names: ["open_round", "approve_merchant"] } }]);
  if (!r1.ok) throw new Error("add watcher key failed");
  const r2 = await tx(c, "open_round", B, w, B, [fc("open_round", { round_id: ROUND, category: CATEGORY, commit_until_ms, reveal_until_ms }, 0n, 30n * TGAS)]);
  if (!r2.ok) throw new Error("open_round failed");
  writePage(rec);
  console.log(`round ${ROUND} open: bids until ${when(commit_until_ms)} UTC, reveals until ${when(reveal_until_ms)} UTC`);
}

/** The round page's config (agents/round-mainnet.json): public facts only. */
function writePage(rec) {
  writeFileSync(PAGE, JSON.stringify({ network: "mainnet", round: rec.round, bazaar: rec.bazaar, usdc: rec.usdc, category: rec.category, commit_until_ms: rec.commit_until_ms, reveal_until_ms: rec.reveal_until_ms, max_price_usdc: rec.max_price_usdc, ours: Object.fromEntries(Object.entries(rec.ours).map(([k, v]) => [k, k === rec.page_test?.account ? "test" : v])), open_tx: rec.txs.open_round, result: rec.result ?? null }, null, 2) + "\n");
}

async function agents(c) {
  gate();
  const rec = load();
  const { save, tx } = recorder(rec);
  if (Date.now() >= rec.commit_until_ms - 60_000) throw new Error("too late to commit");
  for (const [name, m] of Object.entries(BZ.merchants)) {
    const f = join(DIR, `${ROUND}-${name}.json`);
    // Each agent's price is drawn once, at random, from 0.12 to 0.20 USDC, and kept with its salt
    // until the reveal; nobody (us included) sees the other bids before the deadline.
    if (!existsSync(f)) writeFileSync(f, JSON.stringify({ price: (12 + randomBytes(1)[0] % 9) / 100, salt: randomBytes(32).toString("hex") }) + "\n", { mode: 0o600 });
    const s = JSON.parse(readFileSync(f, "utf8"));
    const schedule = flat(s.price);
    const r = await tx(c, `commit ${name}`, m.account, seedKey(name), B, [fc("commit_bid", { round_id: ROUND, commitment: bidCommitment(m.account, schedule, Buffer.from(s.salt, "hex")) }, 20n * MILLI, 30n * TGAS)]);
    if (!r.ok) throw new Error(`commit ${name} failed`);
    rec.agents[name] = { account: m.account };
    save();
  }
}

/** The commit_bid txs to the bazaar signed by `who` (nearblocks), with their arguments (RPC). */
async function commitArgs(c, who) {
  const list = await (await fetch(`${NB}/accounts/${who}/txns?limit=25`, { signal: AbortSignal.timeout(20000) })).json();
  const out = [];
  for (const t of list.data ?? []) {
    if (t.receiver_account_id !== B || !t.actions?.some((x) => x.method === "commit_bid")) continue;
    const r = (await c.rpc("tx", { tx_hash: t.transaction_hash, sender_account_id: who, wait_until: "FINAL" })).result;
    for (const act of r?.transaction?.actions ?? []) {
      const f = act.FunctionCall;
      if (f?.method_name !== "commit_bid") continue;
      const args = JSON.parse(Buffer.from(f.args, "base64").toString());
      if (args.round_id === ROUND) out.push({ hash: t.transaction_hash, args });
    }
  }
  return out;
}

async function watch(c) {
  gate();
  const rec = load();
  const { save, tx } = recorder(rec);
  const w = seedKey("watcher"), relayer = seedKey("relayer", true), buyer = seedKey("buyer");
  // The relayer of time-locked reveals is its own small account, funded once with RELAYER_FUND
  // from the buyer, and only while the buyer keeps BUYER_FLOOR for the settle. A bad delegate can
  // cost the relayer gas, never the buyer.
  rec.relayer = relayer.pub;
  if (!rec.txs["fund relayer"]) {
    const held = BigInt((await c.account(buyer.pub)).amount);
    if (held - RELAYER_FUND < BUYER_FLOOR) throw new Error(`the buyer holds ${held}, funding the relayer would leave less than the ${BUYER_FLOOR} floor`);
    const r = await tx(c, "fund relayer", buyer.pub, buyer, relayer.pub, [{ type: "Transfer", deposit: RELAYER_FUND }]);
    if (!r.ok) throw new Error("fund relayer failed");
  }
  const tries = new Map();
  const RETRY = /too early|429|Too Many|fetch failed|ECONN|ETIMEDOUT|timed out|socket hang up|RPC kept failing|aborted/i;
  const require = createRequire(import.meta.url);
  globalThis.require ??= require;
  const { signableHash } = await import("../relayer/relay.mjs");
  let tl = null, drand = null;
  const done = new Set(Object.keys(rec.reveals));
  for (;;) {
    const now = Date.now();
    if (now >= rec.reveal_until_ms) break;
    try {
      if (now < rec.commit_until_ms) {
        // Approve every account that registered in the round's category and is not approved yet.
        for (let from = 0; ; from += 50) {
          const page = await c.view(B, "merchants", { from_index: from, limit: 50 });
          for (const [who, m] of page) {
            if (m.category !== CATEGORY || m.approved || tries.has(`approve ${who}`)) continue;
            if (Object.keys(rec.approved).length >= MAX_APPROVALS) continue;
            if (!(await c.view(USDC, "storage_balance_of", { account_id: who }))) continue;
            tries.set(`approve ${who}`, 1);
            const r = await tx(c, `approve ${who}`, B, w, B, [fc("approve_merchant", { merchant: who }, 0n, 10n * TGAS)]);
            if (r.ok) { rec.approved[who] = r.hash; save(); }
          }
          if (page.length < 50) break;
        }
        await sleep(20_000);
        continue;
      }
      const round = await c.view(B, "round", { round_id: ROUND });
      // Our agents reveal from their own keys.
      for (const [name, m] of Object.entries(BZ.merchants)) {
        if (!rec.agents[name] || round.revealed.includes(m.account)) continue;
        const s = JSON.parse(readFileSync(join(DIR, `${ROUND}-${name}.json`), "utf8"));
        const r = await tx(c, `reveal ${name}`, m.account, seedKey(name), B, [fc("reveal_bid", { round_id: ROUND, schedule: flat(s.price), salt: s.salt }, 20n * MILLI, 50n * TGAS)]);
        if (r.ok) { rec.agents[name].price = s.price; save(); }
      }
      // Strangers who bid from the page: their reveal_bid, signed by their own key as a NEP-366
      // delegate and time-locked with drand to the bid deadline, rides in their commit's args.
      // Opened now and relayed; the relayer pays the gas, it cannot change a price or a salt.
      for (const [who] of round.commits) {
        if (round.revealed.includes(who) || done.has(who) || Object.values(BZ.merchants).some((m) => m.account === who)) continue;
        // Each bidder on its own: one bad reveal or one busy API never holds up the others.
        try {
          const sealed = (await commitArgs(c, who)).map((x) => x.args.sealed_reveal).find(Boolean);
          if (!sealed) { done.add(who); console.log(`   ${who.slice(0, 16)}..: no time-locked reveal (reveals by itself)`); continue; }
          tl ??= await import("../agents/vendor/tlock.min.js");
          drand ??= tl.mainnetClient();
          let signed, d, a, fine = false;
          try {
            signed = JSON.parse((await tl.timelockDecrypt(sealed, drand)).toString());
            d = signed.delegate_action; a = d.actions?.[0];
            const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(d.public_key_hex, "hex")]), format: "der", type: "spki" });
            fine = d.sender_id === who && d.receiver_id === B && d.actions.length === 1 && a.method_name === "reveal_bid" && a.args?.round_id === ROUND && BigInt(a.deposit) <= 50n * MILLI && BigInt(a.gas) <= 100n * TGAS && verify(null, signableHash(d), pub, Buffer.from(signed.signature_hex, "hex"));
          } catch (e) { if (RETRY.test(String(e.message))) throw e; fine = false; }
          if (!fine) { done.add(who); console.log(`   ${who.slice(0, 16)}..: the opened reveal is not one reveal_bid on ${ROUND} signed by its own key: not sent`); continue; }
          // One attempt per bidder: a delegate that fails is not sent again.
          done.add(who);
          const r = await tx(c, `relay reveal ${who}`, relayer.pub, relayer, who, [{ type: "Delegate", delegate_action: d, signature_hex: signed.signature_hex }]);
          if (r.ok) { rec.reveals[who] = r.hash; save(); } else console.log(`   ${who.slice(0, 16)}..: relay failed once, not retried (it can still reveal itself until ${when(rec.reveal_until_ms)} UTC)`);
        } catch (e) {
          const n = (tries.get(who) ?? 0) + 1;
          tries.set(who, n);
          if (!RETRY.test(String(e.message)) || n >= 8) { done.add(who); console.log(`   ${who.slice(0, 16)}..: ${String(e.message).slice(0, 140)}: given up after ${n} tries`); }
          else console.log(`   ${who.slice(0, 16)}..: ${String(e.message).slice(0, 140)} (try ${n} of 8)`);
        }
      }
      const fin = await c.view(B, "round", { round_id: ROUND });
      if (fin.commits.every(([x]) => fin.revealed.includes(x) || done.has(x))) { console.log(`all ${fin.commits.length} sealed bids handled: ${fin.revealed.length} revealed`); break; }
    } catch (e) { console.log(`   watch: ${String(e.message).slice(0, 200)} (retrying)`); }
    await sleep(15_000);
  }
}

/** The revealed bids, lowest first: [{ who, price (USDC base units), ours }]. */
async function bids(c, rec) {
  const round = await c.view(B, "round", { round_id: rec.round });
  const out = [];
  for (const who of round.revealed) out.push({ who, price: BigInt((await c.view(B, "round_bid", { round_id: rec.round, merchant: who })).base_price), ours: Boolean(rec.ours[who]) });
  return { round, list: out.sort((x, y) => (x.price < y.price ? -1 : x.price > y.price ? 1 : 0)) };
}

async function settle(c) {
  gate();
  const rec = load();
  const { save, tx } = recorder(rec);
  if (Date.now() < rec.reveal_until_ms) throw new Error(`reveals close at ${when(rec.reveal_until_ms)} UTC`);
  const { round, list } = await bids(c, rec);
  if (!list.length) throw new Error("no bid was revealed");
  const win = list[0];
  const buyer = seedKey("buyer"), A = buyer.pub;
  const merchant = await c.view(B, "merchant", { merchant: win.who });
  if (!merchant?.approved) throw new Error(`the winner ${win.who} is no longer approved (it re-registered): stop, settle by hand`);
  rec.result = { sealed: round.commits.length, revealed: round.revealed.length, winner: win.who, winner_is_ours: win.ours, price: String(win.price), bids: list.map((x) => ({ who: x.who, price: String(x.price), ours: x.ours })) };
  rec.buy ??= { buyer: A };
  save();
  const cli = (args) => execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", ...args], { encoding: "utf8" }).trim();
  const usdcHeld = BigInt(await c.view(USDC, "ft_balance_of", { account_id: A }));
  if (usdcHeld < win.price) throw new Error(`the buyer holds ${usdcHeld} USDC units, the winner asks ${win.price}`);
  // USDC storage for the winner's payout account, if it has none (the buyer pays it).
  if (!(await c.view(USDC, "storage_balance_of", { account_id: merchant.payout }))) {
    const r = await tx(c, "usdc storage winner", A, buyer, USDC, [fc("storage_deposit", { account_id: merchant.payout, registration_only: true }, 1250n * 10n ** 18n)]);
    if (!r.ok) throw new Error("usdc storage failed");
  }
  const live = join(DIR, `live-${ROUND}`);
  mkdirSync(live, { recursive: true, mode: 0o700 });
  rec.buy.nullifier ??= cli(["sign-tester", KEYS, A, win.who, `bookerbob-${ROUND}`, live]);
  save();
  if (!rec.txs.verdict) {
    const { issue } = await import("./model-buy.mjs");
    const base = JSON.parse(readFileSync(join(live, "verdict.json"), "utf8")).envelope;
    base.predicates = base.predicates.filter((p) => p !== "world_id_human");
    const { envelope, proof, record } = await issue(c, B, base, "fixtures/proofs.json", KEYS);
    writeFileSync(join(live, "near-ai-verdict.json"), JSON.stringify({ envelope, proof }), { mode: 0o600 });
    rec.buy.near_ai = record; save();
    const r = await tx(c, "verdict", A, buyer, B, [fc("submit_near_ai_verdict", { envelope, proof }, 50n * MILLI, 150n * TGAS)]);
    if (!r.ok) throw new Error("verdict failed");
  }
  const v = JSON.parse(readFileSync(join(live, "near-ai-verdict.json"), "utf8"));
  const q = await c.view(B, "quote", { merchant: win.who, nullifier: rec.buy.nullifier });
  const best = await c.view(B, "round_best_quote", { round_id: ROUND, nullifier: rec.buy.nullifier });
  if (!q || BigInt(q.price) !== win.price || best?.merchant !== win.who) throw new Error(`quote ${q?.price} / best ${best?.merchant} differ from the winner ${win.who} at ${win.price}`);
  const fx = join(live, "fixtures");
  mkdirSync(fx, { recursive: true });
  writeFileSync(join(fx, "merchants.json"), JSON.stringify([{ account: win.who, label: "winner", category: CATEGORY, schedule: merchant.schedule }]));
  writeFileSync(join(fx, "proofs.json"), readFileSync("fixtures/proofs.json"));
  writeFileSync(join(fx, "claims-honest.json"), JSON.stringify(JSON.parse(readFileSync("fixtures/claims-honest.json", "utf8")).filter((x) => v.envelope.predicates.includes(x.line))));
  writeFileSync(join(live, "verdict-mainnet.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(live, "verdict.json"), "utf8")), envelope: v.envelope }));
  if (!rec.txs.receipt) {
    const input = cli(["worker-input", fx, join(live, "verdict-mainnet.json"), String(q?.cohort?.k ?? 0)]);
    const seed = readFileSync(join(KEYS, "referee.seed"), "utf8").trim();
    const result = JSON.parse(execFileSync("cargo", ["run", "-q", "-p", "bookerbob-referee-worker"], { input, encoding: "utf8", env: { ...process.env, REFEREE_SIGNING_SEED: seed } }));
    if (result.body.outcome !== "receipt") throw new Error(`the referee refused: ${result.body.detail}`);
    if (String(result.body.price) !== String(win.price)) throw new Error(`referee price ${result.body.price} differs from ${win.price}`);
    const r = await tx(c, "receipt", A, buyer, B, [fc("submit_referee_result", { result }, 0n, 100n * TGAS)]);
    if (!r.ok) throw new Error("receipt failed");
  }
  const price = String(win.price);
  if (!(await tx(c, "escrow", A, buyer, USDC, [fc("ft_transfer_call", { receiver_id: B, amount: price, msg: "" }, 1n, 100n * TGAS)])).ok) throw new Error("escrow failed");
  rec.buy.checkout_ref ??= `${ROUND}-${Date.now()}`; save();
  if (!(await tx(c, "settle", A, buyer, B, [fc("settle", { nullifier: rec.buy.nullifier, merchant: win.who, checkout_ref: rec.buy.checkout_ref, amount: price }, 0n, 150n * TGAS)])).ok) throw new Error("settle failed");
  rec.result.settle_tx = rec.txs.settle; save();
  writePage(rec);
  await check(c);
}

async function stranger(c, cmd, price) {
  const own = process.env.JOIN_ACCOUNT && process.env.JOIN_KEY_FILE ? { id: process.env.JOIN_ACCOUNT, key: keyFromFile(readFileSync(process.env.JOIN_KEY_FILE, "utf8")) } : null;
  if (own && /\.testnet$/.test(own.id)) throw new Error("this is the mainnet round: JOIN_ACCOUNT is a mainnet account (name.near or a 64-hex implicit account)");
  if (!own) throw new Error("JOIN_ACCOUNT=<you>.near JOIN_KEY_FILE=<near-cli credentials JSON or a hex seed file> in front of the command; or bid from the page, agents/round-mainnet.html");
  const id = own.id, key = own.key;
  const rec = load() ?? JSON.parse(readFileSync(PAGE, "utf8"));
  const dir = join(homedir(), ".bookerbob-community");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const statePath = join(dir, `${id}.${ROUND}.json`);
  const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { account: id, round: ROUND, txs: {} };
  const save = () => writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n", { mode: 0o600 });
  const me = async (step, receiver, actions) => { const r = await send(c, { signer_id: id, key, receiver_id: receiver, actions }); console.log(`   ${r.ok ? "ok" : "FAILED"} ${step}  ${link(r.hash)}${r.ok ? "" : `\n   ${r.error}`}`); if (!r.ok) throw new Error(step); return r.hash; };
  const round = await c.view(B, "round", { round_id: ROUND });
  if (cmd === "bid") {
    const schedule = flat(price);
    if (Date.now() >= round.commit_until_ms) throw new Error(`bids closed at ${when(round.commit_until_ms)} UTC`);
    if (round.commits.some(([w]) => w === id)) throw new Error(`${id} already has a sealed bid in ${ROUND}`);
    if (!(await c.view(USDC, "storage_balance_of", { account_id: id }))) st.txs.usdc_storage = await me("USDC storage_deposit (so the winner can be paid)", USDC, [fc("storage_deposit", { account_id: id, registration_only: true }, 1250n * 10n ** 18n, 30n * TGAS)]);
    let m = await c.view(B, "merchant", { merchant: id });
    if (!m) { st.txs.register = await me(`register_merchant, category ${CATEGORY}`, B, [fc("register_merchant", { schedule: { base_price: "10000000", rules: [], cap_bps: 0 }, category: CATEGORY, payout: null }, 20n * MILLI, 15n * TGAS)]); save(); }
    for (let i = 0; i < 30 && !(m = await c.view(B, "merchant", { merchant: id }))?.approved; i++) { if (!i) console.log("   waiting for BookerBob's watcher to approve the account (about a minute)"); await sleep(10_000); }
    if (!m?.approved) throw new Error("not approved yet: run bid again in a few minutes");
    st.schedule = schedule; st.salt ??= randomBytes(32).toString("hex"); save();
    st.txs.commit = await me(`sealed bid in ${ROUND}: only a hash is public`, B, [fc("commit_bid", { round_id: ROUND, commitment: bidCommitment(id, schedule, Buffer.from(st.salt, "hex")) }, 20n * MILLI, 30n * TGAS)]);
    save();
    console.log(`\n${id}: your bid of ${price} USDC is sealed. Between ${when(round.commit_until_ms)} and ${when(round.reveal_until_ms)} UTC run the same command with reveal. Keep ${statePath}.`);
  } else {
    if (!st.salt) throw new Error(`no sealed bid of ${id} in ${statePath}`);
    if (Date.now() < round.commit_until_ms) return console.log(`too early: reveal between ${when(round.commit_until_ms)} and ${when(round.reveal_until_ms)} UTC`);
    st.txs.reveal = await me(`reveal_bid in ${ROUND}`, B, [fc("reveal_bid", { round_id: ROUND, schedule: st.schedule, salt: st.salt }, 20n * MILLI, 50n * TGAS)]);
    save();
  }
}

async function board(c) {
  const rec = load() ?? JSON.parse(readFileSync(PAGE, "utf8"));
  const { round, list } = await bids(c, rec);
  const now = Date.now();
  console.log(`round ${rec.round} on mainnet bazaar ${B.slice(0, 12)}..: ${now < round.commit_until_ms ? `bids open until ${when(round.commit_until_ms)} UTC` : now < round.reveal_until_ms ? `reveals open until ${when(round.reveal_until_ms)} UTC` : "closed"}`);
  console.log(`${round.commits.length} sealed, ${round.revealed.length} revealed`);
  for (const x of list) console.log(`  ${x.who.padEnd(66)} ${(Number(x.price) / 1e6).toFixed(2)} USDC${x.ours ? "  (ours)" : ""}`);
  for (const [w] of round.commits) if (!round.revealed.includes(w)) console.log(`  ${w.padEnd(66)} sealed${rec.ours[w] ? "  (ours)" : ""}`);
}

async function check(c) {
  const rec = load();
  if (!rec) { console.log("PASS  round mainnet-open-1: not opened yet (no fixtures/mainnet/round.json)"); return; }
  const fails = [];
  const round = await c.view(B, "round", { round_id: rec.round });
  if (!round || round.category !== rec.category || round.commit_until_ms !== rec.commit_until_ms || round.reveal_until_ms !== rec.reveal_until_ms) fails.push("the round on chain differs from the record");
  const keys = (await c.rpc("query", { request_type: "view_access_key", finality: "final", account_id: B, public_key: rec.watcher_key })).result;
  const perm = keys?.permission?.FunctionCall;
  if (!perm || perm.receiver_id !== B || JSON.stringify([...perm.method_names].sort()) !== JSON.stringify(["approve_merchant", "open_round"])) fails.push("the watcher key is not limited to open_round and approve_merchant");
  for (const [name, h] of Object.entries(rec.txs)) {
    const signer = name.startsWith("relay reveal ") ? rec.relayer : name === "fund relayer" ? JSON.parse(readFileSync("fixtures/mainnet/buy.json", "utf8")).buyer : name.startsWith("commit ") || name.startsWith("reveal ") ? BZ.merchants[name.split(" ")[1]].account : ["add watcher key", "open_round"].includes(name) || name.startsWith("approve ") ? B : rec.buy?.buyer ?? B;
    const r = (await c.rpc("tx", { tx_hash: h, sender_account_id: signer, wait_until: "FINAL" })).result;
    const bad = !r || [r.transaction_outcome, ...r.receipts_outcome].some((o) => o.outcome.status.Failure) || r.status.Failure;
    if (bad) fails.push(`tx ${name} ${h.slice(0, 8)}.. did not succeed`);
  }
  let tail = `${round?.commits.length} sealed, ${round?.revealed.length} revealed`;
  if (rec.result) {
    const { list } = await bids(c, rec);
    if (list[0]?.who !== rec.result.winner || String(list[0]?.price) !== rec.result.price) fails.push("the lowest revealed bid on chain is not the recorded winner");
    const st = await c.view(B, "nullifier_status", { nullifier: rec.buy.nullifier });
    if (!JSON.stringify(st).includes("Spent")) fails.push("the purchase's nullifier is not spent");
    tail += `; winner ${rec.result.winner.slice(0, 12)}.. (${rec.result.winner_is_ours ? "ours" : "an outside account"}) at ${(Number(rec.result.price) / 1e6).toFixed(2)} USDC, paid by settle`;
  }
  console.log(`${fails.length ? "FAIL" : "PASS"}  round ${rec.round} on mainnet: ${tail}; ${Object.keys(rec.txs).length} txs re-read${fails.length ? `: ${fails.join("; ")}` : ""}`);
  if (fails.length) process.exit(1);
}

const [cmd, arg] = process.argv.slice(2);
const c = rpcClient(RPC);
const cmds = { open, agents, watch, settle, board, check, bid: (c) => stranger(c, "bid", arg), reveal: (c) => stranger(c, "reveal") };
await (cmds[cmd] ?? (() => Promise.reject(new Error("usage: open|agents|watch|settle --mainnet, bid <price>|reveal (JOIN_ACCOUNT, JOIN_KEY_FILE), board, check"))))(c).catch((e) => { console.error(`FAIL  ${e.message}`); process.exit(1); });
