#!/usr/bin/env node
// `make prove-me`: your own GitHub account becomes the real fact behind one testnet purchase.
//
//   node scripts/prove-me.mjs check                    notary, prover, verifier, keys, token
//   node scripts/prove-me.mjs setup <round>            the builders merchant joins (bonded, open
//                                                      category, a github_builder line); a blind
//                                                      round with it and house: commit, reveal
//   node scripts/prove-me.mjs run <round> [--dry-run] [--public <login>]
//
// run:
//  1. `make leak` before.
//  2. REP's prover (not in this repo) notarizes GET api.github.com/user with your token (PROVE_ME_TOKEN_FILE,
//     default KEYS_DIR/../github-throwaway.token) through the REP notary on Fly (MPC-TLS, a
//     pinned key, not TEE-attested). Only `created_at`, `public_repos` and `followers` are
//     revealed; the request (and the token in it) is never revealed.
//  3. rep-verify checks the signature against the pinned key; the revealed reply must hold
//     those three fields and nothing else; the privacy scan of device-run.mjs runs too.
//  4. The facts (account_age_years, public_repos, followers) go sealed to the NEAR AI model
//     (E2EE v2) with the rule table; its predicates and TEE signature are checked.
//  5. A fresh tester buys from the round's cheapest bid with a sealed verdict (hashes only on
//     chain) revealing github_builder and world_id_human inside the opening; dUSDC settle.
//  6. `make leak` after; fixtures/live/prove-me/<run>.json gets hashes, txs and the outcome.
//
// --public <login>: proves api.github.com/users/<login> with no token. A pipeline test only:
// a public profile proves a fact about an account, not that the prover holds it; the record
// says so. Testnet only; dUSDC is a demo token.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config, Demo, guard } from "./demo-tester.mjs";
import { NOTARY_KEY, NOTARY_URL, REP_VERIFY } from "./lib/notary.mjs";
import { privacyProblems } from "./lib/spend-fact.mjs";
import { clientKey, edVerify, openWith, sealTo, sha } from "./lib/e2ee.mjs";
import { quote } from "../sdk/merchant.mjs";

export const PROVE_ME = process.env.PROVE_ME_BIN || "prove-me";
export const SERVER = "api.github.com";
/** The builders merchant: 20% for a github_builder, 10% for a World-bound agent, capped at 30%. */
export const BUILDERS = { basePrice: 40_000_000, rules: [{ predicate: "github_builder", bps: 2000 }, { predicate: "world_id_human", bps: 1000 }], capBps: 3000 };
export { MIN_AGE_YEARS, REVEAL, deriveGithub, requestKind, blindRef, withGithub } from "./lib/github-fact.mjs";
import { REVEAL, deriveGithub, requestKind, blindRef, withGithub } from "./lib/github-fact.mjs";

function leak() {
  const r = spawnSync("node", ["scripts/leak.mjs"], { encoding: "utf8" });
  // leak.mjs rewrites its dated reports; keep the committed ones, the lines go in the record.
  const changed = spawnSync("git", ["diff", "--name-only", "--", "docs"], { encoding: "utf8" }).stdout.split("\n").filter((f) => /^docs\/leak-report[^/]*\.json$/.test(f));
  if (changed.length) spawnSync("git", ["checkout", "--", ...changed], { encoding: "utf8" });
  return { ok: r.status === 0, lines: `${r.stdout}`.split("\n").filter((l) => /^(LINKED|unlinked)\s|^verdict:/.test(l)).map((l) => l.replace(/\s+/g, " ")) };
}

async function nearAi(facts) {
  const API = process.env.NEAR_AI_BASE ?? "https://cloud-api.near.ai/v1";
  const MODEL = process.env.NEAR_AI_MODEL ?? "z-ai/glm-5.3-flash";
  const KEY = (process.env.NEAR_AI_KEY ?? readFileSync(`${process.env.HOME}/.rep-secrets/near-ai.key`, "utf8")).trim();
  const auth = { Authorization: `Bearer ${KEY}` };
  const nonce = createHash("sha256").update(String(Math.random()) + Date.now()).digest("hex");
  const reportBytes = Buffer.from(await (await fetch(`${API}/attestation/report?model=${encodeURIComponent(MODEL)}&signing_algo=ed25519&nonce=${nonce}`, { headers: { ...auth, "x-no-aliasing": "true" } })).arrayBuffer());
  const modelPub = JSON.parse(reportBytes).model_attestations?.[0]?.signing_address;
  if (!/^[0-9a-f]{64}$/.test(modelPub ?? "")) throw new Error("no ed25519 model attestation");
  const rules = [{ platform: "github", field: "account_age_years", min: MIN_AGE_YEARS, predicate: "github_builder" }];
  const system = 'You are a verdict issuer. Apply the rule table exactly: a fact proves a predicate when platform and field match and value >= min. Output only JSON {"predicates": [sorted predicate names that are proven]}.';
  const user = JSON.stringify({ rules, facts: Object.entries(facts).map(([field, value], i) => ({ id: `F${6 + i}`, platform: "github", field, value })) });
  const me = clientKey();
  const reqBytes = Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 2000, temperature: 0, messages: [{ role: "system", content: sealTo(system, modelPub) }, { role: "user", content: sealTo(user, modelPub) }] }));
  const res = await fetch(`${API}/chat/completions`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", "X-Signing-Algo": "ed25519", "X-Client-Pub-Key": me.pubHex, "X-Model-Pub-Key": modelPub, "X-Encryption-Version": "2", "x-no-aliasing": "true" },
    body: reqBytes,
  });
  const resBytes = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`NEAR AI chat HTTP ${res.status}`);
  const body = JSON.parse(resBytes);
  const answer = openWith(body.choices[0].message.content, me.xSecret);
  const predicates = JSON.parse(answer.match(/\{[\s\S]*\}/)[0]).predicates;
  const sig = await (await fetch(`${API}/signature/${body.id}?model=${encodeURIComponent(MODEL)}&signing_algo=ed25519`, { headers: auth })).json();
  const [, sReq, sRes] = sig.text.split(":");
  const signed = edVerify(sig.text, sig.signature, sig.signing_address) && sReq === sha(reqBytes) && sRes === sha(resBytes) && sig.signing_address === modelPub;
  return { model: MODEL, chat_id: body.id, signing_address: modelPub, report_sha256: sha(reportBytes), request_sha256: sha(reqBytes), response_sha256: sha(resBytes), predicates, signed };
}

async function check(c) {
  const out = [];
  const ok = (x, what, detail = "") => out.push(`${x ? "ok  " : "NO  "} ${what}${detail ? `  (${detail})` : ""}`);
  const info = await fetch(`${NOTARY_URL}/info`, { signal: AbortSignal.timeout(15000) }).then((r) => r.status, () => 0);
  ok(info === 200, `REP notary at ${NOTARY_URL} (MPC-TLS, pinned key, not TEE-attested)`, String(info));
  ok(existsSync(PROVE_ME), "prover REP's prover (not in this repo) built", PROVE_ME);
  ok(existsSync(REP_VERIFY), "rep-verify built", REP_VERIFY);
  for (const f of ["issuer.seed", "referee.seed", "world.seed", "treasury.seed"]) ok(existsSync(join(c.keysDir, f)), `testnet key ${f}`);
  const tok = tokenFile(c);
  ok(existsSync(tok), "a GitHub token file (read-only, no scopes needed)", tok);
  return out;
}

const tokenFile = (c) => process.env.PROVE_ME_TOKEN_FILE || join(dirname(c.keysDir), "github-throwaway.token");

function sh(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")}: exit ${r.status}`);
  return r.stdout;
}

async function setup(c, round) {
  const join_ = (args, env) => console.log(sh("node", ["scripts/join-merchant.mjs", ...args], env).trim());
  join_(["join", "builders"], { JOIN_SCHEDULE: JSON.stringify(BUILDERS) });
  const now = Date.now();
  const args = JSON.stringify({ round_id: round, category: "open", commit_until_ms: now + 4 * 60_000, reveal_until_ms: now + 30 * 60_000 });
  const o = spawnSync("near", ["contract", "call-function", "as-transaction", c.bazaar, "open_round", "json-args", args, "prepaid-gas", "30.0 Tgas", "attached-deposit", "0 NEAR", "sign-as", c.bazaar, "network-config", "testnet", "sign-with-keychain", "send"], { encoding: "utf8" });
  const tx = `${o.stdout}${o.stderr}`.match(/Transaction ID: ([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1];
  if (!tx) throw new Error(`open_round failed: ${`${o.stdout}${o.stderr}`.slice(-200)}`);
  console.log(`   ok open_round ${round} (open category)  https://testnet.nearblocks.io/txns/${tx}`);
  for (const m of ["builders", "house"]) join_(["bid", m, round]);
  for (const m of ["builders", "house"]) join_(["reveal", m, round]);
  const state = { round, open_round_tx: tx };
  writeFileSync(join(c.keysDir, "rounds", `prove-me-${round}.json`), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

/** opts (make try): tokenFile, proxy (the notary's PROXY mode), implicit (a one-time implicit
 *  buyer), out (the public record's name). The notary is PROVE_ME_NOTARY_URL / _KEY when set
 *  (the Phala TDX notary), else the REP notary on Fly. */
export async function run(c, round, dry, publicLogin, opts = {}) {
  const notaryUrl = process.env.PROVE_ME_NOTARY_URL || NOTARY_URL;
  const notaryKey = process.env.PROVE_ME_NOTARY_KEY || NOTARY_KEY;
  const viaRep = notaryUrl === NOTARY_URL;
  const dir = join(c.keysDir, "zktls");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const before = leak();
  console.log(`1. make leak before: ${before.ok ? "PASS" : "FAIL"} (${before.lines.length} lines)`);
  const file = join(dir, `github-${Date.now()}.presentation`);
  // opts.presentation: the owner of the account ran REP's prover (not in this repo) on their own machine with
  // their own token and sent only the presentation. The token never reaches this machine.
  if (opts.presentation) copyFileSync(opts.presentation, file);
  else {
    const proveArgs = [file, ...(opts.proxy ? ["--proxy"] : []), ...(publicLogin ? ["--public", publicLogin] : [])];
    JSON.parse(sh(PROVE_ME, proveArgs, publicLogin ? {} : { PROVE_ME_TOKEN_FILE: opts.tokenFile ?? tokenFile(c) }));
  }
  const bytes = readFileSync(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  console.log(`2. ${opts.presentation ? "a presentation made on its owner's machine, notarized" : "notarized"} ${SERVER} through ${viaRep ? "the REP notary" : notaryUrl}${opts.presentation ? "" : ` (${opts.proxy ? "proxy" : "MPC-TLS"})`}: ${bytes.length} bytes, sha256 ${sha256.slice(0, 16)}..`);
  const v = JSON.parse(execFileSync(REP_VERIFY, ["/dev/stdin", notaryKey, "--json"], { input: bytes, encoding: "utf8" }));
  if (!v.key_matches || v.server_name !== SERVER) throw new Error(`not ${SERVER} under the pinned notary key`);
  const kind = requestKind(v.sent ?? "");
  if (!publicLogin && !kind.authenticated) throw new Error("expected the authenticated GET /user");
  const bad = privacyProblems(`${v.sent ?? ""}\n${v.recv ?? ""}`);
  if (bad.length) throw new Error(`the presentation reveals personal data (${bad.join(", ")}): stop`);
  const facts = deriveGithub(v.recv ?? "", v.time_secs);
  console.log(`3. verified (rep-verify, key ${notaryKey.slice(0, 12)}..), ${kind.authenticated ? "GET /user (your own account)" : `GET /users/${kind.login} (public test, not ownership)`}; only 3 fields revealed; privacy scan clean`);
  const holds = facts.account_age_years >= MIN_AGE_YEARS;
  console.log(`   facts: account_age_years, public_repos, followers; github_builder ${holds ? "holds" : `does NOT hold (< ${MIN_AGE_YEARS} years)`}`);
  if (!holds) throw new Error("github_builder does not hold: nothing to buy with");
  const ai = await nearAi(facts);
  if (!ai.signed || !ai.predicates.includes("github_builder")) throw new Error(`NEAR AI: signed ${ai.signed}, predicates ${ai.predicates}`);
  console.log(`4. NEAR AI ${ai.model} (E2EE v2, facts sealed to the attested key): github_builder; TEE signature over both wire hashes valid`);
  const runDir = join(dir, `prove-me-${sha256.slice(0, 12)}`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const refSalt = randomBytes(32).toString("hex");
  writeFileSync(join(runDir, "proof-ref-salt.hex"), refSalt + "\n", { mode: 0o600 });
  const { proofs, claims } = withGithub(JSON.parse(readFileSync("fixtures/proofs.json", "utf8")), JSON.parse(readFileSync("fixtures/claims-honest.json", "utf8")), facts, blindRef(sha256, refSalt));
  writeFileSync(join(runDir, "proofs.json"), JSON.stringify(proofs, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(runDir, "claims-honest.json"), JSON.stringify(claims, null, 2) + "\n", { mode: 0o600 });
  // The round's revealed bids are the merchants the referee picks from.
  const client = new Demo(c).client;
  const r = await client.view(c.bazaar, "round", { round_id: round });
  if (!r?.revealed?.length) throw new Error(`round ${round} has no revealed bids: run setup first`);
  const merchants = [];
  for (const account of r.revealed) merchants.push({ account, label: "open round bid", category: "open", schedule: (await client.view(c.bazaar, "merchant", { merchant: account })).schedule });
  writeFileSync(join(runDir, "merchants.json"), JSON.stringify(merchants, null, 2) + "\n");
  const revealed = REVEAL.split(",");
  const bids = merchants.map((m) => ({ merchant: m.account, price: Number(quote(m.schedule, revealed, () => 0).price), without_builder: Number(quote(m.schedule, revealed.filter((x) => x !== "github_builder"), () => 0).price) })).sort((a, b) => a.price - b.price);
  console.log(`5. round ${round}: ${bids.map((b) => `${b.merchant.split(".")[0]} ${b.price / 1e6} (without the builder line ${b.without_builder / 1e6})`).join(", ")}`);
  const pub = {
    note: publicLogin
      ? "prove-me PIPELINE TEST on a public GitHub profile (no token): it proves a fact about a public account, not that the prover holds it. The rest of the proof set is synthetic."
      : `prove-me: one real fact from the prover's own GitHub account (authenticated GET /user), ${opts.proxy ? "proxy mode" : "MPC-TLS"} through ${viaRep ? "the REP notary on Fly (pinned key, not TEE-attested)" : `${notaryUrl} (pinned key; its TDX quote is not checked here)`}, 3 fields revealed. The rest of the proof set is synthetic. The presentation stays with the prover; only its hash is here.`,
    authenticated: kind.authenticated,
    presentation_sha256: sha256,
    server_name: v.server_name,
    notary_url: notaryUrl,
    notary_key: notaryKey,
    notary_mode: opts.proxy ? "proxy" : "mpc",
    proved_on: opts.presentation ? "the account owner's own machine, with a token that never left it; this run received the presentation only" : "this machine",
    // The REP notary is one pinned key. A TDX notary's quote is not checked by this script.
    notary_attested: false,
    revealed_fields: ["created_at", "public_repos", "followers"],
    rule: `github account_age_years >= ${MIN_AGE_YEARS} gives github_builder`,
    near_ai: ai,
    round,
    bids,
    leak_before: before,
  };
  if (dry) {
    console.log("\ndry run: stopping before any testnet transaction");
    return;
  }
  console.log(`6. the purchase, as a fresh ${opts.implicit ? "one-time implicit account" : "tester"} (gasless, dUSDC, sealed verdict):`);
  const d = new Demo({ ...c, merchant: bids[0].merchant, category: "open" });
  process.env.BOOKERBOB_REVEAL = REVEAL;
  const rec = await d.run({ proofs: join(runDir, "proofs.json"), fixturesDir: runDir, sealed: true, implicit: Boolean(opts.implicit) }).finally(() => delete process.env.BOOKERBOB_REVEAL);
  // Tag the tester's local record so live-manifest lists this purchase as a prove-me run.
  const recPath = join(c.testersDir, `${rec.tester}.json`);
  if (existsSync(recPath)) writeFileSync(recPath, JSON.stringify({ ...JSON.parse(readFileSync(recPath, "utf8")), prove_me: opts.out ?? (publicLogin ? "public-test" : "run") }, null, 2) + "\n");
  const onChain = await d.client.view(c.bazaar, "verdict", { nullifier: rec.nullifier });
  if (onChain.predicates.length || onChain.tier !== "sealed") throw new Error("the verdict on chain is not sealed");
  const after = leak();
  console.log(`7. make leak after: ${after.ok ? "PASS" : "FAIL"}`);
  Object.assign(pub, { merchant: bids[0].merchant, price: rec.price, verdict_on_chain: "sealed: hashes only", tester: rec.tester, nullifier: rec.nullifier, txs: rec.txs, leak_after: after });
  mkdirSync("fixtures/live/prove-me", { recursive: true });
  const out = `fixtures/live/prove-me/${opts.out ?? (publicLogin ? "public-test" : "run")}.json`;
  writeFileSync(out, JSON.stringify(pub, null, 2) + "\n");
  console.log(`\nprove-me: PASS  ${out} (hashes, txs; no presentation, no token)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = config(process.env);
  const no = guard(c);
  if (no) {
    console.error(`refusing: ${no}`);
    process.exit(2);
  }
  const [cmd, round] = process.argv.slice(2);
  const pi = process.argv.indexOf("--public");
  const go = cmd === "check" ? check(c).then((l) => console.log(l.join("\n"))) : cmd === "setup" ? setup(c, round) : cmd === "run" ? run(c, round, process.argv.includes("--dry-run"), pi > 0 ? process.argv[pi + 1] : null) : Promise.reject(new Error("usage: prove-me.mjs check | setup <round> | run <round> [--dry-run] [--public <login>]"));
  go.catch((e) => {
    console.error(`\nprove-me: STOP ${e.message}`);
    process.exit(1);
  });
}
