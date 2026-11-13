#!/usr/bin/env node
// make verify-presentation: the real TLSNotary presentations in this repo, each checked with
// tools/verify-presentation (upstream tlsnotary/tlsn v0.1.0-alpha.15 only): the notary's
// signature, the server's certificate chain, the pinned notary key, and exactly what is revealed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const BIN = process.env.VERIFY_PRESENTATION ?? "tools/verify-presentation/target/release/verify-presentation";
const NOTARY_KEY = "02114d7e15cb2a93ad88997af3394d00008dae381b601f31379d638de492ab25ef";
const D = "fixtures/live/prove-me";
const CASES = [
  { file: `${D}/public-test.presentation`, record: `${D}/public-test.json`, path: "/users/octocat", what: "a public GitHub profile (octocat), the prove-me pipeline test" },
  { file: `${D}/try-public-test.presentation`, record: `${D}/try-public-test.json`, path: "/users/octocat", what: "the same, through the notary in proxy mode" },
  { file: `${D}/founder-github.presentation`, path: "/users/hustle1hustle", what: "the founder's own GitHub profile (hustle1hustle), public endpoint" },
];
let bad = 0;
for (const c of CASES) {
  const bytes = readFileSync(c.file);
  const sha = createHash("sha256").update(bytes).digest("hex");
  let v;
  try { v = JSON.parse(execFileSync(BIN, [c.file, NOTARY_KEY], { encoding: "utf8" })); } catch (e) { console.log(`FAIL  ${c.file}: ${String(e.stderr || e.message).trim().slice(0, 200)}`); bad++; continue; }
  const revealed = v.recv.split(/X+/).filter(Boolean);
  const fields = revealed.filter((x) => x.startsWith('"'));
  const recorded = c.record ? JSON.parse(readFileSync(c.record, "utf8")).presentation_sha256 : null;
  const ok = v.verified && v.key_matches && v.server_name === "api.github.com" && v.sent.startsWith(`GET ${c.path} `) && fields.length === 3 && (!recorded || recorded === sha);
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.what}: notary ${v.notary_key.slice(0, 8)}.. pinned, server ${v.server_name}, ${new Date(v.time_secs * 1000).toISOString().slice(0, 10)}, GET ${c.path}, revealed ${fields.join(" ")}${recorded ? `; sha256 ${sha.slice(0, 8)}.. equals ${c.record}` : ""}`);
}
console.log(bad ? `FAIL  verify-presentation: ${bad} failed` : `PASS  verify-presentation: ${CASES.length} real presentations, signed by the notary key ${NOTARY_KEY.slice(0, 8)}..`);
process.exit(bad ? 1 : 0);
