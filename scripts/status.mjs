#!/usr/bin/env node
// The README feature table is generated from docs/status.json, so a status cannot drift:
//   node scripts/status.mjs           rewrite the table between the status markers
//   node scripts/status.mjs --check   FAIL when the README differs from docs/status.json,
//                                     when a `live` row names evidence the testnet manifest
//                                     lacks, when a stale phrase is back in the docs, when a
//                                     doc calls a method of a live row "not deployed", or when
//                                     the set-size lines differ from agents/live.json
// Status words: live (on testnet, re-derived by make verify-live), built (tests or make verify,
// not on testnet), stub (an interface with a test double), planned, archived.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { purchases } from "./live-snapshot.mjs";

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
  "6 dUSDC settles",
  "6 settles",
  "32 of 32",
  "32/32",
];
const DOCS = ["README.md", "docs/depth.md", "docs/judge-guide.md", "AGENTS.md", "docs/outlayer.md", "docs/near-ai.md", "docs/jolt.md", "docs/solvers.md"];

// How many testnet buyers share each settled amount and each merchant, as the docs print it:
// from agents/live.json, the same snapshot the pages read. A refunded pledge paid nothing, so
// it is in no amount set; it still names its merchant.
export function setSizes(live) {
  const by = (rows, key) => { const c = new Map(); for (const r of rows) c.set(key(r), (c.get(key(r)) ?? 0) + 1); return [...c]; };
  const amounts = by(live.purchases.filter((p) => p.kind !== "refunded"), (p) => Number(p.paid)).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const merchants = by(live.purchases, (p) => p.merchant.split(".")[0]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return {
    amounts: amounts.map(([a, n]) => `${(a / 1e6).toFixed(2)} x${n}`).join(", "),
    merchants: merchants.map(([m, n], i) => `${m}: ${n}${i ? "" : " buyers"}`).join(", "),
  };
}

// Features with code in the tree. A doc that calls one planned or not built is drift. Each
// entry names the file and the code that proves it shipped; if that code is gone, the entry
// itself fails, so the list cannot outlive the code.
export const SHIPPED = [
  { what: "arbiter threshold", file: "contract/src/lib.rs", code: "pub fn set_arbiter_threshold", claims: [/2-of-3 arbiter is planned/i, /arbiter is one registered key/i, /an arbiter set[^.]*neither is built/i] },
  { what: "sealed referee input", file: "worker/src/sealed.rs", code: "pub fn seal", claims: [/sealed \(not built\)/i, /sealed to the\s+worker key\. Not built/i] },
  { what: "settle-only function-call key", file: "scripts/fc-key-check.mjs", code: "", claims: [/planned function-call\s+key/i, /Not built: function-call keys/i] },
  { what: "relayer sending", file: "relayer/near.mjs", code: "", claims: [/the NEP-366 relayer sending/i] },
  { what: "anchor timelock", file: "contract/src/lib.rs", code: "pub fn execute_anchor", claims: [/timelock[^.\n]*\b(planned|not built)\b/i] },
  { what: "market fee", file: "contract/src/lib.rs", code: "pub fn sweep_fees", claims: [/market fee[^.\n]*\b(planned|not built)\b/i] },
  { what: "certified eval", file: "contract/src/lib.rs", code: "pub fn submit_eval_certificate", claims: [/certified (private )?eval[^.\n]*\b(planned|not built)\b/i] },
];

// Numbers the docs repeat that a fixture already holds.
// Purchases come from the same function verify-live checks against spent_count on chain;
// "N checks" come from the committed fresh-clone make verify log.
export function counted(m, liveRun, verifyLog = "") {
  const rows = purchases(m);
  const paid = rows.filter((x) => x.kind !== "refunded");
  const single = rows.filter((x) => ["single", "hotel", "sealed", "prove-me"].includes(x.kind)).length;
  const num = (re) => Number(verifyLog.match(re)?.[1] ?? NaN);
  return {
    purchases: paid.length,
    single,
    replays: (m.testers ?? []).filter((t) => t.txs?.replay).length,
    shopify: (m.testers ?? []).filter((t) => t.shopify_order).length,
    signatures: (liveRun.calls ?? []).length,
    checks: { all: num(/ALL PASS \((\d+) checks\)/), near_ai: num(/NEAR AI verdict: (\d+) checks/), reviews: num(/sealed reviews: (\d+) checks/), evals: num(/referee evals (\d+)\/\d+/) },
  };
}

export function render(rs) {
  const head = "| feature | track ids | where | status |\n|---|---|---|---|";
  return [BEGIN, head, ...rs.map((r) => `| ${r.feature} | ${r.tracks} | ${r.where} | **${r.status}**${r.detail ? `: ${r.detail}` : ""} |`), END].join("\n");
}

const at = (o, path) => path.split(".").reduce((x, k) => (x == null ? x : x[k]), o);

export function problems(readme, rs, m, docs, src = {}, n = null, sets = null) {
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
  for (const s of SHIPPED) {
    if (!(s.file in src) || !src[s.file].includes(s.code)) { out.push(`SHIPPED "${s.what}": ${s.file} no longer has ${s.code || "the file"}; fix the list`); continue; }
    for (const [f, text] of Object.entries(docs)) for (const re of s.claims) if (re.test(text)) out.push(`${f}: calls ${s.what} planned or not built, but ${s.file} has it`);
  }
  // A planned or stub row whose named method exists in the contract is drift too.
  const lib = src["contract/src/lib.rs"] ?? "";
  for (const r of rs) if (["planned", "stub"].includes(r.status)) for (const [, fn] of r.where.matchAll(/`([a-z_]+)`/g)) if (lib.includes(`pub fn ${fn}(`)) out.push(`"${r.feature.slice(0, 40)}": ${r.status}, but lib.rs has pub fn ${fn}`);
  // A method named by a live row is deployed: a sentence that names it and says "not deployed"
  // is the stale kind of line that once sat beside the live row.
  const liveFns = new Set(rs.filter((r) => r.status === "live").flatMap((r) => [...r.where.matchAll(/`([a-z_]+)`/g)].map((x) => x[1])).filter((fn) => lib.includes(`pub fn ${fn}(`)));
  for (const [f, text] of Object.entries(docs)) for (const s of text.split(/\n\s*\n|(?<=[.;])\s+/)) {
    if (!/\bnot\s+deployed\b/i.test(s)) continue;
    for (const [, fn] of s.matchAll(/`([a-z_]+)`/g)) if (liveFns.has(fn)) out.push(`${f}: says \`${fn}\` is not deployed, but a live row names it`);
  }
  // The set-size lines (amounts shared, buyers per merchant) must be the ones agents/live.json gives.
  if (sets) for (const [f, text] of Object.entries(docs)) for (const l of text.split("\n")) {
    if (/\b\d+\.\d\d x\d+, \d/.test(l) && !l.includes(sets.amounts)) out.push(`${f}: settled-amount sets differ from agents/live.json (${sets.amounts})`);
    if (/\bm01: \d+ buyers/.test(l) && !l.includes(sets.merchants)) out.push(`${f}: buyers per merchant differ from agents/live.json (${sets.merchants})`);
  }
  if (n) for (const [f, text] of Object.entries(docs)) {
    for (const [, x] of text.matchAll(/\b(\d+) dUSDC purchases/g)) if (Number(x) !== n.purchases) out.push(`${f}: "${x} dUSDC purchases", the manifest has ${n.purchases}`);
    for (const [, x, y] of text.matchAll(/\b(\d+) (?:dUSDC )?purchases(?: on testnet)? \((\d+) single settles/g)) if (Number(x) !== n.purchases || Number(y) !== n.single) out.push(`${f}: "${x} purchases (${y} single", the manifest has ${n.purchases} and ${n.single}`);
    const want = (re, n, what) => { for (const [, x] of text.matchAll(re)) if (Number.isFinite(n) && Number(x) !== n) out.push(`${f}: "${x}" ${what}, the source has ${n}`); };
    want(/\bOn testnet, (\d+) purchases/g, n.purchases, "purchases");
    want(/\b(\d+) purchases settled in dUSDC/g, n.purchases, "purchases");
    want(/\bran (\d+) times in dUSDC/g, n.single, "single settles");
    want(/\b(\d+) replays refused/g, n.replays, "replays refused");
    want(/\b(\d+) orders in the Shopify/g, n.shopify, "Shopify orders");
    want(/\b(\d+) orders between #/g, n.shopify, "Shopify orders");
    if (n.checks) {
      want(/ALL PASS \((\d+) checks\)/g, n.checks.all, "make verify checks");
      want(/NEAR AI verdict:? (\d+) checks/g, n.checks.near_ai, "NEAR AI verdict checks");
      want(/NEAR AI verdict \((\d+) checks/g, n.checks.near_ai, "NEAR AI verdict checks");
      want(/sealed reviews: (\d+) checks/g, n.checks.reviews, "sealed review checks");
      want(/referee evals (\d+)\/\d+/g, n.checks.evals, "referee evals");
    }
    for (const [, x, y] of text.matchAll(/\b(\d+)(?:\/| of )(\d+) (?:response )?signatures(?: verified| valid)/g)) if (!(Number(x) === Number(y) && [n.signatures, 20].includes(Number(x)))) out.push(`${f}: "${x}/${y} signatures", the live run has ${n.signatures}`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const readme = readFileSync(root + "README.md", "utf8");
  if (process.argv.includes("--check")) {
    const docs = Object.fromEntries(DOCS.map((f) => [f, readFileSync(root + f, "utf8")]));
    const src = Object.fromEntries([...new Set(SHIPPED.map((s) => s.file).concat("contract/src/lib.rs"))].filter((f) => existsSync(root + f)).map((f) => [f, readFileSync(root + f, "utf8")]));
    const liveRun = JSON.parse(readFileSync(root + "agents/out/live-run.json", "utf8"));
    const log = existsSync(root + "fixtures/live/offline-run/verify-offline.log") ? readFileSync(root + "fixtures/live/offline-run/verify-offline.log", "utf8") : "";
    const live = JSON.parse(readFileSync(root + "agents/live.json", "utf8"));
    const p = problems(readme, rows, manifest, docs, src, counted(manifest, liveRun, log), setSizes(live));
    const n = rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
    if (p.length) {
      for (const x of p) console.log(`FAIL  status: ${x}`);
      process.exit(1);
    }
    console.log(`PASS  status: README table = docs/status.json (${Object.entries(n).map(([k, v]) => `${v} ${k}`).join(", ")}), every live row has testnet evidence, no stale phrase, set sizes = agents/live.json`);
  } else {
    const a = readme.indexOf(BEGIN), b = readme.indexOf(END);
    if (a < 0) throw new Error("add the status markers around the feature table first");
    writeFileSync(root + "README.md", readme.slice(0, a) + render(rows) + readme.slice(b + END.length));
    console.log(`wrote the README feature table: ${rows.length} rows`);
  }
}
