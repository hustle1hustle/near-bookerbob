#!/usr/bin/env node
// The locked testnet Jolt verifier's exact wasm (sha256 29ae5c01..) on NEAR mainnet, with its key
// kept so the storage can be reclaimed after judging. Runs only with --mainnet and
// BOOKERBOB_MAINNET_GO=<today's date, UTC>, set on the founder's word (AGENTS.md).
//
//   node zk/onchain/scripts/mainnet.mjs --mainnet deploy   loader, 6 chunks, deploy (checks the sha256)
//   node zk/onchain/scripts/mainnet.mjs --mainnet job honest|forged
//
// Signs with ~/.rep-secrets/bookerbob-mainnet/jolt-verifier.seed (an implicit account: its id is
// the public key). Every tx is recorded in zk/onchain/onchain-run-mainnet.json.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../..", import.meta.url).pathname;
const today = new Date().toISOString().slice(0, 10);
if (!process.argv.includes("--mainnet") || process.env.BOOKERBOB_MAINNET_GO !== today) {
  console.error(`mainnet: pass --mainnet and BOOKERBOB_MAINNET_GO=${today} (set only on the founder's word)`);
  process.exit(2);
}
const args = process.argv.slice(2).filter((a) => a !== "--mainnet");
const { keyFromSeed, rpcClient, send } = await import(join(root, "relayer/near.mjs"));
const key = keyFromSeed(readFileSync(join(process.env.HOME, ".rep-secrets/bookerbob-mainnet/jolt-verifier.seed"), "utf8"));
const ACC = key.pub;
const client = rpcClient(process.env.NEAR_RPC || "https://rpc.mainnet.fastnear.com");
const OUT = join(root, "zk/onchain/onchain-run-mainnet.json");
const WASM = join(root, "zk/onchain/target/jolt_onchain.wasm");
const LOADER = join(root, "zk/onchain/loader/target/loader.wasm");
const WANT = "29ae5c01c1b95c572f2df3383e889761896cc9322ec2b26779effd98ca5533d2";
const TGAS = 10n ** 12n;
const NEAR = 10n ** 24n;
const st = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { network: "mainnet", contract: ACC, signer: ACC, wasm_sha256: WANT, key: "kept: the storage (about 36 NEAR) is reclaimed after judging", txs: {}, jobs: [] };
const save = () => writeFileSync(OUT, JSON.stringify(st, null, 2) + "\n");
const fc = (method_name, a, deposit = 0n, gas = 100n * TGAS) => ({ type: "FunctionCall", method_name, args: a, gas, deposit });
const call = async (name, actions) => {
  const r = await send(client, { signer_id: ACC, key, receiver_id: ACC, actions });
  console.log(`   ${r.ok ? "ok" : "FAILED"} ${name}  https://nearblocks.io/txns/${r.hash}${r.ok ? "" : `\n   ${r.error}`}`);
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  return r;
};
const view = (m, a = {}) => client.view(ACC, m, a);
console.log(`mainnet ${ACC}: ${Number(BigInt((await client.account(ACC))?.amount ?? 0)) / 1e24} NEAR`);

if (args[0] === "deploy") {
  const code = readFileSync(WASM);
  const sha = createHash("sha256").update(code).digest("hex");
  if (sha !== WANT) throw new Error(`wasm sha256 ${sha} is not ${WANT}`);
  if (!st.txs.loader) { st.txs.loader = (await call("deploy the loader", [{ type: "DeployContract", code: readFileSync(LOADER) }])).hash; save(); }
  st.txs.chunks ??= [];
  for (let i = st.txs.chunks.length, off = i * 700_000; off < code.length; i++, off += 700_000) {
    st.txs.chunks.push((await call(`put chunk ${i}`, [fc("put", code.subarray(off, off + 700_000), 0n, 100n * TGAS)])).hash);
    save();
  }
  if (!st.txs.deploy) { st.txs.deploy = (await call("deploy (loader checks sha256, deploys onto itself)", [fc("deploy", Buffer.from(WANT, "hex"), 0n, 1000n * TGAS)])).hash; save(); }
  console.log(`   program_hash ${await view("program_hash")}`);
}

if (args[0] === "job") {
  const which = args[1];
  const files = which === "honest"
    ? { proof: "zk/onchain/live/proof.bin", io: "zk/onchain/live/io_device.bin", expect: "verified", what: "the live standing proof behind the bazaar's standing tree", result: "zk/onchain/live/result.json" }
    : { proof: "zk/onchain/forged/forged-dory.bin", io: "zk/out/standing-testnet-3/io_device.bin", expect: "refused at unit 56: dory final: InvalidProof", what: "the standing-testnet-3 proof with the final Dory message's E1 moved by the G1 generator (a valid point), the same forgery as testnet job 2" };
  if (!["honest", "forged"].includes(which)) throw new Error("job honest|forged");
  let job = st.jobs.find((j) => j.which === which);
  if (!job) {
    const r = await call(`submit ${which}`, [fc("submit", { proof: readFileSync(join(root, files.proof)).toString("base64"), io: readFileSync(join(root, files.io)).toString("base64") }, 3n * NEAR / 2n, 1000n * TGAS)]);
    job = { which, ...files, id: typeof r.value === "number" ? r.value : (await view("jobs")) - 1, txs: [r.hash] };
    st.jobs.push(job);
    save();
  }
  for (;;) {
    const s = await view("status", { id: job.id });
    if (s.status !== "running") { console.log(`   job ${job.id}: ${s.status}, ${s.advances} advances, ${s.gas_tgas} Tgas`); job.status = s.status; save(); break; }
    job.txs.push((await call(`advance ${job.id}`, [fc("advance", { id: job.id }, 0n, 1000n * TGAS)])).hash);
    save();
  }
}
