#!/usr/bin/env node
// Real data on the mainnet bazaar: the founder's signed-in GitHub proof (a TLSNotary presentation,
// fixtures/live/prove-me/founder-github-owner.presentation) is the whole proof set. The NEAR AI
// model gets those facts under E2EE and is asked for github_builder (rule: account at least 3
// years old). The account is 2 years old: the model's TEE-signed answer refuses it, and that answer
// is recorded. The buyer then buys with a verdict that claims nothing and pays the plain price.
//   node scripts/mainnet-real.mjs run --mainnet     BOOKERBOB_MAINNET_GO=<today>
//   node scripts/mainnet-real.mjs check
process.env.MODEL_BUY_MODEL ??= "deepseek-ai/DeepSeek-V4.1-Flash-1017";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keyFromSeed, rpcClient, send } from "../relayer/near.mjs";

const RPC = process.env.NEAR_MAINNET_RPC ?? "https://rpc.mainnet.fastnear.com";
const DIR = join(homedir(), ".rep-secrets", "bookerbob-mainnet");
const KEYS = join(DIR, "keys"), REAL = join(DIR, "real");
const BZ = JSON.parse(readFileSync("fixtures/mainnet/bazaar.json", "utf8"));
const USDC = BZ.usdc, REF = "v2.ref-finance.near", POOL = 4512;
const OUT = "fixtures/mainnet/real-refusal.json";
const TGAS = 10n ** 12n, MILLI = 10n ** 21n;
const link = (h) => `https://nearblocks.io/txns/${h}`;
const fc = (method_name, args, deposit = 0n, gas = 50n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const cli = (args, opts = {}) => execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", ...args], { encoding: "utf8", ...opts }).trim();
const key = (n) => keyFromSeed(readFileSync(join(DIR, `${n}.seed`), "utf8"));

async function run(c) {
  const today = new Date().toISOString().slice(0, 10);
  if (!process.argv.includes("--mainnet") || process.env.BOOKERBOB_MAINNET_GO !== today) throw new Error(`real money: --mainnet and BOOKERBOB_MAINNET_GO=${today}`);
  const B = BZ.bazaar, buyer = key("buyer"), A = buyer.pub;
  const m = BZ.merchants["merchant-b"];
  const sched = await c.view(B, "round_bid", { round_id: BZ.round.id, merchant: m.account });
  const rec = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { note: "Real data on the mainnet bazaar: the founder's signed-in GitHub proof (TLSNotary, REP notary) is the whole proof set. Asked for github_builder (account at least 3 years old), the NEAR AI model's TEE-signed answer refuses it: the account is 2 years old. The buyer then pays the plain price with a verdict that claims nothing. Check: node scripts/mainnet-real.mjs check", network: "mainnet", bazaar: B, buyer: A, merchant: m.account, presentation: "fixtures/live/prove-me/founder-github-owner.presentation", facts: JSON.parse(readFileSync(join(REAL, "proofs.json"), "utf8")).facts.map(({ platform, field, value }) => ({ platform, field, value })), txs: {} };
  const save = () => writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
  const tx = async (name, receiver, actions) => {
    if (rec.txs[name]) return console.log(`skip ${name} (done)`);
    const r = await send(c, { signer_id: A, key: buyer, receiver_id: receiver, actions });
    console.log(`${r.ok ? "ok  " : "FAIL"} ${name}  ${link(r.hash)}${r.ok ? "" : `  ${String(r.error).slice(0, 300)}`}`);
    if (!r.ok) throw new Error(`${name} failed`);
    rec.txs[name] = r.hash; save();
  };
  const { issue } = await import("./model-buy.mjs");
  const live = join(REAL, "live");
  const base0 = JSON.parse(readFileSync(join(live, "verdict.json"), "utf8")).envelope;
  rec.nullifier = base0.nullifier; save();
  // 1. the ask the facts do not back
  if (!rec.refusal) {
    const r = await issue(c, B, { ...base0, predicates: ["github_builder"] }, join(REAL, "proofs.json"), KEYS, { allowRefusal: true });
    if (!r.refused) throw new Error("the model attested github_builder for a 2-year-old account: stop");
    rec.refusal = r.record; save();
    console.log(`   refused by ${r.record.model}: asked ${r.record.asked.join(", ")}, attested [${r.record.attested.join(", ")}]; TEE signature valid`);
  }
  // 2. the plain price with a verdict that claims nothing
  const usd = BigInt(await c.view(USDC, "ft_balance_of", { account_id: A }));
  if (usd < BigInt(sched.base_price)) {
    const amountIn = 250n * MILLI;
    const wbal = BigInt(await c.view("wrap.near", "ft_balance_of", { account_id: A }));
    if (wbal < amountIn) await tx("near_deposit", "wrap.near", [fc("near_deposit", {}, amountIn - wbal)]);
    const out = BigInt(await c.view(REF, "get_return", { pool_id: POOL, token_in: "wrap.near", amount_in: amountIn.toString(), token_out: USDC }));
    await tx("swap to USDC", "wrap.near", [fc("ft_transfer_call", { receiver_id: REF, amount: amountIn.toString(), msg: JSON.stringify({ force: 0, actions: [{ pool_id: POOL, token_in: "wrap.near", token_out: USDC, amount_in: amountIn.toString(), min_amount_out: ((out * 97n) / 100n).toString() }] }) }, 1n, 180n * TGAS)]);
  }
  if (!rec.txs.verdict) {
    const { envelope, proof, record } = await issue(c, B, { ...base0, predicates: [] }, join(REAL, "proofs.json"), KEYS);
    writeFileSync(join(live, "near-ai-verdict.json"), JSON.stringify({ envelope, proof }), { mode: 0o600 });
    rec.verdict = record; save();
    await tx("verdict", B, [fc("submit_near_ai_verdict", { envelope, proof }, 50n * MILLI, 150n * TGAS)]);
  }
  const v = JSON.parse(readFileSync(join(live, "near-ai-verdict.json"), "utf8"));
  if (!rec.txs.receipt) {
    const fx = join(live, "fixtures");
    mkdirSync(fx, { recursive: true });
    writeFileSync(join(fx, "merchants.json"), JSON.stringify([{ account: m.account, label: "merchant-b", category: BZ.category, schedule: sched }]));
    writeFileSync(join(fx, "proofs.json"), readFileSync(join(REAL, "proofs.json")));
    writeFileSync(join(fx, "claims-honest.json"), "[]");
    writeFileSync(join(live, "verdict-mainnet.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(live, "verdict.json"), "utf8")), envelope: v.envelope }));
    const q = await c.view(B, "quote", { merchant: m.account, nullifier: rec.nullifier });
    const input = cli(["worker-input", fx, join(live, "verdict-mainnet.json"), String(q?.cohort?.k ?? 0)]);
    const result = JSON.parse(execFileSync("cargo", ["run", "-q", "-p", "bookerbob-referee-worker"], { input, encoding: "utf8", env: { ...process.env, REFEREE_SIGNING_SEED: readFileSync(join(KEYS, "referee.seed"), "utf8").trim() } }));
    if (result.body.outcome !== "receipt") throw new Error(`the referee refused: ${result.body.detail}`);
    if (String(result.body.price) !== String(q.price)) throw new Error(`referee ${result.body.price} vs quote ${q.price}`);
    rec.price = String(result.body.price); save();
    console.log(`   receipt: plain price ${Number(rec.price) / 1e6} USDC (public base ${Number(sched.base_price) / 1e6})`);
    await tx("receipt", B, [fc("submit_referee_result", { result }, 0n, 100n * TGAS)]);
  }
  await tx("escrow", USDC, [fc("ft_transfer_call", { receiver_id: B, amount: rec.price, msg: "" }, 1n, 100n * TGAS)]);
  rec.checkout_ref ??= `mainnet-real-${Date.now()}`; save();
  await tx("settle", B, [fc("settle", { nullifier: rec.nullifier, merchant: m.account, checkout_ref: rec.checkout_ref, amount: rec.price }, 0n, 150n * TGAS)]);
  await check(c);
}

async function check(c) {
  const rec = JSON.parse(readFileSync(OUT, "utf8"));
  const v = await c.view(rec.bazaar, "verdict", { nullifier: rec.nullifier });
  const st = await c.view(rec.bazaar, "nullifier_status", { nullifier: rec.nullifier });
  const ok = v && String(v.issuer).startsWith("near-ai:") && JSON.stringify(st).includes("Spent") && rec.refusal && rec.refusal.attested.length === 0;
  console.log(`${ok ? "PASS" : "FAIL"}  real data on mainnet: asked github_builder, the model attested [${rec.refusal?.attested.join(", ")}] (TEE-signed, chat ${rec.refusal?.chat_id}); the buyer paid the plain ${Number(rec.price) / 1e6} USDC, nullifier ${JSON.stringify(st)}`);
  for (const [k, h] of Object.entries(rec.txs)) console.log(`      ${k}: ${link(h)}`);
  if (!ok) process.exit(1);
}

const [cmd] = process.argv.slice(2);
const c = rpcClient(RPC);
await (cmd === "run" ? run(c) : cmd === "check" ? check(c) : Promise.reject(new Error("usage: run --mainnet | check"))).catch((e) => { console.error(`FAIL  ${e.message}`); process.exit(1); });
