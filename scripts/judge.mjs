#!/usr/bin/env node
// `make judge`: the fast path, about 25 s on a warm laptop, Node 22 only (no cargo, no npm install,
// no keys, no network). It checks what is committed:
//   1. every testnet claim, re-derived from the committed RPC snapshot (scripts/verify-live.mjs
//      with SNAPSHOT_REPLAY=1). `JUDGE_LIVE=1 make judge` re-derives them over public RPC
//      instead: 5 to 20 minutes, because old txs come from a rate-limited public archive.
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

console.log("make judge: fast path (Node and the committed Jolt verifier; deep path: make verify, make zk-verify)\n");

// 1. testnet
// Default: offline. Replay the committed RPC snapshot and check its sha256, so the first
// command finishes in any shell. JUDGE_LIVE=1 asks for the live chain: a 6 s probe decides
// whether there is a network, then the live checks run with one retry for flaky RPC.
// JUDGE_OFFLINE=1 still forces the snapshot path, whatever else is set.
const wantLive = process.env.JUDGE_LIVE === "1" && process.env.JUDGE_OFFLINE !== "1";
const online = wantLive && await fetch(process.env.NEAR_RPC || "https://test.rpc.fastnear.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }), signal: AbortSignal.timeout(6000) }).then(() => true, () => false); // any HTTP answer, even a 429, means there is a network
if (!online) {
  const snapFile = `${root}fixtures/live/rpc-snapshot/snapshot.json`;
  const want = readFileSync(`${root}fixtures/live/rpc-snapshot/SHA256`, "utf8").split(" ")[0];
  const got = createHash("sha256").update(readFileSync(snapFile)).digest("hex");
  console.log(wantLive
    ? "SKIP  testnet: JUDGE_LIVE=1 but no network here, so the live RPC checks are skipped (not failed)"
    : `NOTE  testnet: these checks replay a saved RPC snapshot taken ${JSON.parse(readFileSync(snapFile, "utf8")).taken_at}, not a live read of the chain (JUDGE_LIVE=1 make judge or make verify-live reads the live chain, 5 to 20 minutes)`);
  line(got === want, "testnet snapshot: committed RPC responses match their sha256", `${got.slice(0, 12)}..`);
  const rep = spawnSync("node", ["scripts/verify-live.mjs"], { cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, SNAPSHOT_REPLAY: "1" } });
  const taken = JSON.parse(readFileSync(snapFile, "utf8")).taken_at;
  line(rep.status === 0, `testnet snapshot: every claim re-derived from the snapshot taken ${taken}`, `${(rep.stdout.match(/^PASS /gm) ?? []).length} checks; JUDGE_LIVE=1 make judge or make verify-live for the live chain`);
}
// Public testnet RPC can drop a request under load: one retry, and the failures are printed.
// Too slow is not wrong: a run cut off by the limit with no FAIL is a SKIP, and only a check that
// failed is a failure. A timed-out run is not retried, the second would hit the same limit.
// 150 old txs come from a public archive at about 30 a minute: verify-live took 308 to 797 s on 2026-11-10.
const LIVE_MS = Number(process.env.JUDGE_LIVE_MS ?? 1_800_000);
const verifyLive = () => spawnSync("node", ["scripts/verify-live.mjs"], { cwd: root, encoding: "utf8", timeout: LIVE_MS });
const cut = (r) => r.error?.code === "ETIMEDOUT" && !/^FAIL /m.test(r.stdout);
let live = online ? verifyLive() : { status: 0, stdout: "" };
if (live.status !== 0 && !cut(live)) {
  console.log("      (verify-live failed once; retrying, public RPC can be flaky)");
  console.log(live.stdout.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
  live = verifyLive();
}
const passes = (live.stdout.match(/^PASS /gm) ?? []).length;
const fails = (live.stdout.match(/^FAIL /gm) ?? []).length;
if (cut(live)) console.log(`SKIP  testnet: public RPC too slow, ${passes} checks passed and 0 failed before the ${LIVE_MS / 1000} s limit (skipped, not failed; make verify-live has no limit)`);
else if (online) line(live.status === 0, "testnet: every claim re-derived over public RPC", `${passes} checks passed, ${fails} failed; make verify-live for the list`);
if (live.status !== 0 && !cut(live)) console.log(live.stdout.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));

// 1a. mainnet (JUDGE_LIVE=1 only): the keyless mainnet checks (make mainnet-check). Public
// mainnet RPC unreachable or slow is a SKIP, the same rule as the testnet block above.
if (wantLive) {
  const mc = spawnSync("node", ["scripts/mainnet-check.mjs"], { cwd: root, encoding: "utf8", timeout: 900_000 });
  const lastLine = (mc.stdout || "").trim().split("\n").pop() ?? "";
  if (mc.status === 3 || mc.error) console.log(mc.error ? "SKIP  mainnet: public RPC too slow (skipped, not failed; make mainnet-check has no limit)" : lastLine);
  else line(mc.status === 0, "mainnet: the bazaar, its round, three purchases (one under the OutLayer referee), the Intents settlement and the on-chain DCAP check re-read over public RPC", lastLine.replace(/^(PASS|FAIL)\s+/, ""));
} else console.log("SKIP  mainnet checks: offline by default (JUDGE_LIVE=1 make judge or make mainnet-check reads mainnet)");

// 1b. the README's status table is generated from docs/status.json and every live row has
// testnet evidence; a stale phrase anywhere in the docs fails here.
const mk = spawnSync("node", ["scripts/market-eval.mjs", "--check"], { cwd: root, encoding: "utf8" });
line(mk.status === 0, "make market-eval: the published table is what the code computes", mk.status === 0 ? "1,000 simulated rounds, a model with stated assumptions" : mk.stderr.trim().split("\n").pop());

// Coalitions against single agents: the pre-registered rule on the committed 20-seed result
// (docs/coalition-prereg.md, anchored on testnet before the run; make coalition-check re-runs the sim).
const co = spawnSync("node", ["scripts/coalition-check.mjs"], { cwd: root, encoding: "utf8" });
line(co.status === 0, "coalitions against single agents: the pre-registered rule holds on the committed 20-seed result (make coalition-check re-runs it)", (co.stdout.split("\n").find((l) => /^(PASS|FAIL)\s+coalition \(committed/.test(l)) ?? "no verdict line").replace(/^(PASS|FAIL)\s+coalition \(committed result\):\s*/, ""));

// Admission by the hire-edge fan-out, v2 to v4: each pre-registered, each a published FAIL. The
// line passes when the committed result recomputes and its anchor named; the verdict is shown as is.
for (const t of ["v2", "v3", "v4"]) {
  const c = spawnSync("node", [`scripts/coalition-check-${t}.mjs`], { cwd: root, encoding: "utf8" });
  const vl = c.stdout.split("\n").find((l) => new RegExp(`^(PASS|FAIL)\\s+coalition ${t} \\(committed`).test(l)) ?? "no verdict line";
  line(vl !== "no verdict line" && !/^FAIL  (pre-registration|seed|overall|pass rule|[a-z_0-9]+ here)/m.test(c.stdout), `coalition admission ${t}, pre-registered: the committed result recomputes, its verdict published as is`, vl.replace(new RegExp(`^(PASS|FAIL)\\s+coalition ${t} \\(committed result\\):\\s*`), "$1 ").slice(0, 160));
}

// The price leak per sale (L10): every bucketed merchant within its stated bound (docs/leak-amount.md).
const la = spawnSync("node", ["scripts/leak-amount.mjs"], { cwd: root, encoding: "utf8" });
line(la.status === 0, "price leak per sale (L10): bucketed schedules within their bound", (la.stdout.trim().split("\n").pop() ?? "").replace(/^(PASS|FAIL)\s+/, ""));
const forge = spawnSync("node", ["scripts/forge-poc.mjs", "verify"], { cwd: root, encoding: "utf8" });
line(forge.status === 0, "the attack the evaluator closes: the model attested a typed fact (make forge-poc), the contract refuses it unsigned", "README, Known limits");
const col = spawnSync("node", ["scripts/collusion.mjs", "check"], { cwd: root, encoding: "utf8", timeout: 120_000 });
{
  const out = col.stdout.trim().split("\n");
  const h = out.find((l) => /hypothesis/.test(l)) ?? "";
  line(col.status === 0, "make collusion-check: pre-registration anchored on testnet before the run, every TEE signature, prompt and answer re-checked, every number recomputed", col.status === 0 ? h.replace(/^(PASS|INFO)\s+/, "") : out.filter((l) => l.startsWith("FAIL")).slice(0, 2).join("; "));
}
const stat = spawnSync("node", ["scripts/status.mjs", "--check"], { cwd: root, encoding: "utf8" });
line(stat.status === 0, "docs: README status table = docs/status.json, live rows backed by the testnet manifest, no stale phrase, no live method called not deployed, set sizes equal to agents/live.json, every repeated count (purchases, settles, replays, orders, checks) equal to the manifest and the verify log", stat.status === 0 ? "" : stat.stdout.trim().split("\n").slice(0, 3).join("; "));

// 1b2. NVIDIA GPU evidence: the saved NRAS reply, its signatures and claims, offline.
if (existsSync(`${root}fixtures/live/near-ai/nras.json`)) {
  const nr = spawnSync("node", ["scripts/nras.mjs", "verify"], { cwd: root, encoding: "utf8" });
  line(nr.status === 0, "NVIDIA GPU evidence (NRAS): 8 GPU tokens and the platform verdict signed by NVIDIA, bound to the request nonce", nr.status === 0 ? (nr.stdout.trim().split("\n").pop().match(/\d+ checks/) ?? [""])[0] : nr.stdout.split("\n").filter((l) => l.startsWith("FAIL")).slice(0, 2).join("; "));
}

// 1c. REP Eval: signatures, answers hash, issuer signature and (online) the on-chain scores.
if (existsSync(`${root}fixtures/live/eval/rep-eval.json`)) {
  const ev = spawnSync("node", ["scripts/rep-eval.mjs", "verify"], { cwd: root, encoding: "utf8", env: { ...process.env, ...(online ? {} : { JUDGE_OFFLINE: "1" }) }, timeout: 120_000 });
  const rows = (ev.stdout.match(/^PASS /gm) ?? []).length;
  line(ev.status === 0, "REP Eval: 3 model certificates, every TEE signature and the issuer signature verify" + (online ? ", scores on chain match" : ""), ev.status === 0 ? `${rows} models` : ev.stdout.split("\n").filter((l) => l.startsWith("FAIL")).slice(0, 2).join("; "));
}
for (const [v, what] of [["v2", "600 tokens: the budget result"], ["v3", "2,000 tokens: the accuracy result"], ["v4", "40 harder items, 4,000 tokens"], ["v5", "120 items, 8,000 tokens, the gate on the Wilson lower bound"]]) {
  if (!existsSync(`${root}fixtures/live/eval/rep-eval-${v}.json`)) continue;
  const ev = spawnSync("node", ["scripts/rep-eval-v2.mjs", "verify"], { cwd: root, encoding: "utf8", env: { ...process.env, REP_EVAL_PROTOCOL: v, ...(online ? {} : { JUDGE_OFFLINE: "1" }) }, timeout: 120_000 });
  const rows = JSON.parse(readFileSync(`${root}fixtures/live/eval/rep-eval-${v}.json`, "utf8")).models.length;
  line(ev.status === 0, `REP Eval ${v} (referee claims, truth from the referee's code, ${what}): ${v >= "v4" ? 2 : 3} certificates, every TEE signature verifies, cut replies graded as no answer` + (online ? ", scores on chain match, set committed by its own owner" : ""), ev.status === 0 ? `${rows} models` : ev.stdout.split("\n").filter((l) => l.startsWith("FAIL")).slice(0, 2).join("; "));
}

// 1b. the code both bazaars run is the committed, tagged build (contract/DEPLOYED.json)
{
  const dep = JSON.parse(readFileSync(`${root}contract/DEPLOYED.json`, "utf8"));
  if (online) {
    // Public RPC rate-limits: retry, then a second and third endpoint. A hash we could not read
    // is a SKIP, not a FAIL; only a hash that differs is a failure.
    const rpcs = [process.env.NEAR_RPC || "https://test.rpc.fastnear.com", "https://archival-rpc.testnet.fastnear.com", "https://rpc.testnet.fastnear.com"];
    const hashOf = async (a) => {
      for (let i = 0; i < 6; i++) {
        const r = await fetch(rpcs[i % rpcs.length], { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: a } }) }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
        if (r?.result?.code_hash) return r.result.code_hash;
        await new Promise((d) => setTimeout(d, 500 * (i + 1)));
      }
      return null;
    };
    const hashes = [];
    for (const a of dep.accounts) hashes.push(await hashOf(a));
    if (hashes.some((h) => !h) && hashes.every((h) => !h || h === dep.code_hash)) console.log(`SKIP  code parity: public RPC unreachable after retries on ${rpcs.length} endpoints (DEPLOYED.json names ${dep.code_hash.slice(0, 10)}.., tag ${dep.tag})`);
    else line(hashes.every((h) => h === dep.code_hash), `code parity: ${dep.accounts.join(" and ")} run the tagged build ${dep.tag} (make wasm-parity rebuilds it)`, hashes.map((h, i) => `${dep.accounts[i].split(".")[0]} ${h?.slice(0, 10)}..`).join(", ") + `; DEPLOYED ${dep.code_hash.slice(0, 10)}..`);
  } else console.log(`SKIP  code parity: ${wantLive ? "no network" : "offline run, JUDGE_LIVE=1 reads the on-chain code hash"} (DEPLOYED.json names ${dep.code_hash.slice(0, 10)}.., tag ${dep.tag})`);
}

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
for (const [g, input] of [["standing", "standing-input.json"], ["standing-testnet", "standing-testnet-input.json"], ["standing-testnet-2", "standing-testnet-2-input.json"], ["standing-testnet-3", "standing-testnet-3-input.json"], ["standing-coalition", "standing-coalition-input.json"], ["standing-live", "standing-live-input.json"], ["price", "price-input.json"], ["referee", "referee-input.json"], ["cohort", "cohort-input.json"]]) zk(g, input);

// 2b. The Jolt proofs themselves, with the committed prebuilt verifier for this platform.
{
  const zv = spawnSync("sh", ["scripts/zk-verify-prebuilt.sh"], { cwd: root, encoding: "utf8", timeout: 300_000 });
  const last = (zv.stdout || zv.stderr || "").trim().split("\n").pop();
  if (zv.status === 3) console.log(last);
  else line(zv.status === 0, "Jolt proofs verified with the committed prebuilt verifier (sha256-checked)", last.replace(/^(PASS|FAIL)\s+/, ""));
}

// 2c. The browser proof (agents/prove.html): the wasm verifier the page ships, run here in Node
// on the committed proof of the agent's pick. Every changed claim must be refused.
{
  const bv = spawnSync("node", ["zk/browser/check.mjs"], { cwd: root, encoding: "utf8", timeout: 120_000 });
  const n = (bv.stdout.match(/^PASS /gm) ?? []).length, refused = (bv.stdout.match(/^PASS  refused/gm) ?? []).length;
  line(bv.status === 0, "Jolt proof of the agent's pick (the one a browser makes at prove.html) verifies in the page's wasm verifier", `${refused} changed claims refused, ${n} checks; zk/browser/README.md`);
}

// 2d. Proven standing refuses a forged graph: the committed Jolt proof of the live testnet graph,
// re-verified against a forged hire edge, a sybil ring, a changed seed weight, a dropped edge,
// a reordered chain and two changed claims; each must be refused (scripts/standing-negatives.mjs).
{
  const sn = spawnSync("node", ["scripts/standing-negatives.mjs"], { cwd: root, encoding: "utf8", timeout: 120_000 });
  const last = (sn.stdout || sn.stderr || "").trim().split("\n").pop();
  if (sn.status === 3) console.log(last);
  else line(sn.status === 0, "proven standing: the live graph's Jolt proof verifies, and every forged edge, weight or claim is refused", last.replace(/^(PASS|FAIL)\s+standing-negatives:\s+/, ""));
}

// 2d'. The same standing claim in the browser's wasm verifier (agents/standing.html): the log the
// on-chain program proved, re-proved at the browser pin, verified, and 7 forgeries refused.
{
  const bs = spawnSync("node", ["zk/browser/check-standing.mjs"], { cwd: root, encoding: "utf8", timeout: 120_000 });
  const n = (bs.stdout.match(/^PASS /gm) ?? []).length, cases = (bs.stdout.match(/^PASS  refused \(case\)/gm) ?? []).length, flip = /^PASS  refused \(proof bit\)/m.test(bs.stdout);
  line(bs.status === 0 && cases === 7 && flip, "proven standing in the browser (standing.html): the page's wasm verifier, pinned by sha256, accepts a re-proof of the live graph's log", `${cases} changed statements refused${flip ? " and a flipped proof bit" : ""}, ${n} checks`);
}

// 2e. Who sees what on the real-data mainnet purchase: the buyer's facts are absent from every byte
// on chain (txs, logs, the verdict view, the referee's result), and the gateway request (a testnet
// capture of the same code path) is ciphertext; the parties that do see more are listed rows
// (scripts/who-sees-what.mjs, on the committed copy of the 6 mainnet txs; --live re-reads them).
{
  const ws = spawnSync("node", ["scripts/who-sees-what.mjs"], { cwd: root, encoding: "utf8", timeout: 60_000 });
  const last = (ws.stdout || ws.stderr || "").trim().split("\n").pop();
  line(ws.status === 0, "who sees what: the real-data mainnet purchase", last.replace(/^(PASS|FAIL)\s+who sees what:\s+/, ""));
}

// 2f. The Jolt smith (docs/smith.md): programs a NEAR AI model wrote on swarm agents' requests.
// Their proofs in the generic wasm verifier (changed statements refused), the TEE-signed
// authorship, the template and the lint, the registry snapshot; JUDGE_LIVE=1 re-reads the
// registry, its txs and job C over public RPC.
if (existsSync(root + "scripts/smith-check.mjs")) {
  const live = process.env.JUDGE_LIVE === "1";
  const sc = spawnSync("node", ["scripts/smith-check.mjs", ...(live ? ["--live"] : [])], { cwd: root, encoding: "utf8", timeout: live ? 600_000 : 120_000 });
  const n = (sc.stdout.match(/^PASS /gm) ?? []).length, refused = (sc.stdout.match(/^PASS .*refused/gm) ?? []).length;
  line(sc.status === 0, "Jolt smith: model-written guest programs verify against their registered program hashes", `${n} checks, ${refused} changed statements refused${live ? ", registry read live" : ""}; docs/smith.md`);
}

// 3. JS suites
const suites = ["scripts/who-sees-what.test.mjs", "scripts/leak-amount.test.mjs", "ucp/test/near-usdc.test.mjs", "mcp/rep-read.test.mjs", "x402/verdict-read.test.mjs", "sdk/merchant.test.mjs", "scripts/jmpr-rates-to-merchants.test.mjs", "scripts/demo-live.test.mjs", "scripts/demo-tester.test.mjs", "scripts/join-merchant.test.mjs", "relayer/relay.test.mjs", "relayer/near.test.mjs", "relayer/serve.test.mjs", "scripts/mainnet-moment.test.mjs", "scripts/device-run.test.mjs", "scripts/eval-run.test.mjs", "scripts/status.test.mjs", "sdk/buy.test.mjs", "scripts/rep-eval.test.mjs", "scripts/live-pages.test.mjs", "scripts/prove-me.test.mjs", "scripts/rep-eval-v2.test.mjs", "scripts/nras.test.mjs", "scripts/outlayer-eval.test.mjs"].filter((f) => existsSync(root + f));
const { NEAR_RPC: _ignored, ...suiteEnv } = process.env;
const t = spawnSync("node", ["--test", ...suites], { cwd: root, encoding: "utf8", timeout: 60_000, env: suiteEnv });
const pass = Number(t.stdout.match(/^# pass (\d+)/m)?.[1] ?? 0);
const fail = Number(t.stdout.match(/^# fail (\d+)/m)?.[1] ?? 1);
line(t.status === 0 && fail === 0, `JS suites: relayer, demo mode, UCP and Shopify handler, MCP, x402, SDK`, `${pass} tests passed, ${fail} failed`);

const s = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${failed ? "FAIL" : "PASS"}  make judge in ${s} s${failed ? `: ${failed} failed` : ""}. Deeper: make verify (Rust, contract on near-sdk's mocked chain; make verify-offline with no network), make zk-verify-prebuilt (Jolt verifier).`);
process.exit(failed ? 1 : 0);
