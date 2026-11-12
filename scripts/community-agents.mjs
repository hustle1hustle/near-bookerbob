#!/usr/bin/env node
// Our five merchant agents in the community round (category `open`), each on its own account
// with its own 10 dUSDC test bond, like any outside bidder. Each round, each agent asks a NEAR AI
// model, drawn at random per agent and round (seeded by sha256(round | account), so anyone can
// redraw it), for one sealed price. The call is E2EE and TEE-signed, and the record keeps what a
// reader needs to re-check it (merchant-brain.mjs askModel). The bid's salt names the decision
// (decisionSalt), and the reveal is pre-signed and time-locked with drand exactly as the round
// page does, so `community.mjs auto-reveal` opens ours with everyone else's.
//
//   node scripts/community-agents.mjs bid [round]     COMMUNITY_ROUND or fixtures/live/community/round.json
//
// Writes fixtures/live/community/agents-<round>.json (public fields only). Testnet only.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keyFromSeed, rpcClient, send, signDelegate } from "../relayer/near.mjs";
import { bidCommitment, schedule } from "../sdk/merchant.mjs";
import { askModel, decisionSalt } from "./merchant-brain.mjs";

const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const KEYS = process.env.KEYS_DIR ?? join(homedir(), ".rep-secrets", "bookerbob-testnet");
const TGAS = 10n ** 12n, MILLI = 10n ** 21n;
const link = (h) => `https://testnet.nearblocks.io/txns/${h}`;
/** The cheap NEAR AI models whose TEE key the bazaar registered against its attestation. */
export const MODELS = ["z-ai/glm-5.3-flash", "deepseek-ai/DeepSeek-V4.1-Flash-1017"];
export const AGENTS = JSON.parse(readFileSync(new URL("../agents/community-agents.json", import.meta.url), "utf8")).agents;
export const modelFor = (round, account) => MODELS[createHash("sha256").update(`${round}|${account}`).digest()[0] % MODELS.length];
/** Code's bound on the answer: a price from the agent's cost to 100 dUSDC, in cents. */
export const clampPrice = (p, cost) => Math.round(Math.min(100, Math.max(cost, Number(p) || cost)) * 100) / 100;

async function bidSeries(roundId) {
  const file = "fixtures/live/community/round.json";
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const series = cfg.series?.length ? [...cfg.series].sort((x, y) => x.commit_until_ms - y.commit_until_ms) : [{ round: cfg.round }];
  const pick = roundId ?? process.env.COMMUNITY_ROUND;
  for (const [i, s] of series.entries()) {
    if (pick && s.round !== pick) continue;
    if (!pick && s.commit_until_ms && Date.now() >= s.commit_until_ms - 60_000) continue;
    console.log(`== ${s.round}`);
    await bid(s.round, i);
  }
}

async function bid(roundId, idx = 0) {
  const file = "fixtures/live/community/round.json";
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const round = roundId ?? process.env.COMMUNITY_ROUND ?? cfg.round;
  const bazaar = cfg.bazaar ?? process.env.BAZAAR_ACCOUNT_ID ?? "bookerbob.testnet";
  if (!round || !bazaar.endsWith(".testnet")) throw new Error("a testnet round id, please");
  const client = rpcClient(RPC);
  const r = await client.view(bazaar, "round", { round_id: round });
  if (!r || r.category !== "open") throw new Error(`round ${round} is not an open round on ${bazaar}`);
  if (Date.now() >= r.commit_until_ms - 20_000) throw new Error("bids are closed");
  const key = (process.env.NEAR_AI_KEY ?? readFileSync(join(homedir(), ".rep-secrets", "near-ai.key"), "utf8")).trim();
  const globalRequire = createRequire(import.meta.url);
  globalThis.require ??= globalRequire;
  const tl = await import("../agents/vendor/tlock.min.js");
  const drand = tl.mainnetClient();
  const info = await drand.chain().info();
  const out = `fixtures/live/community/agents-${round}.json`;
  const rec = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { note: "our merchant agents in a community round: each price chosen by a NEAR AI model (E2EE, TEE-signed), the decision named in the bid's salt; public fields only", round, bazaar, agents: [] };
  for (const a of AGENTS) {
    if (r.commits.some(([w]) => w === a.account) || rec.agents.some((x) => x.account === a.account && x.commit_tx)) { console.log(`   ${a.account}: already bid`); continue; }
    const model = modelFor(round, a.account);
    const system = `You are ${a.name}, a merchant agent in a sealed-bid round on NEAR testnet. One buyer agent wants a room. You set one price in dUSDC, sealed until the deadline; after it every price is revealed and the lowest wins the buyer, who pays that price. Your rivals are people bidding by hand and other agents; you cannot see their prices. ${a.persona} Your cost is ${a.cost} dUSDC. Think briefly. Answer only JSON: {"price": number, "why": "<one short sentence>"}`;
    const user = JSON.stringify({ round, your_cost_dusdc: a.cost, bids_close_utc: new Date(r.commit_until_ms).toISOString() });
    const d = await askModel({ model, system, user, key });
    const price = clampPrice(d.raw.price, a.cost);
    const s = schedule({ basePrice: Math.round(price * 1e6), rules: [], capBps: 0 });
    const salt = decisionSalt(d);
    const seed = readFileSync(join(KEYS, "merchants", `${a.account}.seed`), "utf8");
    const k = keyFromSeed(seed);
    // The reveal, signed now by the agent's own key and time-locked to the commit deadline.
    const ak = await client.accessKey(a.account, k.pub);
    const head = await client.block();
    const blocks = BigInt(Math.ceil(Math.max(0, r.reveal_until_ms - Date.now()) / 500) + 20000);
    const del = signDelegate({ sender_id: a.account, receiver_id: bazaar, actions: [{ type: "FunctionCall", method_name: "reveal_bid", args: { round_id: round, schedule: s, salt }, gas: 50n * TGAS, deposit: 20n * MILLI }], nonce: BigInt(ak.nonce) + 1000n * BigInt(idx + 1), max_block_height: BigInt(head.height) + blocks, public_key_hex: k.pub }, k);
    const plain = JSON.stringify(del, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    const sealed_reveal = await tl.timelockEncrypt(tl.roundAt(r.commit_until_ms + 5000, info), tl.Buffer.from(plain), drand);
    const res = await send(client, { signer_id: a.account, key: k, receiver_id: bazaar, actions: [{ type: "FunctionCall", method_name: "commit_bid", args: { round_id: round, commitment: bidCommitment(a.account, s, Buffer.from(salt, "hex")), sealed_reveal }, gas: 50n * TGAS, deposit: 20n * MILLI }] });
    console.log(`   ${res.ok ? "ok" : "FAILED"} ${a.account} (${model.split("/")[1]}): sealed bid${d.tee_signed ? ", decision TEE-signed" : ", SIGNATURE NOT CHECKED"}  ${link(res.hash)}${res.ok ? "" : `  ${res.error}`}`);
    // The price and the reason stay out of the record until the reveal: written now, they would
    // unseal the bid. The record keeps them sealed inside the disclosure fields, which open with
    // the answer key; a reader checks them after the deadline.
    rec.agents = rec.agents.filter((x) => x.account !== a.account).concat([{ account: a.account, name: a.name, persona: a.persona, cost: a.cost, model, chat_id: d.chat_id, tee_signed: d.tee_signed, signer: d.signer, signed_text: d.signed_text, signature: d.signature, binding_nonce: d.binding_nonce, request_b64: d.request_b64, response_b64: d.response_b64, commit_tx: res.ok ? res.hash : null }]);
    // answer_key is held back until the reveal deadline: it opens the price.
    mkdirSync(join(KEYS, "community-agents"), { recursive: true, mode: 0o700 });
    writeFileSync(join(KEYS, "community-agents", `${round}-${a.account}.json`), JSON.stringify({ answer_key: d.answer_key, price, why: String(d.raw.why ?? "").slice(0, 200) }, null, 2) + "\n", { mode: 0o600 });
    mkdirSync("fixtures/live/community", { recursive: true });
    writeFileSync(out, JSON.stringify(rec, null, 2) + "\n");
  }
  console.log(`wrote ${out}; the answer keys (they open the prices) stay in ${join(KEYS, "community-agents")} until the reveal deadline`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, round] = process.argv.slice(2);
  if (cmd !== "bid") { console.error("usage: community-agents.mjs bid [round]"); process.exit(2); }
  await bidSeries(round).catch((e) => { console.error(`FAIL  ${e.message}`); process.exit(1); });
}
