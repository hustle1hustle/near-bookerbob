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
