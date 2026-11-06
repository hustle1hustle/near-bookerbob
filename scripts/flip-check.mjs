#!/usr/bin/env node
// `make flip-check`: the checks around making hustle1hustle/bookerbob-near public (ROUND-5 #1).
// The flip itself (repo settings, and enabling Pages) is the founder's click, not this script.
//
//   node scripts/flip-check.mjs pre    before the flip: the secret scan over the full history
//                                      exits 0; fmt, clippy and make test are green (what CI runs);
//                                      no tracked file looks like a key, seed, .env, a
//                                      zkTLS presentation or panel notes; a LICENSE; every
//                                      relative link in README.md resolves to a tracked file
//   node scripts/flip-check.mjs post   after the flip (and again on Nov 13): with no credentials,
//                                      the repo page, a raw file and the Pages site answer 200
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const REPO = "hustle1hustle/bookerbob-near";
const PAGES = "https://hustle1hustle.github.io/near-bookerbob/";
let failed = 0;
const line = (ok, what, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
};

async function pre() {
  const scan = spawnSync("bash", ["scripts/secret-scan.sh"], { encoding: "utf8" });
  line(scan.status === 0, "secret scan over every commit and branch", (scan.stdout.match(/secret scan: [^\n]*/) ?? [""])[0]);
  const run = (what, cmd, args) => line(spawnSync(cmd, args, { stdio: "ignore" }).status === 0, what);
  run("cargo fmt --all -- --check", "cargo", ["fmt", "--all", "--", "--check"]);
  run("cargo clippy, warnings denied", "cargo", ["clippy", "--workspace", "--all-targets", "-j", "2", "--", "-D", "warnings"]);
  run("make test", "make", ["test"]);
  run("make market-eval: the published table is what the code computes", "node", ["scripts/market-eval.mjs", "--check"]);
  run("make wasm-parity: this source rebuilds the deployed wasm", "make", ["wasm-parity"]);
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
  const bad = files.filter((f) => /\.(seed|key|pem|p12)$|(^|\/)\.env$|\.presentation$|^PANEL\/|(^|\/)FOUNDER-COMMANDS/i.test(f));
  line(bad.length === 0, "no tracked key, seed, .env, presentation or panel file", bad.slice(0, 5).join(", ") || `${files.length} tracked files`);
  line(existsSync("LICENSE"), "LICENSE present");
  const readme = readFileSync("README.md", "utf8");
  const links = [...readme.matchAll(/\]\((?!https?:|#|mailto:)([^)\s#]+)/g)].map((x) => x[1]);
  const missing = [...new Set(links)].filter((l) => !files.includes(l.replace(/^\.\//, "")) && !files.some((f) => f.startsWith(l.replace(/^\.\//, "").replace(/\/$/, "") + "/")));
  line(missing.length === 0, `every relative README link resolves (${new Set(links).size} links)`, missing.slice(0, 5).join(", "));
}

async function post() {
  const get = async (url) => fetch(url, { method: "HEAD", redirect: "follow", headers: { "User-Agent": "bookerbob-flip-check" } }).then((r) => r.status, (e) => e.message);
  const a = await get(`https://github.com/${REPO}`);
  line(a === 200, `the repo page answers with no credentials: https://github.com/${REPO}`, String(a));
  const b = await get(`https://raw.githubusercontent.com/${REPO}/main/README.md`);
  line(b === 200, "a raw file answers with no credentials (README.md)", String(b));
  const c = await get(PAGES);
  line(c === 200, `the Pages site answers: ${PAGES}`, c === 404 ? "404: Pages not enabled yet, or the pages workflow has not run" : String(c));
}

const cmd = process.argv[2];
if (!["pre", "post"].includes(cmd)) {
  console.error("usage: flip-check.mjs pre | post");
  process.exit(2);
}
await (cmd === "pre" ? pre() : post());
console.log(`\n${failed ? "FAIL" : "PASS"}  flip-check ${cmd}${failed ? `: ${failed} failed` : ""}`);
process.exit(failed ? 1 : 0);
