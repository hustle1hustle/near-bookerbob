// Checks a REP zk receipt: a notary-signed REP-SESSION-v1 receipt whose answer was only hash-committed, plus a Jolt
// zero-knowledge proof over the committed bytes. verifyZk({ receipt, proof, outputsRaw, notaryKey, template, guest, now })
// returns { floor30d, floorTotal, counts, tag, f, c } or throws an error with a code.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { verifyReceipt } from './verify-receipt.mjs';

const require = createRequire(import.meta.url);
const wasm = require('./wasm/rep_zk_verify.js');
const MAX_AGE_SEC = 600;

const refuse = (code, why) => Object.assign(new Error(why), { code });
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// postcard varint and Bytes, as the guest reads its public input
const varint = (n) => { const o = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; o.push(b); } while (n); return o; };
const pcBytes = (s) => { const u = Buffer.from(s, 'utf8'); return [...varint(u.length), ...u]; };
export const publicInputs = (g) => Buffer.from([...pcBytes(g.context), ...pcBytes(g.issuer), ...pcBytes(g.issuerAlt || ''), ...pcBytes(g.host), ...pcBytes(g.path), ...Buffer.from(g.kFp, 'hex'), g.segment, g.mode ?? 0]);

export function decodeOut(b) {
  let i = 0;
  const v = () => { let r = 0, s = 1; for (;;) { const x = b[i++]; r += (x & 0x7f) * s; if (x < 0x80) return r; s *= 128; } };
  const hex = (n) => { const h = b.subarray(i, i + n).toString('hex'); i += n; return h; };
  const ok = b[i++] === 1, err = b[i++];
  const requestCommit = hex(32), responseCommit = hex(32), tag = hex(32);
  const floor30d = v(), floorTotal = v(), counts = [v(), v(), v()], f = hex(32), c = hex(32);
  return { ok, err, requestCommit, responseCommit, tag, floor30d, floorTotal, counts, f, c };
}

let cached = null;   // the pinned guest's verifier preprocessing, loaded once
export function verifyZk({ receipt: r, proof, outputsRaw, notaryKey, template, guest, now = Math.floor(Date.now() / 1000), maxAgeSec = MAX_AGE_SEC }) {
  // 1. the receipt itself: pinned key, entries against results_digest, statement, signature
  try { verifyReceipt(r, notaryKey); } catch (e) { throw refuse('receipt', e.message); }
  if (r.server_name !== template.host) throw refuse('wrong_host', 'the receipt is about another host');
  if (r.tls_time > now + 60 || now - r.tls_time > maxAgeSec) throw refuse('stale', 'the session is not recent');
  // 2. exactly three entries: the request line revealed from byte 0, the whole request hashed, the whole answer hashed
  const [line, sent, recv, ...rest] = r.entries;
  if (rest.length || !line || !sent || !recv) throw refuse('zk_entries', 'the receipt does not have the zk shape');
  if (line.dir !== 'sent' || line.action !== 'reveal' || line.start !== 0 || line.end !== Buffer.byteLength(line.value, 'utf8') || line.value !== template.requestLine)
    throw refuse('request_line', 'the request is not the one this proof is defined for');
  if (sent.dir !== 'sent' || sent.action !== 'hash' || sent.start !== 0 || !(sent.end > line.end)) throw refuse('zk_entries', 'the request is not hashed from its first byte');
  if (recv.dir !== 'recv' || recv.action !== 'hash' || recv.start !== 0 || !(recv.end > 0)) throw refuse('zk_entries', 'the answer is not hashed from its first byte');
  // (Whole-transcript coverage rests on the guest: it refuses a request or an answer that is not complete HTTP.)
  // 3. the proof's public outputs are bound to those two signed digests
  const out = decodeOut(outputsRaw);
  if (!out.ok) throw refuse('zk_statement', `the proven answer is not in the expected form (guest check ${out.err})`);
  if (out.requestCommit !== sent.value.toLowerCase() || out.responseCommit !== recv.value.toLowerCase()) throw refuse('zk_binding', 'the proof is over other bytes than the notary signed');
  // 4. the Jolt proof against the pinned guest (its verifier data is pinned by hash)
  if (!cached || cached.sha !== guest.verifierSha256) {
    const vpp = fs.readFileSync(guest.verifierPath);
    if (sha256(vpp) !== guest.verifierSha256) throw refuse('zk_guest', 'the verifier data is not the pinned guest');
    cached = { sha: guest.verifierSha256, vpp };
  }
  try { wasm.verify(cached.vpp, proof, publicInputs(guest.public), outputsRaw); } catch (e) { throw refuse('zk_proof', 'the proof does not verify: ' + (e?.message || e)); }
  // f and c are the double lock of the fact, proven from the same figures: admission hashes them into leaf_f.
  return { floor30d: out.floor30d, floorTotal: out.floorTotal, counts: out.counts, tag: out.tag, f: out.f, c: out.c };
}
