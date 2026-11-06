#!/usr/bin/env node
// `make buy-twice`: a past buyer of m01 proves it from a fresh account and pays less, with no link
// to the earlier purchase. Needs the Nov 10 contract batch on testnet. Testnet only.
//
//   node scripts/buy-twice.mjs run       m01 sets 5% (near-cli keychain, as deploy-testnet.sh signs
//                                        merchants), a new tester gets a receipt, a past member
//                                        proves, the tester claims and settles under the receipt
//   node scripts/buy-twice.mjs verify    public check of the recorded run, no keys
//
// All testers here are ours, so the run shows the mechanism, not a stranger's privacy. The record
// names the buyer and the txs, never the member behind the proof.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OUT = "fixtures/live/buy-twice/run.json";
export const BPS = 500;
export const EPOCH_MS = 30 * 86_400_000;
const MILLI = 10n ** 21n;
const TGAS = 10n ** 12n;
const fc = (method_name, args, deposit = 0n, gas = 100n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const sha = (s) => createHash("sha256").update(s).digest("hex");

/** Message and scope of a claim, as `claim_returning` recomputes them. */
export const claimInputs = (merchant, nullifier, nowMs) => {
  const epoch = Math.floor(nowMs / EPOCH_MS);
  return { epoch, message_hex: nullifier, scope_hex: sha(`bookerbob/returning/v0|${merchant}|${epoch}`) };
};

export const discounted = (price, bps) => BigInt(price) - (BigInt(price) * BigInt(bps)) / 10_000n;

async function run() {
  const { Demo, config } = await import("./demo-tester.mjs");
  const { members } = await import("./demo-reviews.mjs");
  const d = new Demo(config(process.env));
  const c = d.c;
  if ((await d.client.view(c.bazaar, "returning_bps", { merchant: c.merchant }).catch(() => null)) === null) throw new Error(`${c.bazaar} has no returning_bps: the contract batch is not deployed`);
  const persons = await d.client.view(c.bazaar, "review_persons", { merchant: c.merchant });
  if (persons < 5) throw new Error(`${c.merchant} has ${persons} people in its group, under k`);
  const out = { merchant: c.merchant, bazaar: c.bazaar, bps: BPS, txs: {} };
  if ((await d.client.view(c.bazaar, "returning_bps", { merchant: c.merchant })) !== BPS) {
    const r = spawnSync("near", ["contract", "call-function", "as-transaction", c.bazaar, "set_returning_bps", "json-args", JSON.stringify({ bps: BPS }), "prepaid-gas", "30.0 Tgas", "attached-deposit", "0 NEAR", "sign-as", c.merchant, "network-config", "testnet", "sign-with-keychain", "send"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`set_returning_bps: ${(r.stderr ?? "").slice(-300)}`);
    out.txs.set_bps = /Transaction ID: (\S+)/.exec(`${r.stdout}${r.stderr}`)?.[1] ?? null;
  }
  const g = await d.client.view(c.bazaar, "review_group", { merchant: c.merchant });
  const ms = members(d);
  const all = ms.map((m) => m.review.commitment);
  if (all.length !== g.tree.size) throw new Error(`the group has ${g.tree.size} members, ${all.length} known locally: a proof needs the full list`);
  const rec = await d.run({
    beforeSettle: async ({ tester, rec, d }) => {
      const m = ms[Math.floor(Math.random() * ms.length)];
      const secret = readFileSync(join(c.testersDir, m.tester, "semaphore.secret"), "utf8").trim();
      const q = claimInputs(c.merchant, rec.nullifier, Date.now());
      const p = spawnSync("node", ["identity.mjs", "prove"], { cwd: "semaphore", input: JSON.stringify({ secret, members: all, message_hex: q.message_hex, scope_hex: q.scope_hex }), encoding: "utf8" });
      if (p.status !== 0) throw new Error(`proof: ${p.stderr.slice(-300)}`);
      const proof = JSON.parse(p.stdout);
      if (!g.recent_roots.includes(proof.root_js)) throw new Error("the local group root is not one of the contract's recent roots");
      delete proof.root_js;
      out.txs.claim = (await d.relay("claim_returning", tester, c.bazaar, fc("claim_returning", { merchant: c.merchant, nullifier: rec.nullifier, proof }, 20n * MILLI, 150n * TGAS))).hash;
      out.epoch = q.epoch;
      out.receipt_price = String(rec.price);
      rec.price = String(discounted(rec.price, BPS));
      out.price = rec.price;
      console.log(`   claimed: ${Number(out.receipt_price) / 1e6} on the receipt, ${Number(rec.price) / 1e6} to pay`);
    },
  });
  Object.assign(out, { tester: rec.tester, nullifier: rec.nullifier, date: rec.date });
  out.txs.settle = rec.txs.settle;
  mkdirSync("fixtures/live/buy-twice", { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`buy-twice: PASS  wrote ${OUT}. Rerun make leak: the discount is a price bit (L10).`);
}

/** Public check. `tx(hash, sender)` returns the raw RPC outcome; `view(account, method, args)`. */
export async function verifyRun(view, tx, out = JSON.parse(readFileSync(OUT, "utf8"))) {
  const lines = [];
  const events = (t, name) => [t.transaction_outcome, ...t.receipts_outcome].flatMap((o) => o.outcome.logs).filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11))).filter((e) => e.event === name);
  const failed = (t) => [t.transaction_outcome, ...t.receipts_outcome].some((o) => o.outcome.status.Failure);
  const claim = await tx(out.txs.claim, out.tester);
  lines.push([!failed(claim) && events(claim, "returning_claimed").length === 1, `claim_returning by ${out.tester.slice(0, 12)}.. (${out.txs.claim.slice(0, 8)}..)`]);
  const settle = await tx(out.txs.settle, out.tester);
  const paid = events(settle, "settled")[0]?.data?.[0];
  const want = discounted(out.receipt_price, out.bps);
  lines.push([!failed(settle) && String(paid?.amount ?? paid?.price) === String(want), `settled ${Number(want) / 1e6}, ${out.bps / 100}% under the receipt's ${Number(out.receipt_price) / 1e6}`]);
  lines.push([(await view(out.bazaar, "nullifier_status", { nullifier: out.nullifier })) === "Spent", "the verdict is spent"]);
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === "run") await run();
  else if (cmd === "verify") {
    if (!existsSync(OUT)) {
      console.log("buy-twice: not run live yet");
      process.exit(0);
    }
    const { rpcClient } = await import("../relayer/near.mjs");
    const client = rpcClient(process.env.NEAR_RPC || "https://test.rpc.fastnear.com");
    const tx = async (h, s) => (await client.rpc("tx", { tx_hash: h, sender_account_id: s, wait_until: "FINAL" })).result;
    const lines = await verifyRun((a, m, args) => client.view(a, m, args), tx);
    for (const [ok, t] of lines) console.log(`${ok ? "PASS" : "FAIL"}  ${t}`);
    process.exit(lines.every(([ok]) => ok) ? 0 : 1);
  } else {
    console.error("usage: buy-twice.mjs run|verify");
    process.exit(2);
  }
}
