#!/usr/bin/env node
// Put real JMPR hotel rates into the hotel merchants' base prices (h01..h08).
//
//   node scripts/jmpr-rates-to-merchants.mjs fixtures/live/jmpr-rates.json   then: make swarm
//
// The rates file is captured in a session that has the JMPR MCP, read-only:
// `hotel_search` for one city and dates, then `hotel_room_rate` for up to 8 hotels.
// NEVER `prebook_hotel` or `book_hotel`. Store only what is below: no guest data.
//
// {
//   "source": "jmpr hotel_search + hotel_room_rate, read-only",
//   "city": "lisbon", "check_in": "2026-11-20", "check_out": "2026-11-22",
//   "fetched_at": "<ISO time>",
//   "hotels": [ { "name": "<hotel name>", "total": "183.40", "currency": "USD" } ]
// }
//
// Discount rules and cohort rules stay as configured; only base_price and persona change.
// Prices are USD totals for the stay, mapped 1:1 to USDC base units (6 decimals). Any other
// currency is refused: no exchange rate is invented here.
import { readFileSync, writeFileSync } from "node:fs";

export function applyRates(merchants, rates) {
  if (!Array.isArray(rates.hotels) || rates.hotels.length === 0) throw new Error("no hotels in the rates file");
  const hotels = merchants.filter((m) => m.category === "hotel-lisbon-2n");
  const out = merchants.map((m) => ({ ...m, schedule: { ...m.schedule } }));
  rates.hotels.slice(0, hotels.length).forEach((h, i) => {
    if (h.currency !== "USD") throw new Error(`${h.name}: currency ${h.currency}, only USD totals are accepted`);
    if (!/^\d+(\.\d{1,2})?$/.test(String(h.total))) throw new Error(`${h.name}: bad total ${h.total}`);
    const [whole, cents = ""] = String(h.total).split(".");
    const base = BigInt(whole) * 1_000_000n + BigInt(cents.padEnd(2, "0")) * 10_000n;
    const target = out.find((m) => m.account === hotels[i].account);
    target.schedule.base_price = base.toString();
    target.persona = `${h.name} (jmpr rate, ${rates.city} ${rates.check_in} to ${rates.check_out})`;
    target.source = "jmpr-rate";
  });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/jmpr-rates-to-merchants.mjs <jmpr-rates.json>");
    process.exit(2);
  }
  const rates = JSON.parse(readFileSync(file, "utf8"));
  const merchants = JSON.parse(readFileSync("agents/merchants.json", "utf8"));
  const out = applyRates(merchants, rates);
  writeFileSync("agents/merchants.json", JSON.stringify(out, null, 2) + "\n");
  console.log(`hotel base prices set from ${Math.min(rates.hotels.length, 8)} jmpr rates; now run make swarm`);
}
