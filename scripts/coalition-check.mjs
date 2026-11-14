#!/usr/bin/env node
// Node-only check of the committed coalition result (for `make judge`, no cargo):
//   1. the pre-registration's sha256 (up to its marker line) equals the one the run recorded
//   2. every seed's totals equal the sum of its epochs (per-epoch Stats are the rawest records)
//   3. `overall` and `per_epoch` (the doc table and the chart) recompute from the seeds, and so
//      do the exploratory blocks
//   4. the pre-registered pass rule, re-applied here to the per-seed numbers
//   5. with --anchor: the anchor tx's memo is the pre-registration's sha256, over public testnet
//      RPC (scripts/prereg-anchor.mjs check). Exit 3 from it (no RPC answered) is a SKIP; any
//      other failure is a FAIL. Without --anchor the tx is only named, unchecked.
// The exploratory arms are printed with NOTE and never change the verdict.
// `make coalition-check` is the deep path: it re-runs the Rust simulation and compares bytes.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const MARKER = "<!-- anchored above this line -->";
const r = JSON.parse(readFileSync(`${root}fixtures/coalition/result.json`, "utf8"));
const doc = readFileSync(`${root}${r.prereg}`, "utf8");
const errs = [];

const sha = createHash("sha256").update(doc.split(MARKER)[0]).digest("hex");
if (sha !== r.prereg_sha256) errs.push(`pre-registration sha256 ${sha.slice(0, 12)}.. differs from the run's ${String(r.prereg_sha256).slice(0, 12)}..`);
const anchor = (doc.split(MARKER)[1] ?? "").match(/\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/);

const KEYS = ["jobs", "unserved", "filled", "failed_bundles", "no_show_legs", "paid_filled", "paid_failed", "slashed", "legs_to_sybils", "admitted", "unreliable_admitted", "sybil_attempts", "sybil_admissions"];
const fill = (t) => t.filled / Math.max(t.jobs, 1);
const failed = (t) => (100 * t.no_show_legs) / Math.max(t.jobs - t.unserved, 1);
const price = (t) => t.paid_filled / Math.max(t.filled, 1) / 1e6;
const loss = (t) => ((t.paid_failed - t.slashed) / 1e6 * 100) / Math.max(t.jobs, 1);
const sum = (epochs) => {
  const t = Object.fromEntries(KEYS.map((k) => [k, epochs.reduce((x, e) => x + e[k], 0)]));
  t.sybil_standing_max = Math.max(0, ...epochs.map((e) => e.sybil_standing_max));
  return t;
};
// Rust's f64::round is half away from zero; r4 matches it.
const r4 = (x) => (Math.sign(x) * Math.round(Math.abs(x) * 10_000)) / 10_000;
const spread = (xs) => {
  const n = xs.length, mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) * (x - mean), 0) / Math.max(n - 1, 1));
  return { mean: r4(mean), sd: r4(sd), min: r4(Math.min(...xs)), max: r4(Math.max(...xs)) };
};
const near = (a, b) => Object.keys(b).every((k) => Math.abs(a[k] - b[k]) < 1e-9);
const overallOf = (totals) => ({
  fill_rate: spread(totals.map(fill)), failed_legs_per_100: spread(totals.map(failed)), price_per_filled: spread(totals.map(price)),
  loss_per_100: spread(totals.map(loss)), unserved_per_100: spread(totals.map((t) => (100 * t.unserved) / t.jobs)),
});
const epochRows = (runs) => runs[0].map((_, e) => {
  const ss = runs.map((x) => x[e]);
  return {
    fill_rate: spread(ss.map(fill)), failed_legs_per_100: spread(ss.map(failed)), price_per_filled: spread(ss.filter((s) => s.filled > 0).map(price)),
    loss_per_100: spread(ss.map(loss)), unserved: spread(ss.map((s) => s.unserved)), admitted: spread(ss.map((s) => s.admitted)), unreliable_admitted: spread(ss.map((s) => s.unreliable_admitted)),
  };
});
const sameBlock = (what, got, want) => {
  for (const [k, v] of Object.entries(want)) if (!got[k] || !near(got[k], v)) errs.push(`${what} ${k} does not recompute from the seeds`);
};

let fillWins = 0, failWins = 0, lossWins = 0, sybilAdm = 0, sybilStanding = 0, attempts = 0;
const totals = { singles: [], singles_clean: [], coalitions: [] };
for (const s of r.seeds) {
  for (const [arm, a] of Object.entries(s.arms)) {
    const t = sum(a.epochs);
    for (const k of [...KEYS, "sybil_standing_max"]) if (t[k] !== a.total[k]) errs.push(`seed ${s.seed} ${arm} ${k}: epochs give ${t[k]}, total ${a.total[k]}`);
    totals[arm].push(a.total);
  }
  if (s.ledger_sum !== "0") errs.push(`seed ${s.seed}: coalition money not conserved (${s.ledger_sum})`);
  const c = s.arms.coalitions.total, q = s.arms.singles_clean.total;
  fillWins += fill(c) > fill(q);
  failWins += failed(c) < failed(q);
  lossWins += loss(c) < loss(q);
  sybilAdm += c.sybil_admissions;
  attempts += c.sybil_attempts;
  sybilStanding = Math.max(sybilStanding, c.sybil_standing_max);
}
for (const arm of Object.keys(totals)) {
  sameBlock(`overall.${arm}`, r.overall[arm], overallOf(totals[arm]));
  epochRows(r.seeds.map((s) => s.arms[arm].epochs)).forEach((row, e) => sameBlock(`per_epoch.${arm}[${e}]`, r.per_epoch[arm][e], row));
}
const n = r.seeds.length, min = r.pass_rule.min_seeds;
const pass = fillWins >= min && failWins >= min && lossWins >= min && sybilAdm === 0 && sybilStanding === 0;
if (pass !== r.pass_rule.pass) errs.push(`pass rule here ${pass}, recorded ${r.pass_rule.pass}`);
for (const [k, v] of [["fill_wins", fillWins], ["failed_leg_wins", failWins], ["loss_wins", lossWins], ["sybil_admissions", sybilAdm], ["sybil_standing_max", sybilStanding]]) {
  if (r.pass_rule[k] !== v) errs.push(`${k} here ${v}, recorded ${r.pass_rule[k]}`);
}

// Exploratory blocks: recomputed for integrity, printed as NOTE, outside the verdict.
const x = r.exploratory;
if (x?.label !== "exploratory, beyond the pre-registration") errs.push("the exploratory block is missing its label");
else {
  for (const s of x.seeds) {
    const t = sum(s.singles_filtered.epochs);
    for (const k of KEYS) if (t[k] !== s.singles_filtered.total[k]) errs.push(`seed ${s.seed} singles_filtered ${k}: epochs give ${t[k]}, total ${s.singles_filtered.total[k]}`);
  }
  sameBlock("exploratory singles_filtered overall", x.singles_filtered.overall, overallOf(x.seeds.map((s) => s.singles_filtered.total)));
  epochRows(x.seeds.map((s) => s.singles_filtered.epochs)).forEach((row, e) => sameBlock(`exploratory singles_filtered per_epoch[${e}]`, x.singles_filtered.per_epoch[e], row));
  for (const arm of Object.keys(x.close_bands.overall)) sameBlock(`exploratory close_bands ${arm}`, x.close_bands.overall[arm], overallOf(x.seeds.map((s) => s.close_bands[arm])));
  const coal = totals.coalitions, clean = totals.singles_clean;
  const per100 = (f) => coal.reduce((a, t) => a + (f(t) / 1e6 * 100) / t.jobs, 0) / coal.length;
  const gap = clean.reduce((a, t) => a + loss(t), 0) / clean.length - (per100((t) => t.paid_failed) - per100((t) => t.slashed));
  if (Math.abs(r4(per100((t) => t.slashed) / gap) - x.loss_decomposition.slashed_share_of_gap) > 1e-9) errs.push("exploratory loss decomposition does not recompute");
  const fw = x.seeds.filter((s, i) => fill(coal[i]) > fill(s.singles_filtered.total)).length;
  if (fw !== x.singles_filtered.coalitions_vs_singles_filtered.fill_wins) errs.push("exploratory coalitions_vs_singles_filtered does not recompute");
}

const m = (arm, k) => r.overall[arm][k].mean;
const states = n * r.params.epochs;
const sybils = r.params.sybils_per_category * r.params.categories.length;
const types = attempts / (states * sybils);
if (!Number.isInteger(types)) errs.push(`sybil attempts ${attempts} are not a whole number of forgery types over ${states} states and ${sybils} sybils`);
const firstRun = ((doc.split(MARKER)[1] ?? "").match(/first run at (\d{4}-\d\d-\d\dT[\d:.]+Z)/) ?? [])[1];
const detail = `fill ${m("coalitions", "fill_rate").toFixed(3)} vs ${m("singles_clean", "fill_rate").toFixed(3)} singles, failed legs/100 ${m("coalitions", "failed_legs_per_100").toFixed(1)} vs ${m("singles_clean", "failed_legs_per_100").toFixed(1)}, wins ${fillWins}/${failWins}/${lossWins} of ${n} seeds (rule: ${min}), sybil admissions ${sybilAdm} for ${types} forgery types in all ${states} epoch states; pre-registration ${sha.slice(0, 12)}..${anchor ? `, anchor tx named in it ${anchor[0].slice(0, 10)}..${process.argv.includes("--anchor") ? "" : " (checked by --anchor)"}` : ", anchor tx missing"}`;
if (!anchor) errs.push("no anchor tx hash below the marker in the pre-registration");
if (anchor && process.argv.includes("--anchor")) {
  const a = spawnSync("node", ["scripts/prereg-anchor.mjs", "check", r.prereg, anchor[0], ...(firstRun ? [firstRun] : [])], { cwd: root, encoding: "utf8", timeout: 60_000 });
  const out = (a.stdout || "").trim().split("\n").pop() ?? "";
  if (a.status === 0 && /^PASS /.test(out)) console.log(out);
  else if (a.status === 3) console.log(`SKIP  pre-registration anchor: no public testnet RPC answered (skipped; node scripts/prereg-anchor.mjs check ${r.prereg} ${anchor[0]})`);
  else errs.push(`pre-registration anchor: ${out.replace(/^(PASS|FAIL|SKIP)\s+/, "") || `exit ${a.status ?? a.signal}`}`);
}
// --rerun <fresh.json>: the deep path. `make coalition-check` writes a fresh run with
// `coalition-sim --out <tmp>` and hands it here. Everything must equal the committed file except
// code_sha256: the sim file's sha must equal the recorded one, and Cargo.lock's is informational.
// Reason: standing-v2 was added to the workspace after the registered run, which changed
// Cargo.lock; the numbers re-run byte-identical.
const ri = process.argv.indexOf("--rerun");
if (ri > 0) {
  const fresh = JSON.parse(readFileSync(process.argv[ri + 1], "utf8"));
  const strip = (o) => { const c = { ...o }; delete c.code_sha256; return JSON.stringify(c); };
  const SIM = "cli/src/coalition_sim.rs";
  if (strip(fresh) !== strip(r)) errs.push("a re-run differs from fixtures/coalition/result.json outside code_sha256 (run `make coalition`)");
  else if (fresh.code_sha256?.files?.[SIM] !== r.code_sha256?.files?.[SIM]) errs.push(`${SIM} sha256 differs from the one the registered run recorded`);
  else {
    const lock = (x) => x.code_sha256?.files?.["Cargo.lock"];
    console.log(`PASS  coalition re-run: every number equals the committed result; ${SIM} sha256 ${String(lock(r) ? r.code_sha256.files[SIM] : "").slice(0, 12)}.. as recorded${lock(fresh) === lock(r) ? "" : `; NOTE Cargo.lock sha256 ${String(lock(fresh)).slice(0, 12)}.. differs from the recorded ${String(lock(r)).slice(0, 12)}.. (informational: standing-v2 joined the workspace after the registered run)`}`);
  }
}
for (const e of errs) console.log(`FAIL  ${e}`);
const ok = pass && errs.length === 0;
console.log(`${ok ? "PASS" : "FAIL"}  coalition (committed result): ${detail}`);
if (x?.singles_filtered) {
  const f = x.singles_filtered, c = x.close_bands;
  console.log(`NOTE  coalition, ${x.label}: singles_filtered fills ${f.overall.fill_rate.mean.toFixed(3)} against ${m("coalitions", "fill_rate").toFixed(3)} for coalitions (coalitions fill more in ${f.coalitions_vs_singles_filtered.fill_wins} of ${n} seeds), so the fill gain is the standing filter; slashed bonds return ${Math.round(100 * x.loss_decomposition.slashed_share_of_gap)}% of the net-loss gap; with unreliable agents at 80% to 90%, coalitions fill ${c.overall.coalitions.fill_rate.mean.toFixed(3)} against ${c.overall.singles_clean.fill_rate.mean.toFixed(3)} for singles (wins ${c.coalitions_vs_singles_clean.fill_wins}/${c.coalitions_vs_singles_clean.failed_leg_wins}/${c.coalitions_vs_singles_clean.loss_wins})`);
}
process.exit(ok ? 0 : 1);
