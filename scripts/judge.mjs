#!/usr/bin/env node
// `make judge`: the fast path, about a minute from a clean clone (the public RPC rate-limits), Node 22 only (no cargo,
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
// No network (a sandboxed judge): SKIP the live checks, replay the committed RPC snapshot,
// and check the snapshot's sha256. With network: the live checks, one retry for flaky RPC.
// JUDGE_OFFLINE=1 forces the snapshot path (to test it); otherwise a 6 s probe decides.
const online = process.env.JUDGE_OFFLINE !== "1" && await fetch(process.env.NEAR_RPC || "https://test.rpc.fastnear.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }), signal: AbortSignal.timeout(6000) }).then(() => true, () => false); // any HTTP answer, even a 429, means there is a network
if (!online) {
  const snapFile = `${root}fixtures/live/rpc-snapshot/snapshot.json`;
  const want = readFileSync(`${root}fixtures/live/rpc-snapshot/SHA256`, "utf8").split(" ")[0];
  const got = createHash("sha256").update(readFileSync(snapFile)).digest("hex");
  console.log("SKIP  testnet: no network here, so the live RPC checks are skipped (not failed)");
  line(got === want, "testnet snapshot: committed RPC responses match their sha256", `${got.slice(0, 12)}..`);
  const rep = spawnSync("node", ["scripts/verify-live.mjs"], { cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, SNAPSHOT_REPLAY: "1" } });
  const taken = JSON.parse(readFileSync(snapFile, "utf8")).taken_at;
  line(rep.status === 0, `testnet snapshot: every claim re-derived from the snapshot taken ${taken}`, `${(rep.stdout.match(/^PASS /gm) ?? []).length} checks; rerun with network for the live chain`);
}
// Public testnet RPC can drop a request under load: one retry, and the failures are printed.
let live = online ? spawnSync("node", ["scripts/verify-live.mjs"], { cwd: root, encoding: "utf8", timeout: 240_000 }) : { status: 0, stdout: "" };
if (live.status !== 0) {
  console.log("      (verify-live failed once; retrying, public RPC can be flaky)");
  console.log(live.stdout.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
  live = spawnSync("node", ["scripts/verify-live.mjs"], { cwd: root, encoding: "utf8", timeout: 240_000 });
}
const passes = (live.stdout.match(/^PASS /gm) ?? []).length;
const fails = (live.stdout.match(/^FAIL /gm) ?? []).length;
if (online) line(live.status === 0, "testnet: every claim re-derived over public RPC", `${passes} checks passed, ${fails} failed; make verify-live for the list`);
if (live.status !== 0) console.log(live.stdout.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));

// 1b. the README's status table is generated from docs/status.json and every live row has
// testnet evidence; a stale phrase anywhere in the docs fails here.
const stat = spawnSync("node", ["scripts/status.mjs", "--check"], { cwd: root, encoding: "utf8" });
line(stat.status === 0, "docs: README status table = docs/status.json, live rows backed by the testnet manifest, no stale phrase", stat.status === 0 ? "" : stat.stdout.trim().split("\n").slice(0, 3).join("; "));

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
const suites = ["ucp/test/near-usdc.test.mjs", "mcp/rep-read.test.mjs", "x402/verdict-read.test.mjs", "sdk/merchant.test.mjs", "scripts/jmpr-rates-to-merchants.test.mjs", "scripts/demo-live.test.mjs", "scripts/demo-tester.test.mjs", "scripts/join-merchant.test.mjs", "relayer/relay.test.mjs", "relayer/near.test.mjs", "relayer/serve.test.mjs", "scripts/mainnet-moment.test.mjs", "scripts/device-run.test.mjs", "scripts/eval-run.test.mjs", "scripts/status.test.mjs", "sdk/buy.test.mjs"].filter((f) => existsSync(root + f));
const { NEAR_RPC: _ignored, ...suiteEnv } = process.env;
const t = spawnSync("node", ["--test", ...suites], { cwd: root, encoding: "utf8", timeout: 60_000, env: suiteEnv });
const pass = Number(t.stdout.match(/^# pass (\d+)/m)?.[1] ?? 0);
const fail = Number(t.stdout.match(/^# fail (\d+)/m)?.[1] ?? 1);
line(t.status === 0 && fail === 0, `JS suites: relayer, demo mode, UCP and Shopify handler, MCP, x402, SDK`, `${pass} tests passed, ${fail} failed`);

const s = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${failed ? "FAIL" : "PASS"}  make judge in ${s} s${failed ? `: ${failed} failed` : ""}. Deeper: make verify (Rust, contract on near-sdk's mocked chain), make zk-verify (Jolt verifier).`);
process.exit(failed ? 1 : 0);
