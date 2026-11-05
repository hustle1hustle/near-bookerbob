#!/usr/bin/env node
// The NEAR AI enclave's NVIDIA GPU evidence, checked by NVIDIA's Remote Attestation Service.
//
//   node scripts/nras.mjs capture   POST the GPU evidence from the captured NEAR AI report
//                                   (fixtures/live/near-ai/report.json, nvidia_payload) to NRAS
//                                   once, and save its signed reply with NVIDIA's key set
//                                   (fixtures/live/near-ai/nras.json). Public service, no account.
//   node scripts/nras.mjs verify    offline (make verify): every NRAS token is signed by a key in
//                                   the saved key set (ES384) whose x5c chain leads to the pinned
//                                   NVIDIA root, the platform verdict is true, its
//                                   nonce is our request nonce (the same one the TDX quote binds),
//                                   it lists every GPU's token by digest, and each GPU's claims
//                                   pass (measurements, secure boot, debug off, report signature
//                                   and nonce, cert chain).
//
// What this proves: NVIDIA, at capture time, judged these 8 GPUs' attestation reports genuine,
// unmodified and bound to our nonce. What it does not: that the GPU and the TDX quote are the
// same machine beyond both carrying our nonce, or anything about the GPUs after capture.
import { createHash, createPublicKey, verify, X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const REPORT = "fixtures/live/near-ai/report.json";
const OUT = "fixtures/live/near-ai/nras.json";
const NRAS = "https://nras.attestation.nvidia.com";
const b64u = (s) => Buffer.from(s, "base64url");

/** NVIDIA's NRAS root, "NVIDIA Attestation Service CA 001" (self-signed, valid to 2055), from
 * NVIDIA's own PKI (https://prod.vault.nvidia.com/v1/dgxc-attestation/pki/nras-prod/cert/ca_chain,
 * the mount the signing certificates' AIA names), pinned by its sha256. */
export const ROOT_PEM = "fixtures/live/near-ai/nras-root.crt";
export const ROOT_SHA256 = "cde269e3f72c667aecc2d8c1ab32c4e42aaf5507379f15f221c77c5518101a1e";

/** The signing key's x5c chain: leaf <- intermediate <- the pinned root, each valid at `atSecs`
 * (the token's issue time: the leaves live about a day), and the JWK is the leaf's own key. */
export function chainOk(jwk, rootPem, atSecs) {
  const root = new X509Certificate(rootPem);
  if (createHash("sha256").update(root.raw).digest("hex") !== ROOT_SHA256) return "the root is not the pinned NVIDIA root";
  const certs = (jwk.x5c ?? []).map((b) => new X509Certificate(Buffer.from(b, "base64")));
  if (!certs.length) return "no x5c chain";
  const chain = [...certs, root];
  const at = new Date(atSecs * 1000);
  for (let i = 0; i < chain.length - 1; i++) {
    const [c, issuer] = [chain[i], chain[i + 1]];
    if (!c.checkIssued(issuer) || !c.verify(issuer.publicKey)) return `certificate ${i} (${c.subject.split("\n").pop()}) is not signed by ${issuer.subject.split("\n").pop()}`;
    if (new Date(c.validFrom) > at || new Date(c.validTo) < at) return `certificate ${i} is not valid at the token's issue time`;
  }
  const leafJwk = certs[0].publicKey.export({ format: "jwk" });
  if (leafJwk.x !== jwk.x || leafJwk.y !== jwk.y) return "the JWK is not the leaf certificate's key";
  return null;
}

export function checkToken(jwt, jwks, rootPem = readFileSync(ROOT_PEM, "utf8")) {
  const [h, p, sig] = jwt.split(".");
  const header = JSON.parse(b64u(h));
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== "ES384") return { ok: false, why: `no ES384 key ${header.kid} in the key set` };
  const chainErr = chainOk(jwk, rootPem, JSON.parse(b64u(p)).iat);
  if (chainErr) return { ok: false, why: chainErr };
  const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: "jwk" });
  const ok = verify("sha384", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, b64u(sig));
  return { ok, claims: JSON.parse(b64u(p)), why: ok ? null : "bad NVIDIA signature" };
}

const GPU_CLAIMS = [
  ["measres", "success"],
  ["secboot", true],
  ["dbgstat", "disabled"],
  ["x-nvidia-gpu-attestation-report-signature-verified", true],
  ["x-nvidia-gpu-attestation-report-nonce-match", true],
  ["x-nvidia-gpu-attestation-report-cert-chain-validated", true],
  ["x-nvidia-gpu-arch-check", true],
  ["x-nvidia-gpu-driver-rim-signature-verified", true],
  ["x-nvidia-gpu-vbios-rim-signature-verified", true],
];

/** All the checks on a saved NRAS reply; returns [ok, detail] rows. */
export function verifySaved(saved, nonce) {
  const rows = [];
  const [[kind, platform], gpus] = saved.response;
  const pt = checkToken(platform, saved.jwks);
  rows.push([kind === "JWT" && pt.ok, `platform token signed by NVIDIA (${pt.why ?? "ES384; the key's x5c chain leads to the pinned NVIDIA root"})`]);
  rows.push([pt.claims?.["x-nvidia-overall-att-result"] === true, "NVIDIA's overall attestation result is true"]);
  rows.push([pt.claims?.eat_nonce === nonce, `the platform token's nonce is our request nonce ${nonce.slice(0, 12)}..`]);
  const names = Object.keys(gpus);
  // The platform token's GPU list and the GPU tokens must be the same set, every digest matching.
  const listed = Object.keys(pt.claims?.submods ?? {}).sort();
  const digestsOk = names.length > 0 && JSON.stringify(listed) === JSON.stringify([...names].sort()) && names.every((n) => pt.claims.submods[n]?.[1]?.[1] === createHash("sha256").update(gpus[n]).digest("hex"));
  rows.push([digestsOk, `the platform token lists all ${names.length} GPU tokens by sha256`]);
  for (const n of names) {
    const t = checkToken(gpus[n], saved.jwks);
    const bad = GPU_CLAIMS.filter(([k, v]) => t.claims?.[k] !== v).map(([k]) => k);
    rows.push([t.ok && bad.length === 0 && t.claims.eat_nonce === nonce, `${n} (${t.claims?.hwmodel ?? "?"}): signed, ${bad.length ? `failing ${bad.join(", ")}` : "measurements, secure boot, debug off, report signature, nonce, cert chain all pass"}`]);
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = JSON.parse(readFileSync(REPORT, "utf8"));
  const payload = JSON.parse(report.model_attestations[0].nvidia_payload);
  const cmd = process.argv[2] ?? "verify";
  if (cmd === "capture") {
    const res = await fetch(`${NRAS}/v3/attest/gpu`, { method: "POST", headers: { "Content-Type": "application/json", accept: "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`NRAS ${res.status}`);
    const response = await res.json();
    const jwks = await (await fetch(`${NRAS}/.well-known/jwks.json`)).json();
    const saved = { note: "NVIDIA NRAS v3 reply for the GPU evidence in fixtures/live/near-ai/report.json (nvidia_payload), with NVIDIA's key set at capture time. Checked offline by scripts/nras.mjs verify.", captured_at: new Date().toISOString(), evidence_sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), response, jwks };
    writeFileSync(OUT, JSON.stringify(saved, null, 2) + "\n");
    console.log(`saved ${OUT}: ${Object.keys(response[1]).length} GPU tokens`);
  }
  const saved = JSON.parse(readFileSync(OUT, "utf8"));
  const rows = verifySaved(saved, payload.nonce);
  for (const [ok, t] of rows) console.log(`${ok ? "PASS" : "FAIL"}  nras ${t}`);
  const pass = rows.every(([ok]) => ok);
  console.log(`${pass ? "PASS" : "FAIL"}  NVIDIA GPU evidence (NRAS): ${rows.length} checks, captured ${saved.captured_at.slice(0, 10)}, offline`);
  process.exit(pass ? 0 : 1);
}
