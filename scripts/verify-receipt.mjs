#!/usr/bin/env node
// node scripts/verify-receipt.mjs [file] : checks a REP notary session receipt (REP-SESSION-v1)
// offline: the version, the pinned notary key, the revealed entries against results_digest, every
// field against the signed statement, and the secp256k1 ECDSA (SHA-256) signature over it. It
// cannot recompute view_digest (that needs the notary's view of the transcript).
import crypto from "node:crypto";
import fs from "node:fs";
import { blake3 } from "./vendor/blake3.min.mjs";

export const QFEX_NOTARY_KEY = "0307293878f0133efed565f3aa39963d7362f7adab8b2b172d1ff3bf7908aaed32";
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };

export function resultsDigest(entries) {
  const parts = [Buffer.from("REP-SESSION-RESULTS-v1\0"), u64(entries.length)];
  for (const e of entries) {
    const dir = { sent: 0, recv: 1 }[e.dir], action = { reveal: 0, hash: 1 }[e.action];
    if (dir === undefined || action === undefined) throw new Error("entries do not encode");
    const v = Buffer.from(e.value, "utf8");
    parts.push(Buffer.from([dir, action]), u64(e.start), u64(e.end), u64(v.length), v);
  }
  return Buffer.from(blake3(Buffer.concat(parts))).toString("hex");
}

export function verifyReceipt(r, key = QFEX_NOTARY_KEY) {
  if (r.version !== "REP-SESSION-v1") throw new Error("unknown receipt version");
  if (r.notary_key.toLowerCase() !== key.toLowerCase()) throw new Error("not signed by the pinned notary key");
  if (resultsDigest(r.entries) !== r.results_digest) throw new Error("entries do not match results_digest");
  const st = ["REP-SESSION-v1", r.server_name, r.tls_time, r.signed_at, r.mode, r.nonce, r.results_digest, r.view_digest].join("\n");
  if (st !== r.statement) throw new Error("fields do not match the signed statement");
  const p = crypto.ECDH.convertKey(key, "secp256k1", "hex", "hex", "uncompressed");
  const jwk = { kty: "EC", crv: "secp256k1", x: Buffer.from(p.slice(2, 66), "hex").toString("base64url"), y: Buffer.from(p.slice(66), "hex").toString("base64url") };
  if (!crypto.verify("sha256", Buffer.from(r.statement, "utf8"), { key: crypto.createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(r.signature, "hex"))) throw new Error("signature does not verify");
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] ?? "fixtures/live/qfex/leaderboard-receipt.json";
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const r = j.receipt ?? j;
  try {
    verifyReceipt(r);
    console.log(`PASS  receipt: ${r.server_name}, ${r.mode}, signed ${new Date(r.signed_at * 1000).toISOString()} by ${r.notary_key.slice(0, 8)}.., revealed ${r.entries.map((e) => `${e.dir} ${e.value}`).join("; ")}`);
  } catch (e) { console.log(`FAIL  receipt: ${e.message}`); process.exit(1); }
}
