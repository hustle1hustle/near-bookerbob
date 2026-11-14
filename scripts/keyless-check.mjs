#!/usr/bin/env node
// Keyless check (testnet, public RPC, no keys): the contracts that hold no access key. For each
// account in the manifest's `keyless` list: it has code, no access key of any kind, and, where a
// lock tx is recorded, that tx is a DeleteKey the account signed on itself and it succeeded.
// With no key, no one can sign a transaction for the account: its code changes only through a
// call the contract itself allows.
// Usage: node scripts/keyless-check.mjs   (NEAR_RPC=<url> to choose the RPC)
import { readFileSync } from "node:fs";
import { rpcClient } from "../relayer/near.mjs";
import { readers } from "./lib/rpc-fallback.mjs";

const m = JSON.parse(readFileSync(new URL("../fixtures/live/testnet-manifest.json", import.meta.url), "utf8"));
const list = m.keyless ?? [];
const client = rpcClient(process.env.NEAR_RPC || "https://test.rpc.fastnear.com");
const { raw } = readers("testnet");
const NET = /fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|429|Too Many Requests|timed out|socket hang up/i;
let failed = 0;
const line = (ok, what, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`); };

try {
  for (const { account, what, lock_tx } of list) {
    const acct = await client.account(account);
    const keys = (await client.rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: account })).result?.keys ?? [];
    line(Boolean(acct) && acct.code_hash !== "11111111111111111111111111111111" && keys.length === 0, `${account}: ${what}, 0 access keys`, acct ? `code ${acct.code_hash.slice(0, 8)}.., ${keys.length} key(s)` : "no such account");
    if (lock_tx) {
      const t = await raw(lock_tx, account);
      const tx = t?.transaction;
      const del = tx?.actions?.some((a) => a.DeleteKey || a === "DeleteKey");
      const ok = tx?.signer_id === account && tx?.receiver_id === account && del && t?.status && "SuccessValue" in t.status;
      line(Boolean(ok), `${account}: the lock tx ${lock_tx.slice(0, 8)}.. is a DeleteKey it signed on itself, and it succeeded`);
    }
  }
} catch (e) {
  if (NET.test(String(e?.message ?? e))) { console.log(`SKIP  keyless-check: public RPC unreachable (${String(e.message ?? e).slice(0, 80)})`); process.exit(3); }
  throw e;
}
console.log(`\n${failed ? "FAIL" : "PASS"}  keyless-check: ${list.length} accounts${failed ? `, ${failed} line(s) failed` : ", none holds an access key"}`);
process.exit(failed ? 1 : 0);
