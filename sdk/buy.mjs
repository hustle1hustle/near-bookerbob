#!/usr/bin/env node
// `node sdk/buy.mjs "3 nights Lisbon under 450"`: you are the buyer. Parses the ask into a
// category, a budget and a stay, prices every approved merchant in that category with the
// contract's own price code (sdk/merchant.mjs `quote`, checked against the Rust board) for the
// buyer's revealed bits, and picks the cheapest bid that fits. It refuses when none fits.
// A hotel ask only ever plans against the hotel merchants (h01..h08); it never falls back to
// the hoodie purchase.
//
// What runs after the plan:
// - hoodie: the live testnet demo purchase from m01 (scripts/demo-tester.mjs run), when m01's
//   bid fits the budget.
// - hotel: the plan only. A hotel stay costs hundreds of dUSDC, and one tester's demo mint is
//   100 dUSDC per hour, so the live hotel purchase is not run (stated, not hidden).
// With BOOKERBOB_RELAYER_URL set (a hosted relayer, only once the founder OKs hosting), the
// plan is sent there instead. Testnet only; dUSDC is a testnet demo token with no value.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { quote } from "./merchant.mjs";

/** The hotel bids are for one fixed stay (agents/merchants.json personas: 2026-12-10 to 13). */
export const HOTEL_STAY_NIGHTS = 3;
/** One demo mint, in dUSDC: the most a fresh tester can escrow. */
export const DEMO_MINT_USD = 100;
/** What the demo buyer's verdict reveals (the fixture verdict, cli/src/fixtures.rs `revealed`). */
export const DEMO_REVEALED = ["airbnb_frequent", "claude_spender", "world_id_human"];
export const DEMO_MERCHANT = "m01.bookerbob.testnet";

export function parseAsk(text) {
  const t = text.toLowerCase();
  const budget = Number(t.match(/under\s+\$?(\d+(?:\.\d+)?)/)?.[1] ?? NaN);
  const category = /lisbon|hotel|night/.test(t) ? "hotel-lisbon" : /hoodie|shirt|merch/.test(t) ? "hoodie" : null;
  const n = t.match(/(\d+)\s+nights?/);
  if (!category) throw new Error("say what you want: a hotel in Lisbon or a hoodie");
  return { category, budget: Number.isFinite(budget) ? budget : null, nights: n ? Number(n[1]) : null };
}

const usd = (units) => Number(units) / 1e6;

/**
 * The buyer's plan: every bid in the ask's category, priced by code, ranked; the winner is the
 * cheapest that fits the budget, or a refusal with the reason. Pure: no chain, no keys.
 */
export function plan(ask, merchants, revealed = DEMO_REVEALED, k = () => 0) {
  const bids = merchants
    .filter((m) => m.category === ask.category)
    .map((m) => ({ merchant: m.account, price: usd(quote(m.schedule, revealed, k).price) }))
    .sort((a, b) => a.price - b.price || a.merchant.localeCompare(b.merchant));
  const base = { ask, bids };
  if (!bids.length) return { ...base, outcome: "refused", reason: `no merchant sells ${ask.category}` };
  if (ask.category === "hotel-lisbon" && ask.nights != null && ask.nights !== HOTEL_STAY_NIGHTS) {
    return { ...base, outcome: "refused", reason: `the hotel bids are for a ${HOTEL_STAY_NIGHTS}-night stay (2026-12-10 to 13); you asked ${ask.nights}` };
  }
  const fits = bids.filter((b) => ask.budget == null || b.price <= ask.budget);
  if (!fits.length) return { ...base, outcome: "refused", reason: `no bid fits a budget of ${ask.budget}; the cheapest is ${bids[0].merchant.split(".")[0]} at ${bids[0].price.toFixed(2)}` };
  return { ...base, outcome: "winner", winner: fits[0] };
}

/** What to run for a plan. Only a hoodie winner that is the demo merchant runs the live buy. */
export function action(p) {
  if (p.outcome !== "winner") return { run: null, why: p.reason };
  if (p.ask.category === "hoodie") {
    return p.winner.merchant === DEMO_MERCHANT
      ? { run: "hoodie-demo", why: `live testnet purchase from ${DEMO_MERCHANT}` }
      : { run: null, why: `the winner ${p.winner.merchant} is not the demo merchant; plan only` };
  }
  return p.winner.price > DEMO_MINT_USD
    ? { run: null, why: `plan only: ${p.winner.price.toFixed(2)} dUSDC is above one demo mint (${DEMO_MINT_USD} dUSDC per tester per hour), so the live hotel purchase is not run` }
    : { run: null, why: "plan only: no live hotel buyer yet" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ask = parseAsk(process.argv.slice(2).join(" "));
  const merchants = JSON.parse(readFileSync(new URL("../agents/merchants.json", import.meta.url), "utf8"));
  const p = plan(ask, merchants);
  console.log(`ask: ${JSON.stringify(ask)}  (revealed: ${DEMO_REVEALED.join(", ")}; no cohort, k = 0)`);
  for (const b of p.bids) console.log(`  ${b.merchant.split(".")[0]}  ${b.price.toFixed(2)}${p.winner?.merchant === b.merchant ? "  <- winner" : ""}`);
  const a = action(p);
  console.log(p.outcome === "winner" ? `winner: ${p.winner.merchant} at ${p.winner.price.toFixed(2)} dUSDC` : `refused: ${p.reason}`);
  if (process.env.BOOKERBOB_RELAYER_URL && p.outcome === "winner") {
    const r = await fetch(`${process.env.BOOKERBOB_RELAYER_URL}/buy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ask, winner: p.winner }) });
    console.log(JSON.stringify(await r.json(), null, 2));
  } else if (a.run === "hoodie-demo") {
    console.log(a.why);
    const r = spawnSync("node", ["scripts/demo-tester.mjs", "run"], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  } else {
    console.log(a.why);
    process.exit(p.outcome === "winner" ? 0 : 3);
  }
}
