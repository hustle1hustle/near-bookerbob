#!/usr/bin/env node
// Node-only check of the committed v3 coalition result (fixtures/coalition/result-v3.json): the
// v2 check with --v3 (same steps, the rule of docs/coalition-prereg-v3.md). Pass --anchor through.
import { spawnSync } from "node:child_process";
const root = new URL("..", import.meta.url).pathname;
const r = spawnSync("node", ["scripts/coalition-check-v2.mjs", "--v3", ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
