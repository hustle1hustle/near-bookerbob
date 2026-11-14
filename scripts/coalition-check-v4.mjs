#!/usr/bin/env node
// Node-only check of the committed v4 coalition result (fixtures/coalition/result-v4.json, seeds
// 21 to 40): the v2 check with --v4 (same steps, the rule of docs/coalition-prereg-v4.md).
import { spawnSync } from "node:child_process";
const root = new URL("..", import.meta.url).pathname;
const r = spawnSync("node", ["scripts/coalition-check-v2.mjs", "--v4", ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
