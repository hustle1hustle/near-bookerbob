#!/usr/bin/env node
// `make no-owner`: who can change a bazaar's code, read over public RPC. No keys needed.
//
//   node scripts/no-owner.mjs [account ...]          default: market.bookerbob.testnet and,
//                                                    as the "before" exhibit, bookerbob.testnet
//   node scripts/no-owner.mjs plan                   the staged steps for panel action 8 (prints
//                                                    them, sends nothing)
//
// For each account: its code hash and every access key with its permission. Then a redeploy
// attempt signed by a fresh random key, which NEAR refuses before execution: with no
// full-access key on the account, no one holds a key that can sign DeployContract.
import { randomBytes } from "node:crypto";
import { b58decode, keyFromSeed, nearPublicKey, rpcClient, signTransaction } from "../relayer/near.mjs";

const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const client = rpcClient(RPC);
const MARKET = "market.bookerbob.testnet";
const DAO = "bookerbob-gov.sputnikv2.testnet";

export function summarize(keys) {
  const full = keys.filter((k) => k.access_key.permission === "FullAccess");
  const fc = keys.filter((k) => k.access_key.permission !== "FullAccess").map((k) => ({ key: k.public_key, receiver: k.access_key.permission.FunctionCall?.receiver_id, methods: k.access_key.permission.FunctionCall?.method_names ?? [] }));
  return { full: full.map((k) => k.public_key), fc, upgradeable_by_key: full.length > 0 };
}

async function inspect(account) {
  const acct = await client.account(account);
  if (!acct) return console.log(`${account}: does not exist (yet)`);
  const r = await client.rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: account });
  const s = summarize(r.result?.keys ?? []);
  console.log(`\n${account}  code ${acct.code_hash}`);
  console.log(`  full-access keys: ${s.full.length ? s.full.join(", ") : "none"}`);
  for (const k of s.fc) console.log(`  function-call key ${k.key} -> ${k.receiver} ${k.methods.length ? k.methods.join(",") : "(any method)"}`);
  // A redeploy signed by a key the account does not hold: refused before it runs.
  const key = keyFromSeed(randomBytes(32).toString("hex"));
  const header = await client.block();
  const { signed } = signTransaction({ signer_id: account, public_key_hex: key.pub, nonce: 1n, receiver_id: account, block_hash: b58decode(header.hash), actions: [{ type: "DeployContract", code: Buffer.from("00", "hex") }] }, key);
  const t = await client.rpc("broadcast_tx_commit", { signed_tx_base64: signed.toString("base64") }).catch((e) => ({ error: { message: e.message } }));
  const why = JSON.stringify(t.error ?? t.result?.status ?? {}).match(/AccessKeyNotFound|InvalidAccessKey[A-Za-z]*/)?.[0] ?? JSON.stringify(t.error ?? t.result).slice(0, 120);
  console.log(`  redeploy signed by a fresh key ${nearPublicKey(key.pub)}: refused (${why})`);
  console.log(s.upgradeable_by_key ? `  => the holder of ${s.full.length} full-access key(s) can replace this code at any time` : "  => no full-access key: the code can change only through a call the contract itself allows");
}

function plan() {
  const steps = [
    ["bookerbob.testnet", `create ${MARKET} with 5 NEAR and one temporary full-access key (KEYS_DIR/market/market.seed)`],
    [MARKET, `deploy the bazaar wasm (sha256 printed) and new(owner = ${DAO}, usdc): the DAO is the owner from block one`],
    [DAO, "proposals, each 2 of 3 council votes: set_demo_token(dUSDC), register_issuer (testnet issuer), register_referee, register_world_verifier, register_arbiter, set_fee(100, DAO)"],
    ["merchants", "re-register m01, h01..h08 and the open merchants on the new bazaar; DAO proposals approve the curated ones (open ones approve by bond)"],
    [DAO, "proposal: set_anchor_delay(300000): every later anchor change waits 5 minutes in public"],
    [MARKET, "IRREVERSIBLE, the founder's OK: DeleteKey of the temporary full-access key; after it no one can redeploy"],
    ["repo", `point DEMO / BAZAAR_ACCOUNT_ID at ${MARKET}; bookerbob.testnet stays as the "before" exhibit; make no-owner shows both`],
  ];
  console.log(`panel action 8, staged (nothing is sent by this command):`);
  steps.forEach(([who, what], i) => console.log(`${i + 1}. [${who}] ${what}`));
  console.log("\nNot built yet: the run itself (scripts/dao-bazaar.mjs has the DAO proposal flow it reuses). About 1 to 2 hours after the OK.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === "plan") plan();
  else for (const a of args.length ? args : [MARKET, "spike.bookerbob.testnet", "bookerbob.testnet"]) await inspect(a);
}
