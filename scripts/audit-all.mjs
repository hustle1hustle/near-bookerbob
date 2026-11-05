#!/usr/bin/env node
// `make audit-all`: `make audit` on every purchase in the public manifest (single settles and
// buying-group members). Prints each verdict line; exits 1 on the first purchase that fails.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const m = JSON.parse(readFileSync("fixtures/live/testnet-manifest.json", "utf8"));
const all = [...m.testers.map((t) => t.nullifier), ...(m.groups ?? []).flatMap((g) => g.members.map((x) => x.nullifier))];
for (const n of all) {
  const r = spawnSync("node", ["scripts/audit.mjs", n], { encoding: "utf8" });
  const lines = r.stdout.trim().split("\n");
  if (r.status !== 0) {
    console.log(lines.filter((l) => l.startsWith("FAIL")).join("\n"));
    process.exit(1);
  }
  console.log(lines.at(-1));
}
console.log(`\nPASS  audit-all: ${all.length} purchases rebuilt from public data`);
