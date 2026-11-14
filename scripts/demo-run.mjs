#!/usr/bin/env node
// Drives the 2:30 video on testnet, one beat per keypress (not in this public copy). Each beat prints the
// line to say, runs its on-screen step and prints the live tx it points to.
//
//   python3 -m http.server -d agents 8000      in another terminal, for the board beat
//   node scripts/demo-run.mjs                  space or enter: next beat; q: quit
//   node scripts/demo-run.mjs --short          the 95 s cut: one buyer, one refusal, one purchase
//   node scripts/demo-run.mjs --rehearse       every beat in a row, no keypress (a dry check)
//
// Nothing here buys or writes fixtures: the agent's purchase is shown as a plan (DEMO_RUN=1)
// and its recorded settle tx; the cheat attempt is a fresh refused tx on testnet.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { BEATS, X_POST } from "./demo-beats.mjs";
import { rpcClient } from "../relayer/near.mjs";

const rehearse = process.argv.includes("--rehearse");
const short = process.argv.includes("--short");
const client = rpcClient(process.env.NEAR_RPC || "https://test.rpc.fastnear.com");
const m = JSON.parse(readFileSync("fixtures/live/testnet-manifest.json", "utf8"));
const sealedNullifier = m.testers.find((t) => t.sealed && !t.prove_me).nullifier;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function key() {
  if (rehearse || !process.stdin.isTTY) return Promise.resolve("next");
  return new Promise((ok) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once("data", (b) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      ok(b.toString() === "q" || b[0] === 3 ? "quit" : "next");
    });
  });
}

async function beat(b) {
  console.log(`\n${bold(`${b.t}  ${b.title}`)}`);
  if (b.title === "no owner") {
    const r = await client.rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: "market.bookerbob.testnet" });
    const full = (r.result?.keys ?? []).filter((k) => k.access_key.permission === "FullAccess").length;
    if (full) console.log(bold(`WARNING: market.bookerbob.testnet still has ${full} full-access key: lock it before filming this beat (node scripts/market-bazaar.mjs lock)`));
  }
  console.log(`say: "${b.say}"`);
  console.log(dim(`screen: ${b.show}`));
  if (b.view) {
    const [account, method] = b.view;
    const v = await client.view(account, method, { nullifier: sealedNullifier });
    console.log(JSON.stringify({ agent: v.agent, predicates: v.predicates, tier: v.tier, max_spend: v.max_spend, disclosure: v.disclosure ?? "(see the disclosure view)", spent: v.spent }, null, 1));
  }
  if (b.run) {
    const [cmd, ...args] = b.run;
    const opened = cmd === "open" ? ["open", [`http://localhost:8000/${args[0].replace(/^agents\//, "")}`]] : [cmd, args];
    const r = spawnSync(opened[0], opened[1], { stdio: "inherit", env: { ...process.env, DEMO_RUN: "1" } });
    if (r.status !== 0) console.log(dim(`(${cmd} exited ${r.status})`));
  }
  if (b.link) console.log(`tx: ${b.link}`);
}

console.log(bold(short ? "bookerbob, the 95 s cut" : "bookerbob, the 2:30 demo") + dim(rehearse ? "  (rehearsal: no keypress)" : "  space/enter: next beat, q: quit"));
for (const b of short ? BEATS.filter((x) => x.short) : BEATS) {
  if ((await key()) === "quit") break;
  await beat(b);
}
console.log(`\n${bold("the X post (the founder posts it, with the video):")}\n${X_POST}\n`);
process.exit(0);
