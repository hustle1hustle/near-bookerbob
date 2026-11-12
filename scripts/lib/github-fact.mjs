// Pure helpers for the GitHub fact (make prove-me, make try): what a notarized reply reveals,
// which request was proven, the blinded proof ref, and the proof set with the three facts.
// No network, no keys, no external binary.
import { createHash } from "node:crypto";

export const MIN_AGE_YEARS = 3; // zkcore RULES ("github", "account_age_years", 3, "github_builder")
export const REVEAL = "github_builder,world_id_human";
const YEAR_MS = 365.25 * 86_400_000;

/** The three revealed fields, and a check that nothing else of the reply is revealed. */
export function deriveGithub(recv, timeSecs) {
  const shown = recv.replace(/X+/g, "\u0000");
  const one = (re, what) => {
    const all = [...shown.matchAll(re)];
    if (all.length !== 1) throw new Error(`${what}: revealed ${all.length} times, expected once`);
    return all[0];
  };
  const created = one(/"created_at":\s*"([0-9TZ:-]+)"/g, "created_at");
  const repos = one(/"public_repos":\s*([0-9]+)/g, "public_repos");
  const followers = one(/"followers":\s*([0-9]+)/g, "followers");
  let rest = shown;
  for (const m of [created, repos, followers]) rest = rest.replace(m[0], "");
  rest = rest.replace(/^HTTP\/1\.1 200 OK/, "").replace(/\u0000/g, "").trim();
  if (rest) throw new Error(`the reply reveals more than the three fields: ${JSON.stringify(rest.slice(0, 40))}`);
  if (!/^HTTP\/1\.1 200 OK/.test(shown)) throw new Error("not a 200 reply");
  const createdMs = Date.parse(created[1]);
  if (!Number.isFinite(createdMs)) throw new Error("created_at is not a date");
  return { account_age_years: Math.floor((timeSecs * 1000 - createdMs) / YEAR_MS), public_repos: Number(repos[1]), followers: Number(followers[1]) };
}

/** Which request was proven: the authenticated /user, or a public profile (test only). */
export function requestKind(sent) {
  const line = sent.split("\r\n")[0].replace(/X+$/, "");
  if (/^GET \/user HTTP\/1\.1/.test(line)) return { authenticated: true };
  const m = line.match(/^GET \/users\/([A-Za-z0-9-]+) HTTP\/1\.1/);
  if (m) return { authenticated: false, login: m[1] };
  throw new Error(`unexpected request line: ${line.slice(0, 40)}`);
}

/**
 * The facts' proof_ref, blinded: sha256(presentation sha256 || a private salt). The presentation's
 * own hash is published, so an unblinded ref would let anyone brute-force the three small
 * numbers back out of the verdict's proof_hash.
 */
export const blindRef = (presentationSha, salt) => createHash("sha256").update(`bookerbob/proof-ref/v1|${presentationSha}|${salt}`).digest("hex");

/** The fixture proof set plus the three real facts, and the claims for the revealed lines. */
export function withGithub(proofs, claims, facts, sha256) {
  const p = structuredClone(proofs);
  p.facts = p.facts.filter((f) => f.platform !== "github");
  p.facts.push(
    { id: "F6", platform: "github", field: "account_age_years", value: facts.account_age_years, proof_ref: sha256 },
    { id: "F7", platform: "github", field: "public_repos", value: facts.public_repos, proof_ref: sha256 },
    { id: "F8", platform: "github", field: "followers", value: facts.followers, proof_ref: sha256 },
  );
  const lines = REVEAL.split(",");
  const c = structuredClone(claims).filter((cl) => lines.includes(cl.line));
  c.push({ line: "github_builder", text: "an old github account", citations: [{ fact: "F6", field: "account_age_years", value: facts.account_age_years }] });
  return { proofs: p, claims: c };
}
