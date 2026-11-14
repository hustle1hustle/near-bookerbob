#!/usr/bin/env node
// The economy anchor on NEAR mainnet: the same wasm as bookerbob-outcomes.testnet on a fresh implicit
// account, and the testnet economy's epochs (source near:testnet:bookerbob, the same records)
// posted to it in a few batched transactions. Dry by default.
//
//   node scripts/econ/mainnet.mjs plan                   the exact itemized cost; reads mainnet gas price; sends nothing
//   node scripts/econ/mainnet.mjs run --dry              every tx of the run built and checked, nothing sent
//   node scripts/econ/mainnet.mjs run --mainnet          real money: BOOKERBOB_MAINNET_GO=<today>, on the founder's word only; funded by the DCAP verifier account, capped at 1.7 NEAR
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { b58decode, keyFromSeed, rpcClient, send } from "../../relayer/near.mjs";
import { SOURCE, epochs, chain } from "./format.mjs";
import { encodePost } from "./anchor.mjs";

const RPC = process.env.NEAR_MAINNET_RPC ?? "https://rpc.mainnet.fastnear.com";
const WASM = process.env.ECON_WASM ?? "target/near/bookerbob_anchor_open.wasm";
const DIR = join(homedir(), ".rep-secrets", "bookerbob-mainnet");
const OUT = "fixtures/mainnet/econ-anchor.json";
const PLAN = "fixtures/mainnet/econ-anchor-plan.json";
const TGAS = 10n ** 12n, NEAR = 10n ** 24n;
const CAP = 17n * 10n ** 23n; // 1.7 NEAR: the founder's cap for this run (2026-11-14)
const BYTE_COST = 10n ** 19n; // yoctoNEAR per byte of storage (protocol constant)
const MAX_TX_GAS = 280n * TGAS; // under the 300 Tgas a transaction may attach
const MAX_TX_BYTES = 280_000; // the largest single post already sent on testnet was 270,567 bytes
const link = (h) => `https://nearblocks.io/txns/${h}`;
const near = (y) => (Number(y) / 1e24).toFixed(6);

// Measured on testnet with the same wasm and the same records (fixtures/live/econ/gas.json).
const measured = () => JSON.parse(readFileSync("fixtures/live/econ/gas.json", "utf8"));

// The posts, in batches: each action attaches 1.5x its measured testnet gas.
function batches(poster) {
  const eps = epochs(JSON.parse(readFileSync("fixtures/live/econ/txs.json", "utf8")).txs);
  const done = JSON.parse(readFileSync("fixtures/live/econ/chain.json", "utf8")).links.length;
  const links = chain(poster, SOURCE, eps).slice(0, done);
  const g = measured();
  const out = [];
  let cur = { actions: [], gas: 0n, bytes: 0 };
  for (const l of links) {
    const args = encodePost({ source: SOURCE, seq: l.seq, prev: l.prev, epoch: l.epoch, records: l.records });
    const gas = (BigInt(g.posts[l.seq].gas) * 3n) / 2n;
    if (cur.actions.length && (cur.gas + gas > MAX_TX_GAS || cur.bytes + args.length > MAX_TX_BYTES)) { out.push(cur); cur = { actions: [], gas: 0n, bytes: 0 }; }
    cur.actions.push({ seq: l.seq, epoch: l.epoch, n: l.n, head: l.head, args, gas });
    cur.gas += gas;
    cur.bytes += args.length;
  }
  if (cur.actions.length) out.push(cur);
  return { links, txs: out };
}

async function plan() {
  const c = rpcClient(RPC);
  const gasPrice = BigInt((await c.rpc("gas_price", [null])).result.gas_price);
  const g = measured();
  const code = readFileSync(WASM);
  // The poster on mainnet is a 64-hex implicit account: the same length for any key.
  const { links, txs } = batches("0".repeat(64));
  const postGas = g.posts.reduce((a, p) => a + BigInt(p.gas), 0n);
  const stateBytes = BigInt(g.storage_usage) - BigInt(code.length) - BigInt(g.account_and_keys_bytes);
  const codeStorage = BigInt(code.length) * BYTE_COST;
  const stateStorage = stateBytes * BYTE_COST;
  const accountStorage = BigInt(g.account_and_keys_bytes) * BYTE_COST;
  const burnt = {
    fund: BigInt(g.transfer_gas) * gasPrice,
    deploy: BigInt(g.deploy_gas) * gasPrice,
    posts: postGas * gasPrice,
  };
  const locked = codeStorage + stateStorage + accountStorage;
  const totalBurnt = burnt.fund + burnt.deploy + burnt.posts;
  const fund = locked + totalBurnt * 2n + NEAR / 100n; // a margin for gas price moves, the rest stays on the account
  const p = {
    note: "The economy anchor on NEAR mainnet, dry: what it would cost to deploy the open anchor (the testnet wasm) and post every anchored testnet epoch. Gas is measured on testnet with the same wasm and records; mainnet gas price read live. Nothing was sent.",
    read_at: new Date().toISOString(),
    mainnet_gas_price_yocto_per_gas: String(gasPrice),
    wasm_sha256: createHash("sha256").update(code).digest("hex"),
    wasm_bytes: code.length,
    epochs: links.length,
    events: links.reduce((a, l) => a + l.n, 0),
    transactions: 2 + txs.length,
    items: [
      { item: "1. fund a fresh implicit account (a transfer from the free balance of the mainnet DCAP verifier account)", gas_tgas: Number(g.transfer_gas) / 1e12, burnt_near: near(burnt.fund) },
      { item: "2. deploy + new() + post-only function-call key, one tx", gas_tgas: Number(g.deploy_gas) / 1e12, burnt_near: near(burnt.deploy), storage_near: near(codeStorage + accountStorage), storage_bytes: code.length + Number(g.account_and_keys_bytes) },
      ...txs.map((t, i) => ({ item: `${3 + i}. post seq ${t.actions[0].seq}..${t.actions.at(-1).seq} (${t.actions.length} epochs, ${t.bytes} bytes of records)`, gas_tgas: Number(t.actions.reduce((a, x) => a + BigInt(g.posts[x.seq].gas), 0n)) / 1e12, attached_tgas: Number(t.gas / TGAS), burnt_near: near(t.actions.reduce((a, x) => a + BigInt(g.posts[x.seq].gas), 0n) * gasPrice) })),
      { item: `state for ${links.length} entries (about ${Number(stateBytes) / links.length | 0} bytes each)`, storage_near: near(stateStorage), storage_bytes: Number(stateBytes) },
    ],
    total_burnt_near: near(totalBurnt),
    total_storage_locked_near: near(locked),
    fund_near: near(fund),
    per_epoch_after: { gas_tgas_typical: 3, gas_tgas_busiest: Number(g.posts.reduce((a, x) => (BigInt(x.gas) > a ? BigInt(x.gas) : a), 0n)) / 1e12, storage_near: near((stateBytes / BigInt(links.length)) * BYTE_COST) },
  };
  mkdirSync("fixtures/mainnet", { recursive: true });
  writeFileSync(PLAN, JSON.stringify(p, null, 1) + "\n");
  for (const i of p.items) console.log(`   ${i.item}: ${i.gas_tgas != null ? `${i.gas_tgas.toFixed(2)} Tgas, ${i.burnt_near} NEAR burnt` : ""}${i.storage_near ? ` ${i.storage_near} NEAR storage (${i.storage_bytes} B)` : ""}`);
  console.log(`   total: ${p.transactions} txs, ${p.total_burnt_near} NEAR burnt, ${p.total_storage_locked_near} NEAR locked as storage; fund the account with ${p.fund_near} NEAR  -> ${PLAN}`);
}

async function run() {
  const today = new Date().toISOString().slice(0, 10);
  const dry = process.argv.includes("--dry");
  if (!dry && (!process.argv.includes("--mainnet") || process.env.BOOKERBOB_MAINNET_GO !== today)) throw new Error(`real money: --mainnet and BOOKERBOB_MAINNET_GO=${today}`);
  const p = JSON.parse(readFileSync(PLAN, "utf8"));
  const seedKey = (n) => { const f = join(DIR, `${n}.seed`); if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString("hex") + "\n", { mode: 0o600 }); return keyFromSeed(readFileSync(f, "utf8")); };
  const acct = seedKey("econ-anchor"), poster = seedKey("econ-anchor-poster");
  const A = acct.pub;
  const c = rpcClient(RPC);
  const rec = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { note: "The economy anchor on NEAR mainnet.", account: A, source: SOURCE, txs: {} };
  const save = () => { if (!dry) writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n"); };
  const tx = async (name, signer, key, receiver, actions) => {
    if (rec.txs[name]) return console.log(`skip ${name} (done)`);
    if (dry) {
      const bytes = actions.reduce((a, x) => a + (x.code?.length ?? 0) + (Buffer.isBuffer(x.args) ? x.args.length : 0), 0);
      const gas = actions.reduce((a, x) => a + (x.gas ?? 0n), 0n);
      if (gas > 300n * TGAS) throw new Error(`${name}: ${gas / TGAS} Tgas attached, over 300`);
      if (key === poster && actions.length > 1) throw new Error(`${name}: a function-call key cannot sign ${actions.length} actions`);
      return console.log(`DRY  ${name}: ${signer.slice(0, 8)}.. (${key === poster ? "post-only key" : "full-access key"}) -> ${receiver.slice(0, 8)}.., ${actions.length} actions, ${bytes} bytes, ${gas / TGAS} Tgas attached${actions[0].type === "Transfer" ? `, ${near(actions[0].deposit)} NEAR` : ""}  (not sent)`);
    }
    const r = await send(c, { signer_id: signer, key, receiver_id: receiver, actions });
    console.log(`${r.ok ? "ok  " : "FAIL"} ${name}  ${link(r.hash)}${r.ok ? "" : `  ${r.error}`}`);
    if (!r.ok) throw new Error(`${name} failed`);
    rec.txs[name] = r.hash; save();
  };
  // The funder: the mainnet DCAP verifier account, from its free balance only (the buyer keeps its
  // NEAR for the open round's settle). Its key file is near-cli JSON; nothing of it is printed.
  const F = "e99f0afb347a1e5155cabb6c55489291794f89cdfb9457e4ba6a4a55882a4b02";
  const cred = JSON.parse(readFileSync(join(DIR, "dcap", `${F}.json`), "utf8"));
  const funder = keyFromSeed(b58decode(cred.private_key.replace(/^ed25519:/, "")).subarray(0, 32).toString("hex"));
  if (funder.pub !== F) throw new Error("the dcap key file does not hold the verifier account's key");
  const fund = BigInt(Math.round(Number(p.fund_near) * 1e6)) * 10n ** 18n;
  if (fund > CAP) throw new Error(`fund ${near(fund)} NEAR is over the ${near(CAP)} NEAR cap`);
  if (!rec.txs.fund) {
    const fa = await c.account(F);
    const free = BigInt(fa.amount) - BigInt(fa.storage_usage) * BYTE_COST;
    console.log(`   funder free balance ${near(free)} NEAR (storage ${fa.storage_usage} B stays covered); sending ${near(fund)} NEAR`);
    if (free < fund + NEAR / 10n) throw new Error("the verifier account's free balance is too low: stop");
  }
  await tx("fund", F, funder, A, [{ type: "Transfer", deposit: fund }]);
  await tx("deploy", A, acct, A, [
    { type: "DeployContract", code: readFileSync(WASM) },
    { type: "FunctionCall", method_name: "new", args: {}, gas: 30n * TGAS, deposit: 0n },
    { type: "AddKey", public_key_hex: poster.pub, permission: { allowance: null, receiver_id: A, method_names: ["post"] } },
  ]);
  const { txs } = batches(A);
  // A function-call key may sign only a transaction with one FunctionCall action (NEAR answers
  // RequiresFullAccess otherwise), so the batched backfill is signed with the account's full-access
  // key; the poster is the same account either way. Later hourly posts (one action) use the post-only key.
  for (const [i, t] of txs.entries()) await tx(`post ${i}`, A, t.actions.length > 1 ? acct : poster, A, t.actions.map((x) => ({ type: "FunctionCall", method_name: "post", args: x.args, gas: x.gas, deposit: 0n })));
  rec.head = txs.at(-1).actions.at(-1).head; save();
  console.log(`${dry ? "DRY  " : ""}mainnet anchor ${A}: head ${rec.head}`);
}

const cmd = process.argv[2];
({ plan, run }[cmd] ?? (() => { console.error("usage: node scripts/econ/mainnet.mjs plan | run --mainnet"); process.exit(2); }))().catch((e) => { console.error(`FAIL  ${e.message}`); process.exit(1); });
