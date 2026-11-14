#!/usr/bin/env node
// `make demo-tester`: testnet demo mode (docs/demo-mode.md). One command gives a tester a
// fresh agent account, funded by the treasury, paid in dUSDC (a testnet demo token with no
// value; production uses Circle USDC), gasless through the NEP-366 relayer:
//
//   node scripts/demo-tester.mjs setup         owner, once: seeds, dUSDC deploy, registrations
//   node scripts/demo-tester.mjs run           one tester: account, mint, verdict, receipt,
//                                              escrow, settle_demo, replay refused, review group
//   node scripts/demo-tester.mjs reviews seal|reveal|publish   sealed reviews for m01's group
//   DRY_RUN=1 node scripts/demo-tester.mjs run  print the plan, read and send nothing
//
// Testnet only (refuses anything else before doing anything). Seeds stay in KEYS_DIR
// (outside the repo); tester seeds and Semaphore identities in KEYS_DIR/testers. Only public
// data is printed: account ids, public keys, tx hashes.
import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { checkDemo, check as checkReview } from "../relayer/relay.mjs";
import { delegateFor, keyFromSeed, near, nearPublicKey, rpcClient, send } from "../relayer/near.mjs";

const TGAS = 10n ** 12n;
const MILLI = 10n ** 21n;
export const TESTER_FUND = near(0.1);
export const TREASURY_MIN = near(1);
export const DAILY_TESTERS = 20;

export function config(env) {
  const bazaar = env.BAZAAR_ACCOUNT_ID || "bookerbob.testnet";
  const keysDir = env.KEYS_DIR || join(homedir(), ".rep-secrets", "bookerbob-testnet");
  return {
    network: env.NEAR_NETWORK || "testnet",
    rpc: env.NEAR_RPC || "https://test.rpc.fastnear.com",
    bazaar,
    dusdc: env.DUSDC_CONTRACT_ID || "bookerbob-dusdc.testnet",
    treasury: env.DEMO_TREASURY_ID || "bookerbob-demo.testnet",
    merchant: env.DEMO_MERCHANT || `m01.${bazaar}`,
    worldAction: env.WORLD_ACTION || "bookerbob-fixture-action",
    shopifyEnv: env.SHOPIFY_ENV_FILE || join(homedir(), ".rep-secrets", "shopify-test-store.env"),
    keysDir,
    testersDir: join(keysDir, "testers"),
    dryRun: env.DRY_RUN === "1",
    record: env.RECORD === "1",
  };
}

/** A reason to refuse, or null. Checked before anything else, dry run included. */
export function guard(c) {
  if (c.network !== "testnet") return `NEAR_NETWORK=${c.network}: demo mode is testnet only`;
  if (!/testnet/.test(c.rpc) && !c.rpc.startsWith("https://test.rpc.fastnear.com")) return `RPC ${c.rpc} is not testnet`;
  for (const a of [c.bazaar, c.dusdc, c.treasury, c.merchant]) if (!a.endsWith(".testnet")) return `${a} is not a .testnet account`;
  return null;
}

export const testerId = (c, hex6) => `t-${hex6}.${c.treasury}`;

/** The run's steps, in order (pure: used by the dry run and the test). */
export function plan(c) {
  return [
    ["preflight", `bazaar ${c.bazaar} accepts ${c.dusdc}; treasury ${c.treasury} holds at least 1 NEAR; under ${DAILY_TESTERS} testers today`],
    ["account", `treasury creates t-<6 hex>.${c.treasury} with 0.1 NEAR and the tester's own key`],
    ["storage", "treasury pays the tester's bazaar escrow entry and dUSDC registration"],
    ["mint", "relayed: the tester mints 100 dUSDC (free, testnet demo token, no value)"],
    ["sign", "sign the tester's verdict and World attestation (own nullifier and person) with the testnet keys"],
    ["world", "relayed: attest_human, one agent per person"],
    ["verdict", "relayed: submit_verdict, merchants see 3 bits and a commitment"],
    ["receipt", "the referee checks the winner's claims and signs a receipt; relayed: submit_referee_result"],
    ["escrow", "relayed: ft_transfer_call the receipt price in dUSDC to the bazaar"],
    ["settle", `relayed: settle_demo pays ${c.merchant} in dUSDC and burns the nullifier`],
    ["shopify", "the paid order is written to the Shopify test store with the near_tx"],
    ["replay", "the same nullifier from another account is refused: nullifier spent"],
    ["review", "relayed: join_review_group with a fresh Semaphore identity"],
  ];
}

const readSeed = (c, name) => keyFromSeed(readFileSync(join(c.keysDir, `${name}.seed`), "utf8"));
function newSeed(path) {
  const s = randomBytes(32).toString("hex");
  writeFileSync(path, s + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return keyFromSeed(s);
}
const fc = (method_name, args, deposit = 0n, gas = 100n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const link = (h) => `https://testnet.nearblocks.io/txns/${h}`;
const BOOKERBOB = ["cargo", "run", "-q", "-p", "bookerbob-cli", "--"];
function run(cmd, opts = {}) {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
  if (r.status !== 0) throw new Error(`${cmd.slice(0, 6).join(" ")}: ${(r.stderr || r.stdout || "").slice(-400)}`);
  return r.stdout;
}

export class Demo {
  constructor(c) {
    this.c = c;
    this.client = rpcClient(c.rpc);
    this.log = [];
    this.used = new Map();
  }
  note(step, account, r) {
    this.log.push({ step, account, hash: r.hash, ok: r.ok });
    console.log(`   ${r.ok ? "ok" : "FAILED"} ${step}${r.hash ? `  ${link(r.hash)}` : ""}${r.ok ? "" : `\n   ${r.error}`}`);
    return r;
  }
  async direct(step, signer_id, key, receiver_id, actions, { expectFail } = {}) {
    const r = await send(this.client, { signer_id, key, receiver_id, actions });
    if (expectFail) {
      const refused = !r.ok && (r.error ?? "").includes(expectFail);
      this.log.push({ step, account: signer_id, hash: r.hash, ok: refused });
      console.log(`   ${refused ? "refused as expected" : "UNEXPECTED"}: ${expectFail}  ${link(r.hash)}`);
      if (!refused) throw new Error(`${step}: expected "${expectFail}", got ${r.ok ? "success" : r.error}`);
      return r;
    }
    this.note(step, signer_id, r);
    if (!r.ok) throw new Error(`${step}: ${r.error}`);
    return r;
  }
  /** Gasless: the tester signs a delegate action, the relayer (treasury) checks the demo
   *  policy and pays the gas. */
  async relay(step, tester, receiver_id, action) {
    const signed = await delegateFor(this.client, { sender_id: tester.id, key: tester.key, receiver_id, actions: [action] });
    const header = await this.client.block();
    const used = this.used.get(tester.id) ?? 0;
    const ok = checkDemo(signed, { bazaar: this.c.bazaar, dusdc: this.c.dusdc, treasury: this.c.treasury, block_height: header.height, implicit: this.implicit }, used);
    if (!ok.ok) throw new Error(`relayer refused ${step}: ${ok.reason}`);
    this.used.set(tester.id, used + 1);
    return this.direct(`${step} (relayed)`, this.c.treasury, this.treasury, tester.id, [{ type: "Delegate", ...signed }]);
  }

  async setup() {
    const c = this.c;
    mkdirSync(c.keysDir, { recursive: true });
    for (const name of ["treasury", "dusdc"]) {
      const p = join(c.keysDir, `${name}.seed`);
      const k = existsSync(p) ? keyFromSeed(readFileSync(p, "utf8")) : newSeed(p);
      const id = name === "treasury" ? c.treasury : c.dusdc;
      const acct = await this.client.account(id);
      console.log(`${id}: ${acct ? "exists" : "MISSING"}  key ${nearPublicKey(k.pub)}`);
      if (!acct) console.log(`   create it (faucet, no NEAR from us): near account create-account sponsor-by-faucet-service ${id} use-manually-provided-public-key ${nearPublicKey(k.pub)} network-config testnet create`);
    }
    if (!(await this.client.account(c.treasury)) || !(await this.client.account(c.dusdc))) return false;
    this.treasury = readSeed(c, "treasury");
    const dk = readSeed(c, "dusdc");
    const meta = await this.client.view(c.dusdc, "ft_metadata").catch(() => null);
    if (!meta) {
      const code = readFileSync("target/near/bookerbob_dusdc.wasm");
      await this.direct("deploy dUSDC and new()", c.dusdc, dk, c.dusdc, [{ type: "DeployContract", code }, fc("new", {}, 0n, 30n * TGAS)]);
    } else console.log(`   skip: dUSDC deployed (${meta.symbol}, ${meta.name})`);
    for (const a of [c.bazaar, c.merchant]) {
      if (await this.client.view(c.dusdc, "storage_balance_of", { account_id: a })) console.log(`   skip: ${a} registered with dUSDC`);
      else await this.direct(`dUSDC storage_deposit ${a}`, c.treasury, this.treasury, c.dusdc, [fc("storage_deposit", { account_id: a, registration_only: true }, 1250n * 10n ** 18n, 30n * TGAS)]);
    }
    const dt = await this.client.view(c.bazaar, "demo_token").catch(() => null);
    console.log(`bazaar demo_token: ${dt ?? "not set (owner: set_demo_token, see scripts/deploy-testnet.sh step 2b)"}`);
    return dt === c.dusdc;
  }

  async preflight() {
    const c = this.c;
    if ((await this.client.view(c.bazaar, "demo_token")) !== c.dusdc) throw new Error(`bazaar does not accept ${c.dusdc}: run setup and deploy-testnet.sh step 2b`);
    const t = await this.client.account(c.treasury);
    if (!t || BigInt(t.amount) < TREASURY_MIN) throw new Error(`treasury ${c.treasury} holds under 1 NEAR: top it up (faucet) before more testers`);
    mkdirSync(c.testersDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const n = readdirSync(c.testersDir).filter((f) => f.endsWith(".json") && JSON.parse(readFileSync(join(c.testersDir, f), "utf8")).date === today).length;
    if (n >= DAILY_TESTERS) throw new Error(`${n} testers today: the daily cap is ${DAILY_TESTERS}`);
    this.treasury = readSeed(c, "treasury");
    console.log(`   ok: demo token set, treasury ${(Number(BigInt(t.amount) / MILLI) / 1000).toFixed(3)} NEAR, ${n} testers today`);
  }

  async run(opts = {}) {
    const c = this.c;
    const step = (i, t) => console.log(`${i}. ${t}`);
    step(1, "preflight");
    await this.preflight();
    const hex6 = randomBytes(3).toString("hex");
    // The default: a one-time implicit account, its id the hex of a fresh key, which also serves
    // as the verdict's cnf, created by the treasury's transfer alone; the seed stays in
    // KEYS_DIR/testers. DEMO_NAMED=1 (or implicit: false) gives a named subaccount of the treasury,
    // whose name shows its parent; `make leak` fails on a new one.
    const implicit = opts.implicit ?? process.env.DEMO_NAMED !== "1";
    let id = testerId(c, hex6);
    let dir = join(c.testersDir, id);
    let key;
    if (implicit) {
      const tmp = join(c.testersDir, `implicit-${hex6}`);
      mkdirSync(tmp, { recursive: true });
      // opts.seed: a key made earlier, so the account can be named before it buys (a coalition
      // job lists its buyer agents when it opens, scripts/coalition-live.mjs jobd).
      if (opts.seed) writeFileSync(join(tmp, "account.seed"), opts.seed.trim() + "\n", { mode: 0o600 });
      key = opts.seed ? keyFromSeed(opts.seed) : newSeed(join(tmp, "account.seed"));
      id = key.pub;
      dir = tmp;
      (this.implicit ??= new Set()).add(id);
    } else {
      mkdirSync(dir, { recursive: true });
      key = newSeed(join(dir, "account.seed"));
    }
    const tester = { id, key };
    const rec = { tester: id, merchant: c.merchant, date: new Date().toISOString().slice(0, 10), txs: {}, ...(implicit && { dir: `implicit-${hex6}` }) };
    const save = () => writeFileSync(join(c.testersDir, `${id}.json`), JSON.stringify(rec, null, 2) + "\n");
    step(2, implicit ? `fund a one-time implicit account ${id.slice(0, 12)}..` : `create ${id}`);
    const create = implicit ? [{ type: "Transfer", deposit: TESTER_FUND }] : [{ type: "CreateAccount" }, { type: "Transfer", deposit: TESTER_FUND }, { type: "AddKey", public_key_hex: tester.key.pub, permission: "FullAccess" }];
    rec.txs.account = (await this.direct(implicit ? "fund implicit tester" : "create tester", c.treasury, this.treasury, id, create)).hash;
    save();
    step(3, "storage: bazaar escrow entry and dUSDC registration, paid by the treasury");
    rec.txs.escrow_entry = (await this.direct("bazaar storage_deposit", c.treasury, this.treasury, c.bazaar, [fc("storage_deposit", { account_id: id }, 10n * MILLI, 30n * TGAS)])).hash;
    rec.txs.dusdc_storage = (await this.direct("dUSDC storage_deposit", c.treasury, this.treasury, c.dusdc, [fc("storage_deposit", { account_id: id, registration_only: true }, 1250n * 10n ** 18n, 30n * TGAS)])).hash;
    step(4, "mint 100 dUSDC");
    // opts.mint: a hotel-size buy mints more in one go (at most 500 dUSDC, still free).
    rec.txs.mint = (await this.relay("mint", tester, c.dusdc, fc("mint", opts.mint ? { amount: String(opts.mint) } : {}, 0n, 30n * TGAS))).hash;
    step(5, "sign the verdict and World attestation");
    const live = join(dir, "live");
    if (opts.voprf) {
      // The account nullifier from REP's VOPRF evaluator (cli/src/voprf.rs): the buyer blinds a
      // fresh input, the evaluator sees only the blinded element and evaluates once for this
      // requester and context, the buyer checks the proof under the bazaar's voprf_key.
      const pk = await this.client.view(c.bazaar, "voprf_key", {});
      if (!pk) throw new Error(`${c.bazaar} has no voprf_key anchored`);
      mkdirSync(live, { recursive: true });
      const rd = JSON.parse(run([...BOOKERBOB, "voprf-nullifier", c.keysDir, id, "bookerbob:v0:demo-hoodie", pk, join(dir, "voprf.json")]));
      process.env.BOOKERBOB_NULLIFIER = rd.nullifier;
      rec.voprf = rd;
      console.log(`   VOPRF nullifier ${rd.nullifier.slice(0, 12)}.. (the evaluator saw a blinded element only; proof checked under ${pk.slice(0, 12)}..)`);
    }
    // opts.proofs: the device run's proof set (one real, notary-verified fact in it).
    // opts.sealed: the verdict goes on chain as hashes only; live/opening.json (mode 600)
    // holds the predicates, tier and cap for the referee.
    rec.nullifier = (opts.proofs
      ? run([...BOOKERBOB, opts.sealed ? "sign-real-sealed" : "sign-real", c.keysDir, id, c.treasury, c.worldAction, live, opts.proofs])
      : run([...BOOKERBOB, "sign-tester", c.keysDir, id, c.treasury, c.worldAction, live])).trim();
    delete process.env.BOOKERBOB_NULLIFIER;
    if (rec.voprf && rec.nullifier !== rec.voprf.nullifier) throw new Error("the signed verdict does not carry the VOPRF nullifier");
    if (opts.proofs && !opts.rehearsal) rec.device_run = true;
    if (opts.sealed) rec.sealed = true;
    const file = (n) => JSON.parse(readFileSync(join(live, n), "utf8"));
    step(6, "attest_human");
    rec.txs.world = (await this.relay("attest_human", tester, c.bazaar, fc("attest_human", { attestation: file("world.json") }, 10n * MILLI))).hash;
    if (opts.nearAi) {
      // A model-issued verdict (make model-buy): the model derives the predicates from the facts
      // sealed to its attested key; the envelope replaces the issuer-signed one.
      step(7, "submit_near_ai_verdict (the model issued it, not the issuer key)");
      const v = file("verdict.json");
      const { envelope, proof, record } = await opts.nearAi(v.envelope);
      writeFileSync(join(live, "verdict.json"), JSON.stringify({ ...v, envelope }, null, 2) + "\n", { mode: 0o600 });
      rec.near_ai = record;
      rec.txs.verdict = (await this.relay("submit_near_ai_verdict", tester, c.bazaar, fc("submit_near_ai_verdict", { envelope, proof }, 50n * MILLI, 150n * TGAS))).hash;
      if (opts.beforeReceipt) await opts.beforeReceipt({ tester, rec, live, d: this });
    } else {
      step(7, "submit_verdict");
      rec.txs.verdict = (await this.relay("submit_verdict", tester, c.bazaar, fc("submit_verdict", { verdict: file("verdict.json") }, 50n * MILLI))).hash;
    }
    step(8, "referee receipt");
    // The live quote: once k >= 5 verdicts in the context reveal the cohort predicate, the
    // group price unlocks on chain, and the referee must price with the same k.
    // A sealed verdict has no on-chain quote: the referee prices it from the opening, k = 0,
    // and the contract accepts only a price its schedule code can produce.
    const q = opts.sealed ? null : await this.client.view(c.bazaar, "quote", { merchant: c.merchant, nullifier: rec.nullifier });
    const k = q?.cohort?.k ?? 0;
    const input = run([...BOOKERBOB, "worker-input", opts.fixturesDir ?? "fixtures", join(live, "verdict.json"), opts.sealed ? join(live, "opening.json") : String(k)]);
    if (opts.referee) {
      // The referee runs elsewhere (make outlayer-buy: OutLayer, through request_referee); the
      // hook returns the receipt's price, or { stop: true } after a refusal it has recorded.
      const r = await opts.referee({ input, rec, tester, live, q, d: this });
      save();
      if (r.stop) return rec;
      rec.price = r.price;
      rec.cohort_k = k;
    } else {
    const seed = readFileSync(join(c.keysDir, "referee.seed"), "utf8").trim();
    const result = JSON.parse(run(["cargo", "run", "-q", "-p", "bookerbob-referee-worker"], { input, env: { ...process.env, REFEREE_SIGNING_SEED: seed } }));
    if (result.body.merchant !== c.merchant) throw new Error(`the referee's winner is ${result.body.merchant}, expected ${c.merchant}`);
    rec.price = result.body.price;
    rec.cohort_k = k;
    if (result.body.outcome !== "receipt") throw new Error(`the referee refused: ${result.body.detail}`);
    if (q && String(rec.price) !== String(q.price)) throw new Error(`referee price ${rec.price} differs from the on-chain quote ${q.price} (k=${k})`);
    rec.txs.receipt = (await this.relay("submit_referee_result", tester, c.bazaar, fc("submit_referee_result", { result }, 0n, 100n * TGAS))).hash;
    }
    console.log(`   receipt price ${Number(rec.price) / 1e6} dUSDC${k ? ` (group price, k=${k})` : ""}`);
    step(9, "escrow in dUSDC");
    rec.txs.escrow = (await this.relay("ft_transfer_call", tester, c.dusdc, fc("ft_transfer_call", { receiver_id: c.bazaar, amount: String(rec.price), msg: "" }, 1n, 100n * TGAS))).hash;
    const bal = await this.client.view(c.bazaar, "demo_escrow_of", { account_id: id });
    if (BigInt(bal ?? 0) < BigInt(rec.price)) throw new Error(`demo escrow ${bal} below the price`);
    if (opts.group) {
      // Buying group: post a sealed intent instead of settling alone (budget sealed).
      step(10, "post a sealed intent: join the buying group for this revealed set");
      const salt = randomBytes(32).toString("hex");
      const budget = String(BigInt(rec.price) + 5_000_000n);
      writeFileSync(join(dir, "budget.secret"), `${budget} ${salt}\n`, { mode: 0o600 });
      const commitment = createHash("sha256").update(`${budget}|${salt}`).digest("hex");
      const r = await this.relay("post_intent", tester, c.bazaar, fc("post_intent", { nullifier: rec.nullifier, category: opts.category ?? "hoodie", budget_commitment: commitment }, 20n * MILLI));
      rec.txs.intent = r.hash;
      rec.group = r.value ?? (await this.client.view(c.bazaar, "group_of", { nullifier: rec.nullifier }));
      save();
      console.log(`   in group ${String(rec.group).slice(0, 12)}..`);
      return rec;
    }
    // Buy Twice (make buy-twice): the claim moves the price the settle must pay.
    if (opts.beforeSettle) await opts.beforeSettle({ tester, rec, d: this });
    step(10, "settle_demo");
    rec.checkout_ref = `demo-${hex6}`;
    const s = await this.relay("settle_demo", tester, c.bazaar, fc("settle_demo", { nullifier: rec.nullifier, merchant: c.merchant, checkout_ref: rec.checkout_ref, amount: String(rec.price) }, 0n, 150n * TGAS));
    rec.txs.settle = s.hash;
    if (s.logs.some((l) => l.includes("settle_reverted"))) throw new Error("the dUSDC payout failed and the settle was reverted");
    if ((await this.client.view(c.bazaar, "paid_in", { nullifier: rec.nullifier })) !== "demo") throw new Error("paid_in is not demo");
    save();
    if (opts.skipFinish) return rec;
    return this.finish(rec, tester, dir, save, step);
  }

  /** Steps 11 to 13; `resume <tester>` re-enters here for a purchase that already settled. */
  async finish(rec, tester, dir, save, step) {
    const c = this.c;
    const id = tester.id;
    const live = join(dir, "live");
    const file = (n) => JSON.parse(readFileSync(join(live, n), "utf8"));
    step(11, "Shopify order");
    if (!rec.shopify?.id) {
      try {
        rec.shopify = await this.shopify(rec, { hash: rec.txs.settle });
      } catch (e) {
        // The purchase is on chain either way; the store write is retried by `resume`.
        rec.shopify = { error: e.message };
        console.log(`   NOT WRITTEN: ${e.message}`);
      }
      save();
    } else console.log(`   skip: order ${rec.shopify.name}`);
    step(12, "replay: same nullifier from the treasury account");
    if (rec.txs.replay) {
      console.log("   skip: done");
    } else {
    rec.txs.replay = (await this.direct("replay refused", c.treasury, this.treasury, c.bazaar, [fc("submit_verdict", { verdict: file("verdict-replay.json") }, 50n * MILLI)], { expectFail: "nullifier spent" })).hash;
      save();
    }
    step(13, `join ${c.merchant.split(".")[0]}'s review group with a fresh Semaphore identity`);
    if (rec.review?.size) {
      console.log(`   skip: member ${rec.review.size}`);
      return rec;
    }
    const identity = randomBytes(32).toString("hex");
    writeFileSync(join(dir, "semaphore.secret"), identity + "\n", { mode: 0o600 });
    const commitment = run(["node", "identity.mjs", "commitment"], { input: identity, cwd: "semaphore" }).trim();
    const j = await this.relay("join_review_group", tester, c.bazaar, fc("join_review_group", { nullifier: rec.nullifier, identity_commitment: commitment }, 20n * MILLI));
    rec.txs.review_join = j.hash;
    const added = j.logs.map((l) => (l.startsWith("EVENT_JSON:") ? JSON.parse(l.slice(11)) : null)).find((e) => e?.event === "review_member_added")?.data?.[0];
    rec.review = { commitment, size: added?.size, root: added?.root };
    save();
    console.log(`\ndemo-tester: PASS  ${id}, paid ${Number(rec.price) / 1e6} dUSDC, review group size ${added?.size}${rec.shopify?.id ? `, Shopify ${rec.shopify.name}` : ", Shopify order NOT written"}`);
    return rec;
  }

  /** n new testers post intents into one group; the merchant offers the first tier; each
   *  member pays the group price. */
  /** One purchase from a hotel merchant (h01..h08): the same calls as the hoodie run, with the
   * hotel's schedule for the referee and a 500 dUSDC mint so the tester can escrow a stay. */
  async hotel(merchant = `h05.${this.c.bazaar}`, opts = {}) {
    const m = JSON.parse(readFileSync("agents/merchants.json", "utf8")).find((x) => x.account === merchant && x.category === "hotel-lisbon");
    if (!m) throw new Error(`${merchant} is not a hotel merchant`);
    const fx = join(this.c.testersDir, "hotel-fixtures");
    mkdirSync(fx, { recursive: true });
    writeFileSync(join(fx, "merchants.json"), JSON.stringify([{ account: m.account, label: m.persona, category: m.category, schedule: m.schedule }], null, 2) + "\n");
    for (const f of ["proofs.json", "claims-honest.json"]) copyFileSync(join("fixtures", f), join(fx, f));
    this.c = { ...this.c, merchant: m.account, category: "hotel" };
    // The verdict's cap must cover a stay (the fixture cap is 45 dUSDC; settle refuses above it).
    process.env.BOOKERBOB_MAX_SPEND = "450000000";
    const rec = await this.run({ fixturesDir: fx, mint: 500_000_000, ...opts }).finally(() => delete process.env.BOOKERBOB_MAX_SPEND);
    rec.category = "hotel-lisbon";
    rec.merchant = m.account;
    writeFileSync(join(this.c.testersDir, `${rec.tester}.json`), JSON.stringify(rec, null, 2) + "\n");
    return rec;
  }

  async group(n = 5) {
    const c = this.c;
    const members = [];
    for (let i = 0; i < n; i++) {
      console.log(`\n=== member ${i + 1} of ${n}`);
      members.push(await this.run({ group: true }));
    }
    const key = members[0].group;
    const g = await this.client.view(c.bazaar, "buying_group", { group: key });
    console.log(`\ngroup ${key.slice(0, 12)}..: ${g.members.length} members, ${g.persons} persons`);
    const o = spawnSync("near", ["contract", "call-function", "as-transaction", c.bazaar, "offer_group", "json-args", JSON.stringify({ group: key, bps: 1000 }), "prepaid-gas", "50.0 Tgas", "attached-deposit", "0 NEAR", "sign-as", c.merchant, "network-config", "testnet", "sign-with-keychain", "send"], { encoding: "utf8" });
    const offerTx = `${o.stdout}${o.stderr}`.match(/Transaction ID: ([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1];
    if (o.status !== 0) throw new Error(`offer_group: ${(o.stdout + o.stderr).slice(-300)}`);
    console.log(`   ok ${c.merchant} offers the 10% tier  ${link(offerTx)}`);
    const offer = (await this.client.view(c.bazaar, "buying_group", { group: key })).offer;
    const out = { group: key, offer_tx: offerTx, offer: { merchant: offer[0], bps: offer[1], price: offer[2] }, members: [] };
    for (const rec of members) {
      const dir = join(c.testersDir, rec.tester);
      const tester = { id: rec.tester, key: keyFromSeed(readFileSync(join(dir, "account.seed"), "utf8")) };
      const s = await this.relay("settle_group_demo", tester, c.bazaar, fc("settle_group_demo", { nullifier: rec.nullifier, checkout_ref: `group-${rec.tester.slice(2, 8)}`, amount: offer[2] }, 0n, 150n * TGAS));
      if (s.logs.some((l) => l.includes("settle_reverted"))) throw new Error("group payout reverted");
      rec.txs.settle_group = s.hash;
      writeFileSync(join(c.testersDir, `${rec.tester}.json`), JSON.stringify(rec, null, 2) + "\n");
      out.members.push({ tester: rec.tester, nullifier: rec.nullifier, receipt_price: rec.price, paid: offer[2], txs: rec.txs });
    }
    writeFileSync(join(c.testersDir, "group-state.json"), JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
    console.log(`\ndemo-tester group: PASS  ${n} members paid ${Number(offer[2]) / 1e6} dUSDC each (receipt ${Number(members[0].price) / 1e6}, 10% tier)`);
    return out;
  }

  async resume(id) {
    await this.preflight();
    const recPath = join(this.c.testersDir, `${id}.json`);
    const rec = JSON.parse(readFileSync(recPath, "utf8"));
    const dir = join(this.c.testersDir, rec.dir ?? id);
    if (rec.dir) (this.implicit ??= new Set()).add(id);
    if (!rec.txs.settle) throw new Error(`${id} has not settled; start a new tester instead`);
    const tester = { id, key: keyFromSeed(readFileSync(join(dir, "account.seed"), "utf8")) };
    const save = () => writeFileSync(recPath, JSON.stringify(rec, null, 2) + "\n");
    return this.finish(rec, tester, dir, save, (i, t) => console.log(`${i}. ${t}`));
  }

  async shopify(rec, settleTx) {
    if (!existsSync(this.c.shopifyEnv)) {
      console.log(`   skip: no ${this.c.shopifyEnv}`);
      return null;
    }
    const { adminFromEnv, orderFields, readPayment, recordPaidOrder } = await import("../ucp/src/near-usdc.mjs");
    const r = await this.client.rpc("tx", { tx_hash: settleTx.hash, sender_account_id: this.c.treasury, wait_until: "FINAL" });
    // The outer tx is the relayer's; the inner call is the tester's settle_demo. readPayment
    // reads the delegate's receipt, so give it the inner transaction view.
    const inner = { ...r.result, transaction: { ...r.result.transaction, receiver_id: this.c.bazaar, actions: [{ FunctionCall: { method_name: "settle_demo" } }] } };
    const paid = readPayment(inner, { bazaar: this.c.bazaar, usdc: "-", demoToken: this.c.dusdc });
    const order = await recordPaidOrder([{ title: `${this.c.merchant} ${this.c.category ?? "hoodie"} (BookerBob testnet demo)` }], orderFields(paid, { network: "testnet" }), { admin: adminFromEnv(readFileSync(this.c.shopifyEnv, "utf8")) });
    console.log(`   ok Shopify order ${order.name} (id ${order.id}) with near_tx ${paid.tx_hash}`);
    return order;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = config(process.env);
  const no = guard(c);
  if (no) {
    console.error(`refusing: ${no}`);
    process.exit(2);
  }
  const cmd = process.argv[2] ?? "run";
  if (c.dryRun || cmd === "plan") {
    console.log(`demo-tester on testnet: bazaar ${c.bazaar}, dUSDC ${c.dusdc}, treasury ${c.treasury}${c.dryRun ? " (dry run, nothing is read or sent)" : ""}`);
    for (const [i, [id, t]] of plan(c).entries()) console.log(`${String(i + 1).padStart(2)}  ${id.padEnd(9)} ${t}`);
    process.exit(0);
  }
  const d = new Demo(c);
  const go = cmd === "setup" ? d.setup() : cmd === "run" ? d.run({ voprf: Boolean(process.env.DEMO_VOPRF) }) : cmd === "hotel" ? d.hotel(process.argv[3]) : cmd === "sealed" ? d.run({ proofs: "fixtures/proofs.json", sealed: true, rehearsal: true }) : cmd === "resume" ? d.resume(process.argv[3]) : cmd === "group" ? d.group(Number(process.argv[3] ?? 5)) : cmd === "reviews" ? import("./demo-reviews.mjs").then((m) => m.reviews(d, process.argv[3])) : Promise.reject(new Error(`unknown command ${cmd}`));
  go.then(
    () => {},
    (e) => {
      console.error(`\ndemo-tester: FAIL ${e.message}`);
      process.exit(1);
    },
  );
}
