// NEAR AI E2EE v2 helpers, node:crypto only (moved from scripts/spikes/e2ee-signature.mjs).
//   wire = eph_x25519_pub(32) || nonce(24) || xchacha20poly1305(plaintext) ; hex
//   key  = HKDF-SHA256(X25519(eph, recipient), salt none, info "ed25519_encryption", 32)
// HChaCha20 is checked against the draft-irtf-cfrg-xchacha test vector on import.
import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, createCipheriv, createDecipheriv, verify } from "node:crypto";

// ---- HChaCha20 ----
const rotl = (v, n) => ((v << n) | (v >>> (32 - n))) >>> 0;
export function hchacha20(key, nonce16) {
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
export function xchachaSeal(key, nonce24, pt) {
  const sub = hchacha20(key, nonce24.subarray(0, 16));
  const c = createCipheriv("chacha20-poly1305", sub, Buffer.concat([Buffer.alloc(4), nonce24.subarray(16)]), { authTagLength: 16 });
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}
export function xchachaOpen(key, nonce24, ct) {
  const sub = hchacha20(key, nonce24.subarray(0, 16));
  const d = createDecipheriv("chacha20-poly1305", sub, Buffer.concat([Buffer.alloc(4), nonce24.subarray(16)]), { authTagLength: 16 });
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}

// ---- Ed25519 <-> X25519 ----
const P = 2n ** 255n - 19n;
const modpow = (b, e) => { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; };
export function edPubToX(edPub) {
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

export function sealTo(plaintext, recipientEdHex) {
  const eph = generateKeyPairSync("x25519");
  const ephPub = eph.publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: xPub(edPubToX(Buffer.from(recipientEdHex, "hex"))) });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), INFO, 32));
  const nonce = randomBytes(24);
  return Buffer.concat([ephPub, nonce, xchachaSeal(key, nonce, Buffer.from(plaintext))]).toString("hex");
}
export function openWith(wireHex, xSecretRaw) {
  const b = Buffer.from(wireHex, "hex");
  const shared = diffieHellman({ privateKey: xPriv(xSecretRaw), publicKey: xPub(b.subarray(0, 32)) });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), INFO, 32));
  return xchachaOpen(key, b.subarray(32, 56), b.subarray(56)).toString();
}
/** The per-field key a buyer discloses so anyone can open one sealed answer (hex). */
export function fieldKey(wireHex, xSecretRaw) {
  const b = Buffer.from(wireHex, "hex");
  const shared = diffieHellman({ privateKey: xPriv(xSecretRaw), publicKey: xPub(b.subarray(0, 32)) });
  return Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), INFO, 32)).toString("hex");
}
/** Open one sealed field with its disclosed per-field key (raw 32 bytes). */
export function openField(wireHex, key) {
  const b = Buffer.from(wireHex, "hex");
  return xchachaOpen(key, b.subarray(32, 56), b.subarray(56)).toString();
}
export function clientKey() {
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


export const sha = (b) => createHash("sha256").update(b).digest("hex");

/** ed25519 verify of a UTF-8 text against a hex public key. */
export function edVerify(text, sigHex, pubHex) {
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pubHex, "hex")]), format: "der", type: "spki" });
  return verify(null, Buffer.from(text), key, Buffer.from(sigHex, "hex"));
}
