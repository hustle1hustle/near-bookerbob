#!/usr/bin/env node
// Open check B1: under NEAR AI E2EE v2, does the response signature
// `model:sha256(request):sha256(response)` cover the ciphertext on the wire or the plaintext?
//   node scripts/spikes/e2ee-signature.mjs      (needs NEAR_AI_KEY or ~/.rep-secrets/near-ai.key)
// Writes fixtures/live/e2ee-signature.json. One small completion, well under $0.001.
//
// E2EE v2 per field (docs.near.ai e2ee guide, as used by rep-concierge):
//   wire = eph_x25519_pub(32) || nonce(24) || xchacha20poly1305(plaintext) ; hex
//   key  = HKDF-SHA256(X25519(eph, recipient), salt none, info "ed25519_encryption", 32)
// Built on node:crypto only. HChaCha20 is the one piece node lacks; it is checked against
// the draft-irtf-cfrg-xchacha test vector before anything is sent.
import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, createCipheriv, createDecipheriv, verify } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const API = process.env.NEAR_AI_BASE ?? "https://cloud-api.near.ai/v1";
const MODEL = process.env.NEAR_AI_MODEL ?? "z-ai/glm-5.3-flash";
const KEY = (process.env.NEAR_AI_KEY ?? readFileSync(`${process.env.HOME}/.rep-secrets/near-ai.key`, "utf8")).trim();
const sha = (b) => createHash("sha256").update(b).digest("hex");

// ---- HChaCha20 ----
const rotl = (v, n) => ((v << n) | (v >>> (32 - n))) >>> 0;
function hchacha20(key, nonce16) {
  const s = new Uint32Array(16);
  s.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  for (let i = 0; i < 8; i++) s[4 + i] = key.readUInt32LE(i * 4);
  for (let i = 0; i < 4; i++) s[12 + i] = nonce16.readUInt32LE(i * 4);
  const qr = (a, b, c, d) => {
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
  }
  const out = Buffer.alloc(32);
  [0, 1, 2, 3, 12, 13, 14, 15].forEach((w, i) => out.writeUInt32LE(s[w], i * 4));
  return out;
}
{
  // draft-irtf-cfrg-xchacha-03, section 2.2.1
  const k = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
  const n = Buffer.from("000000090000004a0000000031415927", "hex");
  if (hchacha20(k, n).toString("hex") !== "82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc") throw new Error("hchacha20 test vector failed");
}
function xchachaSeal(key, nonce24, pt) {
  const sub = hchacha20(key, nonce24.subarray(0, 16));
  const c = createCipheriv("chacha20-poly1305", sub, Buffer.concat([Buffer.alloc(4), nonce24.subarray(16)]), { authTagLength: 16 });
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}
function xchachaOpen(key, nonce24, ct) {
  const sub = hchacha20(key, nonce24.subarray(0, 16));
  const d = createDecipheriv("chacha20-poly1305", sub, Buffer.concat([Buffer.alloc(4), nonce24.subarray(16)]), { authTagLength: 16 });
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}

// ---- Ed25519 <-> X25519 ----
const P = 2n ** 255n - 19n;
const modpow = (b, e) => { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; };
function edPubToX(edPub) {
  const yb = Buffer.from(edPub); yb[31] &= 0x7f;
  const y = BigInt("0x" + Buffer.from(yb).reverse().toString("hex"));
  const u = ((1n + y) * modpow((1n - y + P) % P, P - 2n)) % P;
  return Buffer.from(u.toString(16).padStart(64, "0"), "hex").reverse();
}
const X_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const X_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const ED_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const xPub = (raw) => createPublicKey({ key: Buffer.concat([X_SPKI, raw]), format: "der", type: "spki" });
const xPriv = (raw) => createPrivateKey({ key: Buffer.concat([X_PKCS8, raw]), format: "der", type: "pkcs8" });
const INFO = Buffer.from("ed25519_encryption");

function sealTo(plaintext, recipientEdHex) {
  const eph = generateKeyPairSync("x25519");
  const ephPub = eph.publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: xPub(edPubToX(Buffer.from(recipientEdHex, "hex"))) });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), INFO, 32));
  const nonce = randomBytes(24);
  return Buffer.concat([ephPub, nonce, xchachaSeal(key, nonce, Buffer.from(plaintext))]).toString("hex");
}
function openWith(wireHex, xSecretRaw) {
  const b = Buffer.from(wireHex, "hex");
  const shared = diffieHellman({ privateKey: xPriv(xSecretRaw), publicKey: xPub(b.subarray(0, 32)) });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), INFO, 32));
  return xchachaOpen(key, b.subarray(32, 56), b.subarray(56)).toString();
}
function clientKey() {
  const seed = randomBytes(32);
  const ed = createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: "der", type: "pkcs8" });
  const pub = createPublicKey(ed).export({ format: "der", type: "spki" }).subarray(12);
  const h = createHash("sha512").update(seed).digest().subarray(0, 32);
  h[0] &= 248; h[31] &= 127; h[31] |= 64;
  return { pubHex: pub.toString("hex"), xSecret: Buffer.from(h) };
}
// Self-check: seal to our own Ed25519 key and open with the converted secret.
{
  const me = clientKey();
  if (openWith(sealTo("self-check", me.pubHex), me.xSecret) !== "self-check") throw new Error("e2ee self-check failed");
}

// ---- live ----
const auth = { Authorization: `Bearer ${KEY}` };
const nonce = randomBytes(32).toString("hex");
const att = await (await fetch(`${API}/attestation/report?model=${encodeURIComponent(MODEL)}&signing_algo=ed25519&nonce=${nonce}`, { headers: { ...auth, "x-no-aliasing": "true" } })).json();
const ma = att.model_attestations?.[0] ?? att;
const modelPub = ma.signing_public_key ?? ma.signing_address;
if (!modelPub || !/^[0-9a-f]{64}$/.test(modelPub)) throw new Error(`no ed25519 model key in attestation (keys: ${Object.keys(ma).join(",")})`);

const me = clientKey();
const plainBody = { model: MODEL, max_tokens: 200, temperature: 0, messages: [{ role: "user", content: "Reply with the single word: sealed" }] };
const wireBody = { ...plainBody, messages: plainBody.messages.map((m) => ({ ...m, content: sealTo(m.content, modelPub) })) };
const reqBytes = Buffer.from(JSON.stringify(wireBody));
const res = await fetch(`${API}/chat/completions`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json", "X-Signing-Algo": "ed25519", "X-Client-Pub-Key": me.pubHex, "X-Model-Pub-Key": modelPub, "X-Encryption-Version": "2", "x-no-aliasing": "true" },
  body: reqBytes,
});
const resBytes = Buffer.from(await res.arrayBuffer());
if (!res.ok) throw new Error(`HTTP ${res.status} ${resBytes.toString().slice(0, 300)}`);
const body = JSON.parse(resBytes);
const wireAnswer = body.choices[0].message.content;
const answer = openWith(wireAnswer, me.xSecret);
const plainResp = JSON.parse(JSON.stringify(body));
plainResp.choices[0].message.content = answer;

const sig = await (await fetch(`${API}/signature/${body.id}?model=${encodeURIComponent(MODEL)}&signing_algo=ed25519`, { headers: auth })).json();
const [sModel, sReq, sRes] = sig.text.split(":");
const edVerify = (t, s, k) => verify(null, Buffer.from(t), createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(k, "hex")]), format: "der", type: "spki" }), Buffer.from(s, "hex"));
const result = {
  note: "live E2EE v2 run, one completion. Hashes compared against the bytes actually sent and received, and against plaintext reconstructions.",
  at: new Date().toISOString(),
  model: MODEL,
  model_pub_key: modelPub,
  signing_address: sig.signing_address,
  signature_kind: sig.signature_kind,
  signature_valid: edVerify(sig.text, sig.signature, sig.signing_address),
  signing_key_equals_e2ee_key: sig.signing_address === modelPub,
  model_in_text: sModel === MODEL,
  answer_decrypted: answer,
  answer_was_sealed: /^[0-9a-f]+$/.test(wireAnswer) && wireAnswer.length >= 144,
  request: { signed: sReq, sha256_wire_ciphertext: sha(reqBytes), sha256_plaintext_json: sha(Buffer.from(JSON.stringify(plainBody))) },
  response: { signed: sRes, sha256_wire_ciphertext: sha(resBytes), sha256_plaintext_json: sha(Buffer.from(JSON.stringify(plainResp))) },
};
result.verdict = {
  request_covers: sReq === result.request.sha256_wire_ciphertext ? "ciphertext" : sReq === result.request.sha256_plaintext_json ? "plaintext (our serialization)" : "neither of our candidates",
  response_covers: sRes === result.response.sha256_wire_ciphertext ? "ciphertext" : sRes === result.response.sha256_plaintext_json ? "plaintext (our serialization)" : "neither of our candidates",
};
mkdirSync("fixtures/live", { recursive: true });
writeFileSync("fixtures/live/e2ee-signature.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ valid: result.signature_valid, same_key: result.signing_key_equals_e2ee_key, sealed: result.answer_was_sealed, answer, ...result.verdict }, null, 1));
