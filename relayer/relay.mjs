// NEP-366 meta-transaction relayer for sealed reviews (submit_review, reveal_review).
// No dependencies (node:crypto). Verifies a SignedDelegateAction and checks the policy;
// building the outer transaction and sending it to testnet waits on the testnet deploy.
//
// What it gives: the rater signs with a fresh, unfunded one-time key and the relayer pays
// the gas, so no funding transfer links that account to the buyer. What it does not give:
// NEP-366 hides the gas payer, not the signer. The inner `sender_id` still appears on chain
// as the caller, and the relayer sees every sender and, at reveal time, the rating.
//
// Encoding (NEP-366, borsh): signed bytes = sha256(borsh(SignableMessage)), where
// SignableMessage = u32 discriminant (2^30 + 366) || DelegateAction, and DelegateAction =
// sender_id, receiver_id, actions (Vec<Action>, FunctionCall = variant 2), nonce u64,
// max_block_height u64, public_key (u8 key type 0 = ed25519, 32 bytes).
import { createHash, createPublicKey, verify } from "node:crypto";

export const NEP366_DISCRIMINANT = 2 ** 30 + 366;
export const ALLOWED_METHODS = ["submit_review", "reveal_review"];
const FUNCTION_CALL = 2;

// ---- borsh writer ----
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u128 = (n) => { const b = Buffer.alloc(16); let v = BigInt(n); for (let i = 0; i < 16; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const str = (s) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([u32(b.length), b]); };
const bytes = (b) => Buffer.concat([u32(b.length), Buffer.from(b)]);

export function encodeDelegateAction(d) {
  const actions = d.actions.map((a) => {
    if (a.type !== "FunctionCall") throw new Error("only FunctionCall actions are encoded here");
    return Buffer.concat([Buffer.from([FUNCTION_CALL]), str(a.method_name), bytes(Buffer.from(JSON.stringify(a.args))), u64(a.gas), u128(a.deposit)]);
  });
  return Buffer.concat([str(d.sender_id), str(d.receiver_id), u32(actions.length), ...actions, u64(d.nonce), u64(d.max_block_height), Buffer.from([0]), Buffer.from(d.public_key_hex, "hex")]);
}

/** The 32 bytes the rater signs. */
export function signableHash(d) {
  return createHash("sha256").update(Buffer.concat([u32(NEP366_DISCRIMINANT), encodeDelegateAction(d)])).digest();
}

const edKey = (hex) => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(hex, "hex")]), format: "der", type: "spki" });

/**
 * Policy check before the relayer pays for it. Returns { ok: true } or { ok: false, reason }.
 * `signed` = { delegate_action, signature_hex } ; `ctx` = { bazaar, block_height, max_deposit }.
 */
export function check(signed, ctx) {
  const d = signed.delegate_action;
  if (d.receiver_id !== ctx.bazaar) return { ok: false, reason: `receiver ${d.receiver_id} is not the bazaar` };
  if (!Array.isArray(d.actions) || d.actions.length !== 1) return { ok: false, reason: "exactly one action" };
  const a = d.actions[0];
  if (a.type !== "FunctionCall" || !ALLOWED_METHODS.includes(a.method_name)) return { ok: false, reason: `method ${a.method_name} is not relayed` };
  if (BigInt(a.deposit) > BigInt(ctx.max_deposit)) return { ok: false, reason: "deposit over the relayer's cap" };
  if (BigInt(d.max_block_height) < BigInt(ctx.block_height)) return { ok: false, reason: "delegate action expired" };
  if (!/^[0-9a-f]{64}$/.test(d.public_key_hex)) return { ok: false, reason: "bad public key" };
  // An implicit account is the hex of its own ed25519 key: a one-time account.
  if (d.sender_id !== d.public_key_hex) return { ok: false, reason: "sender must be the implicit account of the signing key (one-time account)" };
  const ok = verify(null, signableHash(d), edKey(d.public_key_hex), Buffer.from(signed.signature_hex, "hex"));
  return ok ? { ok: true } : { ok: false, reason: "bad signature" };
}

// ---------- demo policy (testnet demo mode, docs/demo-mode.md) ----------
//
// A tester account `t-<6 hex>.<treasury>` signs delegate actions for the demo purchase;
// the relayer pays the gas. Allowed: the bazaar and the dUSDC token only, a fixed method
// list per receiver, one action per delegate, deposits within a per-method cap (paid from
// the tester's own balance, not the relayer's), `ft_transfer_call` only to the bazaar,
// and a per-sender daily budget.

const TGAS = 10n ** 12n;
export const DEMO_DAILY_ACTIONS = 20;
export const DEMO_MAX_GAS = 300n * TGAS;
const MILLI = 10n ** 21n;
export const DEMO_METHODS = {
  bazaar: { attest_human: 10n * MILLI, submit_verdict: 50n * MILLI, submit_referee_result: 0n, settle_demo: 0n, join_review_group: 20n * MILLI },
  dusdc: { mint: 0n, ft_transfer_call: 1n },
};

export function checkDemo(signed, ctx, used = 0) {
  const d = signed.delegate_action;
  const tester = new RegExp(`^t-[0-9a-f]{6}\\.${ctx.treasury.replace(/\./g, "\\.")}$`);
  if (!tester.test(d.sender_id)) return { ok: false, reason: `sender ${d.sender_id} is not a demo tester account` };
  const role = d.receiver_id === ctx.bazaar ? "bazaar" : d.receiver_id === ctx.dusdc ? "dusdc" : null;
  if (!role) return { ok: false, reason: `receiver ${d.receiver_id} is not the bazaar or dUSDC` };
  if (!Array.isArray(d.actions) || d.actions.length !== 1) return { ok: false, reason: "exactly one action" };
  const a = d.actions[0];
  const cap = a.type === "FunctionCall" ? DEMO_METHODS[role][a.method_name] : undefined;
  if (cap === undefined) return { ok: false, reason: `method ${a.method_name} is not relayed in demo mode` };
  if (BigInt(a.deposit) > cap) return { ok: false, reason: "deposit over the demo cap" };
  if (a.method_name === "ft_transfer_call" && (a.args?.receiver_id !== ctx.bazaar || BigInt(a.deposit) !== 1n)) return { ok: false, reason: "ft_transfer_call only to the bazaar, with 1 yocto" };
  if (BigInt(a.gas) > DEMO_MAX_GAS) return { ok: false, reason: "gas over the demo cap" };
  if (used >= DEMO_DAILY_ACTIONS) return { ok: false, reason: "tester over the daily budget" };
  if (BigInt(d.max_block_height) < BigInt(ctx.block_height)) return { ok: false, reason: "delegate action expired" };
  if (!/^[0-9a-f]{64}$/.test(d.public_key_hex)) return { ok: false, reason: "bad public key" };
  const ok = verify(null, signableHash(d), edKey(d.public_key_hex), Buffer.from(signed.signature_hex, "hex"));
  return ok ? { ok: true } : { ok: false, reason: "bad signature" };
}
