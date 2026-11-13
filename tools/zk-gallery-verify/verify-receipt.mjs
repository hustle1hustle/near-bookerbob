// node verify-receipt.mjs <pinned notary key, compressed hex> [file]     (or the JSON on stdin)
// Accepts a bare receipt, or any JSON with a `receipt` field (the harness output, a session_completed message).
// Checks, offline: version, pinned key, entries against results_digest, fields against the signed
// statement, and the secp256k1 ECDSA (SHA-256) signature. Same checks as `receipt::verify` in the notary.
// It cannot recompute view_digest: that needs the notary's view of the transcript, which is not in the receipt.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { blake3 } from '@noble/hashes/blake3';

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };

export function resultsDigest(entries) {
  const parts = [Buffer.from('REP-SESSION-RESULTS-v1\0'), u64(entries.length)];
  for (const e of entries) {
    const dir = { sent: 0, recv: 1 }[e.dir], action = { reveal: 0, hash: 1 }[e.action];
    if (dir === undefined || action === undefined) throw new Error('entries do not encode');
    const value = Buffer.from(e.value, 'utf8');
    parts.push(Buffer.from([dir, action]), u64(e.start), u64(e.end), u64(value.length), value);
  }
  return Buffer.from(blake3(Buffer.concat(parts))).toString('hex');
}

export function verifyReceipt(r, pinnedKeyHex) {
  if (r.version !== 'REP-SESSION-v1') throw new Error('unknown receipt version');
  if (r.notary_key.toLowerCase() !== pinnedKeyHex.trim().toLowerCase()) throw new Error('not signed by the pinned notary key');
  if (resultsDigest(r.entries) !== r.results_digest) throw new Error('entries do not match results_digest');
  const statement = ['REP-SESSION-v1', r.server_name, r.tls_time, r.signed_at, r.mode, r.nonce, r.results_digest, r.view_digest].join('\n');
  if (statement !== r.statement) throw new Error('fields do not match the signed statement');
  const point = crypto.ECDH.convertKey(pinnedKeyHex.trim(), 'secp256k1', 'hex', 'hex', 'uncompressed');
  const jwk = { kty: 'EC', crv: 'secp256k1',
    x: Buffer.from(point.slice(2, 66), 'hex').toString('base64url'), y: Buffer.from(point.slice(66), 'hex').toString('base64url') };
  const ok = crypto.verify('sha256', Buffer.from(r.statement, 'utf8'),
    { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(r.signature, 'hex'));
  if (!ok) throw new Error('signature does not verify');
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [key, file] = process.argv.slice(2);
  if (!key) { console.error('usage: node verify-receipt.mjs <pinned key hex> [file]'); process.exit(2); }
  const json = JSON.parse(fs.readFileSync(file || 0, 'utf8'));
  const r = json.receipt === undefined ? json : json.receipt;
  if (!r) { console.error('no receipt in the input (the notary sent none)'); process.exit(1); }
  try {
    verifyReceipt(r, key);
    console.log(JSON.stringify({ ok: true, server_name: r.server_name, tls_time: r.tls_time, signed_at: r.signed_at, mode: r.mode,
      nonce: r.nonce, entries: r.entries, receipt_digest: Buffer.from(blake3(Buffer.from(r.statement, 'utf8'))).toString('hex') }));
  } catch (e) { console.error('receipt rejected: ' + e.message); process.exit(1); }
}
