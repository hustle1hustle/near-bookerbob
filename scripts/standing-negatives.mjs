#!/usr/bin/env node
// Proven standing refuses a forged graph. The committed Jolt proof of the live testnet graph
// (zk/out/standing-live: 10 events, 6 hire edges and 4 attested seeds, finalized on chain) is verified
// with the committed prebuilt verifier, then against inputs and claims changed one at a time.
// Each change must fail. Offline, no keys, about 1 s.
//
//   node scripts/standing-negatives.mjs
//
// Exit 0: the true graph verifies and every change is refused. Exit 3: no prebuilt verifier for
// this platform (a clean SKIP, as in scripts/zk-verify-prebuilt.sh). Anything else: a failure.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "zk/out/standing-live");
const INPUT = join(ROOT, "fixtures/zk/standing-live-input.json");
const target = { "darwin-arm64": "aarch64-apple-darwin", "linux-x64": "x86_64-unknown-linux-gnu" }[`${process.platform}-${process.arch}`];

// Event bytes, as graph/src/lib.rs encodes them: tag 1 = Hire {agent, sub}, tag 2 = Seed
// {merchant, ratings u64, sum u64}; strings are u32 little-endian length then bytes.
const str = (s) => { const b = Buffer.from(s); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return [...n, ...b]; };
const u64 = (x) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(x)); return [...b]; };
export const hire = (a, b) => [1, ...str(a), ...str(b)];
export const seed = (m, ratings, sum) => [2, ...str(m), ...u64(ratings), ...u64(sum)];

export const CASES = [
  ["a hire edge outside the proven log (m09 hires m01)", (i) => { i.events.push(hire("m09.bookerbob.testnet", "m01.bookerbob.testnet")); }],
  ["a sybil ring added (s1 to s3 hire each other, no attested seed)", (i) => { i.events.push(hire("s1.sybil.testnet", "s2.sybil.testnet"), hire("s2.sybil.testnet", "s3.sybil.testnet"), hire("s3.sybil.testnet", "s1.sybil.testnet")); }],
  ["a seed's weight changed (m01's 6 ratings claimed as 60)", (i) => { const e = i.events.findIndex((x) => x[0] === 2); const s = Buffer.from(i.events[e]); s.writeBigUInt64LE(60n, s.length - 16); i.events[e] = [...s]; }],
  ["a hire edge dropped (the m01 to m02 edge removed)", (i) => { i.events.shift(); }],
  ["two events swapped (the hash chain's order)", (i) => { [i.events[0], i.events[1]] = [i.events[1], i.events[0]]; }],
];
export const CLAIMS = [
  // The output is (graph root, scores hash), two 32-byte arrays.
  ["a claimed graph root changed by one byte", (o) => { o[0][0] ^= 1; }],
  ["a claimed scores hash changed by one byte", (o) => { o[1][31] ^= 1; }],
];

function verifier() {
  if (!target) return null;
  const bin = join(ROOT, `zk/bin/bookerbob-zk-${target}`);
  if (!existsSync(bin)) {
    const z = spawnSync("sh", [join(ROOT, "scripts/zk-verify-prebuilt.sh")], { encoding: "utf8" });
    if (z.status !== 0 || !existsSync(bin)) return null;
  }
  return bin;
}

const verify = (bin, input, out) => spawnSync(bin, ["verify", "standing", input, out], { encoding: "utf8" });
// A refusal counts only when the verifier ran: the program hash line passes and the Jolt proof
// line fails. A panic, a parse error or a missing file is a failure of this check, not a refusal.
export const refusedByJolt = (r) => /^PASS  standing: program hash/m.test(r.stdout) && /^FAIL  standing: Jolt proof verifies/m.test(r.stdout) && !/panicked/.test(r.stderr);
export const accepted = (r) => r.status === 0 && /^PASS  standing: Jolt proof verifies/m.test(r.stdout) && /^PASS  standing: the native run/m.test(r.stdout);

if (import.meta.url === `file://${process.argv[1]}`) {
  const bin = verifier();
  if (!bin) {
    // The two shipped targets must be present; only another platform is a skip.
    if (target) { console.log(`FAIL  standing-negatives: the shipped verifier for ${target} did not set up`); process.exit(1); }
    console.log(`SKIP  standing-negatives: no prebuilt Jolt verifier for ${process.platform} ${process.arch}`); process.exit(3);
  }
  const tmp = mkdtempSync(join(tmpdir(), "standing-neg-"));
  const results = [];
  try {
    const input = JSON.parse(readFileSync(INPUT, "utf8"));
    const output = JSON.parse(readFileSync(join(OUT, "result.json"), "utf8")).output;
    const hex = (a) => Buffer.from(a).toString("hex");
    // The input the proof is checked against is the event log whose root the proof outputs; that
    // root is the one the bazaar finalized (verify-live and standing.html read it on chain).
    results.push([input.expected.root === hex(output[0]) && input.expected.scores_hash === hex(output[1]), `the committed input's expected root and standing hash are the proof's output (${hex(output[0]).slice(0, 12)}..)`]);
    const base = verify(bin, INPUT, OUT);
    results.push([accepted(base), `the proof binds this event log and its output: it verifies`]);
    for (const [name, change] of CASES) {
      const i = JSON.parse(readFileSync(INPUT, "utf8"));
      change(i);
      const f = join(tmp, "input.json");
      writeFileSync(f, JSON.stringify(i));
      results.push([refusedByJolt(verify(bin, f, OUT)), `refused by the Jolt verifier: ${name}`]);
    }
    for (const [name, change] of CLAIMS) {
      const o = join(tmp, "out");
      rmSync(o, { recursive: true, force: true });
      cpSync(OUT, o, { recursive: true });
      const r = JSON.parse(readFileSync(join(o, "result.json"), "utf8"));
      change(r.output);
      writeFileSync(join(o, "result.json"), JSON.stringify(r));
      results.push([refusedByJolt(verify(bin, INPUT, o)), `refused by the Jolt verifier: ${name}`]);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  for (const [ok, t] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${t}`);
  const bad = results.filter(([ok]) => !ok).length;
  const changes = CASES.length + CLAIMS.length;
  const refused = results.filter(([ok, t]) => ok && t.startsWith("refused")).length;
  console.log(`${bad ? "FAIL" : "PASS"}  standing-negatives: the proof binds the event log and its output, and ${refused} of ${changes} changes are refused by the Jolt verifier`);
  process.exit(bad ? 1 : 0);
}
