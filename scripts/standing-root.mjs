#!/usr/bin/env node
// A committed standing list on testnet (core/src/standing.rs): the hoodie context's merchants
// ranked by their proven standing, one root on chain, no scores. Then the chain answers
// "is m01 in the top 5%?" from m01's leaf and path, and refuses a low merchant's claim.
//
//   node scripts/standing-root.mjs     build, post_standing_root, two in_top views;
//                                      writes fixtures/live/standing-root/run.json
// Testnet only. The worker key is the registered, bonded referee key (KEYS_DIR/referee.seed).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./demo-tester.mjs";
import { keyFromSeed, rpcClient, send } from "../relayer/near.mjs";

const c = config(process.env);
const client = rpcClient(c.rpc);
const CONTEXT = "hoodie";
const dir = join(c.keysDir, "standing-root");
mkdirSync(dir, { recursive: true, mode: 0o700 });

const merchants = (await client.view(c.bazaar, "merchants", { from_index: 0, limit: 100 })).filter(([, m]) => m.category === CONTEXT && m.approved).map(([a]) => a);
const scores = [];
for (const m of merchants) scores.push([m, (await client.view(c.bazaar, "proven_score", { merchant: m }))?.[0] ?? 0]);
writeFileSync(join(dir, "scores.json"), JSON.stringify(scores), { mode: 0o600 });
const signed = JSON.parse(execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", "standing-commit", c.keysDir, CONTEXT, join(dir, "scores.json"), dir], { encoding: "utf8" }));
const proofs = JSON.parse(readFileSync(join(dir, "standing-proofs.json"), "utf8"));
const treasury = keyFromSeed(readFileSync(join(c.keysDir, "treasury.seed"), "utf8"));
const r = await send(client, { signer_id: c.treasury, key: treasury, receiver_id: c.bazaar, actions: [{ type: "FunctionCall", method_name: "post_standing_root", args: { context: CONTEXT, ...signed }, gas: 50n * 10n ** 12n, deposit: 10n ** 22n }] });
if (!r.ok) throw new Error(`post_standing_root: ${r.error}`);
console.log(`   ok post_standing_root(${CONTEXT}, root ${signed.root.slice(0, 16)}.., n ${signed.n}): no score on chain  https://testnet.nearblocks.io/txns/${r.hash}`);
const top = proofs[0];
const low = proofs.at(-1);
const yes = await client.view(c.bazaar, "in_top", { context: CONTEXT, proof: top, pct: 5 });
const no = await client.view(c.bazaar, "in_top", { context: CONTEXT, proof: low, pct: 50 });
const lie = await client.view(c.bazaar, "in_top", { context: CONTEXT, proof: { ...low, rank: 1 }, pct: 50 });
console.log(`   in_top(${top.merchant.split(".")[0]}, 5%) = ${yes}; in_top(${low.merchant.split(".")[0]}, 50%) = ${no}; the same with a claimed rank 1 = ${lie}`);
if (!(yes && !no && !lie)) throw new Error("unexpected in_top answers");
const pub = {
  note: "A committed standing list: one root per context on chain, no scores. A merchant proves its rank against the root; only the top merchant's opening is published here (it reveals that rank, not the score). Ranked by proven standing: only m01 has one so far; the rest are at 0, tied, ordered by account name.",
  context: CONTEXT,
  root: signed.root,
  n: signed.n,
  worker_key: signed.worker_key,
  post_tx: r.hash,
  published_opening: top,
  answers: { [`in_top(${top.merchant}, 5)`]: yes, [`in_top(${low.merchant}, 50)`]: no, [`in_top(${low.merchant} claiming rank 1, 50)`]: lie },
};
mkdirSync("fixtures/live/standing-root", { recursive: true });
writeFileSync("fixtures/live/standing-root/run.json", JSON.stringify(pub, null, 2) + "\n");
console.log("\nstanding root: PASS  fixtures/live/standing-root/run.json");
