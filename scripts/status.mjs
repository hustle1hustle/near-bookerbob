#!/usr/bin/env node
// The README feature table is generated from docs/status.json, so a status cannot drift:
//   node scripts/status.mjs           rewrite the table between the status markers
//   node scripts/status.mjs --check   FAIL when the README differs from docs/status.json,
//                                     when a `live` row names evidence the testnet manifest
//                                     lacks, or when a stale phrase is back in the docs
// Status words: live (on testnet, re-derived by make verify-live), built (tests or make verify,
// not on testnet), stub (an interface with a test double), planned, archived.
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const rows = JSON.parse(readFileSync(root + "docs/status.json", "utf8"));
const manifest = JSON.parse(readFileSync(root + "fixtures/live/testnet-manifest.json", "utf8"));
const BEGIN = "<!-- status:begin (generated from docs/status.json by scripts/status.mjs; edit that file) -->";
const END = "<!-- status:end -->";
const WORDS = ["live", "built", "stub", "planned", "archived"];

// Phrases that once described features now live; any of them back in these docs is drift.
export const STALE = [
  "no blind round has run on testnet",
  "not deployed yet",
  "nothing is deployed",
  "No USDC has moved",
  "no USDC has moved",
  "Shopify write-back stubbed",
  "points at testnet once deployed",
  "sending on testnet waits",
  "not run (no deploy)",
  "waits on the testnet deploy",
  "The proven standing scores are not yet posted",
];
const DOCS = ["README.md", "docs/judge-guide.md", "AGENTS.md", "CLAUDE.md"];

export function render(rs) {
  const head = "| feature | track ids | where | status |\n|---|---|---|---|";
  return [BEGIN, head, ...rs.map((r) => `| ${r.feature} | ${r.tracks} | ${r.where} | **${r.status}**${r.detail ? `: ${r.detail}` : ""} |`), END].join("\n");
}

const at = (o, path) => path.split(".").reduce((x, k) => (x == null ? x : x[k]), o);

export function problems(readme, rs, m, docs) {
  const out = [];
  const a = readme.indexOf(BEGIN), b = readme.indexOf(END);
  if (a < 0 || b < 0) out.push("README has no status markers");
  else if (readme.slice(a, b + END.length) !== render(rs)) out.push("README feature table differs from docs/status.json (run node scripts/status.mjs)");
  for (const r of rs) {
    if (!WORDS.includes(r.status)) out.push(`"${r.feature.slice(0, 40)}": unknown status ${r.status}`);
    if (r.status === "live" && !(r.evidence ?? []).every((e) => at(m, e) != null)) out.push(`"${r.feature.slice(0, 40)}": live, but the manifest lacks ${(r.evidence ?? []).filter((e) => at(m, e) == null).join(", ") || "evidence"}`);
    if (r.status === "live" && !(r.evidence ?? []).length && !/reads `bookerbob\.testnet`/.test(r.detail)) out.push(`"${r.feature.slice(0, 40)}": live with no evidence named`);
  }
  for (const [f, text] of Object.entries(docs)) for (const p of STALE) if (text.includes(p)) out.push(`${f}: stale phrase "${p}"`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const readme = readFileSync(root + "README.md", "utf8");
  if (process.argv.includes("--check")) {
    const docs = Object.fromEntries(DOCS.map((f) => [f, readFileSync(root + f, "utf8")]));
    const p = problems(readme, rows, manifest, docs);
    const n = rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
    if (p.length) {
      for (const x of p) console.log(`FAIL  status: ${x}`);
      process.exit(1);
    }
    console.log(`PASS  status: README table = docs/status.json (${Object.entries(n).map(([k, v]) => `${v} ${k}`).join(", ")}), every live row has testnet evidence, no stale phrase`);
  } else {
    const a = readme.indexOf(BEGIN), b = readme.indexOf(END);
    if (a < 0) throw new Error("add the status markers around the feature table first");
    writeFileSync(root + "README.md", readme.slice(0, a) + render(rows) + readme.slice(b + END.length));
    console.log(`wrote the README feature table: ${rows.length} rows`);
  }
}
