#!/usr/bin/env node
// The 30 registered merchant agents bid in blind rounds on testnet: one round per category
// (hoodie: 22 merchants, hotel: 8), each merchant commits sha256(account, schedule, salt)
// before the deadline and reveals after it; round_best_quote names the winner.
//   node scripts/blind-round.mjs open <tag> [commit_min] [reveal_min]   owner opens both rounds
//   node scripts/blind-round.mjs commit <tag>                           30 sealed bids
//   node scripts/blind-round.mjs reveal <tag>                           30 reveals (waits for the deadline)
//   node scripts/blind-round.mjs winner <tag> <nullifier>
// Merchant keys are in the near-cli keychain (created by deploy-testnet.sh); salts in
// KEYS_DIR/rounds/<tag>.json. Testnet only.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, guard } from "./demo-tester.mjs";
import { rpcClient } from "../relayer/near.mjs";
import { commitBidArgs, revealBidArgs } from "../sdk/merchant.mjs";

const c = config(process.env);
const no = guard(c);
if (no) { console.error(`refusing: ${no}`); process.exit(2); }
const client = rpcClient(c.rpc);
const [cmd, tag, x, y] = process.argv.slice(2);
if (!/^[a-z0-9-]{1,24}$/.test(tag ?? "")) { console.error("tag: a-z 0-9 -"); process.exit(2); }
const dir = join(c.keysDir, "rounds");
mkdirSync(dir, { recursive: true });
const statePath = join(dir, `${tag}.json`);
const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { tag, rounds: {}, bids: {} };
const save = () => writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n", { mode: 0o600 });
const merchants = JSON.parse(readFileSync("agents/merchants.json", "utf8"));
const roundOf = (category) => `${tag}-${category}`;

function call(signer, method, args, deposit = "0 NEAR", gas = "30.0 Tgas") {
  for (let i = 0; i < 4; i++) {
    const r = spawnSync("near", ["contract", "call-function", "as-transaction", c.bazaar, method, "json-args", JSON.stringify(args), "prepaid-gas", gas, "attached-deposit", deposit, "sign-as", signer, "network-config", process.env.NEAR_CLI_NETWORK ?? "testnet", "sign-with-keychain", "send"], { encoding: "utf8" });
    const out = `${r.stdout}${r.stderr}`;
    const hash = out.match(/Transaction ID: ([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1];
    if (r.status === 0 && hash) return { ok: true, hash };
    if (/nonce|Failed to fetch access key|Too Many Requests|429|timeout/i.test(out)) { spawnSync("node", ["-e", "setTimeout(()=>{},2000)"]); continue; }
    return { ok: false, hash, error: out.match(/Smart contract panicked: [^\n"]*/)?.[0] ?? out.slice(-300) };
  }
  return { ok: false, error: "retries exhausted" };
}

if (cmd === "open") {
  const now = Date.now();
  st.commit_until_ms = now + Number(x ?? 8) * 60000;
  st.reveal_until_ms = st.commit_until_ms + Number(y ?? 8) * 60000;
  for (const cat of [...new Set(merchants.map((m) => m.category))]) {
    const r = call(c.bazaar, "open_round", { round_id: roundOf(cat), category: cat, commit_until_ms: st.commit_until_ms, reveal_until_ms: st.reveal_until_ms });
    console.log(`   ${r.ok ? "ok" : "FAILED"} open_round ${roundOf(cat)}  ${r.hash ?? r.error}`);
    st.rounds[cat] = { round: roundOf(cat), open_tx: r.hash };
  }
  console.log(`commit until ${new Date(st.commit_until_ms).toISOString()}, reveal until ${new Date(st.reveal_until_ms).toISOString()}`);
  save();
} else if (cmd === "commit") {
  let ok = 0;
  for (const m of merchants) {
    if (st.bids[m.account]?.commit_tx) { ok++; continue; }
    const salt = randomBytes(32).toString("hex");
    st.bids[m.account] = { salt, round: roundOf(m.category) };
    save();
    const r = call(m.account, "commit_bid", commitBidArgs(roundOf(m.category), m.account, m.schedule, Buffer.from(salt, "hex")), "0.01 NEAR");
    st.bids[m.account].commit_tx = r.ok ? r.hash : null;
    if (r.ok) ok++;
    console.log(`   ${r.ok ? "ok" : "FAILED"} ${m.account.split(".")[0]} commit  ${r.hash ?? r.error}`);
    save();
  }
  console.log(`${ok} of ${merchants.length} sealed bids committed`);
} else if (cmd === "reveal") {
  const wait = st.commit_until_ms - Date.now() + 5000;
  if (wait > 0) { console.log(`waiting ${Math.ceil(wait / 1000)} s for the commit deadline`); await new Promise((ok) => setTimeout(ok, wait)); }
  let ok = 0;
  for (const m of merchants) {
    const b = st.bids[m.account];
    if (!b?.commit_tx) continue;
    if (b.reveal_tx) { ok++; continue; }
    const r = call(m.account, "reveal_bid", revealBidArgs(b.round, m.schedule, Buffer.from(b.salt, "hex")), "0.01 NEAR", "50.0 Tgas");
    b.reveal_tx = r.ok ? r.hash : null;
    if (r.ok) ok++;
    console.log(`   ${r.ok ? "ok" : "FAILED"} ${m.account.split(".")[0]} reveal  ${r.hash ?? r.error}`);
    save();
  }
  console.log(`${ok} reveals`);
} else if (cmd === "winner") {
  for (const [cat, r] of Object.entries(st.rounds)) {
    const info = await client.view(c.bazaar, "round", { round_id: r.round });
    let w = null;
    try { w = await client.view(c.bazaar, "round_best_quote", { round_id: r.round, nullifier: x }); } catch (e) { w = { error: e.message.slice(0, 80) }; }
    r.revealed = info.revealed.length;
    r.commits = info.commits.length;
    r.winner = w?.merchant ?? null;
    r.price = w?.quote?.price ?? null;
    console.log(`${r.round}: ${info.commits.length} commits, ${info.revealed.length} revealed; winner ${w?.merchant ?? JSON.stringify(w)} at ${w?.quote ? Number(w.quote.price) / 1e6 : "-"}`);
  }
  st.nullifier = x;
  save();
} else {
  console.error("usage: blind-round.mjs open|commit|reveal|winner <tag> ...");
  process.exit(2);
}
