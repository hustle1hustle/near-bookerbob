#!/usr/bin/env node
// Node-only check of the committed v2 coalition result (fixtures/coalition/result-v2.json), no cargo;
// with --v3 the v3 result (fixtures/coalition/result-v3.json, docs/coalition-prereg-v3.md), same rule:
//   1. the pre-registration's sha256 (up to its marker line) equals the one the run recorded
//   2. every seed's arm totals equal the sum of its epochs; every coalition ledger sums to 0
//   3. `overall` recomputes from the seeds
//   4. the pass rule (docs/coalition-prereg-v2.md and -v3.md, "Pass rule", the same clauses), re-applied to the per-seed numbers
//   5. with --anchor: the anchor tx's memo is the pre-registration's sha256 over public testnet RPC
//      (scripts/prereg-anchor.mjs check). Exit 3 from it (no RPC answered) is a SKIP; any other
//      failure is a FAIL.
// `make coalition-v2-check` is the deep path: it re-runs the Rust simulation and compares.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const MARKER = "<!-- anchored above this line -->";
const tag = process.argv.includes("--v4") ? "v4" : process.argv.includes("--v3") ? "v3" : "v2";
const arm = `coalitions_${tag}`;
const r = JSON.parse(readFileSync(`${root}fixtures/coalition/result-${tag}.json`, "utf8"));
const doc = readFileSync(`${root}${r.prereg}`, "utf8");
const errs = [];

const sha = createHash("sha256").update(doc.split(MARKER)[0]).digest("hex");
if (sha !== r.prereg_sha256) errs.push(`pre-registration sha256 ${sha.slice(0, 12)}.. differs from the run's ${String(r.prereg_sha256).slice(0, 12)}..`);
const below = doc.split(MARKER)[1] ?? "";
const anchor = below.match(/\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/);
const firstRun = (below.match(/first run at (\d{4}-\d\d-\d\dT[\d:.]+Z)/) ?? [])[1];

const MAXES = ["ring_standing_max", "hired_score_max"];
const fill = (t) => t.filled / Math.max(t.jobs, 1);
const failed = (t) => (100 * t.no_show_legs) / Math.max(t.jobs - t.unserved, 1);
const price = (t) => t.paid_filled / Math.max(t.filled, 1) / 1e6;
const loss = (t) => ((t.paid_failed - t.slashed) / 1e6 * 100) / Math.max(t.jobs, 1);
const sum = (epochs) => {
  const t = {};
  for (const k of Object.keys(epochs[0])) t[k] = MAXES.includes(k) ? Math.max(0, ...epochs.map((e) => e[k])) : epochs.reduce((x, e) => x + e[k], 0);
  return t;
};
const r4 = (x) => (Math.sign(x) * Math.round(Math.abs(x) * 10_000)) / 10_000;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
const spread = (xs) => {
  const n = xs.length, m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / Math.max(n - 1, 1));
  return { mean: r4(m), sd: r4(sd), min: r4(Math.min(...xs)), max: r4(Math.max(...xs)) };
};
const near = (a, b) => Object.keys(b).every((k) => Math.abs(a[k] - b[k]) < 1e-9);

const ARMS = Object.keys(r.overall);
const COAL = ARMS.filter((a) => a.startsWith("coalitions"));
const totals = Object.fromEntries(ARMS.map((a) => [a, []]));
for (const s of r.seeds) {
  for (const [arm, a] of Object.entries(s.arms)) {
    const t = sum(a.epochs);
    for (const k of Object.keys(t)) if (t[k] !== a.total[k]) errs.push(`seed ${s.seed} ${arm} ${k}: epochs give ${t[k]}, total ${a.total[k]}`);
    totals[arm].push(a.total);
  }
  for (const arm of COAL) if (s.ledger_sum[arm] !== "0") errs.push(`seed ${s.seed} ${arm}: money not conserved (${s.ledger_sum[arm]})`);
}
for (const arm of ARMS) {
  const ts = totals[arm];
  const want = { fill_rate: spread(ts.map(fill)), failed_legs_per_100: spread(ts.map(failed)), price_per_filled: spread(ts.map(price)), loss_per_100: spread(ts.map(loss)), unserved_per_100: spread(ts.map((t) => (100 * t.unserved) / t.jobs)) };
  for (const [k, v] of Object.entries(want)) if (!r.overall[arm][k] || !near(r.overall[arm][k], v)) errs.push(`overall.${arm}.${k} does not recompute from the seeds`);
}

// The pass rule.
const p = r.pass_rule, min = p.min_seeds, n = r.seeds.length;
const nw = r.seeds.filter((s) => s.reliable_newcomers_ever[arm] > s.reliable_newcomers_ever.coalitions_v1).length;
const f1 = mean(totals.coalitions_v1.map(failed)), f2 = mean(totals[arm].map(failed));
const q1 = mean(totals.coalitions_v1.map(fill)), q2 = mean(totals[arm].map(fill));
let ringAdm = 0, ringLeaves = 0, ringStanding = 0, ringAttempts = 0;
for (const arm of COAL) for (const t of totals[arm]) { ringAdm += t.ring_admissions; ringLeaves += t.ring_leaves; ringStanding = Math.max(ringStanding, t.ring_standing_max); ringAttempts += t.ring_attempts; }
const tolF = r.params.failed_leg_tolerance, tolQ = r.params.fill_tolerance;
const c = [nw >= min, r4(f2) <= r4(f1 + tolF), r4(q2) >= r4(q1 - tolQ), ringAdm === 0 && ringLeaves === 0 && ringStanding === 0];
const pass = c.every(Boolean);
if (pass !== p.pass) errs.push(`pass rule here ${pass}, recorded ${p.pass}`);
for (const [k, v] of [["reliable_newcomer_wins", nw], ["failed_legs_per_100_v1", r4(f1)], [`failed_legs_per_100_${tag}`, r4(f2)], ["fill_rate_v1", r4(q1)], [`fill_rate_${tag}`, r4(q2)], ["ring_admissions", ringAdm], ["ring_leaves", ringLeaves], ["ring_standing_max", ringStanding]]) {
  if (p[k] !== v) errs.push(`${k} here ${v}, recorded ${p[k]}`);
}

const hs = r.hired_sybil;
const mark = (ok) => (ok ? "held" : "missed");
const detail = `reliable newcomers more under ${tag} in ${nw} of ${n} seeds (rule ${min}, ${mark(c[0])}); failed legs/100 ${f2.toFixed(1)} ${tag} vs ${f1.toFixed(1)} v1 (rule: at most +${tolF}, ${mark(c[1])}); fill ${q2.toFixed(3)} vs ${q1.toFixed(3)} (rule: at most -${tolQ}, ${mark(c[2])}); ring admissions ${ringAdm} of ${ringAttempts} attempts, leaves ${ringLeaves} (${mark(c[3])}); hired sybil admitted in ${hs.admitted[arm]} of ${hs.epoch_states} states under ${tag}, ${hs.admitted.coalitions_v1} under v1; pre-registration ${sha.slice(0, 12)}..${anchor ? `, anchor tx ${anchor[0].slice(0, 10)}..${process.argv.includes("--anchor") ? "" : " (checked by --anchor)"}` : ", anchor tx missing"}`;
if (!anchor) errs.push(`no anchor tx hash below the marker in the ${tag} pre-registration`);
if (anchor && process.argv.includes("--anchor")) {
  const a = spawnSync("node", ["scripts/prereg-anchor.mjs", "check", r.prereg, anchor[0], ...(firstRun ? [firstRun] : [])], { cwd: root, encoding: "utf8", timeout: 60_000 });
  const out = (a.stdout || "").trim().split("\n").pop() ?? "";
  if (a.status === 0 && /^PASS /.test(out)) console.log(out);
  else if (a.status === 3) console.log(`SKIP  pre-registration anchor: no public testnet RPC answered (skipped; node scripts/prereg-anchor.mjs check ${r.prereg} ${anchor[0]})`);
  else errs.push(`pre-registration anchor: ${out.replace(/^(PASS|FAIL|SKIP)\s+/, "") || `exit ${a.status ?? a.signal}`}`);
}
for (const e of errs) console.log(`FAIL  ${e}`);
const ok = pass && errs.length === 0;
console.log(`${ok ? "PASS" : "FAIL"}  coalition ${tag} (committed result): ${detail}`);
process.exit(ok ? 0 : 1);
