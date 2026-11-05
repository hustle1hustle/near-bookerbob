import { test } from "node:test";
import assert from "node:assert/strict";
import { problems, render, SHIPPED } from "./status.mjs";

const rows = [{ feature: "f", tracks: "t", where: "`settle`", status: "built", detail: "" }];
const readme = render(rows);
const src = Object.fromEntries(SHIPPED.map((s) => [s.file, SHIPPED.filter((x) => x.file === s.file).map((x) => x.code).join("\n")]));
const n = { purchases: 12, single: 7, signatures: 33 };

test("a doc that calls a shipped feature planned fails", () => {
  const p = problems(readme, rows, {}, { "README.md": "the 2-of-3 arbiter is planned" }, src, n);
  assert.ok(p.some((x) => x.includes("arbiter threshold")), p.join("; "));
  assert.deepEqual(problems(readme, rows, {}, { "README.md": "a threshold is built" }, src, n), []);
});

test("an entry whose code is gone fails, so the list cannot outlive the code", () => {
  const p = problems(readme, rows, {}, {}, { ...src, "worker/src/sealed.rs": "" }, n);
  assert.ok(p.some((x) => x.includes("sealed referee input") && x.includes("fix the list")));
});

test("a planned row whose method is in the contract fails", () => {
  const rs = [{ ...rows[0], status: "planned" }];
  const p = problems(render(rs), rs, {}, {}, { ...src, "contract/src/lib.rs": src["contract/src/lib.rs"] + "\npub fn settle(" }, n);
  assert.ok(p.some((x) => x.includes("lib.rs has pub fn settle")));
});

test("repeated counts must match the fixtures", () => {
  const p = problems(readme, rows, {}, { "README.md": "6 dUSDC purchases and 32/32 response signatures verified" }, src, n);
  assert.equal(p.length, 3, p.join("; ")); // the stale phrase, the purchase count, the signature count
  assert.deepEqual(problems(readme, rows, {}, { "README.md": "12 purchases (7 single settles, and 33/33 signatures valid" }, src, n), []);
});

test("purchase totals come from the manifest (spent_count's list), check counts from the verify log", async () => {
  const { readFileSync } = await import("node:fs");
  const { counted } = await import("./status.mjs");
  const m = JSON.parse(readFileSync("fixtures/live/testnet-manifest.json", "utf8"));
  const c = counted(m, { calls: [] }, "ALL PASS (26 checks)\nPASS  NEAR AI verdict: 17 checks\nPASS  sealed reviews: 15 checks\nPASS  referee evals 50/50");
  assert.deepEqual([c.purchases, c.single, c.replays, c.shopify], [26, 16, 16, 16]);
  assert.deepEqual(c.checks, { all: 26, near_ai: 17, reviews: 15, evals: 50 });
  const stale = { "README.md": "14 dUSDC purchases. On testnet, 6 purchases settled. ran 6 times in dUSDC. `PASS  NEAR AI verdict: 14 checks`. 6 replays refused" };
  const p = problems(readme, rows, {}, stale, src, c);
  for (const w of ["dUSDC purchases", "On testnet", "single settles", "NEAR AI verdict checks", "replays refused"]) assert.ok(p.some((x) => x.includes(w) || x.includes("14 dUSDC")), `${w}: ${p.join("; ")}`);
  assert.deepEqual(problems(readme, rows, {}, { "README.md": "26 dUSDC purchases, NEAR AI verdict: 17 checks" }, src, c), []);
});
