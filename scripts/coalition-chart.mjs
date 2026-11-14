#!/usr/bin/env node
// docs/media/coalition-fill.svg from fixtures/coalition/result.json: mean bundle fill rate per
// epoch for each arm over the 20 seeds, with the min..max band across seeds; dashed: the
// exploratory singles_filtered arm (beyond the pre-registration).
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const r = JSON.parse(readFileSync(`${root}fixtures/coalition/result.json`, "utf8"));
const W = 640, H = 340, L = 56, R = 150, T = 36, B = 44;
const arms = [
  ["coalitions", "#3B5BFF", "coalitions (in_top + bond)"],
  ["singles_clean", "#6B7280", "singles, no sybils"],
  ["singles", "#D9480F", "singles, sybils in market"],
];
// Exploratory, beyond the pre-registration: singles that apply the same in_top filter, no bond.
const filtered = r.exploratory?.singles_filtered?.per_epoch;
const E = r.per_epoch.coalitions.length;
const x = (e) => L + (e * (W - L - R)) / (E - 1);
const y = (v) => T + (1 - v) * (H - T - B);
let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif" font-size="12">\n`;
s += `<rect width="${W}" height="${H}" fill="#FFFFFF"/>\n`;
s += `<text x="${L}" y="20" font-size="14" fill="#111">Bundles filled (all 3 legs delivered), mean of ${r.seeds.length} seeds, band = min..max</text>\n`;
for (const v of [0, 0.25, 0.5, 0.75, 1]) {
  s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#E5E7EB"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" fill="#374151">${Math.round(v * 100)}%</text>\n`;
}
for (let e = 0; e < E; e++) s += `<text x="${x(e)}" y="${H - B + 18}" text-anchor="middle" fill="#374151">${e}</text>\n`;
s += `<text x="${(L + W - R) / 2}" y="${H - 8}" text-anchor="middle" fill="#374151">epoch</text>\n`;
arms.forEach(([arm, color, label], i) => {
  const rows = r.per_epoch[arm];
  const band = rows.map((p, e) => `${x(e)},${y(p.fill_rate.max)}`).concat(rows.map((p, e) => `${x(e)},${y(p.fill_rate.min)}`).reverse()).join(" ");
  s += `<polygon points="${band}" fill="${color}" fill-opacity="0.12"/>\n`;
  s += `<polyline points="${rows.map((p, e) => `${x(e)},${y(p.fill_rate.mean)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2.5"/>\n`;
  const last = rows[E - 1].fill_rate.mean;
  s += `<text x="${W - R + 10}" y="${y(last) + 4 + (i - 1) * 2}" fill="${color}">${label}</text>\n`;
});
if (filtered) {
  s += `<polyline points="${filtered.map((p, e) => `${x(e)},${y(p.fill_rate.mean)}`).join(" ")}" fill="none" stroke="#0F9D58" stroke-width="2" stroke-dasharray="5 4"/>\n`;
  s += `<text x="${W - R + 10}" y="${y(filtered[E - 1].fill_rate.mean) + 18}" fill="#0F9D58">singles + same filter</text>\n`;
  s += `<text x="${W - R + 10}" y="${y(filtered[E - 1].fill_rate.mean) + 32}" fill="#0F9D58">(exploratory)</text>\n`;
}
s += `</svg>\n`;
writeFileSync(`${root}docs/media/coalition-fill.svg`, s);
console.log("wrote docs/media/coalition-fill.svg");
