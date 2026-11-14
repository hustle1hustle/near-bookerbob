#!/usr/bin/env node
// Standing v2 on bookerbob.testnet: the bazaar's graph program moves to the v2 guest
// (zk/browser/standing-v2-guest: every account ranked by its quality-weighted own seed plus the
// standing conferred on it along hire edges, standing-v2/), and the live graph is proved and
// submitted with it. The bazaar's code does not change: it builds its in_top tree from the list
// the proven scores hash covers. Testnet only.
//
//   node scripts/standing-v2.mjs input <tx:signer>...   the live graph's events: the committed
//        coalition input plus the graph_event logs of the named txs; must hash to graph_root
//   node scripts/standing-v2.mjs prove                   standing-host build-v2 -> zk/out/standing-v2
//   node scripts/standing-v2.mjs program                 execute the queued set_graph_program anchor
//   node scripts/standing-v2.mjs submit                  graph-sign (v2) + submit_graph_scores
//   node scripts/standing-v2.mjs finalize                after the challenge window; checks the tree
//   node scripts/standing-v2.mjs verify                  keyless: the chain's graph program, proven
//        tree and ranks equal the committed v2 proof's (fixtures/live/standing-v2/run.json)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keyFromSeed, rpcClient, send } from "../relayer/near.mjs";

const RPC = process.env.NEAR_RPC ?? "https://rpc.testnet.fastnear.com";
const BAZAAR = "bookerbob.testnet";
const TREASURY = "bookerbob-demo.testnet";
const KEYS = process.env.KEYS_DIR ?? `${process.env.HOME}/.rep-secrets/bookerbob-testnet`;
const PRIOR = "fixtures/zk/standing-coalition-input.json";
const INPUT = "fixtures/zk/standing-live-input.json";
const V = process.env.STANDING_VERSION ?? "3"; // 3: the program the bazaar ends on; 2: the measured FAIL
const OUT = `zk/out/standing-v${V}`;
const REC = `fixtures/live/standing-v${V}/run.json`;
const TGAS = 10n ** 12n, MILLI = 10n ** 21n;
const fc = (method_name, args, deposit = 0n, gas = 150n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const link = (h) => `https://testnet.nearblocks.io/txns/${h}`;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const client = rpcClient(RPC);
const rec = existsSync(REC) ? JSON.parse(readFileSync(REC, "utf8")) : { note: "Standing v2 on bookerbob.testnet: the graph program set to the v2 guest (own seed plus conferred standing ranks the in_top tree), the live graph proved with it and finalized. Check: node scripts/standing-v2.mjs verify", bazaar: BAZAAR, txs: {} };
const save = () => { mkdirSync(`fixtures/live/standing-v${V}`, { recursive: true }); writeFileSync(REC, JSON.stringify(rec, null, 2) + "\n"); };
const logsOf = (r) => [r.transaction_outcome, ...r.receipts_outcome].flatMap((o) => o.outcome.logs).filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)));

async function go(name, method, args, deposit = 0n) {
  const key = keyFromSeed(readFileSync(join(KEYS, "treasury.seed"), "utf8"));
  const r = await send(client, { signer_id: TREASURY, key, receiver_id: BAZAAR, actions: [fc(method, args, deposit)] });
  console.log(`   ${r.ok ? "ok" : "FAILED"} ${name}  ${r.hash ? link(r.hash) : ""}${r.ok ? "" : `\n   ${r.error}`}`);
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  rec.txs[name] = r.hash;
  save();
  return r;
}

const cmd = process.argv[2];
if (cmd === "input") {
  const [root, count] = await client.view(BAZAAR, "graph_root", {});
  const prior = JSON.parse(readFileSync(PRIOR, "utf8")).events.map((e) => Buffer.from(e).toString("hex"));
  const logged = [];
  for (const x of process.argv.slice(3)) {
    const [h, signer] = x.split(":");
    const r = (await client.rpc("tx", { tx_hash: h, sender_account_id: signer, wait_until: "FINAL" })).result;
    for (const e of logsOf(r).filter((e) => e.event === "graph_event")) logged.push(e.data[0]);
  }
  logged.sort((a, b) => a.index - b.index);
  const evs = [...prior, ...logged.map((e) => e.event)];
  if (evs.length !== count) throw new Error(`the chain has ${count} graph events; prior ${prior.length} + logged ${logged.length}`);
  execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", "graph-input", root, INPUT, ...evs.map((e) => `hex:${e}`)], { stdio: "inherit" });
  rec.graph_root = root;
  rec.events = count;
  rec.input = INPUT;
  save();
  console.log(`input: ${count} events, root ${root.slice(0, 12)}.. -> ${INPUT}`);
} else if (cmd === "prove") {
  // The pinned Dory URS (zk/urs), so the program hash reproduces; see docs/jolt.md "The Dory setup (URS)".
  // A clean dory cache of its own (dory-pcs reads $LOCALAPPDATA/dory) that holds only the pinned files.
  const ursEnv = { ...process.env, LOCALAPPDATA: process.env.DORY_LOCALAPPDATA || join(process.env.HOME, ".cache", "bookerbob-urs") };
  const ursStamp = join(process.env.TMPDIR || "/tmp", `dory-urs-stamp-${process.pid}-${Date.now()}`);
  execFileSync("sh", ["scripts/dory-urs.sh", "pre", ursStamp], { stdio: "inherit", env: ursEnv });
  execFileSync("./target/release/standing-host", [`build-v${V}`, `../../${INPUT}`, `../../${OUT}`], { stdio: "inherit", cwd: "zk/browser", env: ursEnv });
  execFileSync("sh", ["scripts/dory-urs.sh", "post", ursStamp], { stdio: "inherit", env: ursEnv });
  const s = JSON.parse(readFileSync(join(OUT, "scores.json"), "utf8"));
  Object.assign(rec, { program_hash: s.program_hash, scores_hash: s.scores_hash, merchants: s.merchants, proof_sha256: sha(readFileSync(join(OUT, "proof.bin"))), guest_elf_sha256: sha(readFileSync(join(OUT, "guest.elf"))) });
  save();
  console.log(`v${V} program ${s.program_hash.slice(0, 12)}.., scores ${s.scores_hash.slice(0, 12)}..: ${s.merchants.map(([m, n, x]) => `${m.split(".")[0]}=${x}`).join(" ")}`);
} else if (cmd === "program") {
  const id = Number(process.argv[3] ?? 2);
  const p = await client.view(BAZAAR, "pending_anchor", { id });
  if (p && p.kind !== "graph_program") throw new Error(`anchor ${id} is ${p.kind}`);
  if (p) await go("execute_graph_program", "execute_anchor", { id });
  rec.graph_program = await client.view(BAZAAR, "graph_program", {});
  rec.txs.queue_graph_program = rec.txs.queue_graph_program ?? process.env.QUEUE_TX ?? null;
  save();
  console.log(`graph_program now ${rec.graph_program}`);
} else if (cmd === "submit") {
  const program = await client.view(BAZAAR, "graph_program", {});
  if (program !== rec.program_hash) throw new Error(`the bazaar's program ${program} is not the v2 program ${rec.program_hash}`);
  const argsPath = join(KEYS, "coalition", "graph-args-v2.json");
  execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", "graph-sign", KEYS, program, INPUT, argsPath, join(OUT, "proof.bin")], { stdio: "inherit", env: { ...process.env, BOOKERBOB_STANDING_V2: V } });
  const args = JSON.parse(readFileSync(argsPath, "utf8"));
  await go("submit_graph_scores", "submit_graph_scores", args, 100n * MILLI);
  const p = await client.view(BAZAAR, "pending_graph_update", {});
  rec.pending_scores_hash = p?.scores_hash;
  rec.challenge_until_ms = p ? p.submitted_ms + 300_000 : null;
  save();
  console.log(`pending until ${new Date(rec.challenge_until_ms).toISOString()}; then: node scripts/standing-v2.mjs finalize`);
} else if (cmd === "finalize") {
  await go("finalize_graph_scores", "finalize_graph_scores", {});
  rec.standing_root = await client.view(BAZAAR, "standing_root", {});
  const sp = JSON.parse(execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", "standing-proofs", INPUT], { encoding: "utf8", env: { ...process.env, BOOKERBOB_STANDING_V2: V } }));
  if (sp.standing_root !== rec.standing_root[0]) throw new Error("the rebuilt v2 tree is not the bazaar's");
  rec.ranks = sp.proofs.map((p) => [p.merchant, p.rank]);
  rec.openings = sp.proofs;
  save();
  console.log(`proven standing (v2) root ${rec.standing_root[0].slice(0, 12)}.., n=${rec.standing_root[1]}: ${rec.ranks.map(([m, r]) => `${m.split(".")[0]}#${r}`).join(" ")}`);
} else if (cmd === "verify") {
  const [program, sr] = await Promise.all([client.view(BAZAAR, "graph_program", {}), client.view(BAZAAR, "standing_root", {})]);
  const vbin = existsSync(join(OUT, "verifier.bin")) ? sha(readFileSync(join(OUT, "verifier.bin"))) : null;
  const lines = [
    [program === rec.program_hash && vbin === program, `the bazaar's graph program ${String(program).slice(0, 12)}.. is sha256 of the committed v2 verifier preprocessing`],
    [sr?.[2] === rec.scores_hash && sr?.[3] === rec.graph_root, `the proven tree was built from the v2 scores hash ${String(rec.scores_hash).slice(0, 12)}.. over graph root ${String(rec.graph_root).slice(0, 12)}..`],
    [sr?.[0] === rec.standing_root?.[0] && sr?.[1] === rec.ranks?.length, `standing root ${String(sr?.[0]).slice(0, 12)}.., n=${sr?.[1]}: ${(rec.ranks ?? []).map(([m, r]) => `${m.split(".")[0]}#${r}`).join(" ")}`],
  ];
  for (const [ok, t] of lines) console.log(`${ok ? "PASS" : "FAIL"}  ${t}`);
  process.exit(lines.every(([ok]) => ok) ? 0 : 1);
} else {
  console.error("usage: standing-v2.mjs input <tx:signer>... | prove | program [id] | submit | finalize | verify");
  process.exit(2);
}
