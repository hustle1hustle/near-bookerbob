// BookerBob merchant SDK (stub). No dependencies. For a merchant agent that wants to bid.
//
//   import { schedule, validate, bidCommitment, quote, registerArgs } from "./sdk/merchant.mjs";
//
// Mirrors bookerbob-core (Rust) exactly where the chain checks it: schedule rules, the
// blind bid commitment and the quote. sdk/merchant.test.mjs recomputes every commitment and
// price in agents/board.json (produced by the Rust code) to keep the two in step.
import { createHash } from "node:crypto";

export const KNOWN_PREDICATES = ["airbnb_frequent", "booking_genius", "claude_spender", "github_builder", "steam_veteran", "uber_regular", "world_id_human"];
export const K_MIN = 5;
const BID_TAG = Buffer.from("bookerbob/bid/v0\x00", "latin1");

/** Build a schedule. Prices in USDC base units (6 decimals). Every perk is a discount. */
export function schedule({ basePrice, rules = [], capBps, cohort = null }) {
  const s = { base_price: String(basePrice), rules: rules.map(({ predicate, bps }) => ({ predicate, bps })), cap_bps: capBps };
  if (cohort) s.cohort = { predicate: cohort.predicate, k_min: cohort.kMin ?? K_MIN, bps: cohort.bps };
  return s;
}

/** Same checks as `Schedule::validate` in core/src/price.rs. Returns null or the error. */
export function validate(s) {
  if (BigInt(s.base_price) === 0n) return "base price is zero";
  if (BigInt(s.base_price) > 10n ** 30n) return "base price too large";
  if (s.cap_bps > 10000) return "cap over 100%";
  if (s.rules.length > KNOWN_PREDICATES.length) return "too many rules";
  const seen = new Set();
  for (const r of s.rules) {
    if (!KNOWN_PREDICATES.includes(r.predicate)) return "unknown predicate in schedule";
    if (r.bps > 10000) return "rule over 100%";
    if (seen.has(r.predicate)) return "duplicate predicate in schedule";
    seen.add(r.predicate);
  }
  if (s.cohort) {
    if (!KNOWN_PREDICATES.includes(s.cohort.predicate)) return "unknown predicate in cohort rule";
    if (s.cohort.k_min < K_MIN) return "cohort k_min below 5";
    if (s.cohort.bps > 10000) return "cohort over 100%";
  }
  return null;
}

/** JSON exactly as serde writes a Schedule (field order, no cohort key when absent). */
export function scheduleJson(s) {
  const o = { base_price: String(s.base_price), rules: s.rules.map((r) => ({ predicate: r.predicate, bps: r.bps })), cap_bps: s.cap_bps };
  if (s.cohort) o.cohort = { predicate: s.cohort.predicate, k_min: s.cohort.k_min, bps: s.cohort.bps };
  return JSON.stringify(o);
}

/** Round 1 of a blind round: `sha256("bookerbob/bid/v0\0" || account || 0 || json(schedule) || salt)`. */
export function bidCommitment(account, s, salt32) {
  return createHash("sha256").update(BID_TAG).update(Buffer.from(account)).update(Buffer.from([0])).update(Buffer.from(scheduleJson(s))).update(salt32).digest("hex");
}

/** Preview the code-computed price. `k(p)` = cohort size for predicate p in the context. */
export function quote(s, revealed, k = () => 0) {
  const base = BigInt(s.base_price);
  const lines = s.rules.filter((r) => revealed.includes(r.predicate));
  const sum = lines.reduce((a, r) => a + r.bps, 0);
  let bps = Math.min(sum, s.cap_bps);
  let cohort = null;
  if (s.cohort && revealed.includes(s.cohort.predicate) && k(s.cohort.predicate) >= s.cohort.k_min) {
    cohort = { predicate: s.cohort.predicate, k: k(s.cohort.predicate), bps: s.cohort.bps };
    bps += s.cohort.bps;
  }
  bps = Math.min(bps, 10000);
  return { base_price: base, lines, cohort, discount_bps: bps, price: base - (base * BigInt(bps)) / 10000n };
}

/** Arguments for the bazaar's `register_merchant`, called from the merchant's own account. */
export function registerArgs(s, category, payout = null) {
  const err = validate(s);
  if (err) throw new Error(err);
  if (!/^[a-z0-9-]{1,32}$/.test(category)) throw new Error("bad category");
  return { schedule: JSON.parse(scheduleJson(s)), category, payout };
}

/** The near-cli-rs command a merchant runs (testnet). Attach enough for storage; the rest is refunded. */
export function registerCommand({ bazaar, merchant, s, category }) {
  const args = JSON.stringify(registerArgs(s, category));
  return `near contract call-function as-transaction ${bazaar} register_merchant json-args '${args}' prepaid-gas '30 Tgas' attached-deposit '0.05 NEAR' sign-as ${merchant} network-config testnet sign-with-keychain send`;
}

/** Arguments for `commit_bid` (round 1, before the commit deadline). Keep `salt32` secret until the reveal. */
export function commitBidArgs(roundId, account, s, salt32) {
  const err = validate(s);
  if (err) throw new Error(err);
  return { round_id: roundId, commitment: bidCommitment(account, s, salt32) };
}

/** Arguments for `reveal_bid` (round 2, after the commit deadline, before the reveal deadline). */
export function revealBidArgs(roundId, s, salt32) {
  return { round_id: roundId, schedule: JSON.parse(scheduleJson(s)), salt: Buffer.from(salt32).toString("hex") };
}
