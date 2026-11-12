// Model-driven merchant agents: before each sealed round, every merchant asks a NEAR AI model
// for its bid (a discount schedule) from what it can see. Used by swarm-run.mjs when
// SWARM_MERCHANT_BRAIN=1; the decisions go into the run's public record.
//
// What a merchant sees: its own persona, unit cost and units left; and the public history of
// earlier rounds of the same run: every revealed schedule (public after each reveal), the
// winner and price of every purchase, and which proven bits the buyers revealed.
// What it never sees: a rival's bid before the reveal (sealed), any buyer's identity.
//
// What code still decides: the bid is clamped (no price under the unit cost for the buyers the
// merchant prices, base 20 to 80 dUSDC, at most 30% per bit, cap at most 40%) and the contract
// prices every purchase from the revealed schedule. The model chooses a bid; it never sets a
// price at settle.
//
// Provenance: one E2EE v2 chat per merchant per round (NEAR AI signs only E2EE chats); the model's
// TEE signature over sha256(request bytes) and sha256(response bytes) is checked against the
// key in the model's attestation report and kept in the record (chat id, signing key).
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { clientKey, edVerify, openWith, sealTo } from "./lib/e2ee.mjs";

const AI = process.env.NEAR_AI_BASE ?? "https://cloud-api.near.ai/v1";
export const BRAIN_MODEL = process.env.MERCHANT_MODEL ?? "z-ai/glm-5.3-flash";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const BITS = ["airbnb_frequent", "booking_genius", "claude_spender", "world_id_human"];
const USD = 1_000_000;

/** Ten merchant agents, each with a strategy persona, a unit cost and an inventory. Synthetic. */
export const PERSONAS = {
  "m11.bookerbob.testnet": { persona: "undercutter", cost: 24, units: 10 },
  "m02.bookerbob.testnet": { persona: "undercutter", cost: 26, units: 8 },
  "m03.bookerbob.testnet": { persona: "premium", cost: 30, units: 5 },
  "m04.bookerbob.testnet": { persona: "adaptive", cost: 25, units: 8 },
  "m05.bookerbob.testnet": { persona: "adaptive", cost: 27, units: 8 },
  "m06.bookerbob.testnet": { persona: "premium", cost: 32, units: 4 },
  "m07.bookerbob.testnet": { persona: "niche: rewards one bit deeply and ignores the rest", cost: 26, units: 6 },
  "m08.bookerbob.testnet": { persona: "adaptive", cost: 23, units: 12 },
  "m09.bookerbob.testnet": { persona: "undercutter", cost: 28, units: 6 },
  "m10.bookerbob.testnet": { persona: "margin keeper: never sells under cost plus 30%", cost: 25, units: 10 },
};

const PERSONA_TEXT = {
  undercutter: "You want volume: win as many sales as you can while staying above your unit cost.",
  premium: "You want margin: sell fewer units at a high price; you accept losing rounds.",
  adaptive: "You adapt: read what won last round and move toward the price that wins with margin left.",
};

/** The price a schedule gives a buyer who revealed `bits` (contract rules: sum of matching bps, capped). */
export function priceFor(s, bits) {
  const bps = Math.min(s.cap_bps, s.rules.filter((r) => bits.includes(r.predicate)).reduce((a, r) => a + r.bps, 0));
  return Math.floor((s.base_price * (10000 - bps)) / 10000);
}

/** Code's bounds on whatever the model answers. */
export function clamp(raw, me, bitSets) {
  const base = Math.round(Math.min(80, Math.max(20, Number(raw.base_price) || 50)) * 100) / 100;
  const rules = BITS.map((p) => ({ predicate: p, bps: Math.round(Math.min(3000, Math.max(0, Number(raw.discounts?.[p]) || 0))) })).filter((r) => r.bps > 0);
  let cap = Math.round(Math.min(4000, Math.max(0, Number(raw.cap_bps) || rules.reduce((a, r) => a + r.bps, 0))));
  const s = { base_price: Math.round(base * USD), rules, cap_bps: cap, cohort: null };
  // No sale under cost: lower the cap until every bit set the merchant has seen prices at or above cost.
  const floor = me.cost * USD;
  while (s.cap_bps > 0 && bitSets.some((bits) => priceFor(s, bits) < floor)) s.cap_bps = Math.max(0, s.cap_bps - 100);
  if (s.base_price < floor) s.base_price = floor;
  return s;
}

/** The public history a merchant reads before round n. */
export function historyFor(n, rounds, purchases) {
  const out = [];
  for (let r = Math.max(1, n - 2); r < n; r++) {
    const d = rounds[r]?.decisions ?? {};
    const buys = purchases.filter((p) => p.round === r);
    out.push({
      round: r,
      revealed_bids: Object.entries(d).map(([m, x]) => ({ merchant: m.split(".")[0], base: x.schedule.base_price / USD, discounts_bps: Object.fromEntries(x.schedule.rules.map((q) => [q.predicate, q.bps])), cap_bps: x.schedule.cap_bps })),
      sales: buys.map((p) => ({ winner: p.merchant.split(".")[0], price: Number(p.price) / USD, buyer_bits: p.predicates })),
    });
  }
  return out;
}

async function attestedKey(auth) {
  const nonce = randomBytes(32).toString("hex");
  const r = await fetch(`${AI}/attestation/report?model=${encodeURIComponent(BRAIN_MODEL)}&signing_algo=ed25519&nonce=${nonce}`, { headers: { ...auth, "x-no-aliasing": "true" } });
  if (!r.ok) throw new Error(`attestation report HTTP ${r.status}`);
  const k = (await r.json()).model_attestations?.[0]?.signing_address;
  if (!/^[0-9a-f]{64}$/.test(k ?? "")) throw new Error("no ed25519 model key in the report");
  return k;
}

/** One merchant's decision for round n. */
async function decideOne({ account, me, history, n, rounds, bitSets, auth, modelKey }) {
  const sold = history.flatMap((h) => h.sales).filter((s) => s.winner === account.split(".")[0]).length;
  const left = Math.max(0, me.units - sold);
  const persona = PERSONA_TEXT[me.persona] ?? `Your strategy: ${me.persona}.`;
  const system = `You are ${account.split(".")[0]}, a merchant agent selling one hoodie per buyer in sealed-bid rounds on a market. Each round you commit a sealed bid: a base price in dUSDC and a discount in basis points for each proven bit a buyer may reveal (${BITS.join(", ")}), capped by cap_bps. Rivals see your bid only after the deadline. The lowest price for a buyer's revealed bits wins that buyer; you are paid your own price. ${persona} Think briefly. Answer only JSON: {"base_price": number, "discounts": {"<bit>": bps, ...}, "cap_bps": number, "why": "<one short sentence>"}`;
  const user = JSON.stringify({ round: n, of: rounds, your_unit_cost_dusdc: me.cost, units_left: left, units_sold_so_far: sold, buyer_bit_sets_seen: bitSets, history });
  if (left === 0) return { skip: true, why: "sold out" };
  let last = "";
  for (let i = 0; i < 3; i++) {
    const me2 = clientKey();
    const reqBytes = Buffer.from(JSON.stringify({ model: BRAIN_MODEL, max_tokens: 8000, temperature: 0.7, messages: [{ role: "system", content: sealTo(system, modelKey) }, { role: "user", content: sealTo(user, modelKey) }] }));
    const res = await fetch(`${AI}/chat/completions`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", "X-Signing-Algo": "ed25519", "X-Client-Pub-Key": me2.pubHex, "X-Model-Pub-Key": modelKey, "X-Encryption-Version": "2", "x-no-aliasing": "true" }, body: reqBytes });
    const resBytes = Buffer.from(await res.arrayBuffer());
    if (res.status === 402) throw new Error("NEAR AI credit exhausted");
    if (!res.ok) { last = `HTTP ${res.status} ${resBytes.toString().slice(0, 160)}`; await new Promise((ok) => setTimeout(ok, 2000 * (i + 1))); continue; }
    const body = JSON.parse(resBytes);
    let text = "";
    try { text = openWith(body.choices?.[0]?.message?.content ?? "", me2.xSecret); } catch (e) { last = `open: ${e.message}; finish ${body.choices?.[0]?.finish_reason}`; continue; }
    let raw;
    try { raw = JSON.parse(text.match(/\{[\s\S]*\}/)[0]); } catch { last = `parse: ${text.slice(0, 160)}; finish ${body.choices?.[0]?.finish_reason}`; continue; }
    const sig = await (await fetch(`${AI}/signature/${body.id}?model=${encodeURIComponent(BRAIN_MODEL)}&signing_algo=ed25519`, { headers: auth })).json().catch(() => ({}));
    const [, sReq, sRes] = String(sig.text ?? "").split(":");
    const signed = Boolean(sig.signature) && edVerify(sig.text, sig.signature, sig.signing_address) && sReq === sha(reqBytes) && sRes === sha(resBytes) && sig.signing_address === modelKey;
    const schedule = clamp(raw, me, bitSets);
    return {
      persona: me.persona, unit_cost: me.cost, units_left: left,
      asked: { base_price: raw.base_price, discounts: raw.discounts, cap_bps: raw.cap_bps },
      schedule,
      why: String(raw.why ?? "").slice(0, 200), model: BRAIN_MODEL, chat_id: body.id, tee_signed: signed, signer: sig.signing_address ?? null,
      usage: body.usage ?? null,
    };
  }
  throw new Error(`${account}: no usable answer from the model (${last})`);
}

/** Decisions for every merchant for round n, 3 at a time. */
export async function decideRound({ n, rounds, merchants, stRounds, purchases, bitSets }) {
  const key = (process.env.NEAR_AI_KEY ?? readFileSync(`${process.env.HOME}/.rep-secrets/near-ai.key`, "utf8")).trim();
  const auth = { Authorization: `Bearer ${key}` };
  const modelKey = await attestedKey(auth);
  const history = historyFor(n, stRounds, purchases);
  const out = {};
  const todo = merchants.filter((m) => PERSONAS[m.account]);
  for (let i = 0; i < todo.length; i += 3) {
    await Promise.all(todo.slice(i, i + 3).map(async (m) => {
      out[m.account] = await decideOne({ account: m.account, me: PERSONAS[m.account], history, n, rounds, bitSets, auth, modelKey });
    }));
  }
  return out;
}
