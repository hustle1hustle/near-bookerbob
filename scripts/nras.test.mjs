import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifySaved } from "./nras.mjs";

const saved = JSON.parse(readFileSync("fixtures/live/near-ai/nras.json", "utf8"));
const nonce = JSON.parse(JSON.parse(readFileSync("fixtures/live/near-ai/report.json", "utf8")).model_attestations[0].nvidia_payload).nonce;

test("the saved NRAS reply passes every check", () => {
  assert.ok(verifySaved(saved, nonce).every(([ok]) => ok));
});

test("another nonce, an edited claim or a dropped GPU fails", () => {
  assert.ok(!verifySaved(saved, "00".repeat(32)).every(([ok]) => ok), "another nonce");
  const edit = structuredClone(saved);
  const [h, p, s] = edit.response[0][1].split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  claims["x-nvidia-overall-att-result"] = true;
  claims.nbf += 1;
  edit.response[0][1] = [h, Buffer.from(JSON.stringify(claims)).toString("base64url"), s].join(".");
  assert.ok(!verifySaved(edit, nonce)[0][0], "an edited platform token no longer verifies");
  const drop = structuredClone(saved);
  delete drop.response[1][Object.keys(drop.response[1])[0]];
  assert.ok(!verifySaved(drop, nonce).every(([ok]) => ok), "a GPU missing from the list");
});

test("a self-signed key set fails: a valid ES384 signature is not enough without NVIDIA's chain", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync: rf } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createPrivateKey, sign, X509Certificate } = await import("node:crypto");
  const { checkToken, ROOT_PEM } = await import("./nras.mjs");
  const d = mkdtempSync(join(tmpdir(), "nras-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-384", "-nodes", "-keyout", join(d, "k.pem"), "-out", join(d, "c.pem"), "-days", "2", "-subj", "/CN=NVIDIA Attestation Service CA 001"], { stdio: "ignore" });
  const cert = new X509Certificate(rf(join(d, "c.pem")));
  const jwk = cert.publicKey.export({ format: "jwk" });
  const [h, p] = saved.response[0][1].split(".");
  const kid = JSON.parse(Buffer.from(h, "base64url")).kid;
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  claims.iat = Math.floor(Date.now() / 1000);
  const body = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  const sig = sign("sha384", Buffer.from(body), { key: createPrivateKey(rf(join(d, "k.pem"))), dsaEncoding: "ieee-p1363" }).toString("base64url");
  const fake = { keys: [{ ...jwk, kid, x5c: [cert.raw.toString("base64")] }] };
  const r = checkToken(`${body}.${sig}`, fake);
  assert.equal(r.ok, false);
  assert.match(r.why, /not signed by/);
  // The same forged chain presented as the root fails the pin.
  assert.match(checkToken(`${body}.${sig}`, fake, rf(join(d, "c.pem"), "utf8")).why, /pinned NVIDIA root/);
  assert.ok(rf(ROOT_PEM, "utf8").includes("BEGIN CERTIFICATE"));
});
