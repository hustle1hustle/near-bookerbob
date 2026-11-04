// The agent's settle-only function-call key cannot move escrow out: a tester adds a key
// limited to `settle_demo` on the bazaar (0.05 NEAR gas allowance), then tries
// `withdraw_demo` with it. NEAR refuses it before execution (wrong method, and a
// function-call key cannot attach the 1 yocto withdraw needs), so there is no tx hash for
// the refusal: the RPC error is the evidence. The AddKey tx is on chain.
//   node scripts/fc-key-check.mjs <tester-account>
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./demo-tester.mjs";
import { keyFromSeed, near, nearPublicKey, rpcClient, send } from "../relayer/near.mjs";

const c = config(process.env);
const id = process.argv[2];
const dir = join(c.testersDir, id);
const full = keyFromSeed(readFileSync(join(dir, "account.seed"), "utf8"));
const seed = randomBytes(32).toString("hex");
writeFileSync(join(dir, "fc-settle.seed"), seed + "\n", { mode: 0o600 });
const fcKey = keyFromSeed(seed);
const client = rpcClient(c.rpc);
const add = await send(client, { signer_id: id, key: full, receiver_id: id, actions: [{ type: "AddKey", public_key_hex: fcKey.pub, permission: { allowance: near(0.05), receiver_id: c.bazaar, method_names: ["settle_demo"] } }] });
console.log(`AddKey ${nearPublicKey(fcKey.pub)} (settle_demo only): ${add.ok ? "ok" : add.error} https://testnet.nearblocks.io/txns/${add.hash}`);
const results = [];
for (const [method, deposit] of [["withdraw_demo", 1n], ["withdraw_demo", 0n], ["withdraw", 1n]]) {
  let r;
  try {
    r = await send(client, { signer_id: id, key: fcKey, receiver_id: c.bazaar, actions: [{ type: "FunctionCall", method_name: method, args: { amount: "1" }, gas: 30n * 10n ** 12n, deposit }] });
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  const line = `${method} with ${deposit} yocto under the settle-only key: ${r.ok ? "ACCEPTED (bad)" : "refused"} ${r.ok ? r.hash : (r.error ?? "").slice(0, 160)}`;
  console.log(line);
  results.push({ method, deposit: String(deposit), refused: !r.ok, error: r.ok ? null : (r.error ?? "").slice(0, 300), hash: r.ok ? r.hash : null });
}
writeFileSync("fixtures/live/fc-key-check.json", JSON.stringify({ tester: id, add_key_tx: add.hash, key: nearPublicKey(fcKey.pub), method_names: ["settle_demo"], results }, null, 2) + "\n");
process.exit(results.every((x) => x.refused) && add.ok ? 0 : 1);
