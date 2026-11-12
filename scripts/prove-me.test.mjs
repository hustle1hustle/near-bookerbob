import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { blindRef, deriveGithub, requestKind, withGithub, REVEAL } from "./lib/github-fact.mjs";

// What rep-verify shows for a 3-field reveal: undisclosed bytes are X.
const X = (n) => "X".repeat(n);
const recv = `HTTP/1.1 200 OK${X(300)}"public_repos":8${X(40)}"followers":24941${X(20)}"created_at":"2011-01-25T18:44:36Z"${X(90)}`;
const t2026 = Date.parse("2026-11-05T00:00:00Z") / 1000;

test("three fields, the age in whole years at the notary's time", () => {
  assert.deepEqual(deriveGithub(recv, t2026), { account_age_years: 15, public_repos: 8, followers: 24941 });
  assert.equal(deriveGithub(recv.replace("2011", "2024"), t2026).account_age_years, 2);
});

test("a reply that reveals anything else is refused", () => {
  assert.throws(() => deriveGithub(recv.replace(X(40), `"login":"octocat"${X(20)}`), t2026), /more than the three fields/);
  assert.throws(() => deriveGithub(recv + `"followers":1`, t2026), /followers: revealed 2 times/);
  assert.throws(() => deriveGithub(recv.replace("200 OK", "401 Unauthorized"), t2026), /more than the three fields|not a 200/);
});

test("only the authenticated /user counts as your own account", () => {
  assert.deepEqual(requestKind(`GET /user HTTP/1.1\r\n${X(200)}`), { authenticated: true });
  assert.deepEqual(requestKind(`GET /users/octocat HTTP/1.1${X(100)}`), { authenticated: false, login: "octocat" });
  assert.throws(() => requestKind("GET /repos/x HTTP/1.1"), /unexpected request line/);
});

test("the real facts join the synthetic set as F6..F8; claims only for revealed lines", () => {
  const proofs = JSON.parse(readFileSync("fixtures/proofs.json", "utf8"));
  const claims = JSON.parse(readFileSync("fixtures/claims-honest.json", "utf8"));
  const r = withGithub(proofs, claims, { account_age_years: 15, public_repos: 8, followers: 3 }, "ab".repeat(32));
  assert.deepEqual(r.proofs.facts.filter((f) => f.platform === "github").map((f) => [f.id, f.field, f.value]), [["F6", "account_age_years", 15], ["F7", "public_repos", 8], ["F8", "followers", 3]]);
  assert.ok(r.claims.every((c) => REVEAL.split(",").includes(c.line)));
  assert.ok(!/[0-9]/.test(r.claims.at(-1).text), "no number in the claim text");
  assert.equal(proofs.facts.length, 5, "the fixture is untouched");
});

test("the proof_hash does not fall to a search over the three numbers once the ref is blinded", () => {
  const proofs = JSON.parse(readFileSync("fixtures/proofs.json", "utf8"));
  const pres = "ab".repeat(32); // published
  const hash = (ref, age) => createHash("sha256").update(JSON.stringify(withGithub(proofs, [], { account_age_years: age, public_repos: 8, followers: 3 }, ref).proofs)).digest("hex");
  const secretAge = 15;
  const unblinded = hash(pres, secretAge);
  assert.equal([...Array(40).keys()].find((a) => hash(pres, a) === unblinded), secretAge, "with the published ref, the age falls out");
  const onChain = hash(blindRef(pres, "cd".repeat(32)), secretAge);
  assert.ok(![...Array(40).keys()].some((a) => hash(pres, a) === onChain), "blinded: no guess matches without the salt");
});
