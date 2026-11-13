#!/usr/bin/env node
// `make site`: site/ for GitHub Pages. The board, the receipts and the REP Eval leaderboard,
// each reading bookerbob.testnet over public RPC and falling back to its committed snapshot,
// plus a landing page. Static files only. Pages itself is turned on with the public flip
// (.github/workflows/pages.yml is manual and does nothing until Pages is enabled).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The swarm page (swarm.html) reads swarm.json and built.json, both written by
// scripts/built-counts.mjs. Its two optional slots ship only when their files exist, and
// built.json must agree with what is on disk, or the page would hide a slot or fetch a 404.
const OPTIONAL = { buyer_choice: "out/buyer-choice.json", prove: "prove.html" };
const slots = JSON.parse(readFileSync("agents/built.json", "utf8")).slots;
for (const [slot, f] of Object.entries(OPTIONAL)) {
  if (existsSync(join("agents", f)) !== slots[slot]) throw new Error(`agents/built.json is stale about ${f}: run node scripts/built-counts.mjs`);
}
const FILES = ["media/psybob.png", "media/stack.jpg", "media/swarm-setup.svg", "swarm.html", "swarm.json", "swarm-s1.json", "swarm-s2.json", "s2-prices.svg", "built.json", ...Object.values(OPTIONAL).filter((f) => existsSync(join("agents", f))), "clearing.html", "round.html", "round-tx.js", "vendor/noble-ed25519.js", "vendor/noble-ed25519.LICENSE", "community.json", "board.html", "receipts.html", "eval.html", "live.js", "board.json", "receipts.json", "reviews.json", "eval.json", "eval-v5.json", "live.json", "out/live-run.json"];
// The prove page (a Jolt proof made in the visitor's browser) ships its built files as they
// are committed under agents/prove/ (zk/browser/build.sh makes them; the build needs Rust).
const walk = (d) => readdirSync(join("agents", d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
// coi-prove-sw.js: the page's own service worker (scope prove only) adds the cross-origin
// isolation headers a static host cannot send, so the threaded prover can run.
if (existsSync("agents/prove.html")) FILES.push(...walk("prove"), "coi-prove-sw.js");
mkdirSync("site/out", { recursive: true });
for (const f of FILES) {
  mkdirSync(dirname(join("site", f)), { recursive: true });
  copyFileSync(join("agents", f), join("site", f));
}
writeFileSync("site/.nojekyll", "");
// The landing page: agents/index.html, which replays swarm-s1.json (scripts/swarm-replay-data.mjs).
copyFileSync("agents/index.html", "site/index.html");
console.log(`site/: ${FILES.length} files and index.html (open site/index.html through a static server; Pages turns on with the public flip)`);
