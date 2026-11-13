// Rules-registry canonical bytes and digests (RFC 8785 JCS, integers only; M = "REP/rules/v1\\0" || JCS(record)).
import crypto from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3';
export function jcs(v) {
  if (v === null || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isSafeInteger(v)) throw new Error(`non-integer number ${v}`); return String(v); }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(',')}}`;
  throw new Error(`cannot canonicalize ${typeof v}`);
}
const PREFIX = Buffer.from('REP/rules/v1\0');
export const digests = (record) => {
  const m = Buffer.concat([PREFIX, Buffer.from(jcs(record), 'utf8')]);
  return { d_b3: Buffer.from(blake3(m)).toString('hex'), d_sha: crypto.createHash('sha256').update(m).digest('hex'), bytes: m.length };
};
