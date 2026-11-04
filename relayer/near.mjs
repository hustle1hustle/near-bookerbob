// Minimal NEAR transaction building and sending, no dependencies (node:crypto + fetch).
// Borsh layouts from nearcore: Transaction (V0), SignedTransaction, Action variants
// CreateAccount 0, FunctionCall 2, Transfer 3, AddKey 5, Delegate 8, and SignedDelegateAction.
// Keys are raw 32-byte ed25519 seeds kept outside the repo; only public keys are printed.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { encodeDelegateAction, signableHash } from "./relay.mjs";

const u8 = (n) => Buffer.from([n]);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u128 = (n) => { const b = Buffer.alloc(16); let v = BigInt(n); for (let i = 0; i < 16; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const str = (s) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([u32(b.length), b]); };
const bytes = (b) => Buffer.concat([u32(b.length), Buffer.from(b)]);
const vec = (items) => Buffer.concat([u32(items.length), ...items]);
const pk = (hex) => Buffer.concat([u8(0), Buffer.from(hex, "hex")]);

export const NEAR = 10n ** 24n;
export const near = (x) => (BigInt(Math.round(Number(x) * 1e6)) * NEAR) / 1_000_000n;

/** ed25519 key from a 32-byte seed: { seed, pub (hex), priv (KeyObject) }. */
export function keyFromSeed(seedHex) {
  const seed = Buffer.from(seedHex.trim(), "hex");
  if (seed.length !== 32) throw new Error("seed must be 32 bytes hex");
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(12).toString("hex");
  return { pub, priv };
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(buf) {
  let n = BigInt("0x" + (Buffer.from(buf).toString("hex") || "0"));
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = "1" + out; else break; }
  return out;
}
export function b58decode(s) {
  let n = 0n;
  for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
  const lead = [...s].findIndex((c) => c !== "1");
  return Buffer.concat([Buffer.alloc(lead < 0 ? s.length : lead), Buffer.from(n === 0n ? "" : hex, "hex")]);
}
export const nearPublicKey = (hex) => `ed25519:${b58encode(Buffer.from(hex, "hex"))}`;

/** One action, borsh. `a` = { type, ... } as below. */
export function encodeAction(a) {
  switch (a.type) {
    case "CreateAccount": return u8(0);
    case "DeployContract": return Buffer.concat([u8(1), bytes(a.code)]);
    case "FunctionCall": return Buffer.concat([u8(2), str(a.method_name), bytes(Buffer.from(JSON.stringify(a.args))), u64(a.gas), u128(a.deposit)]);
    case "Transfer": return Buffer.concat([u8(3), u128(a.deposit)]);
    case "AddKey": {
      const perm = a.permission === "FullAccess" ? u8(1)
        : Buffer.concat([u8(0), a.permission.allowance == null ? u8(0) : Buffer.concat([u8(1), u128(a.permission.allowance)]), str(a.permission.receiver_id), vec(a.permission.method_names.map(str))]);
      return Buffer.concat([u8(5), pk(a.public_key_hex), u64(0), perm]);
    }
    case "Delegate": return Buffer.concat([u8(8), encodeDelegateAction(a.delegate_action), u8(0), Buffer.from(a.signature_hex, "hex")]);
    default: throw new Error(`action ${a.type} not encoded here`);
  }
}

export function encodeTransaction(t) {
  return Buffer.concat([str(t.signer_id), pk(t.public_key_hex), u64(t.nonce), str(t.receiver_id), Buffer.from(t.block_hash), vec(t.actions.map(encodeAction))]);
}

/** sha256(borsh(tx)) is what the signer signs and also the tx hash. */
export function signTransaction(t, key) {
  const body = encodeTransaction(t);
  const hash = createHash("sha256").update(body).digest();
  const sig = sign(null, hash, key.priv);
  return { signed: Buffer.concat([body, u8(0), sig]), hash: b58encode(hash) };
}

/** A NEP-366 delegate action signed by `key` (the inner sender). */
export function signDelegate(d, key) {
  return { delegate_action: d, signature_hex: sign(null, signableHash(d), key.priv).toString("hex") };
}

export function rpcClient(url) {
  const rpc = async (method, params) => {
    for (let i = 0; i < 6; i++) {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "bookerbob", method, params }) });
      if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1500 * (i + 1))); continue; }
      const j = await r.json();
      if (j.error && /TIMEOUT|Too Many/i.test(JSON.stringify(j.error)) && i < 5) { await new Promise((s) => setTimeout(s, 1500 * (i + 1))); continue; }
      return j;
    }
    throw new Error(`${method}: RPC kept failing`);
  };
  return {
    rpc,
    async view(account_id, method_name, args = {}) {
      const r = await rpc("query", { request_type: "call_function", finality: "final", account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
      if (r.error || r.result?.error) throw new Error(`${method_name}: ${JSON.stringify(r.error ?? r.result.error).slice(0, 300)}`);
      return JSON.parse(Buffer.from(r.result.result).toString() || "null");
    },
    async accessKey(account_id, pubHex) {
      const r = await rpc("query", { request_type: "view_access_key", finality: "final", account_id, public_key: nearPublicKey(pubHex) });
      if (r.error || r.result?.error) return null;
      return r.result;
    },
    async account(account_id) {
      const r = await rpc("query", { request_type: "view_account", finality: "final", account_id });
      return r.error || r.result?.error ? null : r.result;
    },
    async block() {
      const r = await rpc("block", { finality: "final" });
      return r.result.header;
    },
  };
}

/** Outcome summary: ok, failure text, logs and the first SuccessValue (decoded JSON). */
export function outcome(r) {
  if (r.error) return { ok: false, error: JSON.stringify(r.error).slice(0, 600), logs: [] };
  const res = r.result;
  const all = [res.transaction_outcome, ...res.receipts_outcome];
  const logs = all.flatMap((o) => o.outcome.logs);
  const fail = all.map((o) => o.outcome.status.Failure).find(Boolean) ?? res.status.Failure;
  let value = null;
  if (res.status.SuccessValue) { try { value = JSON.parse(Buffer.from(res.status.SuccessValue, "base64").toString()); } catch { value = null; } }
  return { ok: !fail, error: fail ? JSON.stringify(fail).slice(0, 600) : null, logs, value, hash: res.transaction.hash };
}

/** Sign and send `actions` from `signer_id` with `key` to `receiver_id`; waits for FINAL. */
export async function send(client, { signer_id, key, receiver_id, actions }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const ak = await client.accessKey(signer_id, key.pub);
    if (!ak) throw new Error(`no access key ${nearPublicKey(key.pub)} on ${signer_id}`);
    const header = await client.block();
    const { signed, hash } = signTransaction({ signer_id, public_key_hex: key.pub, nonce: BigInt(ak.nonce) + 1n + BigInt(attempt), receiver_id, block_hash: b58decode(header.hash), actions }, key);
    const r = await client.rpc("send_tx", { signed_tx_base64: signed.toString("base64"), wait_until: "FINAL" });
    if (r.error && /InvalidNonce|nonce/i.test(JSON.stringify(r.error))) continue;
    const o = outcome(r);
    return { ...o, hash: o.hash ?? hash };
  }
  throw new Error(`${signer_id}: nonce kept colliding`);
}

/** The inner delegate action for `sender` (its own key), valid for 200 blocks. */
export async function delegateFor(client, { sender_id, key, receiver_id, actions }) {
  const ak = await client.accessKey(sender_id, key.pub);
  if (!ak) throw new Error(`no access key on ${sender_id}`);
  const header = await client.block();
  const d = { sender_id, receiver_id, actions, nonce: BigInt(ak.nonce) + 1n, max_block_height: BigInt(header.height) + 200n, public_key_hex: key.pub };
  return signDelegate(d, key);
}
