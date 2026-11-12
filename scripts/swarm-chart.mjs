#!/usr/bin/env node
// Price discovery in a model-merchant swarm run, from its public record only.
//   node scripts/swarm-chart.mjs [tag]       default s2
// Writes docs/media/<tag>-prices.svg (README), agents/<tag>-prices.svg and agents/swarm-<tag>.json (the landing page).
// Each dot: one merchant's sealed bid, priced by the contract's rule for a buyer who revealed
// the "frequent" bits (airbnb_frequent, claude_spender, world_id_human). The line: the price
// the round's buyers paid. Nothing here is new data: the bids are the revealed schedules and
// the sales are the settled purchases in fixtures/live/swarm/<tag>.json.
import { readFileSync, writeFileSync } from "node:fs";
import { priceFor } from "./merchant-brain.mjs";

const tag = process.argv[2] ?? "s2";
const rec = JSON.parse(readFileSync(`fixtures/live/swarm/${tag}.json`, "utf8"));
const BITS = ["airbnb_frequent", "claude_spender", "world_id_human"];
const short = (a) => a.split(".")[0];
const rounds = rec.rounds.filter((r) => r.decisions?.length).map((r) => {
  const bids = r.decisions.filter((d) => !d.skip).map((d) => {
    const s = { base_price: Number(d.bid.base_price), rules: d.bid.rules, cap_bps: d.bid.cap_bps };
    return { merchant: short(d.merchant), persona: d.persona, price: priceFor(s, BITS) / 1e6, why: d.why, tee_signed: d.tee_signed, chat_id: d.chat_id };
  });
  const sales = rec.purchases.filter((p) => p.round === r.n).map((p) => ({ merchant: short(p.merchant), price: Number(p.price) / 1e6, bits: p.predicates, settle: p.txs.settle }));
  const ps = bids.map((b) => b.price).sort((a, b) => a - b);
  const winsFrequent = sales.filter((s) => BITS.every((b) => s.bits.includes(b)));
  return {
    n: r.n,
    bids,
    sold_out: r.decisions.filter((d) => d.skip).map((d) => short(d.merchant)),
    sales,
    low: ps[0],
    high: ps[ps.length - 1],
    median: ps[Math.floor(ps.length / 2)],
    paid_frequent: winsFrequent.length ? Math.min(...winsFrequent.map((s) => s.price)) : null,
    winners: [...new Set(sales.map((s) => s.merchant))],
    replay_refused: Boolean(r.replay),
  };
});
const out = { note: `price discovery in swarm run ${tag}, from fixtures/live/swarm/${tag}.json; each bid priced for a buyer revealing ${BITS.join(", ")}`, tag, bits: BITS, totals: rec.totals, rounds };
writeFileSync(`agents/swarm-${tag}.json`, JSON.stringify(out) + "\n");

// SVG: x = round, y = price; dots per bid (color by persona), a line through what buyers paid.
const W = 760, H = 300, L = 46, R = 120, T = 28, B = 34;
const all = rounds.flatMap((r) => r.bids.map((b) => b.price));
const ymax = Math.ceil(Math.max(...all, 1) / 10) * 10, ymin = Math.floor(Math.min(...all, ymax) / 10) * 10;
const x = (i) => L + ((W - L - R) * (i + 0.5)) / Math.max(1, rounds.length);
const y = (p) => T + ((H - T - B) * (ymax - p)) / Math.max(1, ymax - ymin);
const color = (p) => (p.startsWith("undercut") ? "#5BE3A0" : p.startsWith("premium") ? "#FF9F5B" : p.startsWith("adaptive") ? "#3B5BFF" : "#C77DFF");
let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,Menlo,monospace" font-size="11"><rect width="${W}" height="${H}" fill="#0A0A0F"/>`;
svg += `<text x="${L}" y="16" fill="#E6E6EF" font-size="12">${tag}: each model merchant's sealed bid for a buyer with 3 proven bits, and what buyers paid (dUSDC)</text>`;
for (let p = ymin; p <= ymax; p += 10) svg += `<line x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}" stroke="#1C1C2A"/><text x="${L - 6}" y="${y(p) + 4}" fill="#7C7C94" text-anchor="end">${p}</text>`;
rounds.forEach((r, i) => {
  svg += `<text x="${x(i)}" y="${H - 12}" fill="#7C7C94" text-anchor="middle">round ${r.n}</text>`;
  r.bids.forEach((b, j) => (svg += `<circle cx="${x(i) + ((j % 5) - 2) * 5}" cy="${y(b.price)}" r="4" fill="${color(b.persona)}" fill-opacity="0.85"><title>${b.merchant} (${b.persona}): ${b.price.toFixed(2)}</title></circle>`));
});
const pts = rounds.map((r, i) => (r.paid_frequent != null ? `${x(i)},${y(r.paid_frequent)}` : null)).filter(Boolean);
if (pts.length) svg += `<polyline points="${pts.join(" ")}" fill="none" stroke="#E6E6EF" stroke-width="2"/>` + pts.map((p) => `<circle cx="${p.split(",")[0]}" cy="${p.split(",")[1]}" r="3" fill="#E6E6EF"/>`).join("");
[["undercutter", "#5BE3A0"], ["premium", "#FF9F5B"], ["adaptive", "#3B5BFF"], ["other strategy", "#C77DFF"], ["paid (3 bits)", "#E6E6EF"]].forEach(([k, c], i) => (svg += `<circle cx="${W - R + 14}" cy="${T + 10 + i * 18}" r="4" fill="${c}"/><text x="${W - R + 24}" y="${T + 14 + i * 18}" fill="#7C7C94">${k}</text>`));
svg += `</svg>\n`;
writeFileSync(`docs/media/${tag}-prices.svg`, svg);
writeFileSync(`agents/${tag}-prices.svg`, svg);
for (const r of rounds) console.log(`round ${r.n}: ${r.bids.length} bids, ${r.low.toFixed(2)} to ${r.high.toFixed(2)} (median ${r.median.toFixed(2)}), buyers with 3 bits paid ${r.paid_frequent ?? "-"}, winners ${r.winners.join(", ") || "-"}${r.sold_out.length ? `, sold out: ${r.sold_out.join(", ")}` : ""}`);
console.log(`wrote agents/swarm-${tag}.json and docs/media/${tag}-prices.svg`);
