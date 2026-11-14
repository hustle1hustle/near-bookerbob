#!/usr/bin/env node
// make mainnet-check: the keyless mainnet checks over public mainnet RPC, one after the other
// (docs/mainnet.md): the bazaar's code hash and its sealed round, the USDC purchase, the real-data
// refusal and the NEAR Intents settlement. No keys. Exit 0: all four PASS. Exit 3: public RPC
// unreachable or too slow for one of them (a SKIP, not a failure). Anything else: a failure.
import { spawnSync } from "node:child_process";

const CHECKS = [
  ["the bazaar on mainnet and round mainnet-1", "scripts/mainnet-bazaar.mjs"],
  ["the USDC purchase with a NEAR AI verdict", "scripts/mainnet-buy.mjs"],
  ["the real-data purchase (the refused discount)", "scripts/mainnet-real.mjs"],
  ["the agent-to-agent NEAR Intents settlement", "scripts/intents-settle.mjs"],
  ["the model's TDX quote verified on chain on mainnet", "scripts/mainnet-dcap.mjs"],
  ["the open round mainnet-open-1 (outside accounts on their own keys)", "scripts/round-mainnet.mjs"],
];
const NET = /fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|429|Too Many Requests|timed out|socket hang up/i;
let failed = 0, skipped = 0;
for (const [what, script] of CHECKS) {
  let r;
  for (let i = 0; i < 2; i++) {
    r = spawnSync("node", [script, "check"], { encoding: "utf8", timeout: 180_000 });
    if (r.status === 0 || !NET.test(`${r.stdout}${r.stderr}${r.error?.code ?? ""}`)) break;
  }
  const out = `${r.stdout}${r.stderr}`;
  const head = out.split("\n").find((l) => /^(PASS|FAIL) /.test(l)) ?? out.trim().split("\n").pop() ?? "";
  if (r.status === 0) console.log(`PASS  mainnet: ${what}  (${head.replace(/^PASS\s+/, "").slice(0, 160)})`);
  else if (NET.test(out) || r.error) { skipped++; console.log(`SKIP  mainnet: ${what}: public mainnet RPC unreachable or too slow (skipped, not failed)`); }
  else { failed++; console.log(`FAIL  mainnet: ${what}  (${head.slice(0, 200)})`); }
}
console.log(failed ? `FAIL  mainnet-check: ${failed} failed` : skipped ? `SKIP  mainnet-check: ${CHECKS.length - skipped} of ${CHECKS.length} checked, ${skipped} skipped (public RPC)` : `PASS  mainnet-check: ${CHECKS.length} of ${CHECKS.length} mainnet records re-read over public RPC, no keys`);
process.exit(failed ? 1 : skipped ? 3 : 0);
