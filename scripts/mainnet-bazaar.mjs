#!/usr/bin/env node
// The bazaar on NEAR mainnet: the byte-identical audited wasm (code hash Bt2rNwTLp1wy, the same
// as both testnet bazaars) deployed to a fresh implicit account, and one sealed round in which two
// merchant agents, each on its own implicit account, commit a hash and reveal after the deadline.
// No purchase runs here: the contract refuses verdicts with a synthetic ("fixture") enclave status
// off testnet, by design. The payment leg on mainnet is the NEAR Intents settle (intents-settle.mjs).
//
//   node scripts/mainnet-bazaar.mjs run --mainnet     real money: BOOKERBOB_MAINNET_GO=<today>
//   node scripts/mainnet-bazaar.mjs check             keyless: code hash, round, bids over public RPC
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { b58encode, keyFromSeed, rpcClient, send } from "../relayer/near.mjs";
import { bidCommitment, schedule } from "../sdk/merchant.mjs";

const RPC = process.env.NEAR_MAINNET_RPC ?? "https://rpc.mainnet.fastnear.com";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // Circle USDC on NEAR
const WASM = process.env.BAZAAR_WASM ?? join(homedir(), "dev", "bookerbob-deploys", "mainnet", "bookerbob_bazaar.wasm");
const CODE_HASH = JSON.parse(readFileSync("contract/DEPLOYED.json", "utf8")).code_hash;
const DIR = join(homedir(), ".rep-secrets", "bookerbob-mainnet");
const OUT = "fixtures/mainnet/bazaar.json";
const CATEGORY = "mainnet-rooms";
const TGAS = 10n ** 12n, MILLI = 10n ** 21n, NEAR = 10n ** 24n;
const link = (h) => `https://nearblocks.io/txns/${h}`;
const fc = (method_name, args, deposit = 0n, gas = 50n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const seedKey = (n) => {
  const f = join(DIR, `${n}.seed`);
  if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  return keyFromSeed(readFileSync(f, "utf8"));
};
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
// Two merchant agents, prices in USDC base units (6 decimals) as the contract counts them.
const MERCHANTS = [
  { name: "merchant-a", base: 1_000_000, rules: [{ predicate: "airbnb_frequent", bps: 1500 }], cap: 2000 },
  { name: "merchant-b", base: 950_000, rules: [{ predicate: "airbnb_frequent", bps: 500 }], cap: 1000 },
];

async function run(c) {
  const today = new Date().toISOString().slice(0, 10);
  if (!process.argv.includes("--mainnet") || process.env.BOOKERBOB_MAINNET_GO !== today) throw new Error(`real money: --mainnet and BOOKERBOB_MAINNET_GO=${today}`);
  const wasm = readFileSync(WASM);
  const hash = b58encode(createHash("sha256").update(wasm).digest());
  if (hash !== CODE_HASH) throw new Error(`the wasm is ${hash}, not the audited ${CODE_HASH}: stop`);
  const funder = seedKey("buyer"), bz = seedKey("bazaar");
  const ms = MERCHANTS.map((m) => ({ ...m, key: seedKey(m.name) }));
  const B = bz.pub;
  const rec = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { note: "The bazaar on NEAR mainnet: the audited wasm (the same code hash as both testnet bazaars) on a fresh implicit account, and one sealed round with two merchant agents. No purchase: the contract refuses synthetic (fixture) verdicts off testnet. Check: node scripts/mainnet-bazaar.mjs check", network: "mainnet", bazaar: B, code_hash: CODE_HASH, usdc: USDC, owner: B, category: CATEGORY, merchants: {}, txs: {} };
  const save = () => writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
  const tx = async (name, signer, key, receiver, actions) => {
    if (rec.txs[name]) return console.log(`skip ${name} (done)`);
    const r = await send(c, { signer_id: signer, key, receiver_id: receiver, actions });
    console.log(`${r.ok ? "ok  " : "FAIL"} ${name}  ${link(r.hash)}${r.ok ? "" : `  ${r.error}`}`);
    if (!r.ok) throw new Error(`${name} failed`);
    rec.txs[name] = r.hash; save();
  };
  await tx("fund bazaar", funder.pub, funder, B, [{ type: "Transfer", deposit: 9n * NEAR + 300n * MILLI }]);
  for (const m of ms) await tx(`fund ${m.name}`, funder.pub, funder, m.key.pub, [{ type: "Transfer", deposit: 150n * MILLI }]);
  await tx("deploy and init", B, bz, B, [{ type: "DeployContract", code: wasm }, fc("new", { owner: B, usdc: USDC }, 0n, 100n * TGAS)]);
  for (const m of ms) {
    m.schedule = schedule({ basePrice: m.base, rules: m.rules, capBps: m.cap });
    rec.merchants[m.name] = { account: m.key.pub };
    await tx(`register ${m.name}`, m.key.pub, m.key, B, [fc("register_merchant", { schedule: m.schedule, category: CATEGORY, payout: null }, 50n * MILLI)]);
    await tx(`approve ${m.name}`, B, bz, B, [fc("approve_merchant", { merchant: m.key.pub })]);
  }
  rec.round ??= { id: `mainnet-1`, commit_until_ms: Date.now() + 4 * 60_000 };
  rec.round.reveal_until_ms ??= rec.round.commit_until_ms + 20 * 60_000;
  save();
  await tx("open_round", B, bz, B, [fc("open_round", { round_id: rec.round.id, category: CATEGORY, commit_until_ms: rec.round.commit_until_ms, reveal_until_ms: rec.round.reveal_until_ms })]);
  for (const m of ms) {
    const sf = join(DIR, `${rec.round.id}-${m.name}.salt`);
    if (!existsSync(sf)) writeFileSync(sf, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    m.salt = readFileSync(sf, "utf8").trim();
    await tx(`commit ${m.name}`, m.key.pub, m.key, B, [fc("commit_bid", { round_id: rec.round.id, commitment: bidCommitment(m.key.pub, m.schedule, Buffer.from(m.salt, "hex")) }, 20n * MILLI)]);
  }
  const wait = rec.round.commit_until_ms + 5000 - Date.now();
  if (wait > 0) { console.log(`waiting ${Math.ceil(wait / 1000)} s for the commit deadline`); await sleep(wait); }
  for (const m of ms) await tx(`reveal ${m.name}`, m.key.pub, m.key, B, [fc("reveal_bid", { round_id: rec.round.id, schedule: m.schedule, salt: m.salt }, 20n * MILLI)]);
  await check(c);
}

async function check(c) {
  const rec = JSON.parse(readFileSync(OUT, "utf8"));
  const acct = await c.rpc("query", { request_type: "view_account", finality: "final", account_id: rec.bazaar });
  const code = acct.result?.code_hash;
  console.log(`${code === rec.code_hash ? "PASS" : "FAIL"}  code on ${rec.bazaar.slice(0, 12)}.. is ${code} (the audited wasm, the same as both testnet bazaars)`);
  const r = await c.view(rec.bazaar, "round", { round_id: rec.round.id });
  const bids = [];
  for (const [n, m] of Object.entries(rec.merchants)) {
    const s = await c.view(rec.bazaar, "round_bid", { round_id: rec.round.id, merchant: m.account });
    bids.push({ n, base: s ? Number(s.base_price) / 1e6 : null });
  }
  const ok = r && r.commits.length === 2 && r.revealed.length === 2 && bids.every((b) => b.base != null);
  const low = [...bids].sort((a, b) => a.base - b.base)[0];
  console.log(`${ok ? "PASS" : "FAIL"}  round ${rec.round.id}: ${r?.commits.length} sealed, ${r?.revealed.length} revealed; ${bids.map((b) => `${b.n} ${b.base?.toFixed(2)}`).join(", ")}; lowest revealed base price: ${low?.n}`);
  if (!ok) process.exit(1);
}

const [cmd] = process.argv.slice(2);
const c = rpcClient(RPC);
await (cmd === "run" ? run(c) : cmd === "check" ? check(c) : Promise.reject(new Error("usage: run --mainnet | check"))).catch((e) => { console.error(`FAIL  ${e.message}`); process.exit(1); });
