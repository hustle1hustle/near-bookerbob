#!/usr/bin/env node
// `make judge`: the fast path, under a minute from a clean clone, Node 22 only (no cargo,
// no npm install, no keys). It checks what is committed and what is on testnet:
//   1. every testnet claim, re-derived over public RPC (scripts/verify-live.mjs)
//   2. the committed Jolt proofs' outputs equal the committed inputs' expected values, and
//      each program hash is sha256 of its committed verifier preprocessing
//   3. the JS test suites (relayer, demo mode, UCP/Shopify handler, MCP, x402, SDK)
// The deep path is `make verify` (Rust, the contract on near-sdk's mocked chain, about 40 s
// warm) and `make zk-verify` (the Jolt verifier on the committed proofs; needs the Jolt build).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const t0 = Date.now();
const root = new URL("..", import.meta.url).pathname;
let failed = 0;
const line = (ok, what, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
};

console.log("make judge: fast path (Node only; deep path: make verify, make zk-verify)\n");

// 1. testnet
// Public testnet RPC can drop a request under load: one retry, and the failures are printed.
let live = spawnSync("node", ["scripts/verify-live.mjs"], { cwd: root, encoding: "utf8", timeout: 120_000 });
if (live.status !== 0) {
  console.log("      (verify-live failed once; retrying, public RPC can be flaky)");
  console.log(live.stdout.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
  live = spawnSync("node", ["scripts/verify-live.mjs"], { cwd: root, encoding: "utf8", timeout: 120_000 });
}
const passes = (live.stdout.match(/^PASS /gm) ?? []).length;
const fails = (live.stdout.match(/^FAIL /gm) ?? []).length;
line(live.status === 0, "testnet: every claim re-derived over public RPC", `${passes} checks passed, ${fails} failed; make verify-live for the list`);
if (live.status !== 0) console.log(live.stdout.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));

// 2. committed Jolt artifacts
const hex = (a) => Buffer.from(a).toString("hex");
const zk = (g, input) => {
  const dir = `${root}zk/out/${g}`;
  if (!existsSync(`${dir}/result.json`)) return line(false, `jolt ${g}`, "no committed result");
  const r = JSON.parse(readFileSync(`${dir}/result.json`, "utf8"));
  const e = JSON.parse(readFileSync(`${root}fixtures/zk/${input}`, "utf8")).expected;
  const pp = readFileSync(`${dir}/jolt_verifier_preprocessing.dat`);
  const program = createHash("sha256").update(pp).digest("hex") === r.program_hash;
  const o = r.output;
  const out = {
    standing: () => hex(o[0]) === e.root && hex(o[1]) === e.scores_hash,
    price: () => String(o[0]) === e.price && o[1] === e.discount_bps && hex(o[2]) === e.input_hash,
    referee: () => o[0] === e.receipt && hex(o[1]) === e.input_hash,
    cohort: () => hex(o[0]) === e.root && o[1] === e.k,
  }[g.split("-")[0]]();
  const proof = existsSync(`${dir}/proof.bin`) ? readFileSync(`${dir}/proof.bin`).length : 0;
  line(program && out && proof === r.proof_bytes, `jolt ${g}: committed output equals the input's expected value, program hash = sha256(preprocessing)`, `proved in ${r.prove_seconds.toFixed(2)} s, proof ${proof} B`);
};
for (const [g, input] of [["standing", "standing-input.json"], ["standing-testnet", "standing-testnet-input.json"], ["standing-testnet-2", "standing-testnet-2-input.json"], ["price", "price-input.json"], ["referee", "referee-input.json"], ["cohort", "cohort-input.json"]]) zk(g, input);

// 3. JS suites
const suites = ["ucp/test/near-usdc.test.mjs", "mcp/rep-read.test.mjs", "x402/verdict-read.test.mjs", "sdk/merchant.test.mjs", "scripts/jmpr-rates-to-merchants.test.mjs", "scripts/demo-live.test.mjs", "scripts/demo-tester.test.mjs", "scripts/join-merchant.test.mjs", "relayer/relay.test.mjs", "relayer/near.test.mjs"].filter((f) => existsSync(root + f));
const t = spawnSync("node", ["--test", ...suites], { cwd: root, encoding: "utf8", timeout: 60_000 });
const pass = Number(t.stdout.match(/^# pass (\d+)/m)?.[1] ?? 0);
const fail = Number(t.stdout.match(/^# fail (\d+)/m)?.[1] ?? 1);
line(t.status === 0 && fail === 0, `JS suites: relayer, demo mode, UCP and Shopify handler, MCP, x402, SDK`, `${pass} tests passed, ${fail} failed`);

const s = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${failed ? "FAIL" : "PASS"}  make judge in ${s} s${failed ? `: ${failed} failed` : ""}. Deeper: make verify (Rust, contract on near-sdk's mocked chain), make zk-verify (Jolt verifier).`);
process.exit(failed ? 1 : 0);
