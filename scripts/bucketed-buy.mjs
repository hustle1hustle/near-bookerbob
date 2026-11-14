#!/usr/bin/env node
// L10 shrunk on testnet (docs/leak-amount.md): a merchant with a bucketed schedule, and buyers
// with different proven bit sets who settle at one amount.
//
//   node scripts/bucketed-buy.mjs join                 bkt-m01 joins the open category (bonded,
//                                                      no owner step) with m01's "any" bucket
//   node scripts/bucketed-buy.mjs buy <p1,p2,..>       one buyer, sealed verdict revealing those
//                                                      predicates, settles with bkt-m01 in dUSDC
//   node scripts/bucketed-buy.mjs check                public RPC only: every settle paid one
//                                                      amount, every verdict on chain is sealed
//
// Testnet only (the demo-tester guard). Buyers are one-time implicit accounts kept in
// KEYS_DIR/bucketed, outside KEYS_DIR/testers. The record, fixtures/live/bucketed/run.json, holds
// account ids, nullifiers, tx hashes and the synthetic predicates each buyer sealed. No seed and
// no opening salt is written there.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, guard, Demo } from "./demo-tester.mjs";
import { rpcClient } from "../relayer/near.mjs";
import { quote } from "../sdk/merchant.mjs";

const NAME = "bkt-m01";
const OF = "m01.bookerbob.testnet";
const OUT = "fixtures/live/bucketed/run.json";
const BUCKETS = "agents/merchants-bucketed.json";
const link = (h) => `https://testnet.nearblocks.io/txns/${h}`;
const readJson = (p, d = null) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : d);

/** The record's settled amounts and the predicates behind them: the claim this run makes. The
 *  sets are as we recorded them (the chain holds only their hashes). With a schedule, each amount
 *  must be the schedule's quote for its recorded set; an empty or non-numeric amount never passes. */
export function sameAmount(buys, schedule = null) {
  const amounts = new Set(buys.map((b) => String(b.paid ?? "")));
  const sets = new Set(buys.map((b) => JSON.stringify([...b.revealed].sort())));
  const numeric = buys.every((b) => /^[1-9][0-9]*$/.test(String(b.paid ?? "")));
  const quoted = !schedule || buys.every((b) => String(quote(schedule, b.revealed).price) === String(b.paid));
  return { amounts: [...amounts], sets: sets.size, numeric, quoted, ok: buys.length >= 2 && numeric && quoted && amounts.size === 1 && sets.size >= 2 };
}

/** What the merchant receives: the amount less the bazaar fee (floor, as the contract takes it). */
export const payoutOf = (amount, feeBps) => String(BigInt(amount) - (BigInt(amount) * BigInt(feeBps)) / 10000n);

async function main() {
  const c0 = config(process.env);
  const no = guard(c0);
  if (no) {
    console.error(`refusing: ${no}`);
    process.exit(2);
  }
  const merchant = `${NAME}.${c0.treasury}`;
  const c = { ...c0, merchant, category: "open", testersDir: join(c0.keysDir, "bucketed"), shopifyEnv: "/nonexistent" };
  const [cmd, arg] = process.argv.slice(2);
  const buckets = JSON.parse(readFileSync(BUCKETS, "utf8"));
  const design = buckets.merchants.find((m) => m.of === OF && !m.account);
  const rec = readJson(OUT, { note: "testnet only: a bucketed merchant and buyers with different proven bit sets who settle at one amount. dUSDC is a testnet demo token; the buyers are our own one-time accounts; the facts are the synthetic fixture set. Each buyer's sealed predicates are listed here to show the claim; the opening salt and every seed stay with the buyer, so the on-chain hashes cannot be opened from this file.", bazaar: c.bazaar, merchant, of: OF, schedule: design.schedule, join: null, buys: [] });

  if (cmd === "join") {
    const s = design.schedule;
    const out = execFileSync("node", ["scripts/join-merchant.mjs", "join", NAME], { encoding: "utf8", env: { ...process.env, JOIN_SCHEDULE: JSON.stringify({ basePrice: Number(s.base_price), rules: s.rules, capBps: s.cap_bps }) } });
    console.log(out.trim());
    const st = JSON.parse(readFileSync(join(c.keysDir, "merchants", `${merchant}.json`), "utf8"));
    const onChain = (await rpcClient(c.rpc).view(c.bazaar, "merchant", { merchant })).schedule;
    if (JSON.stringify(onChain.rules) !== JSON.stringify(s.rules) || String(onChain.base_price) !== String(s.base_price) || onChain.cap_bps !== s.cap_bps) throw new Error(`on-chain schedule differs: ${JSON.stringify(onChain)}`);
    rec.join = { txs: st.txs, approved: st.approved };
    mkdirSync("fixtures/live/bucketed", { recursive: true });
    writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
    // The live merchant enters the bucketed file with its bounds; leak-amount.mjs checks it.
    const live = { account: merchant, of: OF, category: "open", bucketed: true, design: "any", bound_bits: { swarm: 0, uniform: 1 }, bound_why: "swarm 0 is our claim about who buys here: the schedule prices world_id_human, and every swarm set proves it, so every swarm buyer pays one price. A buyer without a priced bit pays the base, so under another prior the bound is the design's 1 bit.", schedule: s };
    buckets.merchants = [live, ...buckets.merchants.filter((m) => m.account !== merchant)];
    writeFileSync(BUCKETS, JSON.stringify(buckets, null, 2) + "\n");
    console.log(`\nbucketed-buy: PASS  ${merchant} registered with ${s.rules.map((r) => r.predicate).join(", ")} at ${s.cap_bps} bps each, cap ${s.cap_bps}`);
  } else if (cmd === "buy") {
    const revealed = (arg ?? "").split(",").filter(Boolean).sort();
    if (!revealed.length) throw new Error("buy: name the predicates to reveal, e.g. world_id_human");
    const expect = String(quote(design.schedule, revealed).price);
    mkdirSync(c.testersDir, { recursive: true, mode: 0o700 });
    const runDir = join(c.testersDir, `run-${Date.now()}`);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    copyFileSync("fixtures/proofs.json", join(runDir, "proofs.json"));
    const claims = JSON.parse(readFileSync("fixtures/claims-honest.json", "utf8")).filter((x) => revealed.includes(x.line));
    writeFileSync(join(runDir, "claims-honest.json"), JSON.stringify(claims, null, 2) + "\n");
    writeFileSync(join(runDir, "merchants.json"), JSON.stringify([{ account: merchant, label: "bucketed", category: "open", schedule: design.schedule }], null, 2) + "\n");
    console.log(`bucketed buy: reveal {${revealed.join(", ")}} sealed; the schedule gives ${Number(expect) / 1e6}`);
    const d = new Demo(c);
    process.env.BOOKERBOB_REVEAL = revealed.join(",");
    const r = await d.run({ proofs: join(runDir, "proofs.json"), fixturesDir: runDir, sealed: true, rehearsal: true }).finally(() => delete process.env.BOOKERBOB_REVEAL);
    if (String(r.price) !== expect) throw new Error(`paid ${r.price}, the schedule gives ${expect}`);
    const v = await d.client.view(c.bazaar, "verdict", { nullifier: r.nullifier });
    if (v.predicates.length || v.tier !== "sealed") throw new Error("the verdict on chain is not sealed");
    // The opening's salt stays with the buyer (KEYS_DIR); only what it sealed is recorded.
    const { salt: _salt, ...opening } = JSON.parse(readFileSync(join(c.testersDir, r.dir ?? r.tester, "live", "opening.json"), "utf8"));
    rec.buys.push({ buyer: r.tester, nullifier: r.nullifier, revealed, paid: String(r.price), opening, txs: r.txs });
    writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
    console.log(`\nbucketed-buy: PASS  {${revealed.join(", ")}} paid ${Number(r.price) / 1e6} dUSDC to ${merchant}; settle ${link(r.txs.settle)}`);
  } else if (cmd === "check") {
    // Public RPC only: the settle args and the verdict view.
    const client = rpcClient(c.rpc);
    const buys = [];
    const onChain = (await client.view(c.bazaar, "merchant", { merchant })).schedule;
    const same = String(onChain.base_price) === String(rec.schedule.base_price) && onChain.cap_bps === rec.schedule.cap_bps && JSON.stringify(onChain.rules) === JSON.stringify(rec.schedule.rules) && !onChain.cohort;
    console.log(`${same ? "ok  " : "FAIL"}  ${merchant} schedule on chain equals the record (${onChain.rules.length} rules at ${onChain.cap_bps} bps, base ${Number(onChain.base_price) / 1e6}, ${onChain.cohort ? "a cohort line" : "no cohort line"})`);
    if (!same) process.exitCode = 1;
    const [feeBps] = await client.view(c.bazaar, "fee", {});
    for (const b of rec.buys) {
      const r = await client.rpc("tx", { tx_hash: b.txs.settle, sender_account_id: c.treasury, wait_until: "FINAL" });
      const t = r.result ?? r;
      const evs = t.receipts_outcome.flatMap((x) => x.outcome.logs).filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)));
      const ev = evs.find((e) => e.event === "settled")?.data?.[0];
      const ft = evs.find((e) => e.event === "ft_transfer" && e.data?.[0]?.new_owner_id === merchant)?.data?.[0];
      const paid = String(ev?.amount ?? "");
      const payoutOk = /^[0-9]+$/.test(paid) && String(ft?.amount ?? "") === payoutOf(paid, feeBps);
      const ok = ev && ev.nullifier === b.nullifier && ev.merchant === merchant && t.status?.Failure === undefined && payoutOk;
      const v = await client.view(c.bazaar, "verdict", { nullifier: b.nullifier });
      const sealed = v && !v.predicates.length && v.tier === "sealed";
      buys.push({ ...b, paid, payout: String(ft?.amount ?? "") });
      console.log(`${sealed && ok ? "ok  " : "FAIL"}  ${b.buyer.slice(0, 12)}.. verdict on chain ${sealed ? "sealed (no predicates)" : "NOT sealed"}; settled ${Number(paid) / 1e6}, merchant received ${Number(ft?.amount ?? 0) / 1e6} (amount less the ${feeBps} bps fee: ${payoutOk ? "yes" : "NO"})  ${link(b.txs.settle)}`);
      if (!ok) process.exitCode = 1;
      if (!sealed) process.exitCode = 1;
    }
    const s = sameAmount(buys, rec.schedule);
    console.log(`${s.ok && !process.exitCode ? "PASS" : "FAIL"}  ${buys.length} buyers, ${s.sets} different bit sets as we recorded them (the chain holds only hashes), ${s.amounts.length} amount(s): ${s.amounts.map((a) => Number(a) / 1e6).join(", ")}, ${s.quoted ? "each the schedule's quote for its set" : "NOT the schedule's quote"}`);
    if (!s.ok) process.exitCode = 1;
    // L10 on this amount: the bit sets an observer reading the public schedule is left with.
    const { decodeAmount } = await import("./leak-decode.mjs");
    const d = decodeAmount(rec.schedule, s.amounts[0]);
    console.log(`L10   ${Number(s.amounts[0]) / 1e6} at ${NAME}: ${d.sets.length} of ${d.of} bit sets give this amount (at m01 each amount leaves 1 of 8)`);
  } else {
    console.error("usage: bucketed-buy.mjs join | buy <p1,p2> | check");
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => {
  console.error(`bucketed-buy: FAIL ${e.message}`);
  process.exit(1);
});
