#!/usr/bin/env node
// Put real JMPR hotel rates into the hotel merchants' base prices (h01..h08).
//
//   node scripts/jmpr-rates-to-merchants.mjs fixtures/live/jmpr-lisbon-rates.json   then: make swarm
//
// The rates file is captured read-only in a session with the JMPR MCP (`hotel_search`,
// optionally `hotel_room_rate`). NEVER `prebook_hotel` or `book_hotel`. It holds hotel
// names, prices and perks only, no guest data. Accepted shapes, per hotel:
//   { "name", "total", "currency" }                                   a stay total
//   { "name", "base_nightly", "elite_nightly", "elite_perks" }        nightly "from" prices,
//      with top-level "nights" and "currency": total = base_nightly x nights, or
//      elite_nightly x nights when there is no base rate (the basis is recorded).
// These are comparison prices, not quotes. Discount and cohort rules stay as configured;
// base_price, persona, perks and source change. USD only: no exchange rate is invented.
import { readFileSync, writeFileSync } from "node:fs";

const toBase = (usd) => {
  const [whole, cents = ""] = String(usd).split(".");
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(cents)) throw new Error(`bad amount ${usd}`);
  return BigInt(whole) * 1_000_000n + BigInt(cents.padEnd(2, "0") || "0") * 10_000n;
};

function stayTotal(h, rates) {
  const currency = h.currency ?? rates.currency;
  if (currency !== "USD") throw new Error(`${h.name}: currency ${currency}, only USD is accepted`);
  if (h.total !== undefined) return { base: toBase(h.total), basis: "stay total" };
  const nights = Number(rates.nights);
  if (!Number.isInteger(nights) || nights < 1) throw new Error("nightly rates need an integer nights field");
  if (h.base_nightly != null) return { base: toBase(h.base_nightly) * BigInt(nights), basis: `base ${h.base_nightly}/night x ${nights}, incl. tax` };
  if (h.elite_nightly != null) return { base: toBase(h.elite_nightly) * BigInt(nights), basis: `elite ${h.elite_nightly}/night x ${nights}, before tax (no base rate)` };
  throw new Error(`${h.name}: no rate`);
}

export function applyRates(merchants, rates) {
  if (!Array.isArray(rates.hotels) || rates.hotels.length === 0) throw new Error("no hotels in the rates file");
  const hotels = merchants.filter((m) => m.category.startsWith("hotel-"));
  const out = merchants.map((m) => ({ ...m, schedule: { ...m.schedule } }));
  const label = rates.label ?? `JMPR rates, ${rates.queried ?? rates.fetched_at ?? "undated"}`;
  rates.hotels.slice(0, hotels.length).forEach((h, i) => {
    const { base, basis } = stayTotal(h, rates);
    const target = out.find((m) => m.account === hotels[i].account);
    target.schedule.base_price = base.toString();
    target.persona = `${h.name}${h.stars ? `, ${h.stars} stars` : ""}. ${rates.city ?? ""} ${rates.checkin ?? rates.check_in ?? ""} to ${rates.checkout ?? rates.check_out ?? ""}. ${basis}`.replace(/\s+/g, " ").trim();
    target.perks = h.elite_perks ?? [];
    target.source = label;
  });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/jmpr-rates-to-merchants.mjs <rates.json>");
    process.exit(2);
  }
  const rates = JSON.parse(readFileSync(file, "utf8"));
  const merchants = JSON.parse(readFileSync("agents/merchants.json", "utf8"));
  writeFileSync("agents/merchants.json", JSON.stringify(applyRates(merchants, rates), null, 2) + "\n");
  console.log(`hotel base prices set from ${Math.min(rates.hotels.length, 8)} rates (${rates.label ?? "unlabelled"}); now run make swarm`);
}
