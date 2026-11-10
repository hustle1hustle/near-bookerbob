#!/usr/bin/env node
// Data for agents/swarm.html, read from the repo. Nothing here is typed by hand: rerun it
// after any change to the files below (and after adding agents/out/buyer-choice.json or
// agents/prove.html, so the page shows their slots).
//   node scripts/built-counts.mjs
// Writes:
//   agents/built.json  the "what we built" counts, each with the file it was read from, and
//                      which optional slots exist
//   agents/swarm.json  the slice of fixtures/live/testnet-manifest.json the replay needs (the
//                      manifest is outside agents/, so a static server cannot read it)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const git = (...a) => {
  try {
    return execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const walk = (dir, out = []) => {
  for (const f of readdirSync(dir)) {
    if (f === "node_modules" || f === "target" || f.startsWith(".")) continue;
    const p = join(dir, f);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
};

const manifest = json("fixtures/live/testnet-manifest.json");
const merchants = json("agents/merchants.json");
const live = json("agents/live.json");
const status = json("docs/status.json");
const evals = json("fixtures/referee-evals.json");

// The repo URL for "check it" links: the origin remote, as https.
const origin = git("remote", "get-url", "origin").replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");
const repo = origin || "https://github.com/hustle1hustle/near-bookerbob";
const blob = (p) => `${repo}/blob/main/${p}`;

// Every tx hash in the manifest: base58 strings of 43 or 44 characters (nullifiers, roots and
// senders there are hex, so they do not match).
const txs = new Set();
(function collect(v) {
  if (typeof v === "string") {
    if (/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(v)) txs.add(v);
  } else if (v && typeof v === "object") Object.values(v).forEach(collect);
})(manifest);

const bids = Object.values(manifest.blind_round.bids);
const rounds = Object.values(manifest.blind_round.rounds);
const paid = live.purchases.filter((p) => p.kind !== "refunded");
const reviewRounds = [manifest.reviews, ...manifest.review_rounds];
const byStatus = {};
for (const r of status) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
const rustTests = ["contract/src", "core/src", "worker/src", "cli/src"]
  .flatMap((d) => walk(d))
  .filter((f) => f.endsWith(".rs"))
  .reduce((n, f) => n + (readFileSync(f, "utf8").match(/#\[test\]/g) ?? []).length, 0);
const proofs = readdirSync("zk/out").filter((d) => existsSync(join("zk/out", d, "proof.bin")));
const shallow = git("rev-parse", "--is-shallow-repository") !== "false";
const commits = shallow ? null : Number(git("rev-list", "--count", "HEAD"));
const days = shallow ? [] : [...new Set(git("log", "--format=%ad", "--date=short").split("\n"))].sort();

const counts = [
  // agents/merchants.json: one entry per listed merchant agent.
  { n: merchants.length, label: "merchant agents listed", detail: Object.entries(merchants.reduce((a, m) => ((a[m.category] = (a[m.category] ?? 0) + 1), a), {})).map(([c, n]) => `${n} ${c}`).join(", "), source: "agents/merchants.json", href: "board.html" },
  // manifest.blind_round.bids: one commit tx and one reveal tx per merchant, on testnet.
  { n: bids.filter((b) => b.commit_tx && b.reveal_tx).length, label: "sealed bids committed and revealed on testnet", detail: rounds.map((r) => `${r.revealed} in ${r.round}`).join(", "), source: "fixtures/live/testnet-manifest.json (blind_round)", href: blob("docs/testnet.md") },
  // agents/live.json: purchases on bookerbob.testnet, without the refunded group pledge.
  { n: paid.length, label: "purchases settled in dUSDC on testnet", detail: "make verify-live re-derives each one over public RPC", source: "agents/live.json", href: "receipts.html" },
  // fixtures/referee-evals.json: authored referee cases and how many must be refused.
  { n: evals.filter((e) => e.expect === "refused").length, label: `false claims refused, of ${evals.length} referee cases`, detail: "make verify runs all of them", source: "fixtures/referee-evals.json", href: blob("fixtures/referee-evals.json") },
  // manifest.reviews and manifest.review_rounds: sealed ratings released on testnet.
  { n: reviewRounds.reduce((n, r) => n + r.ratings, 0), label: `anonymous ratings released over ${reviewRounds.length} rounds on testnet`, detail: "Semaphore proofs, released only at 5 raters", source: "fixtures/live/testnet-manifest.json (reviews, review_rounds)", href: "receipts.html" },
  // zk/out/*/proof.bin: committed Jolt proofs.
  { n: proofs.length, label: "Jolt proofs committed", detail: proofs.join(", "), source: "zk/out/*/proof.bin", href: blob("docs/jolt.md") },
  // The manifest, every base58 tx hash in it.
  { n: txs.size, label: "testnet transactions on record", detail: "each hash is in the manifest", source: "fixtures/live/testnet-manifest.json", href: blob("docs/testnet.md") },
  // docs/status.json: the feature table, by status.
  { n: byStatus.live ?? 0, label: `features live, of ${status.length} listed`, detail: Object.entries(byStatus).filter(([s]) => s !== "live").map(([s, n]) => `${n} ${s}`).join(", "), source: "docs/status.json", href: blob("README.md") + "#every-feature-its-status-and-its-evidence" },
  // #[test] attributes under contract/, core/, worker/ and cli/.
  { n: rustTests, label: "Rust test functions", detail: "contract, core, worker, cli; make test runs them", source: "#[test] in contract/src, core/src, worker/src, cli/src", href: blob("contract/src/tests.rs") },
];
// git: commits on this branch and the days they span. Left out in a shallow clone.
if (commits) counts.push({ n: commits, label: `commits, ${days[0]} to ${days.at(-1)}`, detail: "counted when this page was built", source: "git rev-list --count HEAD", href: `${repo}/commits/main` });

const slots = { buyer_choice: existsSync("agents/out/buyer-choice.json"), prove: existsSync("agents/prove.html") };
writeFileSync("agents/built.json", JSON.stringify({ note: "written by scripts/built-counts.mjs from the files named in each source; not edited by hand", repo, slots, counts }, null, 2) + "\n");

// The replay slice. Field for field from the manifest; nothing computed except the picks.
const HOTEL = "hotel-lisbon";
const round = manifest.blind_round.rounds[HOTEL];
const buyer = manifest.testers.find((t) => t.merchant === round.winner && t.price === round.price);
const g = manifest.group_dao;
// The ask of the recorded hotel purchase, as docs/testnet.md states the command that ran it.
const ask = (readFileSync("docs/testnet.md", "utf8").match(/node sdk\/buy\.mjs "([^"]+)"/) ?? [])[1] ?? null;
const swarm = {
  note: "the slice of fixtures/live/testnet-manifest.json that agents/swarm.html replays; written by scripts/built-counts.mjs. Every tx is on NEAR testnet; dUSDC is a testnet demo token; the facts behind verdicts are synthetic.",
  bazaar: manifest.bazaar,
  category: HOTEL,
  ask,
  rounds: Object.fromEntries(Object.entries(manifest.blind_round.rounds).map(([c, r]) => [c, { round: r.round, commits: r.commits, revealed: r.revealed }])),
  round: { ...round, bids: Object.fromEntries(Object.entries(manifest.blind_round.bids).filter(([, b]) => b.round === round.round)) },
  anchors: Object.fromEntries(Object.entries(manifest.cheat.anchors).map(([m, a]) => [m, { max_base: a.max_base, tx: a.tx }])),
  cheat: manifest.cheat.cheat,
  buyer: { tester: buyer.tester, nullifier: buyer.nullifier, price: buyer.price, txs: { verdict: buyer.txs.verdict, receipt: buyer.txs.receipt, settle: buyer.txs.settle, replay: buyer.txs.replay } },
  group: {
    dao: g.dao,
    offer: g.offer,
    dropout: g.dropout,
    members: g.members.map((m) => ({ tester: m.tester, intent: m.intent })),
    txs: { offer: g.txs.offer, dao: g.txs.dao, direct_release_refused: g.txs.direct_release_refused, refund: g.txs.refund_vote4, release: g.txs.release_vote4 },
  },
  fee_bps: manifest.fee.bps,
};
writeFileSync("agents/swarm.json", JSON.stringify(swarm, null, 2) + "\n");
console.log(`agents/built.json: ${counts.length} counts (${counts.map((c) => c.n).join(", ")}); slots ${JSON.stringify(slots)}\nagents/swarm.json: ${Object.keys(swarm.round.bids).length} bids in ${round.round}, a group of ${g.members.length} pledges`);
