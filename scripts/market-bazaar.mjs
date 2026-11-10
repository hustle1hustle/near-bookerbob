#!/usr/bin/env node
// Panel round 4, action 8 (the coordinating session's decision on the founder's delegation, 2026-11-05):
// market.bookerbob.testnet is a bazaar owned by the Sputnik DAO bookerbob-gov from block one.
// Every trust anchor goes in by a 2-of-3 council vote, the anchor delay is set above 0, and
// then the account's only full-access key is deleted, so no one can redeploy its code.
//
//   node scripts/market-bazaar.mjs setup      create, deploy + init (owner = DAO), dUSDC storage
//   node scripts/market-bazaar.mjs anchors    DAO proposal 1: demo token, issuer, referee, World
//                                             verifier, arbiter, fee
//   node scripts/market-bazaar.mjs merchants  m01 and h05 register; DAO proposal 2: approve them,
//                                             h05's price anchor, anchor delay 5 min
//   node scripts/market-bazaar.mjs lock       DeleteKey of the temporary full-access key (IRREVERSIBLE)
// Testnet only. Keys: KEYS_DIR/market/market.seed (temporary), KEYS_DIR/dao/{c1,c2}.seed.
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./demo-tester.mjs";
import { keyFromSeed, near, nearPublicKey, rpcClient, send } from "../relayer/near.mjs";

const TGAS = 10n ** 12n;
const c = config({ ...process.env, BAZAAR_ACCOUNT_ID: "bookerbob.testnet" });
export const MARKET = "market.bookerbob.testnet";
const DAO = "bookerbob-gov.sputnikv2.testnet";
const OPS = "bookerbob-dao-ops.testnet";
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const client = rpcClient(c.rpc);
const dir = join(c.keysDir, "market");
mkdirSync(dir, { recursive: true });
const statePath = join(dir, "state.json");
const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { txs: {} };
const save = () => writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n", { mode: 0o600 });
const seedKey = (p) => keyFromSeed(readFileSync(p, "utf8"));
const K = { c1: seedKey(join(c.keysDir, "dao", "c1.seed")), c2: seedKey(join(c.keysDir, "dao", "c2.seed")) };
const ID = { c1: `c1.${OPS}`, c2: `c2.${OPS}` };
const fc = (method_name, args, deposit = 0n, gas = 100n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const link = (h) => `https://testnet.nearblocks.io/txns/${h}`;

async function tx(label, signer, key, receiver, actions) {
  const r = await send(client, { signer_id: signer, key, receiver_id: receiver, actions });
  console.log(`   ${r.ok ? "ok" : "FAILED"} ${label}  ${link(r.hash)}`);
  if (!r.ok) throw new Error(`${label}: ${r.error}`);
  return r;
}

/** One DAO proposal with several bazaar calls, voted by c1 and c2 (2 of 3): executes on the second vote. */
async function viaDao(label, calls) {
  const actions = calls.map(([method, args, deposit = "0", gas = 20n]) => ({ method_name: method, args: Buffer.from(JSON.stringify(args)).toString("base64"), deposit, gas: String(gas * TGAS) }));
  const kind = { FunctionCall: { receiver_id: MARKET, actions } };
  const p = await tx(`c1 proposes: ${label}`, ID.c1, K.c1, DAO, [fc("add_proposal", { proposal: { description: label, kind } }, near(1), 50n * TGAS)]);
  await tx(`c1 votes on ${p.value}`, ID.c1, K.c1, DAO, [fc("act_proposal", { id: p.value, action: "VoteApprove", proposal: kind }, 0n, 100n * TGAS)]);
  const v = await tx(`c2 votes on ${p.value}: executes`, ID.c2, K.c2, DAO, [fc("act_proposal", { id: p.value, action: "VoteApprove", proposal: kind }, 0n, 300n * TGAS)]);
  const pr = await client.view(DAO, "get_proposal", { id: p.value });
  if (pr.status !== "Approved") throw new Error(`proposal ${p.value}: ${pr.status}`);
  return { proposal: p.value, propose: p.hash, execute: v.hash };
}

/** Sign as a keychain account with near-cli, broadcast over RPC (so a failure still has a hash). */
async function asKeychain(signer, receiver, method, args, deposit) {
  const o = spawnSync("near", ["contract", "call-function", "as-transaction", receiver, method, "json-args", JSON.stringify(args), "prepaid-gas", "50.0 Tgas", "attached-deposit", deposit, "sign-as", signer, "network-config", "testnet", "sign-with-keychain", "display"], { encoding: "utf8" });
  const b64 = `${o.stdout}${o.stderr}`.replace(/\x1b\[[0-9;]*m/g, "").split("serialized as base64):")[1]?.trim().split(/\s/)[0];
  if (!b64) throw new Error(`could not sign ${method} as ${signer}`);
  const r = await client.rpc("send_tx", { signed_tx_base64: b64, wait_until: "FINAL" });
  const res = r.result;
  const fail = res ? [res.transaction_outcome, ...res.receipts_outcome].map((x) => x.outcome.status.Failure).find(Boolean) ?? res.status.Failure : r.error;
  console.log(`   ${fail ? "FAILED" : "ok"} ${signer.split(".")[0]} ${method}  ${link(res?.transaction?.hash)}`);
  if (fail) throw new Error(`${method}: ${JSON.stringify(fail).slice(0, 300)}`);
  return res.transaction.hash;
}

async function setup() {
  const seedPath = join(dir, "market.seed");
  if (!existsSync(seedPath)) writeFileSync(seedPath, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  const key = seedKey(seedPath);
  if (!(await client.account(MARKET))) {
    const o = spawnSync("near", ["account", "create-account", "fund-myself", MARKET, "9 NEAR", "use-manually-provided-public-key", nearPublicKey(key.pub), "sign-as", "bookerbob.testnet", "network-config", "testnet", "sign-with-keychain", "send"], { encoding: "utf8" });
    st.txs.create = `${o.stdout}${o.stderr}`.match(/Transaction ID: ([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1];
    if (!(await client.account(MARKET))) throw new Error(`create ${MARKET} failed`);
    console.log(`   ok create ${MARKET} with one temporary full-access key ${nearPublicKey(key.pub)}  ${link(st.txs.create)}`);
    save();
  }
  if (!st.txs.deploy) {
    const code = readFileSync("target/near/bookerbob_bazaar.wasm");
    st.wasm_sha256 = createHash("sha256").update(code).digest("hex");
    st.txs.deploy = (await tx(`deploy the bazaar (wasm sha256 ${st.wasm_sha256.slice(0, 16)}..) and new(owner = ${DAO})`, MARKET, key, MARKET, [{ type: "DeployContract", code }, fc("new", { owner: DAO, usdc: USDC }, 0n, 100n * TGAS)])).hash;
    save();
  }
  if (!(await client.view(c.dusdc, "storage_balance_of", { account_id: MARKET }))) {
    const t = seedKey(join(c.keysDir, "treasury.seed"));
    st.txs.dusdc_storage = (await tx("dUSDC storage for the market (treasury pays)", c.treasury, t, c.dusdc, [fc("storage_deposit", { account_id: MARKET, registration_only: true }, 1250n * 10n ** 18n, 30n * TGAS)])).hash;
    save();
  }
}

async function anchors() {
  if (st.anchors) return console.log("   anchors already set by proposal", st.anchors.proposal);
  const live = (m, a = {}) => client.view("bookerbob.testnet", m, a);
  const issuer = (await live("issuers")).find(([, l]) => l === "testnet issuer")[0];
  const referee = (await live("referees"))[0][0];
  const pub = (n) => seedKey(join(c.keysDir, `${n}.seed`)).pub;
  st.anchors = await viaDao("market bazaar trust anchors: demo token, issuer, referee, World verifier, arbiter, 1% fee to the DAO", [
    ["set_demo_token", { token: c.dusdc }],
    ["register_issuer", { key_id: issuer, label: "testnet issuer" }],
    ["register_referee", { key_hex: referee, label: "testnet referee" }],
    ["register_world_verifier", { key_hex: pub("world"), action: c.worldAction, label: "testnet World verifier (placeholder action)" }],
    ["register_arbiter", { key_hex: pub("arbiter"), label: "testnet arbiter (REP)" }],
    ["set_fee", { bps: 100, treasury: DAO }],
  ]);
  save();
  console.log(`   issuers ${JSON.stringify((await client.view(MARKET, "issuers", {})).map((x) => x[1]))}, fee ${JSON.stringify(await client.view(MARKET, "fee", {}))}`);
}

async function merchants() {
  const all = JSON.parse(readFileSync("agents/merchants.json", "utf8"));
  const pick = ["m01.bookerbob.testnet", "h05.bookerbob.testnet"].map((a) => all.find((m) => m.account === a));
  st.merchants = st.merchants ?? {};
  for (const m of pick) {
    if (st.merchants[m.account]) continue;
    st.merchants[m.account] = await asKeychain(m.account, MARKET, "register_merchant", { schedule: m.schedule, category: m.category, payout: null }, "0.02 NEAR");
    save();
  }
  if (!st.approve) {
    const rates = JSON.parse(readFileSync("fixtures/live/cheat/run.json", "utf8")).anchors["h05.bookerbob.testnet"];
    st.approve = await viaDao("market bazaar: approve m01 and h05, h05's public price anchor, anchor delay 5 minutes", [
      ["approve_merchant", { merchant: "m01.bookerbob.testnet" }],
      ["approve_merchant", { merchant: "h05.bookerbob.testnet" }],
      ["set_price_anchor", { merchant: "h05.bookerbob.testnet", max_base: rates.max_base, source: rates.source }],
      ["set_anchor_delay", { ms: 300000 }],
    ]);
    save();
  }
  for (const m of pick) console.log(`   ${m.account}: approved ${(await client.view(MARKET, "merchant", { merchant: m.account })).approved}`);
  console.log(`   anchor_delay ${await client.view(MARKET, "anchor_delay", {})} ms`);
}

/** Run a queued anchor change once its public delay has passed (anyone may; c1 does here). */
async function executeQueued(label, logsFrom) {
  const q = logsFrom.map((l) => (l.startsWith("EVENT_JSON:") ? JSON.parse(l.slice(11)) : null)).find((e) => e?.event === "anchor_queued")?.data?.[0];
  if (!q) return null;
  const wait = q.ready_ms - Date.now() + 5000;
  if (wait > 0) {
    console.log(`   ${label}: queued as ${q.id}, waiting ${Math.ceil(wait / 1000)} s for the anchor delay`);
    await new Promise((ok) => setTimeout(ok, wait));
  }
  return (await tx(`execute_anchor ${q.id} (${label}) after the delay`, ID.c1, K.c1, MARKET, [fc("execute_anchor", { id: q.id }, 0n, 50n * TGAS)])).hash;
}

/** DAO proposals 3 and 4: the market takes model keys only through the on-chain quote verifier.
 * Both changes are anchors, so each waits out the market's delay in public before it applies. */
async function quote() {
  st.quote = st.quote ?? {};
  const run = JSON.parse(readFileSync("tools/dcap-spike/run.json", "utf8"));
  const cap = JSON.parse(readFileSync("fixtures/live/near-ai/capture.json", "utf8"));
  const att = { model: cap.model, nonce: cap.nonce, report_hash: cap.envelope.attestation.report_hash, tcb_status: "UpToDate" };
  if (!(await client.view(MARKET, "quote_verifier", {}))) {
    st.quote.verifier = await viaDao("market bazaar: the on-chain TDX quote verifier (spike.bookerbob.testnet)", [["set_quote_verifier", { verifier: SPIKE }]]);
    save();
    st.quote.verifier_execute = await executeQueued("set_quote_verifier", await logsOf(st.quote.verifier.execute));
    save();
  }
  if (!(await client.view(MARKET, "model_attestation", { signing_key: cap.signing_address }))) {
    st.quote.register = await viaDao("market bazaar: the NEAR AI model key, against its finalized on-chain quote verification", [["register_model_attestation_verified", { signing_key: cap.signing_address, attestation: att, verification_id: run.real.id }, "0", 80n]]);
    save();
    st.quote.register_execute = await executeQueued("model_attestation", await logsOf(st.quote.register.execute));
    save();
  }
  console.log(`   quote verifier ${await client.view(MARKET, "quote_verifier", {})}; model key ${JSON.stringify(await client.view(MARKET, "model_attestation", { signing_key: cap.signing_address }))?.slice(0, 70)}`);
}

/** Before the lock: the market runs the bazaar's current code (redeployed with the temporary
 *  key, the one the lock deletes; the bazaar has no upgrade method, so a DAO cannot redeploy it),
 *  then DAO proposal 5 registers the REP Eval issuer (an anchor: it waits out the delay), the set
 *  owner commits the v4 root and the v4 certificates go in, so a market merchant can set an eval gate. */
async function upgrade() {
  const { createHash } = await import("node:crypto");
  const { b58encode: base58 } = await import("../relayer/near.mjs");
  const wasm = readFileSync("target/near/bookerbob_bazaar.wasm");
  const hash = createHash("sha256").update(wasm).digest();
  const acct = await client.account(MARKET);
  if (acct.code_hash !== base58(hash)) {
    const key = seedKey(join(dir, "market.seed"));
    const n = Object.keys(st.txs).filter((k) => k.startsWith("redeploy")).length + 1;
    st.txs[`redeploy_${n}`] = (await tx(`redeploy ${MARKET} with the current bazaar code (sha256 ${hash.toString("hex").slice(0, 12)}..), temporary key, before the lock`, MARKET, key, MARKET, [{ type: "DeployContract", code: wasm }])).hash;
    st.wasm_sha256 = hash.toString("hex");
    save();
  } else console.log(`   ${MARKET} already runs this code (sha256 ${hash.toString("hex").slice(0, 12)}..)`);
  const v4 = JSON.parse(readFileSync("fixtures/live/eval/rep-eval-v4.json", "utf8"));
  st.eval = st.eval ?? {};
  if (!(await client.view(MARKET, "issuers", {})).some(([k]) => k === v4.issuer_key)) {
    st.eval.issuer = await viaDao("market bazaar: the REP Eval issuer key (signs eval certificates only)", [["register_issuer", { key_id: v4.issuer_key, label: "REP Eval issuer" }]]);
    save();
    st.eval.issuer_execute = await executeQueued("register_issuer (eval)", await logsOf(st.eval.issuer.execute));
    save();
  }
  // DAO proposal: the VOPRF evaluator's public key, the same one bookerbob.testnet anchors.
  const voprf = await client.view("bookerbob.testnet", "voprf_key", {});
  if (voprf && (await client.view(MARKET, "voprf_key", {})) !== voprf) {
    st.voprf = await viaDao("market bazaar: the VOPRF evaluator's public key (RFC 9497 ristretto255; buyers check its proofs against it)", [["set_voprf_key", { public_key: voprf }]]);
    save();
    st.voprf_execute = await executeQueued("set_voprf_key", await logsOf(st.voprf.execute));
    save();
  }
  console.log(`   ${MARKET}: voprf_key ${(await client.view(MARKET, "voprf_key", {}))?.slice(0, 12)}..`);
  // DAO proposal: the verdict evaluator's key (a model verdict needs its signature on the
  // request), the same one bookerbob.testnet anchors. An anchor: it waits out the delay.
  const evaluator = await client.view("bookerbob.testnet", "evaluator_key", {});
  if (evaluator && (await client.view(MARKET, "evaluator_key", {})) !== evaluator) {
    st.evaluator = await viaDao("market bazaar: the verdict evaluator's public key (a model verdict needs its signature on the request)", [["set_evaluator_key", { public_key: evaluator }]]);
    save();
    st.evaluator_execute = await executeQueued("set_evaluator_key", await logsOf(st.evaluator.execute));
    save();
  }
  console.log(`   ${MARKET}: evaluator_key ${(await client.view(MARKET, "evaluator_key", {}))?.slice(0, 12)}..`);
  const ownerId = `evalset.${c.treasury}`;
  const owner = seedKey(join(c.keysDir, "eval", `${ownerId}.seed`));
  if (!(await client.view(MARKET, "eval_set", { set_root: v4.set_root }))) {
    st.eval.commit = (await tx("commit_eval_set v4 (by the set owner)", ownerId, owner, MARKET, [fc("commit_eval_set", { set_root: v4.set_root, n: v4.n, label: "REP Eval v4: 40 harder referee-claim items, 2 tiers, truth from the referee check, 4000 tokens, protocol frozen before the set" }, 10n ** 22n)])).hash;
    save();
  }
  const relayer = seedKey(join(c.keysDir, "treasury.seed"));
  for (const m of v4.models) {
    if ((await client.view(MARKET, "eval_score", { subject: m.certificate.subject, set_root: v4.set_root })) != null) continue;
    st.eval[m.model] = (await tx(`${m.model}: v4 certificate`, c.treasury, relayer, MARKET, [fc("submit_eval_certificate", { certificate: m.certificate, issuer_key: v4.issuer_key, signature: m.signature }, 10n ** 22n)])).hash;
    save();
  }
  for (const m of v4.models) console.log(`   ${MARKET}: eval_passes(${m.model.split("/")[1]}, v4, 70) = ${await client.view(MARKET, "eval_passes", { subject: m.certificate.subject, set_root: v4.set_root, threshold: 70 })}`);
}

async function logsOf(hash) {
  const r = await client.rpc("tx", { tx_hash: hash, sender_account_id: ID.c2, wait_until: "FINAL" });
  return [r.result.transaction_outcome, ...r.result.receipts_outcome].flatMap((o) => o.outcome.logs);
}

export const SPIKE = "spike.bookerbob.testnet";

/** IRREVERSIBLE: the market's and the quote verifier's full-access keys go; no one can redeploy either. */
async function lock() {
  const key = seedKey(join(dir, "market.seed"));
  if (await client.accessKey(MARKET, key.pub)) {
    st.txs.delete_key = (await tx(`IRREVERSIBLE: delete ${MARKET}'s only full-access key ${nearPublicKey(key.pub)}`, MARKET, key, MARKET, [{ type: "DeleteKey", public_key_hex: key.pub }])).hash;
    save();
  } else console.log(`   ${MARKET}: its full-access key is already gone`);
  // The verifier's key sits in the near-cli keychain (it was created with save-to-keychain).
  const r = await client.rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: SPIKE });
  for (const k of (r.result?.keys ?? []).filter((x) => x.access_key.permission === "FullAccess")) {
    const o = spawnSync("near", ["account", "delete-keys", SPIKE, "public-keys", k.public_key, "network-config", "testnet", "sign-with-keychain", "send"], { encoding: "utf8" });
    const h = `${o.stdout}${o.stderr}`.match(/Transaction ID: ([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1];
    if (!h) throw new Error(`delete ${SPIKE} key ${k.public_key}: ${`${o.stdout}${o.stderr}`.slice(-200)}`);
    console.log(`   ok IRREVERSIBLE: deleted ${SPIKE}'s full-access key ${k.public_key}  ${link(h)}`);
    st.txs.spike_delete_key = h;
    save();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  const go = { setup, anchors, merchants, quote, upgrade, lock }[cmd];
  if (!go) {
    console.error("usage: market-bazaar.mjs setup | anchors | merchants | quote | upgrade | lock");
    process.exit(2);
  }
  go().then(() => {
    mkdirSync("fixtures/live/market", { recursive: true });
    const f = "fixtures/live/market/state.json";
    const prev = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
    writeFileSync(f, JSON.stringify({ ...prev, market: MARKET, owner: DAO, wasm_sha256: st.wasm_sha256, txs: st.txs, anchors: st.anchors, merchants: st.merchants, approve: st.approve, eval: st.eval, voprf: st.voprf ? { ...st.voprf, execute_anchor: st.voprf_execute } : undefined, locked: Boolean(st.txs.delete_key) }, null, 2) + "\n");
  }).catch((e) => {
    console.error(`market: FAIL ${e.message}`);
    process.exit(1);
  });
}
