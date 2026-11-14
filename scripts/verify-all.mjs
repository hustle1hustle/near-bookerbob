#!/usr/bin/env node
// `make verify-all`: every keyless check of BookerBob in one run, for a judge. No keys, no build:
// each check re-reads public mainnet or testnet RPC (and OutLayer's public attestation API) and
// re-derives one claim. A check whose network is unreachable falls back to the committed
// snapshot where one exists, and says FIXTURE. Writes agents/verify.json, which agents/verify.html
// shows next to its own live reads.
//
//   make verify-all              everything, about 10 to 25 minutes (verify-live reads old testnet
//                                txs from a rate-limited public archive)
//   QUICK=1 make verify-all      skip the full testnet sweep (verify-live), about 3 minutes
//   ONLY=<script> make verify-all   rerun the checks whose command names <script>; the other results
//                                in agents/verify.json are kept, each result carries its own ran_at
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const QUICK = process.env.QUICK === "1";
const ONLY = process.env.ONLY ?? "";
const NETERR = /fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|429|Too Many Requests|timed out|socket hang up|unreachable|RPC kept failing/i;

// [section, what it shows, command, script it needs (absent: listed as not in this tree), fixture fallback env]
const CHECKS = [
  ["mainnet", "the bazaar's code and sealed round, the USDC purchase under a NEAR AI verdict, the refused real-data discount, the NEAR Intents settlement, the model's TDX quote verified on chain (DCAP) and its key registered against it, the OutLayer referee, the open round mainnet-open-1 and the Jolt verifier on mainnet", ["node", "scripts/mainnet-check.mjs"], "scripts/mainnet-check.mjs"],
  ["mainnet", "the OutLayer referee on outlayer.near: project, TEE key registered on the mainnet bazaar, one purchase settled under its receipt", ["node", "scripts/mainnet-outlayer.mjs", "check"], "scripts/mainnet-outlayer.mjs"],
  ["both", "OutLayer TDX attestation of five runs (the referee's purchase, cheat and dispute and the Jolt verifier on testnet; the referee purchase on mainnet): record = tx, task hash = the quote's report_data, the quote verified by our DCAP verifier, measurements approved on chain", ["node", "scripts/outlayer-attest.mjs", "verify"], "scripts/outlayer-attest.mjs"],
  ["testnet", "the OutLayer referee: a purchase settled under its signed receipt, a cheat refused and its settle blocked", ["node", "scripts/outlayer-buy.mjs", "verify"], "scripts/outlayer-buy.mjs"],
  ["testnet", "the Jolt verifier on OutLayer: the standing proof behind the bazaar's root, signed accept; a forged proof, signed reject; a registry admits only the accept", ["node", "scripts/outlayer-jolt.mjs", "verify"], "scripts/outlayer-jolt.mjs"],
  ["testnet", "standing v2 as history: set through the timelock, set back to v1, and the bazaar on v1 today", ["node", "scripts/standing-v2.mjs", "verify"], "scripts/standing-v2.mjs"],
  ["testnet", "the coalition jobs on testnet", ["node", "scripts/coalition-live.mjs", "verify"], "scripts/coalition-live.mjs"],
  ["testnet", "the transparency anchor", ["node", "scripts/anchor.mjs", "verify"], "scripts/anchor.mjs"],
  ["testnet", "the locked on-chain Jolt verifier: the standing proof verified over 8 txs, every recorded job bound to its proof, claim and code", ["node", "scripts/jolt-onchain-check.mjs"], "scripts/jolt-onchain-check.mjs"],
  ["testnet", "keyless contracts: the testnet bazaar, the on-chain Jolt verifier, coalition v4, the DCAP verifier and the market bazaar hold no access key, each lock tx a DeleteKey on itself", ["node", "scripts/keyless-check.mjs"], "scripts/keyless-check.mjs"],
  ["testnet", "coalition version 4: a member admitted on a Jolt proof the locked verifier checked, one with a proof of another graph refused", ["node", "scripts/coalition-jolt-check.mjs"], "scripts/coalition-jolt-check.mjs"],
  ["testnet", "the Jolt smith: every registered program's proof, authorship and registry entry, the registry and job C re-read", ["node", "scripts/smith-check.mjs", "--live"], "scripts/smith-check.mjs"],
  ["testnet", "the economy anchor: every hourly root recomputed from the source contracts' txs and compared with the anchor", ["node", "scripts/econ/anchor.mjs", "check"], "scripts/econ/anchor.mjs"],
  ["mainnet", "the economy anchor's mainnet copy, the same records under the implicit account", ["env", "ECON_ANCHOR=a145dcce5119739380e74b3295098a2ae040e1ce4679efb4a7046420cee23474", "ECON_POSTER=a145dcce5119739380e74b3295098a2ae040e1ce4679efb4a7046420cee23474", "ECON_ANCHOR_RPC=https://rpc.mainnet.fastnear.com", "ECON_ANCHOR_INDEXER=https://tx.main.fastnear.com", "ECON_OUT=fixtures/mainnet/econ", "node", "scripts/econ/anchor.mjs", "check"], "scripts/econ/anchor.mjs"],
  ["testnet", "every other testnet claim in the manifest (purchases, rounds, reviews, standing, gates)", ["node", "scripts/verify-live.mjs"], "scripts/verify-live.mjs", { SNAPSHOT_REPLAY: "1" }],
  ["offline", "the committed Jolt proofs, with the committed prebuilt verifier", ["sh", "scripts/zk-verify-prebuilt.sh"], "scripts/zk-verify-prebuilt.sh"],
  ["offline", "tacit collusion, measured: the pre-registered run's prices, TEE signatures and fallback prices re-checked", ["node", "scripts/collusion.mjs", "check"], "scripts/collusion.mjs"],
];

const results = [];
const kept = ONLY && existsSync("agents/verify.json") ? JSON.parse(readFileSync("agents/verify.json", "utf8")).results ?? [] : [];
const t0 = Date.now();
for (const [section, what, cmd, needs, fixtureEnv] of CHECKS) {
  if (ONLY && !cmd.join(" ").includes(ONLY)) {
    const k = kept.find((x) => x.command === cmd.join(" "));
    if (k) results.push(k);
    continue;
  }
  if (!existsSync(needs)) {
    results.push({ section, what, command: cmd.join(" "), mode: "absent", ok: null, line: `${needs} is not in this tree` });
    console.log(`----  ${section}: ${what}\n      not in this tree (${needs})`);
    continue;
  }
  if (QUICK && needs === "scripts/verify-live.mjs") {
    results.push({ section, what, command: cmd.join(" "), mode: "skipped", ok: null, line: "QUICK=1: skipped" });
    console.log(`----  ${section}: ${what}\n      skipped (QUICK=1)`);
    continue;
  }
  const t = Date.now();
  // The full testnet sweep reads old txs from a rate-limited public archive; it has 20 minutes.
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", timeout: (fixtureEnv ? 20 : 30) * 60_000, maxBuffer: 64 << 20 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const timedOut = r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM";
  const lines = out.split("\n").filter((l) => /^(PASS|FAIL|SKIP)/.test(l));
  const pass = lines.filter((l) => l.startsWith("PASS")).length;
  // The summary line of a sweep ("FAIL  verify-live: N checks failed") is not a check of its own.
  const fail = lines.filter((l) => l.startsWith("FAIL") && !/^FAIL\s+verify-live:/.test(l)).map((l) => l.slice(0, 240));
  let mode = "live";
  let ok = r.status === 0 && !timedOut ? true : false;
  // mainnet-check alone exits 3 when public RPC is unreachable: a SKIP, not a failure.
  if (needs === "scripts/mainnet-check.mjs" && r.status === 3) {
    ok = null;
    mode = "unreachable";
  }
  // The snapshot may stand in for a live run only when nothing real failed: every live FAIL is a
  // network error, or the run timed out with no FAIL so far. A real live FAIL stays a FAIL; the
  // replay is then kept beside it, for information.
  let replay = null;
  const netOnly = fail.length > 0 && fail.every((l) => NETERR.test(l));
  const unreachable = fail.length === 0 && r.status !== 0 && !timedOut && NETERR.test(out);
  if (ok === false && fixtureEnv) {
    const rr = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 64 << 20, env: { ...process.env, ...fixtureEnv } });
    const rl = `${rr.stdout ?? ""}${rr.stderr ?? ""}`.split("\n").filter((l) => /^(PASS|FAIL)/.test(l));
    replay = { ok: rr.status === 0, pass: rl.filter((l) => l.startsWith("PASS")).length, fail: rl.filter((l) => l.startsWith("FAIL") && !/^FAIL\s+verify-live:/.test(l)).length };
    if ((timedOut && fail.length === 0) || netOnly || unreachable) {
      mode = "fixture";
      ok = replay.ok;
      console.log(`      ${timedOut ? "the live run timed out" : "public RPC unreachable"} after ${Math.round((Date.now() - t) / 1000)} s with no real FAIL: the committed snapshot stands in`);
    }
  }
  if (ok === false && !fixtureEnv && (netOnly || unreachable)) {
    ok = null;
    mode = "unreachable";
  }
  const last = lines.at(-1) ?? out.trim().split("\n").at(-1) ?? "";
  results.push({ section, what, command: cmd.join(" "), ran_at: new Date().toISOString(), mode, ok, live_pass: pass, live_fail: fail, timed_out: timedOut, replay, seconds: Math.round((Date.now() - t) / 1000), line: last.slice(0, 240) });
  const tag = ok === true ? "PASS" : ok === null ? "SKIP" : "FAIL";
  console.log(`${tag}  ${section}: ${what}${mode === "fixture" ? "  [FIXTURE: the live run timed out or public RPC was unreachable; the committed snapshot]" : ""}\n      ${cmd.join(" ")}: live ${pass} PASS${fail.length ? `, ${fail.length} FAIL` : ""}${timedOut ? ", timed out" : ""}${replay ? `; snapshot replay ${replay.pass} PASS, ${replay.fail} FAIL` : ""}, ${Math.round((Date.now() - t) / 1000)} s`);
  for (const f of fail) console.log(`      ${f}`);
}
const failed = results.filter((x) => x.ok === false).length;
writeFileSync("agents/verify.json", JSON.stringify({ ran_at: new Date().toISOString(), only: ONLY || undefined, seconds: Math.round((Date.now() - t0) / 1000), quick: QUICK, results }, null, 2) + "\n");
const live = results.filter((x) => x.ok === true && x.mode === "live").length;
const fixture = results.filter((x) => x.ok === true && x.mode === "fixture").length;
console.log(`\n${failed ? "FAIL" : "PASS"}  verify-all: ${live} passed live, ${fixture} passed from the snapshot (FIXTURE), ${failed} failed, ${results.filter((x) => x.ok === null).length} not run (absent, skipped or unreachable); written to agents/verify.json`);
process.exit(failed ? 1 : 0);
