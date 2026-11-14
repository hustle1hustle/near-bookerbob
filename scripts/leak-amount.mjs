#!/usr/bin/env node
// L10 measured: how many bits about the buyer's proven set a settled amount gives away, per sale,
// for every merchant schedule, and the same for bucketed schedules (docs/leak-amount.md).
//
//   node scripts/leak-amount.mjs           print the table; FAIL if a bucketed merchant leaks
//                                          more than its stated bound, or the file is stale
//   node scripts/leak-amount.mjs --write   rewrite agents/merchants-bucketed.json from
//                                          agents/merchants.json (deterministic)
//
// Offline, no keys. The leak of one sale is I(bits; amount) = H(bits) - H(bits | amount). The
// amount is a function of the bits (core/src/price.rs, mirrored by sdk/merchant.mjs), so the
// leak equals H(amount) under the prior. Leak at k = 0; cost also at k >= k_min.
//
// This is the amount channel only. The merchant a buyer picks is a second channel, measured by
// merchantChannel() on the swarm's recorded sales; bucketing does not touch it.
import { readFileSync, writeFileSync } from "node:fs";
import { quote, validate } from "../sdk/merchant.mjs";

const root = (p) => new URL(`../${p}`, import.meta.url);
const subsets = (xs) => xs.reduce((all, x) => all.concat(all.map((s) => [...s, x])), [[]]);
const key = (bits) => JSON.stringify([...bits].sort());

/** Shannon entropy in bits of a list of probabilities. */
export const entropy = (ps) => 0 - ps.filter((p) => p > 0).reduce((a, p) => a + p * Math.log2(p), 0) + 0;

/** Prior A: every subset of the merchant's priced predicates, equally likely (the worst case
 *  for a schedule with distinct prices: n bits leak). */
export function uniformPrior(s) {
  const all = subsets(s.rules.map((r) => r.predicate));
  return all.map((bits) => ({ bits, p: 1 / all.length }));
}

/** Prior B: the bit sets the testnet swarm's buyers proved (fixtures/live/swarm/s1.json, 96
 *  purchases, 4 synthetic sets of 3 predicates). */
export function swarmPrior(file = "fixtures/live/swarm/s1.json") {
  const ps = JSON.parse(readFileSync(root(file))).purchases;
  const n = new Map();
  for (const x of ps) n.set(key(x.predicates), (n.get(key(x.predicates)) ?? 0) + 1);
  return [...n].map(([k, c]) => ({ bits: JSON.parse(k), p: c / ps.length }));
}

/** The leak of one sale under a schedule and a prior over the buyer's bit sets. */
export function amountLeak(s, prior) {
  const byBits = new Map();
  for (const { bits, p } of prior) byBits.set(key(bits), { bits: JSON.parse(key(bits)), p: (byBits.get(key(bits))?.p ?? 0) + p });
  const byPrice = new Map();
  for (const { bits, p } of byBits.values()) {
    const price = String(quote(s, bits).price);
    const e = byPrice.get(price) ?? { price, p: 0, sets: [] };
    e.p += p;
    e.sets.push(bits);
    byPrice.set(price, e);
  }
  const hBits = entropy([...byBits.values()].map((x) => x.p));
  const hAmount = entropy([...byPrice.values()].map((x) => x.p));
  // Round to 1e-9 so floating noise never reads as a leak.
  const r = (x) => Math.round(x * 1e9) / 1e9;
  return { bits_leaked: r(hAmount), h_bits: r(hBits), h_bits_given_amount: r(hBits - hAmount), amounts: byPrice.size, prices: [...byPrice.values()] };
}

const priceOf = (s, bits, k = 0) => Number(quote(s, bits, () => k).price);
const expect = (prior, f) => prior.reduce((a, x) => a + x.p * f(x.bits), 0);

/** The "any" bucket: every rule pays the same b bps and the cap is b, so a buyer with one priced
 *  bit and a buyer with all of them pay one price. b keeps the merchant's expected revenue under
 *  the prior (floored to whole bps, so the merchant never earns less than b implies). */
export function bucketAny(s, prior) {
  const disc = (bits) => quote(s, bits).discount_bps;
  const any = (bits) => (s.rules.some((r) => bits.includes(r.predicate)) ? 1 : 0);
  const pAny = expect(prior, any);
  const b = pAny ? Math.min(s.cap_bps, Math.floor(expect(prior, disc) / pAny)) : s.cap_bps;
  return { base_price: s.base_price, rules: s.rules.map((r) => ({ predicate: r.predicate, bps: b })), cap_bps: b };
}

/** What the buyer pays for the bucket, against the exact schedule, under the prior. At k = 0
 *  (single purchase), and for a schedule with a cohort line also at k >= k_min, where the exact
 *  schedule adds the group unlock and the bucket (no cohort line) does not. */
export function bucketCost(exact, bucket, prior) {
  const d = prior.map(({ bits, p }) => ({ bits, p, delta: priceOf(bucket, bits) - priceOf(exact, bits) }));
  const worst = d.reduce((a, x) => (x.delta > a.delta ? x : a));
  const best = d.reduce((a, x) => (x.delta < a.delta ? x : a));
  const kc = exact.cohort?.k_min ?? 0;
  const dc = prior.map(({ bits }) => ({ bits, delta: priceOf(bucket, bits) - priceOf(exact, bits, kc) }));
  const worstCohort = exact.cohort ? dc.reduce((a, x) => (x.delta > a.delta ? x : a)) : null;
  // The alternative that costs no buyer anything: b = the cap. The merchant pays the difference.
  const noLoss = { ...bucket, rules: bucket.rules.map((r) => ({ ...r, bps: exact.cap_bps })), cap_bps: exact.cap_bps };
  return {
    mean_delta: expect(prior, (bits) => priceOf(bucket, bits) - priceOf(exact, bits)),
    worst: { bits: worst.bits, delta: worst.delta },
    worst_cohort: worstCohort && { k: kc, bits: worstCohort.bits, delta: worstCohort.delta, mean_delta: expect(prior, (bits) => priceOf(bucket, bits) - priceOf(exact, bits, kc)) },
    best: { bits: best.bits, delta: best.delta },
    no_loss_merchant_cost: expect(prior, (bits) => priceOf(exact, bits) - priceOf(noLoss, bits)),
  };
}

/** Bounds fixed by the design alone. "any" has at most two prices (base, and base less
 *  b), so one sale's amount tells at most 1 bit under every prior. A tighter bound (0) is a claim
 *  about who buys, and is written by hand on the entry that makes it, with its reason. */
export const DESIGN_BOUNDS = { any: { swarm: 1, uniform: 1 } };

/** The bucketed merchants file: one "any" bucket per listed merchant, with its stated bounds. */
export function bucketedFile(merchants, prior, live = []) {
  const designs = merchants.map((m) => {
    const s = bucketAny(m.schedule, prior);
    return { account: null, of: m.account, category: m.category, bucketed: true, design: "any", bound_bits: { ...DESIGN_BOUNDS.any }, schedule: s };
  });
  return {
    note: "bucketed schedules (docs/leak-amount.md): each rule pays the same bps and the cap equals it, so every buyer with at least one priced bit pays one price. b keeps the merchant's expected revenue under the swarm prior. Written by node scripts/leak-amount.mjs --write; checked by node scripts/leak-amount.mjs. account null: a design with no on-chain registration.",
    prior: "swarm: fixtures/live/swarm/s1.json purchases; uniform: every subset of the merchant's priced predicates",
    merchants: [...live, ...designs],
  };
}

/** Check one bucketed entry against its bounds. Returns failure strings. */
export function checkBucketed(m, priors) {
  const out = [];
  const err = validate(m.schedule);
  if (err) out.push(`${m.account ?? m.of}: schedule invalid: ${err}`);
  if (m.schedule.cohort) out.push(`${m.account ?? m.of}: a cohort line adds a bit (the group unlock); a bucketed schedule has none`);
  // The design itself: "any" means one bps on every rule and the cap equal to it.
  if (m.design === "any" && (new Set(m.schedule.rules.map((r) => r.bps)).size > 1 || m.schedule.rules.some((r) => r.bps !== m.schedule.cap_bps))) out.push(`${m.account ?? m.of}: design "any" needs one bps on every rule and the cap equal to it`);
  if (!m.design || !DESIGN_BOUNDS[m.design]) out.push(`${m.account ?? m.of}: unknown design ${m.design}`);
  for (const [name, b] of Object.entries(DESIGN_BOUNDS[m.design] ?? {})) if (!(m.bound_bits?.[name] <= b)) out.push(`${m.account ?? m.of}: bound_bits.${name} ${m.bound_bits?.[name]} is above the design's ${b}`);
  for (const [name, prior] of Object.entries(priors)) {
    const bound = m.bound_bits?.[name];
    if (bound == null) continue;
    const l = amountLeak(m.schedule, prior(m.schedule)).bits_leaked;
    if (l > bound + 1e-9) out.push(`${m.account ?? m.of}: leaks ${l.toFixed(3)} bits per sale under the ${name} prior, bound ${bound}`);
  }
  return out;
}

/** The second channel: which merchant the buyer picked. From the swarm's recorded sales (one
 *  category or all), I(set; merchant), I(set; merchant, amount), and the amount's part given the
 *  merchant, I(set; amount | merchant), with the recorded price or with a price function. */
export function merchantChannel(purchases, price = (x) => x.price) {
  const n = purchases.length;
  const H = (f) => {
    const c = new Map();
    for (const x of purchases) c.set(f(x), (c.get(f(x)) ?? 0) + 1);
    return entropy([...c.values()].map((v) => v / n));
  };
  const set = (x) => x.bit_set;
  const hSet = H(set);
  const hM = H((x) => x.merchant);
  const hSetM = H((x) => `${set(x)}|${x.merchant}`);
  const hMA = H((x) => `${x.merchant}|${price(x)}`);
  const hSetMA = H((x) => `${set(x)}|${x.merchant}|${price(x)}`);
  const r = (x) => Math.round(x * 1e9) / 1e9 + 0;
  const iM = r(hSet - (hSetM - hM));
  const iMA = r(hSet - (hSetMA - hMA));
  return { sales: n, h_set: r(hSet), merchant: iM, merchant_amount: iMA, amount_given_merchant: r(iMA - iM) };
}

const usd = (x) => (x / 1e6).toFixed(2);

async function main() {
  const merchants = JSON.parse(readFileSync(root("agents/merchants.json")));
  const swarm = swarmPrior();
  const priors = { swarm: () => swarm, uniform: uniformPrior };
  const path = root("agents/merchants-bucketed.json");
  let file = null;
  try {
    file = JSON.parse(readFileSync(path));
  } catch {}
  const live = (file?.merchants ?? []).filter((m) => m.account);
  const want = bucketedFile(merchants, swarm, live);
  if (process.argv.includes("--write")) {
    writeFileSync(path, JSON.stringify(want, null, 2) + "\n");
    console.log(`wrote agents/merchants-bucketed.json: ${want.merchants.length} bucketed schedules (${live.length} live)`);
    return;
  }
  console.log(`leak-amount: bits about the buyer's set that one settled amount gives, per merchant (leak at k = 0; cost also at k >= k_min)`);
  console.log(`prior swarm: ${swarm.length} bit sets from fixtures/live/swarm/s1.json (${swarm.map((x) => `{${x.bits.join(",")}} ${x.p.toFixed(2)}`).join("; ")})`);
  console.log(`prior uniform: every subset of the merchant's priced predicates\n`);
  console.log(`amount channel only, every swarm set assumed at every merchant (counterfactual); cost at k = 0, and at k >= k_min for a cohort line`);
  console.log(`merchant  exact:swarm  exact:uniform  bucket:swarm  bucket:uniform  b_bps  mean_delta  worst_set_pays  worst_at_k_min  no_loss_merchant_cost`);
  const rows = [];
  const byOf = new Map(want.merchants.filter((m) => !m.account).map((m) => [m.of, m]));
  for (const m of merchants) {
    const bkt = byOf.get(m.account).schedule;
    const c = bucketCost(m.schedule, bkt, swarm);
    const r = {
      merchant: m.account.split(".")[0],
      exact: { swarm: amountLeak(m.schedule, swarm).bits_leaked, uniform: amountLeak(m.schedule, uniformPrior(m.schedule)).bits_leaked },
      bucket: { swarm: amountLeak(bkt, swarm).bits_leaked, uniform: amountLeak(bkt, uniformPrior(bkt)).bits_leaked },
      b_bps: bkt.cap_bps,
      cost: c,
    };
    rows.push(r);
    console.log(`${r.merchant.padEnd(8)}  ${r.exact.swarm.toFixed(3).padStart(11)}  ${r.exact.uniform.toFixed(3).padStart(13)}  ${r.bucket.swarm.toFixed(3).padStart(12)}  ${r.bucket.uniform.toFixed(3).padStart(14)}  ${String(r.b_bps).padStart(5)}  ${usd(c.mean_delta).padStart(10)}  ${`+${usd(c.worst.delta)} {${c.worst.bits.join(",")}}`.padStart(14)}  ${c.worst_cohort ? `+${usd(c.worst_cohort.delta)} (${((100 * c.worst_cohort.delta) / Number(m.schedule.base_price)).toFixed(2)}%)` : "-"}  ${usd(c.no_loss_merchant_cost).padStart(8)}`);
  }
  const mean = (f) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
  console.log(`\nmean over ${rows.length} schedules (amount channel, every swarm set assumed at every merchant): exact ${mean((r) => r.exact.swarm).toFixed(3)} bits (swarm), ${mean((r) => r.exact.uniform).toFixed(3)} (uniform); bucketed ${mean((r) => r.bucket.swarm).toFixed(3)} (swarm), ${mean((r) => r.bucket.uniform).toFixed(3)} (uniform)`);
  // The sales that happened (s1.json): merchant choice and amount, per category, exact (the
  // recorded price) and bucketed (each merchant's "any" bucket priced from the sealed set).
  const sales = JSON.parse(readFileSync(root("fixtures/live/swarm/s1.json"))).purchases;
  const bucketPrice = (x) => String(quote(byOf.get(x.merchant).schedule, x.predicates).price);
  console.log(`\nrecorded swarm sales (fixtures/live/swarm/s1.json), bits about the 2-bit set per sale:`);
  console.log(`scope         sales  I(set;merchant)  I(set;merchant,amount)  amount|merchant exact  amount|merchant bucketed`);
  for (const [name, ps] of [...[...new Set(sales.map((x) => x.category))].map((c) => [c, sales.filter((x) => x.category === c)]), ["all", sales]]) {
    const e = merchantChannel(ps);
    const b = merchantChannel(ps, bucketPrice);
    console.log(`${name.padEnd(12)}  ${String(e.sales).padStart(5)}  ${e.merchant.toFixed(3).padStart(15)}  ${e.merchant_amount.toFixed(3).padStart(22)}  ${e.amount_given_merchant.toFixed(3).padStart(21)}  ${b.amount_given_merchant.toFixed(3).padStart(24)}`);
  }
  const fails = [];
  if (JSON.stringify(file) !== JSON.stringify(want)) fails.push("agents/merchants-bucketed.json is stale: run node scripts/leak-amount.mjs --write");
  for (const m of want.merchants) fails.push(...checkBucketed(m, priors));
  for (const m of live) {
    const l = { swarm: amountLeak(m.schedule, swarm).bits_leaked, uniform: amountLeak(m.schedule, uniformPrior(m.schedule)).bits_leaked };
    console.log(`live ${m.account}: ${l.swarm.toFixed(3)} bits (swarm), ${l.uniform.toFixed(3)} (uniform); bound ${JSON.stringify(m.bound_bits)}`);
  }
  for (const f of fails) console.log(`FAIL  ${f}`);
  if (fails.length) process.exit(1);
  console.log(`PASS  leak-amount: ${want.merchants.length} bucketed schedules within their bounds (${live.length} live)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => {
  console.error(`leak-amount: FAIL ${e.message}`);
  process.exit(1);
});
