#!/usr/bin/env node
// `make try TOKEN=<file>`: the judge is the buyer. Your own GitHub account is the fact behind one
// testnet purchase, on the local path (this machine runs the prover; nothing is hosted for you):
//
//  1. tools/prove-me notarizes the authenticated GET api.github.com/user with the token in
//     <file> (sent inside TLS only, never printed, never revealed). PROXY mode by default
//     (TRY_MPC=1 for MPC-TLS). The notary: PROVE_ME_NOTARY_URL / PROVE_ME_NOTARY_KEY when set
//     (the Phala TDX notary, when it is up), else the REP notary on Fly (pinned key, not attested).
//  2. The reply is cut to 3 fields, then to 1 bit that is ruled on: account age >= 3 years gives
//     github_builder (repos and followers are revealed facts, not ruled on).
//  3. A fresh NEAR AI verdict: the facts sealed to the model's attested key (E2EE v2), its TEE
//     signature checked. Not the fixture.
//  4. A one-time implicit account (its id is a fresh key) is funded by the treasury, buys from
//     the cheapest bid of the blind `builders` round with a sealed verdict, and settles in dUSDC.
//  5. fixtures/live/prove-me/try-<time>.json: hashes and txs only. No login, no token.
//
// TRY_DRY=1 stops before the first transaction. Testnet only; dUSDC is a demo token.
// A fine-grained token with no permissions is enough for /user; revoke it after.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { config, guard } from "./demo-tester.mjs";
import { run } from "./prove-me.mjs";

const token = process.env.TOKEN || process.argv[2];
const round = process.env.ROUND || "builder-1";
if (!token || !existsSync(token) || statSync(token).size < 10) {
  console.error("usage: make try TOKEN=<file holding your GitHub token>   (a fine-grained token with no permissions is enough)");
  process.exit(2);
}
const c = config(process.env);
const no = guard(c);
if (no) {
  console.error(`refusing: ${no}`);
  process.exit(2);
}
// A real fact does not go near the model path while a committed key opens a sealed field.
execFileSync("node", ["scripts/leak-keys.mjs"], { stdio: "inherit" });
console.log(`make try: you are the buyer. round ${round}, ${process.env.TRY_MPC ? "MPC-TLS" : "proxy mode"}, a one-time implicit account\n`);
run(c, round, Boolean(process.env.TRY_DRY), null, { tokenFile: token, proxy: !process.env.TRY_MPC, implicit: true, out: `try-${new Date().toISOString().replace(/[:.]/g, "-")}` }).catch((e) => {
  console.error(`\nmake try: STOP ${e.message}`);
  process.exit(1);
});
