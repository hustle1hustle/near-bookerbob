#!/usr/bin/env node
// The run for the day the repository goes public. One stage at a time, in this order; each
// stage says what it sends and stops on the first failure.
//
//   node scripts/flip-day.mjs                    print the plan and what is true right now
//   node scripts/flip-day.mjs check              is the repo public, is CI green on main
//   node scripts/flip-day.mjs pages              dispatch the Pages workflow, wait, open every page
//   node scripts/flip-day.mjs post-check         make flip-check-post
//   node scripts/flip-day.mjs market --i-have-the-founders-word     the Agent Market listing (public, under our name)
//   node scripts/flip-day.mjs outlayer           the OutLayer sequence, step by step (scripts/outlayer-go.mjs)
//   node scripts/flip-day.mjs links              every value the submission form needs, and the payload
//
// What this script never does: make the repo public, post on X, or send the submission. Those
// are the founder's. The submission payload is printed for him to read and send once.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const REPO = "hustle1hustle/bookerbob-near";
const REPO_URL = `https://github.com/${REPO}`;
const PAGES = `https://hustle1hustle.github.io/near-bookerbob`;
const PAGE_FILES = ["", "swarm.html", "prove.html", "clearing.html", "round.html", "board.html", "receipts.html", "prove/sizes.json", "coi-prove-sw.js"];
const TRACKS = ["swarms", "privacy", "open", "agents", "security", "social"];
const DESC = `${process.env.HOME}/Documents/rep code/claude/near-hackathon/SUBMISSION-DESC-DRAFT-2026-11-11.txt`;
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const line = (ok, what, detail = "") => console.log(`${ok === null ? "SKIP" : ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
const status = async (url) => (await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(20000) }).catch(() => null))?.status ?? 0;
const isPublic = async () => (await status(REPO_URL)) === 200;

const PLAN = [
  ["check", "reads", "the repo answers 200 without a login; the last CI run on main is green"],
  ["pages", "sends: a workflow dispatch on our own repo", "Settings > Pages source must be \"GitHub Actions\" (the founder's click, with the flip). Dispatches pages.yml, waits for it, then fetches every page"],
  ["post-check", "reads", "make flip-check-post: the public repo, the pages and the README links as a stranger sees them"],
  ["market", "sends: a public listing under the project's name (the founder gave his word 2026-11-10; no money)", "node scripts/agent-market.mjs register --i-have-the-founders-word; it refuses while the repo is a 404"],
  ["outlayer", "sends: testnet transactions and one GitHub release (the founder gave his word 2026-11-10; testnet fees only)", "node scripts/outlayer-go.mjs prints 15 steps; run them one at a time, reading each result. It goes last: the receipt is already checked on chain without it"],
  ["links", "reads", "prints the repo, the pages, the tracks, the description and the payload for POST /api/applications. Sending it is the founder's, once"],
];

async function check() {
  const pub = await isPublic();
  line(pub, `${REPO_URL} is public`, pub ? "200" : "not yet: it answers a 404 to a stranger");
  const ci = sh("gh", ["run", "list", "--repo", REPO, "--branch", "main", "--workflow", "ci", "-L", "1", "--json", "conclusion,headSha,displayTitle"]);
  const run = JSON.parse(ci.stdout || "[]")[0];
  const head = sh("git", ["rev-parse", "HEAD"]).stdout.trim();
  line(run?.conclusion === "success" && run?.headSha === head, "CI is green on the commit that is checked out", run ? `${run.conclusion || "still running"} on ${run.headSha.slice(0, 7)}, local ${head.slice(0, 7)}` : "no run found");
  const dirty = sh("git", ["status", "--porcelain"]).stdout.trim();
  line(!dirty, "the working tree is clean", dirty ? `${dirty.split("\n").length} changed files` : "");
  return pub;
}

async function pages() {
  if (!(await isPublic())) return line(false, "pages: the repo is not public yet");
  const d = sh("gh", ["workflow", "run", "pages.yml", "--repo", REPO]);
  line(d.status === 0, "dispatched pages.yml", (d.stderr || d.stdout).trim().split("\n")[0]);
  if (d.status !== 0) return;
  await new Promise((ok) => setTimeout(ok, 8000));
  const id = JSON.parse(sh("gh", ["run", "list", "--repo", REPO, "--workflow", "pages.yml", "-L", "1", "--json", "databaseId"]).stdout || "[]")[0]?.databaseId;
  const w = sh("gh", ["run", "watch", String(id), "--repo", REPO, "--exit-status"], { timeout: 900_000 });
  line(w.status === 0, `the pages run ${id} finished`, w.status === 0 ? "success" : "see gh run view; is the Pages source set to GitHub Actions?");
  for (const f of PAGE_FILES) {
    const s = await status(`${PAGES}/${f}`);
    line(s === 200, `${PAGES}/${f}`, String(s));
  }
}

function postCheck() {
  const r = sh("make", ["flip-check-post"], { stdio: "inherit" });
  line(r.status === 0, "make flip-check-post");
}

async function market() {
  if (!process.argv.includes("--i-have-the-founders-word")) return sh("node", ["scripts/agent-market.mjs", "register"], { stdio: "inherit" });
  if (!(await isPublic())) return line(false, "market: the repo is not public yet, the listing would point at a 404");
  sh("node", ["scripts/agent-market.mjs", "register", "--i-have-the-founders-word"], { stdio: "inherit" });
  sh("node", ["scripts/agent-market.mjs", "list"], { stdio: "inherit" });
  console.log("then: add the listing URL to README (docs/agent-market.md says where) and a beat to WOW-BANK.md");
}

function outlayer() {
  console.log("OutLayer goes last. `make outlayer-local` first (the component against a mock host), then the plan below, one step per command, reading each result:\n");
  sh("node", ["scripts/outlayer-go.mjs"], { stdio: "inherit" });
  console.log("\nAfter step 15: node scripts/live-manifest.mjs, SNAPSHOT_RECORD=1 node scripts/verify-live.mjs (5 to 20 minutes), node scripts/status.mjs, then README, docs/outlayer.md and WOW-BANK.md get the tx links.");
}

async function links() {
  const head = sh("git", ["rev-parse", "--short", "HEAD"]).stdout.trim();
  const idea = existsSync(DESC) ? readFileSync(DESC, "utf8").split("\nTracks, in order of fit")[0].trim() : null;
  console.log(`repository      ${REPO_URL}   (commit ${head}; tag it hackathon-submission at submit)`);
  console.log(`swarm page      ${PAGES}/swarm.html`);
  console.log(`prove page      ${PAGES}/prove.html`);
  console.log(`clearing page   ${PAGES}/clearing.html`);
  console.log(`board, receipts ${PAGES}/board.html  ${PAGES}/receipts.html`);
  console.log(`judge guide     ${REPO_URL}/blob/main/docs/judge-guide.md`);
  console.log(`live contracts  https://testnet.nearblocks.io/address/bookerbob.testnet  https://testnet.nearblocks.io/address/market.bookerbob.testnet  https://testnet.nearblocks.io/address/bookerbob-anchor.testnet`);
  console.log(`tracks          ${TRACKS.join(", ")}`);
  console.log(`description     ${idea ? `${idea.length} characters (limit 2000), from ${DESC}` : `MISSING: ${DESC}`}`);
  console.log(`demo post       <the X post URL, after the founder posts it: it must say "built at NEAR HACKATHON" and carry the video>`);
  console.log(`payout account  <a mainnet NEAR account the founder names>`);
  console.log("\nthe payload (POST https://nearhackathon.com/api/applications, Content-Type: application/json). One submission per repository, it cannot be edited, never add a `website` field. The founder reads it, fills the four blanks and sends it once, with one requestId:\n");
  console.log(JSON.stringify({ requestId: "<one fresh UUID, reused on a retry>", projectName: "BookerBob", leadName: "<lead>", email: "<email>", size: "<1 | 2 - 4 | ...>", tracks: TRACKS, nearAddress: "<mainnet account>", projectUrl: REPO_URL, demoUrl: "<X post URL>", idea: idea ?? "<description>", consent: true }, null, 2));
  for (const [what, url] of [["repo", REPO_URL], ["swarm page", `${PAGES}/swarm.html`]]) line((await status(url)) === 200, `${what} answers 200 right now`);
}

const cmd = process.argv[2];
const go = { check, pages, "post-check": postCheck, market, outlayer, links }[cmd];
if (!go) {
  console.log("flip day, in order (node scripts/flip-day.mjs <stage>):\n");
  PLAN.forEach(([id, kind, what], i) => console.log(`${i + 1}. ${id}  [${kind}]\n   ${what}`));
  console.log("\nnot in this script, the founder's: make the repo public and set the Pages source; record the voice; post on X; send the submission.\n\nright now:");
  await check();
} else await go();
