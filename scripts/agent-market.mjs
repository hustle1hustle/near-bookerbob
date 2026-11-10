#!/usr/bin/env node
// NEAR Agent Market (market.near.ai, API 2.0.0): who is listed there, and BookerBob's listing.
//
//   node scripts/agent-market.mjs list        LIVE read, no key: the agents listed right now,
//                                             by category; writes a public snapshot to
//                                             fixtures/live/agent-market/listing.json
//   node scripts/agent-market.mjs register    prints the listing BookerBob would register.
//                                             Sends it only with --i-have-the-founders-word.
//
// What a listing is and is not: Agent Market is mainnet only and BookerBob runs on testnet, so
// the listing is a door, not a deployment. It says where an outside agent joins the testnet
// market (AGENTS.md: a bond in the open category, no owner step) and that nothing there is real
// money. No job is posted and no money moves: a job needs an escrow in real funds.
// The token the market returns once is written to KEYS_DIR/agent-market/token (mode 600) and
// never printed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API = process.env.AGENT_MARKET_API ?? "https://market.near.ai";
const KEYS_DIR = process.env.KEYS_DIR ?? `${process.env.HOME}/.rep-secrets/bookerbob-testnet`;
const OUT = "fixtures/live/agent-market/listing.json";
const REPO = "https://github.com/hustle1hustle/near-bookerbob";

export const LISTING = {
  handle: "bookerbob",
  name: "BookerBob",
  category: "travel",
};
export const PROFILE = {
  description: "A testnet market where merchant agents bid sealed for a buyer who proved a few private facts. Join as a merchant agent with a bond; no owner approves you.",
  bio_markdown: [
    "BookerBob is a market on NEAR testnet. A buyer's agent reveals a few proven bits in a signed verdict, never the history behind them. Merchant agents commit sealed bids and reveal after a deadline. Code computes every price, a referee refuses any claim the proofs do not back, and the contract pays the winner against a receipt.",
    "",
    "## For an agent that sells something",
    "",
    `Read AGENTS.md in ${REPO}. In the open category a 10 dUSDC bond admits you, no owner step. Then commit a bid, reveal it, and read the winner. Every step prints its explorer link.`,
    "",
    "## What this is not",
    "",
    "Testnet only. dUSDC is a demo token with no value. The facts behind the demo verdicts are synthetic. Nothing here takes or pays real money, and this listing sells nothing.",
  ].join("\n"),
  tags: ["near", "testnet", "sealed-bids", "group-buying", "privacy"],
};

async function get(path) {
  const r = await fetch(`${API}${path}`, { headers: { "User-Agent": "bookerbob-agent-market/1" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status}`);
  return r.json();
}

async function list() {
  const agents = [];
  for (let offset = 0; offset < 2000; offset += 50) {
    const page = (await get(`/v1/agents?limit=50&offset=${offset}`)).agents ?? [];
    agents.push(...page);
    if (page.length < 50) break;
  }
  const by = {};
  for (const a of agents) by[a.category] = (by[a.category] ?? 0) + 1;
  const rows = agents.map((a) => ({ handle: a.handle, category: a.category, delivered_jobs: a.delivered_jobs ?? 0 }));
  const ours = rows.find((a) => a.handle === LISTING.handle) ?? null;
  // The agents whose category could sell in a BookerBob round (a stay, a ticket, a payment).
  const sellers = rows.filter((a) => ["travel", "finance", "events"].includes(a.category));
  mkdirSync("fixtures/live/agent-market", { recursive: true });
  writeFileSync(OUT, JSON.stringify({ note: "a public read of market.near.ai/v1/agents; nothing here is ours unless `bookerbob` says so", taken_at: new Date().toISOString(), api: API, total: rows.length, by_category: by, bookerbob: ours, could_sell: { categories: ["travel", "finance", "events"], count: sellers.length, handles: sellers.map((a) => a.handle).sort() } }, null, 2) + "\n");
  console.log(`LIVE  Agent Market: ${rows.length} agents listed (${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")})`);
  console.log(`      ${sellers.length} of them are in travel, finance or events: the kinds that could sell in a BookerBob round. None has joined one; the door is AGENTS.md`);
  console.log(`      BookerBob's listing: ${ours ? `${ours.handle} (${ours.category})` : "not listed"}`);
  console.log(`      wrote ${OUT}`);
}

async function register() {
  console.log("the listing (POST /v1/agents/register, then PATCH the profile with the returned token):");
  console.log(JSON.stringify({ ...LISTING, ...PROFILE }, null, 2));
  if (!process.argv.includes("--i-have-the-founders-word")) {
    console.log("\nDRY: nothing sent. A listing is public and under the project's name: it needs the founder's word (--i-have-the-founders-word).");
    return;
  }
  const head = await fetch(REPO, { method: "HEAD", signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!head?.ok) throw new Error(`refusing: ${REPO} is not public yet, the listing would point at a 404`);
  const r = await fetch(`${API}/v1/agents/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(LISTING) });
  const j = await r.json().catch(() => ({}));
  if (r.status !== 201) throw new Error(`register: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  const token = j.apiToken;
  const id = j.agentId;
  if (!token || !id) throw new Error(`register: 201 without a token or an id (fields: ${Object.keys(j).join(", ")})`);
  const dir = join(KEYS_DIR, "agent-market");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "token"), token, { mode: 0o600 });
  writeFileSync(join(dir, "agent.json"), JSON.stringify({ agent_id: id, handle: LISTING.handle, registered_at: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  console.log(`registered ${LISTING.handle} (agent ${id}); token saved to ${join(dir, "token")}, not printed`);
  const p = await fetch(`${API}/v1/agents/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(PROFILE) });
  console.log(p.ok ? "profile set" : `profile NOT set: HTTP ${p.status} ${(await p.text()).slice(0, 200)} (the listing exists with its name only; fix by hand with the saved token)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  const go = { list, register }[cmd];
  if (!go) {
    console.error("usage: agent-market.mjs list | register [--i-have-the-founders-word]");
    process.exit(2);
  }
  await go().catch((e) => {
    console.error(`FAIL  agent market: ${e.message}`);
    process.exit(1);
  });
}
