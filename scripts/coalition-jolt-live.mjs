#!/usr/bin/env node
// Coalition version 4 on testnet: admission bound to a Jolt proof the locked on-chain verifier
// checked (docs/jolt-onchain.md, "A contract that acts on it"). Testnet only, no bazaar purchase.
//
//   node scripts/coalition-jolt-live.mjs run       create + deploy (no access key), open, fund, 2 joins
//   node scripts/coalition-jolt-live.mjs finalize  after the deadline: finalize the job
//
// Every tx is recorded in fixtures/live/coalition-jolt/run.json; a step already recorded is skipped.
// Keys: ~/.rep-secrets/bookerbob-testnet (treasury.seed, coalition/cl-lead-1df7...seed); m01 and h05
// sign through the near-cli macOS keychain, as in scripts/coalition-live.mjs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const OUT = join(root, "fixtures/live/coalition-jolt/run.json");
const KEYS = process.env.KEYS_DIR || join(process.env.HOME, ".rep-secrets", "bookerbob-testnet");
const TGAS = 10n ** 12n;
const C = {
  coalition: "coalition-v4.bookerbob-demo.testnet",
  treasury: "bookerbob-demo.testnet",
  bazaar: "bookerbob.testnet",
  dusdc: "bookerbob-dusdc.testnet",
  verifier: "verifier.bookerbob-jolt-a.testnet",
  lead: "cl-lead-1df7.bookerbob-demo.testnet",
  m01: "m01.bookerbob.testnet",
  h05: "h05.bookerbob.testnet",
  live_job: 4, // the live standing proof (zk/onchain/live), verified on chain
  old_job: 1, // standing-testnet-3: an older graph, verified on chain
};
const BOND = 1_000_000n; // 1 dUSDC
const BUDGET = 2_000_000n;
const link = (h) => `https://testnet.nearblocks.io/txns/${h}`;

const st = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { ...C, txs: {} };
const save = () => { mkdirSync(join(root, "fixtures/live/coalition-jolt"), { recursive: true }); writeFileSync(OUT, JSON.stringify(st, null, 2) + "\n"); };
const done = (n) => Boolean(st.txs[n]);
const record = (name, signer, r, expectRefused) => {
  console.log(`   ${r.ok ? "ok" : "FAILED"} ${name}  ${r.hash ? link(r.hash) : ""}${r.ok ? "" : `\n   ${r.error}`}`);
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  st.txs[name] = { hash: r.hash, signer, ...(expectRefused ? { expect: expectRefused } : {}) };
  save();
  return r;
};

// JoltDevice (arkworks compressed): inputs, trusted advice, untrusted advice, outputs, panic.
function ioInputs(file) {
  const b = readFileSync(file);
  let p = 0;
  const n = Number(b.readBigUInt64LE(p));
  p += 8;
  let i = b.subarray(p, p + n);
  let k = i.length;
  while (k > 0 && i[k - 1] === 0) k--;
  return i.subarray(0, k);
}

function nearCli(signer, receiver, method, args, deposit = "0 NEAR", gas = "100.0 Tgas") {
  const nets = (process.env.NEAR_CLI_NETWORKS ?? "testnet-fastnear,testnet,testnet-lava").split(",");
  for (let i = 0; i < 10; i++) {
    const r = spawnSync("near", ["contract", "call-function", "as-transaction", receiver, method, "json-args", JSON.stringify(args), "prepaid-gas", gas, "attached-deposit", deposit, "sign-as", signer, "network-config", nets[i % nets.length], "sign-with-keychain", "send"], { encoding: "utf8" });
    const out = `${r.stdout}${r.stderr}`;
    const hash = out.match(/Transaction ID: ([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1];
    if (r.status === 0 && hash) return { ok: true, hash };
    if (/nonce|Failed to fetch access key|Too Many Requests|429|timeout|rate limit/i.test(out)) {
      spawnSync("node", ["-e", `setTimeout(()=>{},${3000 * (i + 1)})`]);
      continue;
    }
    return { ok: false, hash, error: out.match(/Smart contract panicked: [^\n"]*/)?.[0] ?? out.slice(-400) };
  }
  return { ok: false, error: "retries exhausted" };
}

async function main() {
  const mode = process.argv[2] || "run";
  const { keyFromSeed, rpcClient, send } = await import("../relayer/near.mjs");
  const client = rpcClient(process.env.NEAR_RPC || "https://test.rpc.fastnear.com");
  const treasury = keyFromSeed(readFileSync(join(KEYS, "treasury.seed"), "utf8"));
  const lead = keyFromSeed(readFileSync(join(KEYS, "coalition", `${C.lead}.seed`), "utf8"));
  const fc = (method_name, args, deposit = 0n, gas = 100n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
  const view = (account_id, method, args = {}) => client.view(account_id, method, args);

  if (mode === "run") {
    if (!done("create_deploy")) {
      const code = readFileSync(join(root, "coalition/v4/target/coalition_v4.wasm"));
      st.wasm_sha256 = (await import("node:crypto")).createHash("sha256").update(code).digest("hex");
      // no AddKey: the account never has an access key, so its code cannot change
      record("create_deploy", C.treasury, await send(client, { signer_id: C.treasury, key: treasury, receiver_id: C.coalition, actions: [
        { type: "CreateAccount" },
        { type: "Transfer", deposit: 3_200_000_000_000_000_000_000_000n },
        { type: "DeployContract", code },
        fc("new", { token: C.dusdc, bazaar: C.bazaar, treasury: C.treasury, verifier: C.verifier }),
      ] }));
    }
    if (!done("dusdc_storage")) record("dusdc_storage", C.treasury, await send(client, { signer_id: C.treasury, key: treasury, receiver_id: C.dusdc, actions: [fc("storage_deposit", { account_id: C.coalition, registration_only: true }, 1_250_000_000_000_000_000_000n, 30n * TGAS)] }));
    st.standing_root = await view(C.bazaar, "standing_root");
    console.log(`   bazaar standing_root ${st.standing_root[0].slice(0, 8)}.. n ${st.standing_root[1]} scores ${st.standing_root[2].slice(0, 8)}.. graph ${st.standing_root[3].slice(0, 8)}..`);
    if (!done("open")) {
      st.deadline_ms = Date.now() + 11 * 60_000;
      const legs = [{ category: "hoodie", max_price: "48000000" }, { category: "hotel-lisbon", max_price: "450000000" }];
      const r = record("open", C.lead, await send(client, { signer_id: C.lead, key: lead, receiver_id: C.coalition, actions: [fc("open_job", { legs, bond: String(BOND), budget: String(BUDGET), min_top_pct: 100, deadline_ms: st.deadline_ms, buyers: null }, 20_000_000_000_000_000_000_000n)] }));
      st.job = (await view(C.coalition, "config")).jobs - 1;
      save();
    }
    if (!done("fund")) record("fund", C.lead, await send(client, { signer_id: C.lead, key: lead, receiver_id: C.dusdc, actions: [fc("ft_transfer_call", { receiver_id: C.coalition, amount: String(BUDGET), msg: JSON.stringify({ fund: st.job }) }, 1n, 100n * TGAS)] }));
    const e = JSON.parse(readFileSync(join(process.env.BOOKERBOB_MAIN || join(process.env.HOME, "dev/bookerbob-near"), "fixtures/live/coalition/job-e.json"), "utf8"));
    const opening = (m) => e.openings.find((o) => o.merchant === m);
    const joinArgs = (leg, price, proof, sj, inputs) => ({ receiver_id: C.coalition, amount: String(BOND), msg: JSON.stringify({ join: { job: st.job, leg, price, proof, standing_job: sj, standing_inputs: inputs.toString("base64") } }) });
    const live = ioInputs(join(root, "zk/onchain/live/io_device.bin"));
    const old = ioInputs(join(root, "zk/out/standing-testnet-3/io_device.bin"));
    // h05 names verifier job 1: verified, but over an older graph than the bazaar's live root
    if (!done("join_h05_old_root")) record("join_h05_old_root", C.h05, nearCli(C.h05, C.dusdc, "ft_transfer_call", joinArgs(1, "420000000", opening(C.h05), C.old_job, old), "1 yoctoNEAR", "300.0 Tgas"), "refused");
    // m01 names verifier job 4: the live standing proof, verified on chain
    if (!done("join_m01_live")) record("join_m01_live", C.m01, nearCli(C.m01, C.dusdc, "ft_transfer_call", joinArgs(0, "40000000", opening(C.m01), C.live_job, live), "1 yoctoNEAR", "300.0 Tgas"), "joined");
    console.log(`   job ${st.job}: ${JSON.stringify((await view(C.coalition, "job", { job: st.job })).seats.map((s) => s && s.member))}; finalize after ${new Date(st.deadline_ms).toISOString()}`);
  }
  if (mode === "finalize" && !done("finalize")) {
    if (Date.now() < st.deadline_ms) throw new Error(`deadline ${new Date(st.deadline_ms).toISOString()} not reached`);
    record("finalize", C.lead, await send(client, { signer_id: C.lead, key: lead, receiver_id: C.coalition, actions: [fc("finalize", { job: st.job }, 0n, 200n * TGAS)] }));
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
