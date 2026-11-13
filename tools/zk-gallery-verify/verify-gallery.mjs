// Public check of a REP zk gallery bundle (zk mode 1), against the rules registry only.
// node verify-gallery.mjs <bundle.json> [registry.jsonl] [verifier-data dir]
// Trusts: the registry records (chain re-verified here), the notary key they name, the pinned guest. Nothing else.
import fs from 'node:fs';
import { verifyZk } from './verify-zk.mjs';
import { digests } from './registry-digests.mjs';

const [bundlePath, regPath = new URL('./registry.jsonl', import.meta.url).pathname, vdir = new URL('./verifier-data', import.meta.url).pathname] = process.argv.slice(2);
if (!bundlePath) { console.error('usage: node verify-gallery.mjs <bundle.json> [registry.jsonl] [verifier-data dir]'); process.exit(2); }
const fail = (why) => { console.log(`INVALID: ${why}`); process.exit(1); };
const b = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
if (b.format !== 'rep-zk-bundle/v1' || b.zk_mode !== 1) fail('not a public (mode 1) bundle');

// 1. the registry: walk the chain from seq 0, then take the latest version of each record
const lines = fs.readFileSync(regPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
let prev = { d_b3: '0'.repeat(64), d_sha: '0'.repeat(64) };
for (const { record } of lines) {
  if (record.prev_blake3 !== prev.d_b3 || record.prev_sha256 !== prev.d_sha) fail(`registry chain broken at seq ${record.seq}`);
  prev = digests(record);
}
const recs = lines.map((l) => l.record);
const latest = (kind, id) => recs.filter((r) => r.kind === kind && r.id === id).sort((x, y) => y.version - x.version)[0];
const tpl = latest('template', b.template); if (!tpl) fail(`no template ${b.template} in the registry`);
if (tpl.body.zk_mode !== 1) fail('the registry template is not a public-mode template');
const guest = latest('guest', tpl.body.guest_id); if (!guest) fail('the template names no guest');
if (b.guest_elf_sha256 !== guest.body.elf_sha256) fail('the bundle was made by another guest than the registry pins');

// 2. the notary key, and the session inside its validity window
const r = b.receipt; if (!r) fail('no signed receipt');
const keyRec = recs.find((x) => x.kind === 'notary_key' && x.body.key === r.notary_key);
if (!keyRec || !tpl.body.notary_key_ids.includes(keyRec.body.key_id)) fail('the receipt is not signed by a notary key the template accepts');
const t = r.tls_time;
if (t < Date.parse(keyRec.body.valid_from_utc) / 1000 || t > Date.parse(keyRec.body.valid_until_utc) / 1000) fail('the session is outside the notary key validity window');

// 3. receipt + proof, with the guest's verifier data pinned by the registry; no freshness limit for an archive
const verifierPath = `${vdir}/${guest.body.elf_sha256}.verifier.bin`;
const pub = { context: tpl.body.context, issuer: tpl.body.issuers[0], issuerAlt: tpl.body.issuers[1] || '', host: tpl.body.host,
  path: tpl.body.path, kFp: tpl.body.k_fp, segment: tpl.body.segment, mode: 1 };
let v;
try {
  v = verifyZk({ receipt: r, proof: Buffer.from(b.proof_b64, 'base64'), outputsRaw: Buffer.from(b.outputs_hex, 'hex'), notaryKey: r.notary_key,
    template: { host: tpl.body.host, requestLine: tpl.body.request_line }, guest: { verifierPath, verifierSha256: guest.body.verifier_data_sha256, public: pub },
    now: t, maxAgeSec: Number.MAX_SAFE_INTEGER });
} catch (e) { fail(`${e.code || 'error'}: ${e.message}`); }

// 4. public mode carries nothing that identifies the account
const zero = '0'.repeat(64);
if (v.tag !== zero || v.f !== zero || v.c !== zero) fail('a public bundle must not carry a tag, F or C');
const usd = (n) => `$${n.toLocaleString('en-US')}`;
console.log(`VALID (registry head ${prev.d_b3.slice(0, 16)}...)`);
console.log(`  ${tpl.body.host}, ${tpl.body.request_line}, session ${new Date(t * 1000).toISOString()}, notary key ${keyRec.body.key_id} (${keyRec.body.host})`);
console.log(`  referral volume, 30 days: at least ${usd(v.floor30d)}; lifetime: at least ${usd(v.floorTotal)}`);
console.log(`  referrals per level: ${v.counts.map((n) => `${n}+`).join(' / ')}`);
console.log(`  account: not identified (public mode); guest ${guest.body.elf_sha256.slice(0, 16)}... (reproducible build)`);
