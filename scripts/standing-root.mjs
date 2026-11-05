#!/usr/bin/env node
// The proven standing tree on testnet: after a Jolt-proven graph update applies (its challenge
// window passed), the bazaar holds one root over the proven score list and no scores. Anyone
// rebuilds every merchant's opening from the graph's public events (`bookerbob standing-proofs`)
// and asks the chain "is X in the top N%" (`in_top`).
//
//   node scripts/standing-root.mjs <graph-input.json>   checks the root, asks in_top for the top
//                                                        merchant and a refused claim; writes
//                                                        fixtures/live/standing-root/run.json
// Read-only (views); testnet.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "./demo-tester.mjs";
import { rpcClient } from "../relayer/near.mjs";

const c = config(process.env);
const client = rpcClient(c.rpc);
const input = process.argv[2];
if (!input) throw new Error("usage: standing-root.mjs <graph-input.json>");
const t = JSON.parse(execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", "standing-proofs", input], { encoding: "utf8" }));
const onChain = await client.view(c.bazaar, "standing_root", {});
if (!onChain) throw new Error("no proven standing root on chain yet (finalize the graph update first)");
const [root, n, scoresHash, graphRoot] = onChain;
if (root !== t.standing_root || scoresHash !== t.scores_hash || graphRoot !== t.graph_root) throw new Error(`the input's tree ${t.standing_root.slice(0, 12)} is not the proven one ${root.slice(0, 12)}`);
const top = t.proofs[0];
const low = t.proofs.at(-1);
const pct = Math.ceil((100 * top.rank) / n);
const yes = await client.view(c.bazaar, "in_top", { proof: top, pct });
const lie = await client.view(c.bazaar, "in_top", { proof: { ...top, rank: 1, merchant: low.merchant }, pct: 100 });
console.log(`   proven standing root ${root.slice(0, 16)}.. (${n} merchants) over scores_hash ${scoresHash.slice(0, 12)}..; ranks ${t.proofs.map((p) => `${p.merchant.split(".")[0]}#${p.rank}`).join(" ")}`);
console.log(`   in_top(${top.merchant.split(".")[0]}, ${pct}%) = ${yes}; ${low.merchant.split(".")[0]} on ${top.merchant.split(".")[0]}'s path = ${lie}`);
if (!(yes && !lie)) throw new Error("unexpected in_top answers");
const pub = {
  note: "The proven standing tree: its root is built by the bazaar from the score list of a Jolt-proven, challengeable graph update; no score is stored. The scores follow from public events, so the root is a compact rank check, not score privacy. Only the top merchant's opening is published here.",
  standing_root: root,
  n,
  scores_hash: scoresHash,
  graph_root: graphRoot,
  ranks: t.proofs.map((p) => [p.merchant, p.rank]),
  published_opening: top,
  pct,
  low_merchant: low.merchant,
};
mkdirSync("fixtures/live/standing-root", { recursive: true });
if (process.env.DEMO_RUN !== "1") writeFileSync("fixtures/live/standing-root/run.json", JSON.stringify(pub, null, 2) + "\n");
console.log("\nstanding root: PASS  fixtures/live/standing-root/run.json");
