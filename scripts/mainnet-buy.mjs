#!/usr/bin/env node
// One purchase on the mainnet bazaar (scripts/mainnet-bazaar.mjs deployed it and ran round mainnet-1):
//  1. owner: the NEAR AI model key and attestation already verified on chain on testnet
//     (spike.bookerbob.testnet, fixtures/live/near-ai/models/...); a fresh mainnet evaluator key
//     and a fresh mainnet referee key (~/.rep-secrets/bookerbob-mainnet/keys, never the testnet seeds)
//  2. the buyer: 0.35 NEAR to wNEAR, swapped on Ref (pool 4512) to Circle USDC
//  3. a real E2EE NEAR AI verdict over the synthetic fixture facts (submit_near_ai_verdict); the
//     verdict reveals airbnb_frequent, claude_spender (no World predicate: no World verifier on mainnet)
//  4. the referee's receipt for the round's lowest bidder, escrow in USDC, settle, a refused replay
//   node scripts/mainnet-buy.mjs run --mainnet    real money: BOOKERBOB_MAINNET_GO=<today>
//   node scripts/mainnet-buy.mjs check            keyless recheck of fixtures/mainnet/buy.json
process.env.MODEL_BUY_MODEL ??= "deepseek-ai/DeepSeek-V4.1-Flash-1017";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keyFromSeed, rpcClient, send } from "../relayer/near.mjs";

const RPC = process.env.NEAR_MAINNET_RPC ?? "https://rpc.mainnet.fastnear.com";
const DIR = join(homedir(), ".rep-secrets", "bookerbob-mainnet");
const KEYS = join(DIR, "keys");
const BZ = JSON.parse(readFileSync("fixtures/mainnet/bazaar.json", "utf8"));
const USDC = BZ.usdc, REF = "v2.ref-finance.near", POOL = 4512;
const OUT = "fixtures/mainnet/buy.json";
const TGAS = 10n ** 12n, MILLI = 10n ** 21n, NEAR = 10n ** 24n;
const link = (h) => `https://nearblocks.io/txns/${h}`;
const fc = (method_name, args, deposit = 0n, gas = 50n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const cli = (args, opts = {}) => execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", ...args], { encoding: "utf8", ...opts }).trim();
const key = (n) => keyFromSeed(readFileSync(join(DIR, `${n}.seed`), "utf8"));
const pubOf = (role) => JSON.parse(cli(["keys", KEYS, "--pub"]))[role];

async function run(c) {
  const today = new Date().toISOString().slice(0, 10);
  if (!process.argv.includes("--mainnet") || process.env.BOOKERBOB_MAINNET_GO !== today) throw new Error(`real money: --mainnet and BOOKERBOB_MAINNET_GO=${today}`);
  const B = BZ.bazaar, bz = key("bazaar"), buyer = key("buyer"), A = buyer.pub;
  const winner = Object.entries(BZ.merchants).map(([n, m]) => ({ n, ...m }));
  const bids = await Promise.all(winner.map((m) => c.view(B, "round_bid", { round_id: BZ.round.id, merchant: m.account })));
  const low = winner.map((m, i) => ({ ...m, schedule: bids[i] })).sort((x, y) => Number(BigInt(x.schedule.base_price) - BigInt(y.schedule.base_price)))[0];
  const reg = JSON.parse(readFileSync(`fixtures/live/near-ai/models/${process.env.MODEL_BUY_MODEL.replace(/[^A-Za-z0-9.-]+/g, "_")}/run.json`, "utf8"));
  const rec = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { note: "One purchase on the mainnet bazaar: a real E2EE NEAR AI verdict (TEE-signed, its model key verified on chain on testnet) over the synthetic fixture facts, the referee's receipt from a fresh mainnet key, escrow and settle in Circle USDC to the lowest bidder of round mainnet-1, and the replay refused. Check: node scripts/mainnet-buy.mjs check", network: "mainnet", bazaar: B, buyer: A, merchant: low.account, model: reg.model, model_key: reg.signing_key, model_verified_on: { contract: reg.spike, verification_id: reg.verification_id, tx: reg.calls.at(-1).tx }, txs: {} };
  const save = () => writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
  const tx = async (name, signer, k, receiver, actions, expectFail) => {
    if (rec.txs[name]) return console.log(`skip ${name} (done)`);
    const r = await send(c, { signer_id: signer, key: k, receiver_id: receiver, actions });
    if (expectFail) {
      if (r.ok || !String(r.error).includes(expectFail)) throw new Error(`${name}: expected "${expectFail}", got ${r.ok ? "ok" : r.error}`);
      console.log(`ok   ${name}: refused (${expectFail})  ${link(r.hash)}`);
    } else {
      console.log(`${r.ok ? "ok  " : "FAIL"} ${name}  ${link(r.hash)}${r.ok ? "" : `  ${String(r.error).slice(0, 300)}`}`);
      if (!r.ok) throw new Error(`${name} failed`);
    }
    rec.txs[name] = r.hash; save();
    return r;
  };
  // 1. owner registrations
  await tx("register_model_attestation", B, bz, B, [fc("register_model_attestation", { signing_key: reg.signing_key, attestation: reg.attestation }, 0n, 30n * TGAS)]);
  await tx("set_evaluator_key", B, bz, B, [fc("set_evaluator_key", { public_key: pubOf("evaluator") })]);
  await tx("register_referee", B, bz, B, [fc("register_referee", { key_hex: pubOf("referee"), label: "mainnet referee" })]);
  // 2. USDC: storage for the bazaar, the merchant and the buyer, then the swap
  for (const [n, who] of [["bazaar", B], ["merchant", low.account], ["buyer", A]]) {
    if (!(await c.view(USDC, "storage_balance_of", { account_id: who }))) await tx(`usdc storage ${n}`, A, buyer, USDC, [fc("storage_deposit", { account_id: who, registration_only: true }, 1250n * 10n ** 18n)]);
  }
  if (!(await c.view(REF, "get_user_storage_state", { account_id: A }).catch(() => null))) await tx("ref storage", A, buyer, REF, [fc("storage_deposit", { account_id: A, registration_only: true }, 100n * MILLI)]);
  const amountIn = 350n * MILLI;
  const wbal = BigInt(await c.view("wrap.near", "ft_balance_of", { account_id: A }));
  if (wbal < amountIn) await tx("near_deposit", A, buyer, "wrap.near", [fc("near_deposit", {}, amountIn - wbal)]);
  if (BigInt(await c.view(USDC, "ft_balance_of", { account_id: A })) < 1_000_000n) {
    const out = BigInt(await c.view(REF, "get_return", { pool_id: POOL, token_in: "wrap.near", amount_in: amountIn.toString(), token_out: USDC }));
    const min = (out * 97n) / 100n;
    console.log(`   swap 0.35 wNEAR for about ${Number(out) / 1e6} USDC (min ${Number(min) / 1e6})`);
    await tx("swap to USDC", A, buyer, "wrap.near", [fc("ft_transfer_call", { receiver_id: REF, amount: amountIn.toString(), msg: JSON.stringify({ force: 0, actions: [{ pool_id: POOL, token_in: "wrap.near", token_out: USDC, amount_in: amountIn.toString(), min_amount_out: min.toString() }] }) }, 1n, 180n * TGAS)]);
  }
  rec.usdc_after_swap = (await c.view(USDC, "ft_balance_of", { account_id: A })).toString(); save();
  // 3. the verdict
  const live = join(DIR, "live");
  mkdirSync(live, { recursive: true, mode: 0o700 });
  if (!rec.nullifier) rec.nullifier = cli(["sign-tester", KEYS, A, low.account, "bookerbob-mainnet", live]);
  save();
  await tx("bazaar storage", A, buyer, B, [fc("storage_deposit", { account_id: A }, 10n * MILLI, 30n * TGAS)]);
  if (!rec.txs.verdict) {
    const { issue } = await import("./model-buy.mjs");
    const base = JSON.parse(readFileSync(join(live, "verdict.json"), "utf8")).envelope;
    base.predicates = base.predicates.filter((p) => p !== "world_id_human");
    const { envelope, proof, record } = await issue(c, B, base, "fixtures/proofs.json", KEYS);
    writeFileSync(join(live, "near-ai-verdict.json"), JSON.stringify({ envelope, proof }), { mode: 0o600 });
    rec.near_ai = record; save();
    await tx("verdict", A, buyer, B, [fc("submit_near_ai_verdict", { envelope, proof }, 50n * MILLI, 150n * TGAS)]);
  }
  const v = JSON.parse(readFileSync(join(live, "near-ai-verdict.json"), "utf8"));
  // 4. receipt, escrow, settle
  const q = await c.view(B, "quote", { merchant: low.account, nullifier: rec.nullifier });
  const fx = join(live, "fixtures");
  mkdirSync(fx, { recursive: true });
  writeFileSync(join(fx, "merchants.json"), JSON.stringify([{ account: low.account, label: low.n, category: BZ.category, schedule: low.schedule }]));
  writeFileSync(join(fx, "proofs.json"), readFileSync("fixtures/proofs.json"));
  writeFileSync(join(fx, "claims-honest.json"), JSON.stringify(JSON.parse(readFileSync("fixtures/claims-honest.json", "utf8")).filter((x) => v.envelope.predicates.includes(x.line))));
  writeFileSync(join(live, "verdict-mainnet.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(live, "verdict.json"), "utf8")), envelope: v.envelope }));
  if (!rec.txs.receipt) {
    const input = cli(["worker-input", fx, join(live, "verdict-mainnet.json"), String(q?.cohort?.k ?? 0)]);
    const seed = readFileSync(join(KEYS, "referee.seed"), "utf8").trim();
    const result = JSON.parse(execFileSync("cargo", ["run", "-q", "-p", "bookerbob-referee-worker"], { input, encoding: "utf8", env: { ...process.env, REFEREE_SIGNING_SEED: seed } }));
    if (result.body.outcome !== "receipt") throw new Error(`the referee refused: ${result.body.detail}`);
    if (q && String(result.body.price) !== String(q.price)) throw new Error(`referee price ${result.body.price} differs from the quote ${q.price}`);
    rec.price = String(result.body.price); save();
    console.log(`   receipt: ${low.n} at ${Number(rec.price) / 1e6} USDC`);
    await tx("receipt", A, buyer, B, [fc("submit_referee_result", { result }, 0n, 100n * TGAS)]);
  }
  await tx("escrow", A, buyer, USDC, [fc("ft_transfer_call", { receiver_id: B, amount: rec.price, msg: "" }, 1n, 100n * TGAS)]);
  rec.checkout_ref = rec.checkout_ref ?? `mainnet-${Date.now()}`; save();
  await tx("settle", A, buyer, B, [fc("settle", { nullifier: rec.nullifier, merchant: low.account, checkout_ref: rec.checkout_ref, amount: rec.price }, 0n, 150n * TGAS)]);
  await tx("replay", A, buyer, B, [fc("submit_near_ai_verdict", { envelope: v.envelope, proof: v.proof }, 50n * MILLI, 150n * TGAS)], "nullifier");
  await check(c);
}

async function check(c) {
  const rec = JSON.parse(readFileSync(OUT, "utf8"));
  const v = await c.view(rec.bazaar, "verdict", { nullifier: rec.nullifier });
  const st = await c.view(rec.bazaar, "nullifier_status", { nullifier: rec.nullifier });
  const paid = await c.view(rec.bazaar, "paid_in", { nullifier: rec.nullifier }).catch(() => null);
  const ok = v && String(v.issuer).startsWith("near-ai:") && JSON.stringify(st).includes("Spent");
  console.log(`${ok ? "PASS" : "FAIL"}  mainnet purchase: verdict issued by ${String(v?.issuer).slice(0, 20)}.. (a NEAR AI model key), nullifier ${JSON.stringify(st)}, paid in ${paid ?? "?"}, ${Number(rec.price) / 1e6} USDC to ${rec.merchant.slice(0, 12)}..`);
  for (const [k, h] of Object.entries(rec.txs)) console.log(`      ${k}: ${link(h)}`);
  if (!ok) process.exit(1);
}

const [cmd] = process.argv.slice(2);
const c = rpcClient(RPC);
await (cmd === "run" ? run(c) : cmd === "check" ? check(c) : Promise.reject(new Error("usage: run --mainnet | check"))).catch((e) => { console.error(`FAIL  ${e.message}`); process.exit(1); });
