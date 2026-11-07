#!/usr/bin/env node
// `make market-eval`: a seeded simulation of the hoodie market over 1,000 rounds, comparing
// disclosure regimes for the same buyers and the same adaptive merchants:
//
//   none      buyers reveal nothing: every merchant quotes its base price
//   price war buyers reveal nothing, and each merchant adapts one public price by the same rule
//             (a loser cuts it by STEP bps, a winner raises it 25), down to its floor
//   bookerbob buyers reveal at most 3 proven bits, picked by the planner (lowest best price,
//             then fewest bits), as core/src/disclosure.rs does
//   full      buyers reveal every proven bit and who they are (anonymity set 1)
//
// Merchants are the 22 hoodie merchants in agents/merchants.json: their base prices, and a
// cost and margin floor per merchant derived from the base price. Each round a merchant
// adapts its discount per predicate from public data only: whether it won, its realised
// margin, and the last clearing price. Code clamps every schedule (no discount below the
// margin floor, the cap at 50%). The price is always the shared code's quote (sdk/merchant.mjs
// mirrors core/src/price.rs). This is a model with stated assumptions, not market data.
import { readFileSync, writeFileSync } from "node:fs";
import { quote, schedule, KNOWN_PREDICATES } from "../sdk/merchant.mjs";

const ROUNDS = Number(process.env.ROUNDS ?? 1000);
const BUYERS_PER_ROUND = 20;
const MAX_BITS = 3;
// The market fee on market.bookerbob.testnet: 100 bps of the settled amount (set_fee), paid by
// the merchant on a BookerBob sale only.
export const FEE = 0.01;
// The public-price step of the price-war baseline, in bps; the report also prints 60 and 150.
const STEPS = [60, 100, 150];

// Deterministic PRNG (mulberry32), seed fixed so the report is reproducible.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Assumptions, stated. Each predicate a buyer can prove, how common it is in the population,
// and the lifetime value uplift a merchant expects from a buyer who holds it (in % of price).
export const PREDICATES = {
  world_id_human: { share: 0.6, ltv: 4 },
  claude_spender: { share: 0.25, ltv: 12 },
  airbnb_frequent: { share: 0.3, ltv: 10 },
  booking_genius: { share: 0.2, ltv: 9 },
  uber_regular: { share: 0.35, ltv: 6 },
  steam_veteran: { share: 0.15, ltv: 3 },
  github_builder: { share: 0.1, ltv: 8 },
};

export function merchantsFrom(file) {
  const all = JSON.parse(readFileSync(file, "utf8")).filter((m) => m.category === "hoodie");
  return all.map((m, i) => {
    const base = Number(m.schedule.base_price) / 1e6;
    return { id: m.account.split(".")[0], base, cost: base * 0.55, floor: base * 0.62, bps: Object.fromEntries(KNOWN_PREDICATES.map((p) => [p, (m.schedule.rules.find((r) => r.predicate === p)?.bps ?? 0)])), wins: 0, profit: 0, i };
  });
}

const sched = (m) => schedule({ basePrice: Math.round(m.base * 1e6), rules: KNOWN_PREDICATES.filter((p) => m.bps[p] > 0).map((p) => ({ predicate: p, bps: m.bps[p] })), capBps: 5000 });
const price = (m, revealed) => Number(quote(sched(m), revealed).price) / 1e6;

/** The planner: up to MAX_BITS proven bits, lowest best price, then fewest bits. */
export function plan(merchants, proven) {
  let best = { bits: [], price: Math.min(...merchants.map((m) => m.base)) };
  const subsets = (xs, k) => (k === 0 ? [[]] : xs.flatMap((x, i) => subsets(xs.slice(i + 1), k - 1).map((s) => [x, ...s])));
  for (let k = 1; k <= Math.min(MAX_BITS, proven.length); k++) {
    for (const s of subsets(proven, k)) {
      const p = Math.min(...merchants.map((m) => price(m, s)));
      if (p < best.price - 1e-9) best = { bits: s, price: p };
    }
  }
  return best.bits;
}

// forged: the share of buyers who claim every bit with no proof behind it (no notary check),
// and bring no lifetime value for it. With a notary check that share is 0.
function simulate(regime, seed = 7, ltvScale = 1, { step = 100, forged = 0 } = {}) {
  const r = rng(seed);
  const merchants = merchantsFrom(new URL("../agents/merchants.json", import.meta.url));
  const population = Array.from({ length: 2000 }, () => KNOWN_PREDICATES.filter((p) => r() < PREDICATES[p].share));
  let paid = 0, baseline = 0, bits = 0, sales = 0, anon = 0, clearing = null;
  const setKey = (s) => [...s].sort().join(",");
  const freq = new Map();
  for (const b of population) freq.set(setKey(b), (freq.get(setKey(b)) ?? 0) + 1);
  const war = regime === "price war";
  // A separate stream for the forger draw, so forged = 0 leaves the run identical.
  const fr = rng(seed + 1);
  for (const m of merchants) m.pub = m.base;
  for (let round = 0; round < ROUNDS; round++) {
    for (let j = 0; j < BUYERS_PER_ROUND; j++) {
      const buyer = population[Math.floor(r() * population.length)];
      const forger = forged > 0 && fr() < forged;
      const claims = forger ? KNOWN_PREDICATES : buyer;
      const revealed = regime === "none" || war ? [] : regime === "full" ? claims : plan(merchants, claims);
      // Every merchant quotes the code's price, never below its floor. (Under full disclosure
      // a merchant could also price upward per buyer where competition is thin; this model
      // does not, so it understates what full disclosure costs the buyer.)
      const quotes = merchants.map((m) => ({ m, p: war ? m.pub : Math.max(price(m, revealed), m.floor) }));
      const win = quotes.reduce((a, q) => (q.p < a.p || (q.p === a.p && q.m.i < a.m.i) ? q : a));
      const ltv = forger ? 0 : revealed.reduce((a, p) => a + PREDICATES[p].ltv, 0) / 100;
      const fee = regime === "bookerbob" ? win.p * FEE : 0;
      win.m.wins++;
      win.m.profit += win.p - fee - win.m.cost + win.p * ltv * ltvScale;
      paid += win.p;
      baseline += Math.min(...merchants.map((m) => m.base));
      bits += revealed.length;
      sales++;
      anon += regime === "full" ? 1 : regime === "none" ? population.length : freqOf(freq, population, revealed);
      clearing = win.p;
    }
    // Adapt from public data only: winners keep or trim discounts toward their floor; losers
    // raise the discount on the predicates the clearing buyers revealed, clamped by code.
    for (const m of merchants) {
      const lost = m.lastWins === m.wins;
      if (war) m.pub = Math.max(m.floor, Math.min(m.base, m.pub * (1 + (lost ? -step : 25) / 10000)));
      for (const p of KNOWN_PREDICATES) {
        const target = lost ? m.bps[p] + Math.round(PREDICATES[p].ltv * 15) : m.bps[p] - 25;
        m.bps[p] = Math.max(0, Math.min(target, Math.floor((1 - m.floor / m.base) * 10000)));
      }
      m.lastWins = m.wins;
    }
  }
  return {
    regime,
    rounds: ROUNDS,
    sales,
    avg_price: +(paid / sales).toFixed(2),
    avg_saving_vs_lowest_base: +((baseline - paid) / sales).toFixed(2),
    avg_bits_revealed: +(bits / sales).toFixed(2),
    avg_anonymity_set: Math.round(anon / sales),
    merchant_profit_total: Math.round(merchants.reduce((a, m) => a + m.profit, 0)),
    winners: merchants.filter((m) => m.wins).map((m) => `${m.id}:${m.wins}`).join(" "),
  };
}

/** How many buyers in the population hold every revealed bit (the set a merchant sees). */
function freqOf(_freq, population, revealed) {
  if (!revealed.length) return population.length;
  let n = 0;
  for (const b of population) if (revealed.every((p) => b.includes(p))) n++;
  return n;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = ["none", "bookerbob", "full"].map((x) => simulate(x));
  const wars = STEPS.map((step) => ({ step_bps: step, ...simulate("price war", 7, 1, { step }) }));
  console.log(`market-eval: ${ROUNDS} rounds x ${BUYERS_PER_ROUND} buyers, 22 adaptive hoodie merchants, seed 7 (a model, not market data)\n`);
  console.log("regime      avg price  saving  bits  anonymity set  merchant profit  wins");
  for (const x of [...rows, ...wars]) console.log(`${(x.step_bps ? `war ${x.step_bps}` : x.regime).padEnd(10)}  ${String(x.avg_price).padStart(9)}  ${String(x.avg_saving_vs_lowest_base).padStart(6)}  ${String(x.avg_bits_revealed).padStart(4)}  ${String(x.avg_anonymity_set).padStart(13)}  ${String(x.merchant_profit_total).padStart(15)}  ${x.winners}`);
  // The merchant's side, all from the same run. LTV only moves the books here: merchants adapt
  // the same way, so profit is linear in the assumed uplift and the break-even is exact.
  const [none, book] = [rows[0], rows[1]];
  const flat = simulate("bookerbob", 7, 0);
  const margin = (x) => x.merchant_profit_total / x.sales;
  const lift = book.merchant_profit_total - flat.merchant_profit_total;
  const elastic = [0, 1, 2, 3].map((e) => {
    const volume = (none.avg_price / book.avg_price) ** e;
    return { elasticity: e, volume: +volume.toFixed(2), merchant_profit: Math.round(book.merchant_profit_total * volume), vs_none_pct: +((100 * (book.merchant_profit_total * volume)) / none.merchant_profit_total - 100).toFixed(1) };
  });
  const merchant = {
    none_profit: none.merchant_profit_total,
    bookerbob_profit: book.merchant_profit_total,
    loss_pct: +((100 * (none.merchant_profit_total - book.merchant_profit_total)) / none.merchant_profit_total).toFixed(1),
    profit_ltv_zero: flat.merchant_profit_total,
    loss_pct_ltv_zero: +((100 * (none.merchant_profit_total - flat.merchant_profit_total)) / none.merchant_profit_total).toFixed(1),
    profit_per_sale: { none: +margin(none).toFixed(2), bookerbob: +margin(book).toFixed(2), bookerbob_ltv_zero: +margin(flat).toFixed(2) },
    break_even_ltv_multiple: +((none.merchant_profit_total - flat.merchant_profit_total) / lift).toFixed(2),
    break_even_volume: +(none.merchant_profit_total / book.merchant_profit_total).toFixed(2),
    break_even_volume_ltv_zero: +(none.merchant_profit_total / flat.merchant_profit_total).toFixed(2),
    break_even_elasticity: +(Math.log(none.merchant_profit_total / book.merchant_profit_total) / Math.log(none.avg_price / book.avg_price)).toFixed(2),
    elastic_demand_assumed: elastic,
    discount_per_sale: book.avg_saving_vs_lowest_base,
    effective_cac_assumed: [1, 0.5, 0.25].map((incremental) => ({ incremental, cost_per_new_customer: +(book.avg_saving_vs_lowest_base / incremental).toFixed(2) })),
  };
  // Against a price war: the same merchants cutting one public price instead.
  merchant.against_price_war = wars.map((w) => ({ step_bps: w.step_bps, war_avg_price: w.avg_price, war_profit: w.merchant_profit_total, bookerbob_vs_war_pct: +((100 * book.merchant_profit_total) / w.merchant_profit_total - 100).toFixed(1), bookerbob_ltv_zero_vs_war_pct: +((100 * flat.merchant_profit_total) / w.merchant_profit_total - 100).toFixed(1) }));
  // Forged claims with no notary check: forgers claim every bit and bring no LTV.
  merchant.forged = [0, 0.25, 0.5, 1].map((f) => ({ forged_share: f, bookerbob_profit: f ? simulate("bookerbob", 7, 1, { forged: f }).merchant_profit_total : book.merchant_profit_total }));
  console.log(`\nmerchant side: ${merchant.loss_pct}% less profit than no disclosure, ${merchant.loss_pct_ltv_zero}% with LTV 0; break-even at ${merchant.break_even_ltv_multiple}x the assumed LTV, or ${merchant.break_even_volume}x volume (elasticity ${merchant.break_even_elasticity})`);
  for (const w of merchant.against_price_war) console.log(`against a price war at ${w.step_bps} bps: avg price ${w.war_avg_price}, merchant profit ${w.war_profit}; BookerBob ${w.bookerbob_vs_war_pct}% (${w.bookerbob_ltv_zero_vs_war_pct}% with LTV 0)`);
  console.log(`forged claims, no notary check: ${merchant.forged.map((f) => `${f.forged_share * 100}% forged ${f.bookerbob_profit}`).join(", ")}`);
  const report = JSON.stringify({ assumptions: { rounds: ROUNDS, buyers_per_round: BUYERS_PER_ROUND, max_bits: MAX_BITS, predicates: PREDICATES, cost: "0.55 x base", floor: "0.62 x base", fee: `${FEE * 100}% of a BookerBob sale`, price_war_steps_bps: STEPS, seed: 7 }, rows, price_war: wars, merchant }, null, 2) + "\n";
  const file = new URL("../docs/market-eval.json", import.meta.url);
  // --check: the table the docs publish must be what this code computes.
  if (process.argv.includes("--check")) {
    if (readFileSync(file, "utf8") !== report) {
      console.error("FAIL  docs/market-eval.json differs from this run: make market-eval and commit it");
      process.exit(1);
    }
    console.log("\nPASS  docs/market-eval.json is what this code computes");
  } else writeFileSync(file, report);
}
