#!/usr/bin/env node
// Testnet view-call spikes. Free, no keys, no transactions. Writes fixtures/live/views.json.
//   node scripts/spikes/views.mjs
// - Chain Signatures: derived Ed25519 key (domain_id 1) for the bazaar account, and the
//   Stellar G-address that key controls (strkey: version 6<<3, key, CRC16-XModem LE).
// - OutLayer: estimate_execution_cost with default limits.
// - USDC: ft_metadata of the Circle testnet token.
import { writeFileSync, mkdirSync } from "node:fs";

const RPC = process.env.NEAR_RPC ?? "https://rpc.testnet.near.org";
const MPC = process.env.MPC_SIGNER_ID ?? "v1.signer-prod.testnet";
const OUTLAYER = process.env.OUTLAYER_CONTRACT_ID ?? "outlayer.testnet";
const USDC = process.env.USDC_CONTRACT_ID ?? "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const BAZAAR = process.env.BAZAAR_ACCOUNT_ID || "bookerbob.testnet";

async function view(account_id, method_name, args) {
  const body = {
    jsonrpc: "2.0",
    id: "bookerbob",
    method: "query",
    params: { request_type: "call_function", finality: "final", account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
  };
  const r = await (await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  if (r.error || r.result?.error) return { ok: false, error: r.error?.cause?.name ?? r.error?.message ?? r.result.error };
  const text = Buffer.from(r.result.result).toString();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return { ok: true, block_height: r.result.block_height, block_hash: r.result.block_hash, value };
}

const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHA.indexOf(c));
  const out = [];
  while (n > 0n) out.unshift(Number(n & 0xffn)), (n >>= 8n);
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Buffer.from(out);
}

function crc16xmodem(buf) {
  let crc = 0;
  for (const b of buf) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function base32(buf) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0, out = "";
  for (const b of buf) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) out += A[(val >>> (bits - 5)) & 31], (bits -= 5);
  }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}

export function stellarAddress(ed25519Key32) {
  const payload = Buffer.concat([Buffer.from([6 << 3]), ed25519Key32]);
  const crc = crc16xmodem(payload);
  return base32(Buffer.concat([payload, Buffer.from([crc & 0xff, crc >> 8])]));
}

const path = "stellar-1";
const derived = await view(MPC, "derived_public_key", { path, predecessor: BAZAAR, domain_id: 1 });
let stellar = null;
if (derived.ok && typeof derived.value === "string" && derived.value.startsWith("ed25519:")) {
  const raw = b58decode(derived.value.slice("ed25519:".length));
  stellar = { key_hex: raw.toString("hex"), g_address: raw.length === 32 ? stellarAddress(raw) : null };
}
const out = {
  note: "live testnet view calls, no transactions. Re-run to refresh.",
  at: new Date().toISOString(),
  rpc: RPC,
  chain_signatures: {
    contract: MPC,
    request: { path, predecessor: BAZAAR, domain_id: 1 },
    derived_public_key: derived,
    stellar,
    root_public_key_domain_1: await view(MPC, "public_key", { domain_id: 1 }),
  },
  outlayer: { contract: OUTLAYER, estimate_execution_cost: await view(OUTLAYER, "estimate_execution_cost", {}) },
  usdc: { contract: USDC, ft_metadata: await view(USDC, "ft_metadata", {}) },
};
mkdirSync("fixtures/live", { recursive: true });
writeFileSync("fixtures/live/views.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ derived: derived.value, stellar: stellar?.g_address, root: out.chain_signatures.root_public_key_domain_1.value ?? out.chain_signatures.root_public_key_domain_1.error, outlayer_cost: out.outlayer.estimate_execution_cost.value ?? out.outlayer.estimate_execution_cost.error, usdc: out.usdc.ft_metadata.value?.symbol }, null, 1));
