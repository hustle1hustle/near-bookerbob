#!/usr/bin/env node
// A large swarm on the live testnet bazaar: the 30 registered merchant agents bid sealed in
// fresh rounds, and many buyer agents each get a verdict from a NEAR AI model (E2EE v2, the
// make model-buy path) and buy from the round's winner for that verdict, settling in dUSDC.
//
//   node scripts/swarm-run.mjs plan <tag> --rounds R --buyers B     what it would do and cost; sends nothing
//   node scripts/swarm-run.mjs run <tag> --rounds R --buyers B      resumable: a rerun continues
//   node scripts/swarm-run.mjs retry <tag> [--log <an earlier run's log>]   settles buyers that failed at
//     settle_demo (their verdict, receipt and escrow are on chain) and gives buyers whose round
//     never opened one extra round; `run` on an existing tag does the same
//   node scripts/swarm-run.mjs verify <tag>                         no keys, public RPC only
//   options: --commit-min 5 --reveal-min 5 --concurrency 3 --sets N --no-sweep --no-faucet
//
// Each round r: scripts/blind-round.mjs opens a hoodie and a hotel round (tag <tag>-r<r>), the
// 30 merchants commit and reveal, and after the reveal deadline the round's buyers run. A buyer
// is the demo tester (scripts/demo-tester.mjs) with the model verdict of scripts/model-buy.mjs:
// a fresh implicit account, a synthetic proof set, submit_near_ai_verdict, round_best_quote,
// the referee's receipt, escrow, settle_demo. One buyer per round also tries a replay.
//
// What the swarm does differently from the public demo, on purpose:
// - It BYPASSES THE DAILY CAP of 20 testers (DAILY_TESTERS in demo-tester.mjs guards the public
//   demo). Its buyers live in KEYS_DIR/swarm/<tag>/buyers, not KEYS_DIR/testers, so they do not
//   count against that cap and scripts/live-manifest.mjs never lists them.
// - It writes no Shopify order and joins no review group.
// - A buyer sends its unspent testnet NEAR back to the treasury that funded it (--no-sweep keeps it).
// - If the treasury runs short it takes 10 testnet NEAR from the public faucet through a fresh
//   account whose key stays in KEYS_DIR/swarm (--no-faucet stops instead).
//
// State: KEYS_DIR/swarm/<tag>.json (mode 600). Public record: fixtures/live/swarm/<tag>.json
// (round ids, counts, accounts, nullifiers, prices, model and chat ids, tx hashes; no seeds, no
// salts, no facts). The record is separate from fixtures/live/testnet-manifest.json.
//
// Testnet only (refuses anything else first). dUSDC is a demo token with no value. NEAR AI
// costs about $0.001 a buyer; a 402 (credit exhausted) stops the run cleanly. Do not kill a run
// between a round's commits and its reveals: rerun it at once so every sealed bid is opened.
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config, guard, Demo, TREASURY_MIN } from "./demo-tester.mjs";
import { keyFromSeed, near, nearPublicKey, outcome, rpcClient, send } from "../relayer/near.mjs";

const TGAS = 10n ** 12n;
const MILLI = 10n ** 21n;
const ARCHIVAL = "https://archival-rpc.testnet.fastnear.com";
const PUBLIC_RPC = "https://test.rpc.fastnear.com";
const FAUCET = process.env.NEAR_FAUCET ?? "https://helper.nearprotocol.com/account";
const AI_API = process.env.NEAR_AI_BASE ?? "https://cloud-api.near.ai/v1";
const EXPLORER = "https://testnet.nearblocks.io/txns/";
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const yoctoToNear = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;

export const CATEGORIES = (process.env.SWARM_CATEGORIES ?? "hoodie,hotel-lisbon").split(",");
/** SWARM_MERCHANTS=m02,m03,...: only these merchant agents bid (with SWARM_MERCHANT_BRAIN=1, each
 *  chooses its sealed bid every round through scripts/merchant-brain.mjs). */
const ONLY_MERCHANTS = process.env.SWARM_MERCHANTS ? process.env.SWARM_MERCHANTS.split(",").map((x) => `${x.trim()}.bookerbob.testnet`) : null;
const BRAIN = process.env.SWARM_MERCHANT_BRAIN === "1";
/** A hotel stay costs more than the fixture cap of 45 dUSDC; 500 is also dUSDC's largest mint. */
export const HOTEL_CAP = 500_000_000;
export const MAX_SETS_GROUP = 5;
/** Measured on testnet (the pilot); `plan` prices a run with these. */
export const MEASURED = { buyerSeconds: 45, nearGrossPerBuyer: 0.125, nearNetPerBuyer: 0.047, nearAiUsdPerBuyer: 0.00015, merchantNearPerRound: 0.004 };

const fact = (set, id, platform, field, value) => ({ id, platform, field, value, proof_ref: sha(`bookerbob swarm synthetic proof v0|${set}|${id}`) });
const claim = (line, text, f) => ({ line, text, citations: [{ fact: f.id, field: f.field, value: f.value }] });
/** The synthetic proof sets a buyer can hold and the bits each reveals. No real user data. */
export const SETS = [
  (() => {
    const f = [fact("frequent", "F1", "airbnb", "trips_12m", 7), fact("frequent", "F2", "booking", "genius_level", 2), fact("frequent", "F3", "anthropic", "monthly_spend_usd", 120), fact("frequent", "F4", "uber", "trips_90d", 4), fact("frequent", "F5", "world_id", "verified", 1)];
    return { name: "frequent", predicates: ["airbnb_frequent", "claude_spender", "world_id_human"], facts: f, claims: [claim("airbnb_frequent", "7 airbnb trips in 12 months", f[0]), claim("claude_spender", "spends 120 a month on claude", f[2]), claim("world_id_human", "one human, one agent", f[4])] };
  })(),
  (() => {
    const f = [fact("traveller", "F1", "airbnb", "trips_12m", 9), fact("traveller", "F2", "booking", "genius_level", 3), fact("traveller", "F3", "uber", "trips_90d", 6), fact("traveller", "F4", "world_id", "verified", 1)];
    return { name: "traveller", predicates: ["airbnb_frequent", "booking_genius", "world_id_human"], facts: f, claims: [claim("airbnb_frequent", "9 airbnb trips in 12 months", f[0]), claim("booking_genius", "booking genius level 3", f[1]), claim("world_id_human", "one human, one agent", f[3])] };
  })(),
  (() => {
    const f = [fact("builder", "F1", "anthropic", "monthly_spend_usd", 200), fact("builder", "F2", "github", "account_age_years", 8), fact("builder", "F3", "steam", "account_age_years", 2), fact("builder", "F4", "world_id", "verified", 1)];
    return { name: "builder", predicates: ["claude_spender", "github_builder", "world_id_human"], facts: f, claims: [claim("claude_spender", "spends 200 a month on claude", f[0]), claim("github_builder", "an old github account", f[1]), claim("world_id_human", "one human, one agent", f[3])] };
  })(),
  (() => {
    const f = [fact("regular", "F1", "uber", "trips_90d", 31), fact("regular", "F2", "steam", "account_age_years", 11), fact("regular", "F3", "airbnb", "trips_12m", 1), fact("regular", "F4", "world_id", "verified", 1)];
    return { name: "regular", predicates: ["steam_veteran", "uber_regular", "world_id_human"], facts: f, claims: [claim("steam_veteran", "an old steam account", f[1]), claim("uber_regular", "31 uber trips in 90 days", f[0]), claim("world_id_human", "one human, one agent", f[3])] };
  })(),
];

// ---------- pure: arguments, planning, the public record ----------

export function parseArgs(argv) {
  const [cmd, tag, ...rest] = argv;
  const a = { cmd, tag, rounds: null, buyers: null, commitMin: 5, revealMin: 5, concurrency: 3, sets: null, sweep: true, faucet: true, log: null };
  const num = { "--rounds": "rounds", "--buyers": "buyers", "--commit-min": "commitMin", "--reveal-min": "revealMin", "--concurrency": "concurrency", "--sets": "sets" };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--no-sweep") a.sweep = false;
    else if (rest[i] === "--no-faucet") a.faucet = false;
    else if (rest[i] === "--log" && rest[i + 1]) a.log = rest[++i];
    else if (num[rest[i]]) {
      const v = Number(rest[++i]);
      if (!Number.isInteger(v) || v < 1) throw new Error(`${rest[i - 1]}: a whole number, at least 1`);
      a[num[rest[i - 1]]] = v;
    } else throw new Error(`unknown option ${rest[i]}`);
  }
  if (!["plan", "run", "retry", "verify"].includes(cmd)) throw new Error("usage: swarm-run.mjs plan|run|retry|verify <tag> [--rounds R --buyers B]");
  // blind-round.mjs takes a tag of at most 24 characters, and the swarm's is <tag>-r<n>.
  if (!/^[a-z0-9][a-z0-9-]{0,17}$/.test(tag ?? "")) throw new Error("tag: 1 to 18 of a-z 0-9 -");
  if (cmd !== "verify" && cmd !== "retry" && a.rounds != null && a.buyers != null) {
    if (a.rounds > 99) throw new Error("--rounds: at most 99");
    if (a.buyers < a.rounds) throw new Error("--buyers: at least one buyer a round");
    if (a.sets != null && a.sets > SETS.length) throw new Error(`--sets: at most ${SETS.length}`);
    if (a.concurrency > 8) throw new Error("--concurrency: at most 8");
  }
  return a;
}

function assign(rounds, buyers, nSets) {
  const out = [];
  const seen = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (let r = 1; r <= rounds; r++) {
    const n = Math.floor(buyers / rounds) + (r <= buyers % rounds ? 1 : 0);
    for (let j = 0; j < n; j++) {
      const ci = (j + r - 1) % CATEGORIES.length;
      const category = CATEGORIES[ci];
      // The second category starts half a turn later, so the sets stay level across both.
      const set = (seen[category]++ + ci * Math.floor(nSets / 2)) % nSets;
      out.push({ i: out.length, round: r, category, set });
    }
  }
  return out;
}

const groupSizes = (slots) => slots.reduce((g, s) => ((g[s.set] = (g[s.set] ?? 0) + 1), g), {});

/** Every buyer of the run: its round, category and proof set. Buyers split evenly across the
 *  rounds and the two categories; as many sets as leave at least 5 buyers on each. */
export function slotsFor({ rounds, buyers, sets = null }) {
  if (sets) return assign(rounds, buyers, sets);
  for (let n = Math.max(1, Math.min(SETS.length, Math.floor(buyers / MAX_SETS_GROUP))); n > 1; n--) {
    const s = assign(rounds, buyers, n);
    if (Math.min(...Object.values(groupSizes(s))) >= MAX_SETS_GROUP) return s;
  }
  return assign(rounds, buyers, 1);
}

/** What a run does and costs. Rounds are prepared ahead while earlier buyers buy. */
export function planOf(p, { merchants = 30, measured = MEASURED } = {}) {
  const slots = slotsFor(p);
  const cycle = (p.commitMin + p.revealMin) * 60;
  let t = 0;
  const per_round = [];
  for (let r = 1; r <= p.rounds; r++) {
    const mine = slots.filter((s) => s.round === r);
    t = Math.max(t, r * cycle) + mine.length * measured.buyerSeconds;
    per_round.push({ round: r, buyers: mine.length, ...Object.fromEntries(CATEGORIES.map((c) => [c, mine.filter((s) => s.category === c).length])) });
  }
  const round6 = (x) => Math.round(x * 1e6) / 1e6;
  return {
    rounds: p.rounds,
    buyers: p.buyers,
    per_round,
    bit_sets: Object.fromEntries(Object.entries(groupSizes(slots)).map(([i, n]) => [SETS[i].name, n])),
    merchant_agents: merchants,
    sealed_bids: merchants * p.rounds,
    reveals: merchants * p.rounds,
    near_ai_calls: p.buyers,
    near_ai_usd: round6(p.buyers * measured.nearAiUsdPerBuyer),
    treasury_near: round6(p.buyers * (p.sweep === false ? measured.nearGrossPerBuyer : measured.nearNetPerBuyer)),
    treasury_float_near: round6((p.concurrency ?? 3) * measured.nearGrossPerBuyer),
    merchant_near_each: round6(p.rounds * measured.merchantNearPerRound),
    est_minutes: Math.ceil(t / 60),
  };
}

/** Error text for the record: no home paths, no key directory, one line, short. */
export function clean(msg) {
  return String(msg ?? "").replaceAll(homedir(), "~").replace(/\S*\.rep-secrets\S*/g, "<keys dir>").replace(/\b([0-9a-f]{12})[0-9a-f]{52}\b/g, "$1..").replace(/\s+/g, " ").trim().slice(0, 240);
}

/** The demo's step names and the record's name for each step's tx. */
export const STEP_TX = { "fund implicit tester": "account", "bazaar storage_deposit": "escrow_entry", "dUSDC storage_deposit": "dusdc_storage", "mint (relayed)": "mint", "attest_human (relayed)": "world", "submit_near_ai_verdict (relayed)": "verdict", "submit_referee_result (relayed)": "receipt", "ft_transfer_call (relayed)": "escrow", "settle_demo (relayed)": "settle" };
/** A buyer's successful txs as an earlier run's log printed them (`[r1 b003 hoodie]    ok <step>  <link>`). */
export function txsFromLog(text, slot) {
  const pre = `[r${slot.round} b${String(slot.i + 1).padStart(3, "0")} ${slot.category.split("-")[0]}]`;
  const out = {};
  for (const l of text.split("\n")) {
    if (!l.startsWith(pre)) continue;
    const m = l.slice(pre.length).match(/^\s+ok (.+?)\s+https:\S+\/txns\/([1-9A-HJ-NP-Za-km-z]{43,44})\s*$/);
    if (m && STEP_TX[m[1]]) out[STEP_TX[m[1]]] = m[2];
  }
  return out;
}

const TX_KEYS = ["account", "escrow_entry", "dusdc_storage", "mint", "world", "verdict", "receipt", "escrow", "settle", "replay", "sweep"];
const pickTxs = (txs = {}) => Object.fromEntries(TX_KEYS.filter((k) => typeof txs[k] === "string").map((k) => [k, txs[k]]));

/** The public record, built field by field from the private state: nothing is copied whole. */
export function buildRecord(st) {
  const rounds = Object.values(st.rounds ?? {}).sort((a, b) => a.n - b.n).map((r) => ({
    n: r.n,
    ready: Boolean(r.ready),
    seconds: r.seconds ?? null,
    categories: CATEGORIES.filter((c) => r.cats?.[c]).map((c) => ({ category: c, round_id: r.cats[c].round_id, open_tx: r.cats[c].open_tx ?? null, commits: r.cats[c].commits ?? 0, reveals: r.cats[c].reveals ?? 0, commit_until_ms: r.cats[c].commit_until_ms, reveal_until_ms: r.cats[c].reveal_until_ms })),
    replay: r.replay ? { nullifier: r.replay.nullifier, tx: r.replay.tx, refused: "nullifier spent" } : null,
    ...(r.note && { note: clean(r.note) }),
    ...(r.decisions && { decisions: Object.entries(r.decisions).map(([m, d]) => (d.skip ? { merchant: m, skip: true, why: clean(d.why) } : { merchant: m, persona: d.persona, unit_cost: d.unit_cost, units_left: d.units_left, asked: { base_price: Number(d.asked?.base_price) || null, cap_bps: Number(d.asked?.cap_bps) || null, rules: Object.entries(d.asked?.discounts ?? {}).map(([predicate, bps]) => ({ predicate: String(predicate).slice(0, 40), bps: Number(bps) || 0 })) }, bid: { base_price: String(d.schedule.base_price), cap_bps: d.schedule.cap_bps, rules: d.schedule.rules }, why: clean(d.why), model: d.model, chat_id: d.chat_id, tee_signed: d.tee_signed, signer: d.signer, ...(d.signature && { signed_text: d.signed_text, signature: d.signature }) })) }),
  }));
  const purchases = [];
  const failures = [];
  for (const s of st.slots ?? []) {
    if (s.status === "settled" && s.rec) {
      const x = s.rec;
      purchases.push({ round: s.round, round_id: x.round_id, category: s.category, bit_set: SETS[s.set].name, predicates: [...SETS[s.set].predicates], buyer: x.buyer, nullifier: x.nullifier, merchant: x.merchant, price: String(x.price), model: x.model, chat_id: x.chat_id, seconds: x.seconds ?? null, retried: s.attempts.some((a) => a.error), ...(s.moved_from && { first_round: s.moved_from }), txs: pickTxs(x.txs) });
    }
    for (const a of s.attempts ?? []) if (a.error) failures.push({ round: s.round, category: s.category, bit_set: SETS[s.set].name, buyer: a.buyer ?? null, step: a.step ?? null, error: clean(a.error), retried: s.status === "settled" });
  }
  for (const r of Object.values(st.rounds ?? {})) if (r.error) failures.push({ round: r.n, category: null, bit_set: null, buyer: null, step: "round", error: clean(r.error), retried: Boolean(r.ready) });
  const merchants = new Set(Object.values(st.rounds ?? {}).flatMap((r) => Object.values(r.cats ?? {}).flatMap((c) => c.revealed ?? [])));
  const volume = purchases.reduce((n, p) => n + BigInt(p.price), 0n);
  const sum = (f) => rounds.reduce((n, r) => n + r.categories.reduce((m, c) => m + f(c), 0), 0);
  const ai = st.near_ai ?? {};
  return {
    note: "A swarm on NEAR testnet: the registered merchant agents bid sealed in fresh rounds; each buyer agent is a fresh account whose verdict a NEAR AI model issued under E2EE v2 (submit_near_ai_verdict), and it bought from its round's winner for that verdict (round_best_quote), paid in dUSDC, a testnet demo token with no value. Every proof set is synthetic. `node scripts/swarm-run.mjs verify <tag>` re-reads this from public RPC.",
    tag: st.tag,
    network: "testnet",
    bazaar: st.bazaar,
    dusdc: st.dusdc,
    relayer: st.treasury_id,
    explorer: EXPLORER,
    started_at: new Date(st.created_ms).toISOString(),
    updated_at: new Date(st.updated_ms ?? st.created_ms).toISOString(),
    complete: Boolean(st.complete),
    dusdc_registrations: (st.registered ?? []).map((x) => ({ merchant: x.merchant, tx: x.tx })),
    stopped: st.stopped ? clean(st.stopped) : null,
    plan: { rounds: st.params.rounds, buyers: st.params.buyers, commit_min: st.params.commitMin, reveal_min: st.params.revealMin },
    rounds,
    purchases,
    failures,
    totals: {
      merchant_agents: merchants.size,
      buyer_agents: new Set([...purchases.map((p) => p.buyer), ...failures.map((f) => f.buyer).filter(Boolean)]).size,
      rounds: rounds.filter((r) => r.ready).length,
      sealed_bids: sum((c) => c.commits),
      reveals: sum((c) => c.reveals),
      model_verdicts: ai.calls ?? 0,
      purchases_settled: purchases.length,
      dusdc_volume: (Number(volume) / 1e6).toFixed(2),
      refused_replays: rounds.filter((r) => r.replay).length,
      failures: failures.length,
      failures_first_pass: (st.slots ?? []).filter((s) => s.attempts?.[0]?.error).length,
      retried_ok: (st.slots ?? []).filter((s) => s.attempts?.[0]?.error && s.status === "settled").length,
      failures_final: (st.slots ?? []).filter((s) => s.status !== "settled").length,
      near_ai_calls: (ai.calls ?? 0) + (ai.failed ?? 0),
      near_ai_cost_usd: Number((ai.usd ?? 0).toFixed(6)),
      near_ai_cost_basis: ai.estimated ? "about $0.001 a call (no usage in the answers)" : "token usage in each answer at the model's listed price",
      treasury_near_spent: Number(yoctoToNear(st.treasury?.spent_yocto ?? "0").toFixed(4)),
      faucet_near: (st.treasury?.topups ?? []).reduce((n, t) => n + t.near, 0),
      wall_time_s: Math.round((st.wall_ms ?? 0) / 1000),
    },
  };
}

const HEX64 = /^[0-9a-f]{64}$/;
const SECRET_KEY = /seed|secret|salt|priv|token|passw|response_key|signing_key|evaluator|facts|proof|citation|api_?key|bearer|^key$|^dir$/i;
const RECORD_KEYS = new Set([
  "note", "tag", "network", "bazaar", "dusdc", "relayer", "explorer", "started_at", "updated_at", "complete", "dusdc_registrations", "first_round", "failures_first_pass", "retried_ok", "failures_final", "stopped", "plan", "rounds", "purchases", "failures", "totals",
  "buyers", "commit_min", "reveal_min", "n", "ready", "seconds", "categories", "replay", "category", "round_id", "open_tx", "commits", "reveals", "commit_until_ms", "reveal_until_ms", "nullifier", "tx", "refused",
  "round", "bit_set", "predicates", "buyer", "merchant", "price", "model", "chat_id", "txs", ...TX_KEYS, "step", "error", "retried",
  "decisions", "skip", "why", "persona", "unit_cost", "units_left", "asked", "base_price", "cap_bps", "rules", "predicate", "bps", "bid", "tee_signed", "signer", "signed_text", "signature",
  "merchant_agents", "buyer_agents", "sealed_bids", "model_verdicts", "purchases_settled", "dusdc_volume", "refused_replays", "near_ai_calls", "near_ai_cost_usd", "near_ai_cost_basis", "treasury_near_spent", "faucet_near", "wall_time_s",
]);

/** Throws unless `record` holds only the public fields above: any other key, a secret-looking
 *  key, a 32-byte hex value outside buyer and nullifier, or a key path stops the write. */
export function assertPublic(record, path = "record") {
  if (Array.isArray(record)) return record.forEach((v, i) => assertPublic(v, `${path}[${i}]`));
  if (record && typeof record === "object") {
    for (const [k, v] of Object.entries(record)) {
      if (SECRET_KEY.test(k) || !RECORD_KEYS.has(k)) throw new Error(`${path}.${k}: not a field of the public record`);
      if (typeof v === "string" && HEX64.test(v) && !["buyer", "nullifier", "signer"].includes(k)) throw new Error(`${path}.${k}: a 32-byte hex value does not belong here`);
      assertPublic(v, `${path}.${k}`);
    }
    return;
  }
  if (typeof record === "string" && (/\.rep-secrets|\/Users\/|ed25519:[1-9A-HJ-NP-Za-km-z]{80,}|Bearer\s|sk-[A-Za-z0-9]{16,}/.test(record) || /\b[0-9a-f]{64}\b/.test(record) && !HEX64.test(record))) throw new Error(`${path}: looks like a key or a private path`);
}

/** The record's totals re-derived from its own rows; a list of what does not add up. */
export function recordProblems(rec) {
  const bad = [];
  const eq = (name, got, want) => { if (String(got) !== String(want)) bad.push(`totals.${name} is ${got}, the rows give ${want}`); };
  const cats = rec.rounds.flatMap((r) => r.categories);
  eq("purchases_settled", rec.totals.purchases_settled, rec.purchases.length);
  eq("sealed_bids", rec.totals.sealed_bids, cats.reduce((n, c) => n + c.commits, 0));
  eq("reveals", rec.totals.reveals, cats.reduce((n, c) => n + c.reveals, 0));
  eq("rounds", rec.totals.rounds, rec.rounds.filter((r) => r.ready).length);
  eq("refused_replays", rec.totals.refused_replays, rec.rounds.filter((r) => r.replay).length);
  eq("failures", rec.totals.failures, rec.failures.length);
  eq("retried_ok", rec.totals.retried_ok, rec.purchases.filter((p) => p.retried).length);
  eq("failures_final", rec.totals.failures_final, rec.plan.buyers - rec.purchases.length);
  eq("dusdc_volume", rec.totals.dusdc_volume, (Number(rec.purchases.reduce((n, p) => n + BigInt(p.price), 0n)) / 1e6).toFixed(2));
  if (new Set(rec.purchases.map((p) => p.nullifier)).size !== rec.purchases.length) bad.push("a nullifier appears twice");
  if (new Set(rec.purchases.map((p) => p.buyer)).size !== rec.purchases.length) bad.push("a buyer appears twice");
  const ids = new Set(cats.map((c) => c.round_id));
  for (const p of rec.purchases) if (!ids.has(p.round_id)) bad.push(`purchase ${p.nullifier.slice(0, 12)} names round ${p.round_id}, which the record does not list`);
  return bad;
}

/** At most `max` txs to look up: every refused replay, then settles spread across the run. */
export function sampleTxs(rec, max = 25) {
  const out = rec.rounds.filter((r) => r.replay).map((r) => ({ kind: "replay", hash: r.replay.tx, nullifier: r.replay.nullifier })).slice(0, Math.floor(max / 2));
  const settles = rec.purchases.filter((p) => p.txs.settle);
  const room = Math.min(max - out.length, settles.length);
  for (let i = 0; i < room; i++) {
    const p = settles[Math.floor((i * settles.length) / room)];
    out.push({ kind: "settle", hash: p.txs.settle, nullifier: p.nullifier });
  }
  return out;
}

// ---------- live ----------

const TRANSIENT = /fetch failed|RPC kept failing|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|aborted|timeout|timed out|terminated|Unexpected (token|end)|chat HTTP (429|5\d\d)|other side closed/i;
const mutex = () => {
  let tail = Promise.resolve();
  return (fn) => {
    const r = tail.then(fn);
    tail = r.catch(() => {});
    return r;
  };
};

/** rpcClient whose calls survive a dropped connection or a timeout. Every call is a read or
 *  the same signed tx again (same hash), so a repeat is safe. */
function steadyClient(url) {
  const inner = rpcClient(url);
  const wrap = (f) => async (...args) => {
    for (let i = 0; ; i++) {
      try {
        return await f(...args);
      } catch (e) {
        if (i >= 5 || !TRANSIENT.test(String(e?.message ?? e)) || /panicked|HostError/.test(String(e?.message))) throw e;
        await sleep(2000 * (i + 1));
      }
    }
  };
  return Object.fromEntries(Object.entries(inner).map(([k, f]) => [k, wrap(f)]));
}

const fc = (method_name, args, deposit = 0n, gas = 100n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });

/** The demo tester, as a swarm buyer. See the header for what differs and why. */
class SwarmBuyer extends Demo {
  constructor(c, shared, hooks) {
    super(c);
    this.client = shared.client;
    this.shared = shared;
    this.hooks = hooks;
    this.treasury = shared.treasuryKey;
  }
  /** No daily cap here, on purpose (the cap guards the public demo's KEYS_DIR/testers). */
  async preflight() {
    mkdirSync(this.c.testersDir, { recursive: true, mode: 0o700 });
  }
  /** One treasury key, one nonce: everything the treasury or the relayer signs goes in line. */
  async direct(step, signer_id, key, receiver_id, actions, o) {
    const go = () => super.direct(step, signer_id, key, receiver_id, actions, o);
    return signer_id === this.c.treasury ? this.shared.treasuryLock(go) : go();
  }
  async relay(step, tester, receiver_id, action) {
    this.tester = tester;
    this.step = step;
    return super.relay(step, tester, receiver_id, action);
  }
  /** The demo's steps 11 to 13 are a Shopify order, a replay and a review group. The swarm
   *  writes no order and joins no group; one buyer a round tries the replay. */
  async finish(rec, tester, dir, save) {
    if (!this.hooks.claimReplay()) return rec;
    try {
      const verdict = JSON.parse(readFileSync(join(dir, "live", "verdict-replay.json"), "utf8"));
      const r = await this.direct("replay refused", this.c.treasury, this.treasury, this.c.bazaar, [fc("submit_verdict", { verdict }, 50n * MILLI)], { expectFail: "nullifier spent" });
      rec.txs.replay = r.hash;
      save();
      this.hooks.replayDone({ nullifier: rec.nullifier, tx: r.hash });
    } catch (e) {
      this.hooks.replayDone(null, e);
    }
    return rec;
  }
  /** The buyer's own key sends what it did not spend back to the treasury. */
  async sweep() {
    const t = this.tester;
    if (!t) return null;
    const a = await this.client.account(t.id);
    const keep = near(0.005);
    if (!a || BigInt(a.amount) < keep + near(0.01)) return null;
    const r = await send(this.client, { signer_id: t.id, key: t.key, receiver_id: this.c.treasury, actions: [{ type: "Transfer", deposit: BigInt(a.amount) - keep }] });
    return r.ok ? r.hash : null;
  }
}

function child(args, prefix, cwd = process.cwd()) {
  return new Promise((done) => {
    // near-cli's `testnet` is the archival RPC, which rate-limits: sign through fastnear's.
    const p = spawn("node", [join(process.cwd(), "scripts/blind-round.mjs"), ...args], { cwd, env: { NEAR_CLI_NETWORK: "testnet-fastnear", ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const on = (b) => {
      out += b;
      for (const l of String(b).split("\n")) if (l.trim()) console.log(`${prefix} ${l.trim()}`);
    };
    p.stdout.on("data", on);
    p.stderr.on("data", on);
    p.on("close", (code) => done({ code, out }));
  });
}

async function run(a) {
  const c = config(process.env);
  const no = guard(c);
  if (no) {
    console.error(`refusing: ${no}`);
    process.exit(2);
  }
  const { issue } = await import("./model-buy.mjs");
  const swarmDir = join(c.keysDir, "swarm");
  const buyersDir = join(swarmDir, a.tag, "buyers");
  mkdirSync(buyersDir, { recursive: true, mode: 0o700 });
  const statePath = join(swarmDir, `${a.tag}.json`);
  const recordPath = `fixtures/live/swarm/${a.tag}.json`;
  const merchants = JSON.parse(readFileSync("agents/merchants.json", "utf8")).filter((m) => CATEGORIES.includes(m.category) && (!ONLY_MERCHANTS || ONLY_MERCHANTS.includes(m.account)));
  const expected = Object.fromEntries(CATEGORIES.map((cat) => [cat, merchants.filter((m) => m.category === cat).length]));

  let st;
  if (a.cmd === "retry" && !existsSync(statePath)) throw new Error(`no run ${a.tag} to retry`);
  if (existsSync(statePath)) {
    st = JSON.parse(readFileSync(statePath, "utf8"));
    if ((a.rounds && a.rounds !== st.params.rounds) || (a.buyers && a.buyers !== st.params.buyers)) throw new Error(`tag ${a.tag} is a run of ${st.params.rounds} rounds and ${st.params.buyers} buyers: rerun it with those, or pick another tag`);
    // A buyer cut off mid-way is not resumed: its slot gets a fresh buyer.
    for (const s of st.slots) if (s.status === "running") {
      s.status = "failed";
      const last = s.attempts.at(-1);
      if (last && !last.error) last.error = "interrupted: the run stopped while this buyer was buying";
    }
    for (const r of Object.values(st.rounds)) delete r.replaying;
    console.log(`resuming ${a.tag}: ${st.slots.filter((s) => s.status === "settled").length} of ${st.slots.length} buyers settled`);
  } else {
    if (!a.rounds || !a.buyers) throw new Error("a new run needs --rounds and --buyers");
    const params = { rounds: a.rounds, buyers: a.buyers, commitMin: a.commitMin, revealMin: a.revealMin };
    st = { tag: a.tag, bazaar: c.bazaar, dusdc: c.dusdc, treasury_id: c.treasury, created_ms: Date.now(), params, wall_ms: 0, near_ai: { calls: 0, failed: 0, usd: 0, prompt_tokens: 0, completion_tokens: 0 }, treasury: { spent_yocto: "0", topups: [] }, rounds: {}, slots: slotsFor({ ...params, sets: a.sets }).map((s) => ({ ...s, status: "todo", attempts: [] })) };
  }
  delete st.stopped;
  const save = () => {
    st.updated_ms = Date.now();
    writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n", { mode: 0o600 });
    chmodSync(statePath, 0o600);
  };
  const writeRecord = () => {
    const rec = buildRecord(st);
    try {
      assertPublic(rec);
      mkdirSync("fixtures/live/swarm", { recursive: true });
      writeFileSync(recordPath, JSON.stringify(rec, null, 2) + "\n");
    } catch (e) {
      // A record that fails its own privacy check is never written; the run goes on.
      console.error(`RECORD NOT WRITTEN: ${e.message}`);
      st.record_error = e.message;
    }
    return rec;
  };
  save();

  // Each buyer's lines carry its name; the demo's own steps print through console.log.
  const als = new AsyncLocalStorage();
  const plain = console.log.bind(console);
  console.log = (...x) => (als.getStore() ? plain(als.getStore(), ...x) : plain(...x));

  // No call may hang the line behind it: every request gives up after two minutes.
  const rawFetch = globalThis.fetch;
  globalThis.fetch = (u, o = {}) => rawFetch(u, o.signal ? o : { ...o, signal: AbortSignal.timeout(120_000) });
  const client = steadyClient(c.rpc);
  const shared = { client, treasuryLock: mutex(), aiLock: mutex(), fundLock: mutex(), treasuryKey: keyFromSeed(readFileSync(join(c.keysDir, "treasury.seed"), "utf8")), stop: null };
  if ((await client.view(c.bazaar, "demo_token")) !== c.dusdc) throw new Error(`bazaar does not accept ${c.dusdc}`);
  const balance = async () => BigInt((await client.account(c.treasury))?.amount ?? 0);
  const t0 = Date.now();
  const before = await balance();
  let faucetIn = 0n;
  console.log(`swarm ${a.tag} on testnet: ${st.params.rounds} rounds, ${st.params.buyers} buyers; treasury ${yoctoToNear(before).toFixed(3)} NEAR`);
  process.on("SIGINT", () => {
    if (shared.stop) process.exit(130);
    shared.stop = "interrupted";
    console.log("\nstopping: buyers in flight finish first (again to quit now)");
  });

  /** The model's listed price per token, once. */
  let price;
  const priceOf = async (model) => {
    if (price !== undefined) return price;
    try {
      const key = (process.env.NEAR_AI_KEY ?? readFileSync(join(homedir(), ".rep-secrets", "near-ai.key"), "utf8")).trim();
      const list = await fetch(`${AI_API}/models`, { headers: { Authorization: `Bearer ${key}` } }).then((r) => r.json());
      const m = list.data.find((x) => x.id === model);
      price = m ? { in: Number(m.pricing.prompt), out: Number(m.pricing.completion) } : null;
    } catch {
      price = null;
    }
    return price;
  };

  /** 10 testnet NEAR from the public faucet, through a fresh account, into the treasury. */
  async function topUp() {
    const id = `bbswarm-${randomBytes(5).toString("hex")}.testnet`;
    const seed = randomBytes(32).toString("hex");
    const seedPath = join(swarmDir, `faucet-${id}.seed`);
    writeFileSync(seedPath, seed + "\n", { mode: 0o600 });
    chmodSync(seedPath, 0o600);
    const key = keyFromSeed(seed);
    const f = await fetch(FAUCET, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: nearPublicKey(key.pub) }) });
    if (!f.ok) throw new Error(`the testnet faucet refused: HTTP ${f.status} ${(await f.text()).slice(0, 120)}`);
    let acct = null;
    for (let i = 0; i < 20 && !(acct = await client.account(id)); i++) await sleep(1500);
    if (!acct) throw new Error(`the faucet account ${id} did not appear`);
    const amount = BigInt(acct.amount) - near(0.05);
    const r = await send(client, { signer_id: id, key, receiver_id: c.treasury, actions: [{ type: "Transfer", deposit: amount }] });
    if (!r.ok) throw new Error(`faucet transfer failed: ${r.error}`);
    faucetIn += amount;
    st.treasury.topups.push({ account: id, tx: r.hash, near: yoctoToNear(amount) });
    save();
    console.log(`   ok treasury topped up with ${yoctoToNear(amount).toFixed(2)} testnet NEAR from the faucet  ${EXPLORER}${r.hash}`);
  }
  const fundsOk = () => shared.fundLock(async () => {
    const need = TREASURY_MIN + near(0.15) * BigInt(a.concurrency);
    if ((await balance()) >= need) return true;
    if (a.faucet) {
      try {
        await topUp();
        if ((await balance()) >= need) return true;
      } catch (e) {
        console.log(`   faucet: ${clean(e.message)}`);
      }
    }
    shared.stop ??= `treasury under ${yoctoToNear(need).toFixed(2)} NEAR`;
    return false;
  });

  async function prepareRound(n) {
    const r = (st.rounds[n] ??= { n, blind_tag: `${a.tag}-r${n}`, cats: {} });
    if (r.ready) return;
    const CATS = r.only ?? CATEGORIES;
    // A round for one category: blind-round bids for the merchants its agents/merchants.json lists.
    let cwd = process.cwd();
    if (r.only || ONLY_MERCHANTS || BRAIN) {
      cwd = join(swarmDir, a.tag, `round-${n}`);
      mkdirSync(join(cwd, "agents"), { recursive: true });
      let bidders = merchants.filter((m) => CATS.includes(m.category));
      if (BRAIN) {
        // Decided once and kept: a rerun must commit and reveal the same bid.
        if (!r.decisions) {
          const { decideRound } = await import("./merchant-brain.mjs");
          const seen = [...new Set((st.slots ?? []).map((x) => x.set))].map((i) => SETS[i].predicates);
          r.decisions = await decideRound({ n, rounds: st.params.rounds, merchants: bidders, stRounds: st.rounds, purchases: buildRecord(st).purchases, bitSets: seen });
          save();
          for (const [m, d] of Object.entries(r.decisions)) console.log(`[r${n}] ${m.split(".")[0]} ${d.skip ? "sits out: " + d.why : `bids base ${d.schedule.base_price / 1e6}, ${d.schedule.rules.map((q) => `${q.predicate} -${q.bps / 100}%`).join(", ") || "no discounts"}, cap ${d.schedule.cap_bps / 100}%${d.tee_signed ? ", TEE-signed" : ", SIGNATURE NOT CHECKED"}: ${d.why}`}`);
        }
        bidders = bidders.filter((m) => r.decisions[m.account] && !r.decisions[m.account].skip).map((m) => ({ ...m, schedule: r.decisions[m.account].schedule }));
      }
      writeFileSync(join(cwd, "agents", "merchants.json"), JSON.stringify(bidders));
    }
    const started = Date.now();
    const pre = `[r${n}]`;
    const look = async () => {
      for (const cat of CATS) {
        const round_id = `${r.blind_tag}-${cat}`;
        const info = await client.view(c.bazaar, "round", { round_id });
        if (info) r.cats[cat] = { ...r.cats[cat], round_id, commits: info.commits.length, reveals: info.revealed.length, revealed: info.revealed, commit_until_ms: info.commit_until_ms, reveal_until_ms: info.reveal_until_ms };
      }
      save();
      return Object.values(r.cats);
    };
    const blindState = () => {
      const p = join(c.keysDir, "rounds", `${r.blind_tag}.json`);
      return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
    };
    let cats = await look();
    if (!cats.length) {
      // Never opened twice: a second `open` would move the deadlines blind-round waits on.
      await child(["open", r.blind_tag, String(st.params.commitMin), String(st.params.revealMin)], pre, cwd);
      cats = await look();
      for (const cat of CATS) if (r.cats[cat]) r.cats[cat].open_tx ??= blindState()?.rounds?.[cat]?.open_tx ?? null;
      if (cats.length < CATS.length) {
        // Once more for a category that did not open; the one that did answers "round exists".
        console.log(`${pre} ${CATS.filter((cat) => !r.cats[cat]).join(", ")} did not open: once more`);
        await sleep(4000);
        await child(["open", r.blind_tag, String(st.params.commitMin), String(st.params.revealMin)], pre, cwd);
        cats = await look();
      }
      if (!cats.length) throw new Error("open_round failed");
    }
    for (const cat of CATS) if (r.cats[cat]) r.cats[cat].open_tx ??= blindState()?.rounds?.[cat]?.open_tx ?? null;
    const commitUntil = Math.max(...cats.map((x) => x.commit_until_ms));
    const revealUntil = Math.max(...cats.map((x) => x.reveal_until_ms));
    const short = (f) => CATS.some((cat) => r.cats[cat] && f(r.cats[cat], expected[cat]));
    if (short((x, want) => x.commits < want) && Date.now() < commitUntil - 5000) {
      const t = Date.now();
      await child(["commit", r.blind_tag], pre, cwd);
      r.commit_seconds = Math.round((Date.now() - t) / 1000);
      await look();
      if (short((x, want) => x.commits < want) && Date.now() < commitUntil - 15000) {
        await child(["commit", r.blind_tag], pre, cwd);
        await look();
      }
    }
    if (short((x) => x.reveals < x.commits) && Date.now() < revealUntil - 5000) {
      const wait = Math.max(0, commitUntil + 5000 - Date.now());
      const t = Date.now() + wait;
      await child(["reveal", r.blind_tag], pre, cwd);
      r.reveal_seconds = Math.round((Date.now() - t) / 1000);
      await look();
      if (short((x) => x.reveals < x.commits) && Date.now() < revealUntil - 15000) {
        await child(["reveal", r.blind_tag], pre, cwd);
        await look();
      }
    }
    if (short((x) => x.reveals < x.commits)) r.error = `${CATS.map((cat) => `${cat}: ${r.cats[cat]?.reveals ?? 0} of ${r.cats[cat]?.commits ?? 0} sealed bids opened`).join("; ")}`;
    // round_best_quote answers only after the reveal deadline, by the chain's clock.
    const wait = revealUntil + 8000 - Date.now();
    if (wait > 0) {
      console.log(`${pre} ${CATS.map((cat) => `${cat} ${r.cats[cat]?.commits ?? 0} sealed, ${r.cats[cat]?.reveals ?? 0} opened`).join("; ")}; ${Math.ceil(wait / 1000)} s to the reveal deadline`);
      await sleep(wait);
    }
    await look();
    r.ready = true;
    r.seconds = (r.seconds ?? 0) + Math.round((Date.now() - started) / 1000);
    save();
    writeRecord();
  }

  async function buyer(slot, attempt) {
    const round = st.rounds[slot.round];
    const cat = round.cats[slot.category];
    if (!cat?.reveals) throw new Error(`round ${slot.round} has no opened bid in ${slot.category}`);
    const set = SETS[slot.set];
    const hotel = slot.category !== "hoodie";
    const fx = join(buyersDir, "fx", `b${slot.i}-${slot.attempts.length}`);
    mkdirSync(fx, { recursive: true, mode: 0o700 });
    writeFileSync(join(fx, "proofs.json"), JSON.stringify({ facts: set.facts }, null, 2) + "\n", { mode: 0o600 });
    writeFileSync(join(fx, "claims-honest.json"), JSON.stringify(set.claims, null, 2) + "\n", { mode: 0o600 });
    // `merchant` is a placeholder until the verdict is on chain: the round names the winner.
    const bc = { ...c, testersDir: buyersDir, merchant: merchants.find((m) => m.category === slot.category).account, category: hotel ? "hotel" : "hoodie" };
    const d = new SwarmBuyer(bc, shared, {
      claimReplay: () => !round.replay && !round.replaying && (round.replaying = true),
      replayDone: (r, e) => {
        round.replaying = false;
        if (r) round.replay = r;
        else console.log(`   replay not recorded: ${clean(e.message)}`);
        save();
      },
    });
    const ai = {};
    try {
      const rec = await d.run({
        implicit: true,
        proofs: join(fx, "proofs.json"),
        rehearsal: true,
        fixturesDir: fx,
        ...(hotel && { mint: HOTEL_CAP }),
        // The model rules on this buyer's set; the envelope it binds reveals that set's bits.
        nearAi: (base) => shared.aiLock(async () => {
          attempt.buyer = d.tester?.id;
          const env = { ...base, predicates: [...set.predicates].sort(), ...(hotel && { max_spend: typeof base.max_spend === "string" ? String(HOTEL_CAP) : HOTEL_CAP }) };
          for (let i = 0; ; i++) {
            try {
              const out = await issue(client, c.bazaar, env, join(fx, "proofs.json"), c.keysDir);
              const u = JSON.parse(out.proof.response).usage;
              const p = await priceOf(out.record.model);
              st.near_ai.calls++;
              if (u && p) {
                st.near_ai.prompt_tokens += u.prompt_tokens ?? 0;
                st.near_ai.completion_tokens += u.completion_tokens ?? 0;
                st.near_ai.usd += (u.prompt_tokens ?? 0) * p.in + (u.completion_tokens ?? 0) * p.out;
              } else {
                st.near_ai.estimated = true;
                st.near_ai.usd += MEASURED.nearAiUsdPerBuyer;
              }
              Object.assign(ai, { model: out.record.model, chat_id: out.record.chat_id });
              return out;
            } catch (e) {
              if (/credits exhausted/.test(e.message)) {
                shared.stop ??= "NEAR AI credits exhausted (402)";
                throw e;
              }
              st.near_ai.failed++;
              if (i >= 2 || !TRANSIENT.test(e.message)) throw e;
              await sleep(3000 * (i + 1));
            }
          }
        }),
        beforeReceipt: async ({ rec }) => {
          let w;
          for (let i = 0; ; i++) {
            try {
              w = await client.view(c.bazaar, "round_best_quote", { round_id: cat.round_id, nullifier: rec.nullifier });
              break;
            } catch (e) {
              // The chain's clock can trail ours by a few blocks at the deadline.
              if (i >= 6 || !/round still open/.test(e.message)) throw e;
              await sleep(5000);
            }
          }
          if (!w?.merchant) throw new Error(`round ${cat.round_id} names no winner for this verdict`);
          const schedule = (await client.view(c.bazaar, "round_bid", { round_id: cat.round_id, merchant: w.merchant })) ?? (await client.view(c.bazaar, "merchant", { merchant: w.merchant })).schedule;
          writeFileSync(join(fx, "merchants.json"), JSON.stringify([{ account: w.merchant, label: "round winner", category: slot.category, schedule }], null, 2) + "\n");
          bc.merchant = w.merchant;
          rec.merchant = w.merchant;
          console.log(`   round ${cat.round_id}: winner ${w.merchant.split(".")[0]} at ${Number(w.quote.price) / 1e6} dUSDC for ${set.predicates.join(", ")}`);
        },
      });
      const v = await client.view(c.bazaar, "verdict", { nullifier: rec.nullifier });
      if (!v?.spent || !String(v.issuer).startsWith("near-ai:")) throw new Error(`the verdict on chain is not a spent model verdict (issuer ${v?.issuer}, spent ${v?.spent})`);
      return { buyer: rec.tester, nullifier: rec.nullifier, merchant: rec.merchant, price: String(rec.price), round_id: cat.round_id, ...ai, txs: rec.txs, dir: rec.dir };
    } catch (e) {
      attempt.buyer ??= d.tester?.id;
      attempt.step = d.log.at(-1)?.step ?? d.step ?? "account";
      // What is already on chain, for `retry`: it settles this buyer instead of starting another.
      attempt.txs = Object.fromEntries(d.log.filter((l) => l.ok && STEP_TX[l.step]).map((l) => [STEP_TX[l.step], l.hash]));
      Object.assign(attempt, ai);
      throw e;
    } finally {
      if (a.sweep) {
        const tx = await d.sweep().catch(() => null);
        if (tx) attempt.sweep = tx;
      }
    }
  }

  async function slotRun(slot) {
    if (shared.stop || !(await fundsOk())) return;
    const attempt = { at: new Date().toISOString() };
    slot.attempts.push(attempt);
    slot.status = "running";
    save();
    const t = Date.now();
    await als.run(`[r${slot.round} b${String(slot.i + 1).padStart(3, "0")} ${slot.category.split("-")[0]}]`, async () => {
      try {
        slot.rec = await buyer(slot, attempt);
        slot.rec.seconds = Math.round((Date.now() - t) / 1000);
        if (attempt.sweep) slot.rec.txs.sweep = attempt.sweep;
        slot.status = "settled";
        console.log(`SETTLED ${Number(slot.rec.price) / 1e6} dUSDC to ${slot.rec.merchant.split(".")[0]} in ${slot.rec.seconds} s`);
      } catch (e) {
        slot.status = "failed";
        attempt.error = clean(e.message);
        console.log(`FAILED at ${attempt.step}: ${attempt.error}`);
      }
    });
    attempt.seconds = Math.round((Date.now() - t) / 1000);
    save();
    writeRecord();
  }

  /** Merchants are paid in dUSDC: a winner whose payout account has no dUSDC registration
   *  makes settle_demo panic ("receiver not registered"). Checked, and fixed, before any buyer. */
  async function registerPayouts() {
    st.registered ??= [];
    for (const m of merchants) {
      const payout = (await client.view(c.bazaar, "merchant", { merchant: m.account }))?.payout ?? m.account;
      if (await client.view(c.dusdc, "storage_balance_of", { account_id: payout })) continue;
      const r = await shared.treasuryLock(() => send(client, { signer_id: c.treasury, key: shared.treasuryKey, receiver_id: c.dusdc, actions: [fc("storage_deposit", { account_id: payout, registration_only: true }, 1250n * 10n ** 18n, 30n * TGAS)] }));
      if (!r.ok) throw new Error(`dUSDC storage_deposit for ${payout}: ${r.error}`);
      st.registered.push({ merchant: m.account, tx: r.hash });
      save();
      console.log(`   ok dUSDC registration for ${m.account.split(".")[0]}  ${EXPLORER}${r.hash}`);
    }
  }

  /** A buyer that failed at settle_demo has its verdict, receipt and escrow on chain: settle it. */
  async function resumeSettle(slot) {
    const first = slot.attempts.at(-1);
    const id = first.buyer;
    const file = JSON.parse(readFileSync(join(buyersDir, `${id}.json`), "utf8"));
    const dir = join(buyersDir, file.dir);
    const tester = { id, key: keyFromSeed(readFileSync(join(dir, "account.seed"), "utf8")) };
    const nullifier = JSON.parse(readFileSync(join(dir, "live", "verdict.json"), "utf8")).envelope.nullifier;
    const cat = st.rounds[slot.round].cats[slot.category];
    const w = await client.view(c.bazaar, "round_best_quote", { round_id: cat.round_id, nullifier });
    let v = await client.view(c.bazaar, "verdict", { nullifier });
    if (!v || v.agent !== id || !String(v.issuer).startsWith("near-ai:")) throw new Error("no model verdict of this buyer on chain");
    const attempt = { at: new Date().toISOString(), buyer: id, resumed: "settle_demo" };
    slot.attempts.push(attempt);
    const txs = { ...(a.log && existsSync(a.log) ? txsFromLog(readFileSync(a.log, "utf8"), slot) : {}), ...first.txs };
    if (first.sweep) txs.sweep = first.sweep;
    try {
      if (!v.spent) {
        const d = new SwarmBuyer({ ...c, testersDir: buyersDir, merchant: w.merchant }, shared, {});
        d.implicit = new Set([id]);
        const s = await d.relay("settle_demo", tester, c.bazaar, fc("settle_demo", { nullifier, merchant: w.merchant, checkout_ref: `demo-${file.dir.slice(-6)}`, amount: String(w.quote.price) }, 0n, 150n * TGAS));
        if (s.logs.some((l) => l.includes("settle_reverted"))) throw new Error("the dUSDC payout failed and the settle was reverted");
        txs.settle = s.hash;
        v = await client.view(c.bazaar, "verdict", { nullifier });
      }
      if (!v.spent) throw new Error("the nullifier is not spent after settle_demo");
      let chat_id = first.chat_id ?? null;
      if (!chat_id && txs.verdict) {
        const o = outcome(await client.rpc("tx", { tx_hash: txs.verdict, sender_account_id: c.treasury, wait_until: "FINAL" }));
        chat_id = o.logs.map((l) => (l.startsWith("EVENT_JSON:") ? JSON.parse(l.slice(11)) : null)).find((e) => e?.event === "near_ai_verdict")?.data?.[0]?.chat_id ?? null;
      }
      const model = first.model ?? (await client.view(c.bazaar, "model_attestation", { signing_key: v.issuer.slice(8) }))?.model;
      slot.rec = { buyer: id, nullifier, merchant: w.merchant, price: String(w.quote.price), round_id: cat.round_id, model, chat_id, seconds: first.seconds ?? null, txs, dir: file.dir };
      slot.status = "settled";
      console.log(`SETTLED on retry: ${Number(w.quote.price) / 1e6} dUSDC to ${w.merchant.split(".")[0]}`);
    } catch (e) {
      attempt.error = clean(e.message);
      attempt.step = "settle_demo (relayed)";
      console.log(`FAILED again: ${attempt.error}`);
    }
    save();
    writeRecord();
  }

  await registerPayouts();
  for (const slot of st.slots) {
    const last = slot.attempts.at(-1);
    if (slot.status === "failed" && last?.buyer && String(last.step).startsWith("settle_demo") && slot.attempts.length < 3 && !shared.stop) await als.run(`[r${slot.round} b${String(slot.i + 1).padStart(3, "0")} ${slot.category.split("-")[0]}]`, () => resumeSettle(slot).catch((e) => console.log(`not retried: ${clean(e.message)}`)));
  }
  // Buyers whose category never opened in their round get one extra round of that category.
  for (const cat of CATEGORIES) {
    const lost = st.slots.filter((s) => s.status === "failed" && s.category === cat && !s.moved_from && st.rounds[s.round]?.ready && !st.rounds[s.round].cats[cat]);
    if (!lost.length) continue;
    const n = Math.max(...Object.keys(st.rounds).map(Number), st.params.rounds) + 1;
    st.rounds[n] = { n, blind_tag: `${a.tag}-r${n}`, cats: {}, only: [cat], note: `an extra ${cat} round for the ${lost.length} buyers of round ${[...new Set(lost.map((s) => s.round))].join(", ")}, whose ${cat} round did not open` };
    for (const s of lost) Object.assign(s, { moved_from: s.round, round: n });
    save();
  }

  const ready = {};
  const rounds = [...new Set([...Array.from({ length: st.params.rounds }, (_, i) => i + 1), ...Object.keys(st.rounds).map(Number)])].sort((x, y) => x - y);
  const gate = Object.fromEntries(rounds.map((n) => [n, {}]));
  for (const n of rounds) (ready[n] = new Promise((ok, fail) => Object.assign(gate[n], { ok, fail }))).catch(() => {});
  // Model merchants decide each round from the sales before it: round n waits for round n-1's buyers.
  const bought = {};
  for (const n of rounds) bought[n] = new Promise((ok) => (gate[n].bought = ok));
  const roundsTrack = (async () => {
    for (const n of rounds) {
      // A stop opens no new round; a round already open is always carried to its reveals.
      if (shared.stop && !Object.keys(st.rounds[n]?.cats ?? {}).length) {
        gate[n].fail(new Error(`not opened: ${shared.stop}`));
        continue;
      }
      try {
        if (BRAIN && gate[n - 1]) await bought[n - 1];
        await prepareRound(n);
        gate[n].ok();
      } catch (e) {
        (st.rounds[n] ??= { n, cats: {} }).error = clean(e.message);
        save();
        console.log(`[r${n}] FAILED: ${clean(e.message)}`);
        gate[n].fail(e);
      }
    }
  })();
  try {
    for (const n of rounds) {
      try {
        await ready[n];
      } catch {
        gate[n].bought();
        continue;
      }
      const todo = st.slots.filter((s) => s.round === n && s.status !== "settled" && s.attempts.length < 2 + (s.moved_from ? 1 : 0));
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(a.concurrency, todo.length) }, async () => {
        while (next < todo.length && !shared.stop) await slotRun(todo[next++]);
      }));
      gate[n].bought();
    }
    await roundsTrack;
  } finally {
    st.wall_ms += Date.now() - t0;
    const spent = before + faucetIn - (await balance().catch(() => before + faucetIn));
    st.treasury.spent_yocto = String(BigInt(st.treasury.spent_yocto) + spent);
    delete st.record_error;
    st.complete = st.slots.every((s) => s.status === "settled") && rounds.every((n) => st.rounds[n]?.ready);
    if (shared.stop) st.stopped = shared.stop;
    save();
    const rec = writeRecord();
    console.log = plain;
    const t = rec.totals;
    console.log(`\nswarm ${a.tag}: ${t.purchases_settled} of ${st.params.buyers} purchases settled (${t.dusdc_volume} dUSDC), ${t.rounds} rounds, ${t.sealed_bids} sealed bids, ${t.reveals} reveals, ${t.model_verdicts} model verdicts, ${t.refused_replays} replays refused, ${t.failures} failures`);
    console.log(`   NEAR AI $${t.near_ai_cost_usd}, treasury ${t.treasury_near_spent} NEAR, wall ${t.wall_time_s} s${shared.stop ? `; STOPPED: ${shared.stop}` : ""}`);
    console.log(`   ${recordPath}`);
  }
  process.exit(st.complete ? 0 : shared.stop ? 3 : 1);
}

async function plan(a) {
  const c = config(process.env);
  const no = guard(c);
  if (no) {
    console.error(`refusing: ${no}`);
    process.exit(2);
  }
  if (!a.rounds || !a.buyers) throw new Error("plan needs --rounds and --buyers");
  const merchants = JSON.parse(readFileSync("agents/merchants.json", "utf8"));
  const p = planOf(a, { merchants: merchants.length });
  console.log(`swarm ${a.tag} on testnet (plan: nothing is sent): bazaar ${c.bazaar}, dUSDC ${c.dusdc}, treasury ${c.treasury}`);
  console.log(`rounds    ${p.rounds}, each a hoodie and a hotel round: ${a.commitMin} min to commit, ${a.revealMin} min to reveal`);
  console.log(`merchants ${p.merchant_agents} agents: ${p.sealed_bids} sealed bids, ${p.reveals} reveals; about ${p.merchant_near_each} NEAR of storage and gas from each merchant's own balance`);
  console.log(`buyers    ${p.buyers}: ${p.per_round.map((r) => `r${r.round} ${r.hoodie}+${r["hotel-lisbon"]}`).join(", ")} (hoodie+hotel), ${a.concurrency} at a time; the relayer signs in line`);
  console.log(`bit sets  ${Object.entries(p.bit_sets).map(([n, k]) => `${n} x${k} (${SETS.find((s) => s.name === n).predicates.join(", ")})`).join("; ")}`);
  console.log(`NEAR AI   ${p.near_ai_calls} model verdicts under E2EE v2, about $${p.near_ai_usd}`);
  console.log(`treasury  about ${p.treasury_near} testnet NEAR${a.sweep ? " after each buyer returns what it did not spend" : ""}, ${p.treasury_float_near} in flight`);
  console.log(`time      about ${p.est_minutes} min`);
  console.log(`skipped   Shopify orders, review groups, the public demo's daily cap of testers`);
  try {
    const client = rpcClient(c.rpc);
    const bal = yoctoToNear((await client.account(c.treasury)).amount);
    const need = yoctoToNear(TREASURY_MIN) + p.treasury_near + p.treasury_float_near;
    console.log(`now       treasury holds ${bal.toFixed(3)} NEAR; this run needs ${need.toFixed(2)} with the 1 NEAR floor: ${bal >= need ? "enough" : a.faucet ? "short, the faucet tops it up" : "SHORT"}`);
    let low = null;
    for (const m of merchants) {
      const b = yoctoToNear((await client.account(m.account))?.amount ?? 0);
      if (!low || b < low.b) low = { b, id: m.account };
    }
    console.log(`          the poorest merchant, ${low.id.split(".")[0]}, holds ${low.b.toFixed(3)} NEAR: ${low.b > p.merchant_near_each + 0.02 ? "enough" : "NOT enough"} for ${p.rounds} rounds`);
  } catch (e) {
    console.log(`now       (public RPC not read: ${clean(e.message)})`);
  }
  const statePath = join(c.keysDir, "swarm", `${a.tag}.json`);
  if (existsSync(statePath)) {
    const st = JSON.parse(readFileSync(statePath, "utf8"));
    console.log(`resume    tag ${a.tag} exists: ${st.slots.filter((s) => s.status === "settled").length} of ${st.slots.length} buyers settled, ${Object.values(st.rounds).filter((r) => r.ready).length} rounds ready`);
  }
}

async function verify(a) {
  const path = `fixtures/live/swarm/${a.tag}.json`;
  const rec = JSON.parse(readFileSync(path, "utf8"));
  if (rec.network !== "testnet" || !rec.bazaar.endsWith(".testnet")) throw new Error("the record is not a testnet record");
  const client = steadyClient(PUBLIC_RPC);
  let fails = 0;
  const say = (ok, what, detail = "") => {
    if (!ok) fails++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  ${detail}` : ""}`);
  };
  try {
    assertPublic(rec);
    say(true, "the record holds public fields only");
  } catch (e) {
    say(false, "the record holds public fields only", e.message);
  }
  const bad = recordProblems(rec);
  say(!bad.length, "the totals follow from the rows", bad.join("; "));

  const merchantsSeen = new Set();
  for (const r of rec.rounds) for (const cat of r.categories) {
    const info = await client.view(rec.bazaar, "round", { round_id: cat.round_id });
    for (const m of info?.revealed ?? []) merchantsSeen.add(m);
    const ok = info && info.category === cat.category && info.commits.length === cat.commits && info.revealed.length === cat.reveals;
    say(ok, `round ${cat.round_id}: ${cat.commits} sealed bids, ${cat.reveals} opened`, ok ? "" : `chain: ${info ? `${info.commits.length} and ${info.revealed.length}` : "no such round"}`);
  }
  say(merchantsSeen.size === rec.totals.merchant_agents, `${rec.totals.merchant_agents} merchant agents opened a bid`, merchantsSeen.size === rec.totals.merchant_agents ? "" : `chain: ${merchantsSeen.size}`);

  // Every purchase through the normal RPC: the nullifier is spent under a model verdict held
  // by the buyer, and the round still names the same winner at the same price.
  const wrong = [];
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < rec.purchases.length) {
      const p = rec.purchases[next++];
      try {
        const v = await client.view(rec.bazaar, "verdict", { nullifier: p.nullifier });
        if (!v?.spent) wrong.push(`${p.nullifier.slice(0, 12)}: not spent`);
        else if (!String(v.issuer).startsWith("near-ai:")) wrong.push(`${p.nullifier.slice(0, 12)}: issuer ${v.issuer}`);
        else if (v.agent !== p.buyer) wrong.push(`${p.nullifier.slice(0, 12)}: agent ${v.agent}`);
        else if (JSON.stringify(v.predicates) !== JSON.stringify(p.predicates)) wrong.push(`${p.nullifier.slice(0, 12)}: predicates ${v.predicates}`);
        const w = await client.view(rec.bazaar, "round_best_quote", { round_id: p.round_id, nullifier: p.nullifier });
        if (w?.merchant !== p.merchant || String(w?.quote?.price) !== p.price) wrong.push(`${p.nullifier.slice(0, 12)}: the round names ${w?.merchant} at ${w?.quote?.price}, the record ${p.merchant} at ${p.price}`);
      } catch (e) {
        wrong.push(`${p.nullifier.slice(0, 12)}: ${clean(e.message)}`);
      }
    }
  }));
  say(!wrong.length, `${rec.purchases.length} purchases: nullifier spent, verdict issued by a NEAR AI model key to the buyer, bought from the round's winner at its price`, wrong.slice(0, 5).join("; ") + (wrong.length > 5 ? `; and ${wrong.length - 5} more` : ""));

  // A sample of txs through the archival RPC, which rate-limits: 1.5 s apart.
  const sample = sampleTxs(rec, 25);
  const txBad = [];
  for (const [i, t] of sample.entries()) {
    if (i) await sleep(1500);
    let o = null;
    for (const url of [ARCHIVAL, PUBLIC_RPC, ARCHIVAL]) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "swarm", method: "tx", params: { tx_hash: t.hash, sender_account_id: rec.relayer, wait_until: "FINAL" } }), signal: AbortSignal.timeout(20000) });
        const j = r.ok ? await r.json() : null;
        if (j?.result) {
          o = outcome(j);
          break;
        }
      } catch {
        // the next host
      }
      await sleep(2500);
    }
    if (!o) txBad.push(`${t.hash}: not found`);
    else if (t.kind === "settle" && !(o.ok && o.logs.some((l) => l.includes(t.nullifier) && l.includes("settled")))) txBad.push(`${t.hash}: not a successful settle of ${t.nullifier.slice(0, 12)}`);
    else if (t.kind === "replay" && !(!o.ok && String(o.error).includes("nullifier spent"))) txBad.push(`${t.hash}: the replay was not refused as spent`);
  }
  const n = (k) => sample.filter((t) => t.kind === k).length;
  say(!txBad.length, `${sample.length} txs sampled: ${n("settle")} settles succeeded, ${n("replay")} replays refused (nullifier spent)`, txBad.join("; "));
  console.log(`\nswarm verify ${a.tag}: ${fails ? `FAIL (${fails})` : "PASS"}  ${rec.totals.purchases_settled} purchases, ${rec.totals.dusdc_volume} dUSDC, ${rec.totals.rounds} rounds, ${rec.totals.sealed_bids} sealed bids, ${rec.totals.merchant_agents} merchant agents, ${rec.totals.buyer_agents} buyer agents`);
  process.exit(fails ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const a = parseArgs(process.argv.slice(2));
    await (a.cmd === "plan" ? plan(a) : a.cmd === "verify" ? verify(a) : run(a));
  } catch (e) {
    console.error(`swarm-run: ${clean(e.message)}`);
    process.exit(1);
  }
}
