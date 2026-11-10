// The JS reference solver against fixtures/clearing.json, the same file the Rust solver
// (core/src/clearing.rs) is tested on, and Dan's refused proposals through `check`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { check, replaces, solve, steps } from "./clearing.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const { cases } = JSON.parse(read("fixtures/clearing.json"));
const big = (c) => ({ offers: c.offers.map((o) => ({ ...o, price: BigInt(o.price) })), budgets: c.budgets.map(BigInt) });

test("the three worked examples give what the Rust solver gives", () => {
  assert.equal(cases.length, 3);
  for (const c of cases) {
    const { offers, budgets } = big(c);
    const got = solve(offers, budgets);
    assert.equal(String(got.price), c.expect.price, c.name);
    assert.deepEqual(got.fills, c.expect.fills, c.name);
    assert.deepEqual(got.leftOut, c.expect.left_out, c.name);
    assert.deepEqual(steps(offers, budgets).map((s) => [s.r, String(s.price), s.canPay, s.valid]), c.expect.steps, c.name);
    assert.equal(check(offers, budgets, got.price, got.fills), null, `${c.name}: the solver's own proposal passes the bounds`);
  }
});

test("the same answers on plain numbers", () => {
  for (const c of cases) {
    const got = solve(c.offers.map((o) => ({ ...o, price: Number(o.price) })), c.budgets.map(Number));
    assert.deepEqual([String(got.price), got.fills], [c.expect.price, c.expect.fills], c.name);
  }
});

test("cheap seats run out: what the contract refuses, and what it keeps", () => {
  const { offers, budgets } = big(cases[0]);
  const four = [[0, "A"], [1, "A"], [2, "B"], [3, "B"]];
  assert.equal(check(offers, budgets, 355n, four), null);
  assert.equal(check(offers, budgets, 390n, [...four, [4, "D"]]), "price above a participant's budget", "the fifth buyer, budget 360, on D at 390");
  assert.equal(check(offers, budgets, 365n, four), "price is not the highest code price among the filled seats", "the same seating at 365");
  const two = [[0, "A"], [1, "A"]];
  assert.equal(check(offers, budgets, 340n, two), null, "two seats at 340 pass the bounds");
  assert.equal(replaces({ price: 340n, fills: two }, { price: 355n, fills: four }), false, "and do not replace four");
  assert.equal(replaces({ price: 355n, fills: four }, { price: 340n, fills: two }), true);
  assert.equal(replaces({ price: 340n, fills: two }, { price: 355n, fills: [[0, "A"], [1, "B"]] }), true, "the same seats, cheaper");
  assert.equal(replaces({ price: 355n, fills: two }, { price: 355n, fills: two }), false);
});

test("the other bounds", () => {
  const { offers, budgets } = big(cases[0]);
  assert.equal(check(offers, budgets, 340n, [[0, "A"], [1, "A"], [2, "A"]]), "more seats than the merchant declared for this round");
  assert.equal(check(offers, budgets, 355n, [[0, "A"], [0, "B"]]), "a participant sits once");
  assert.equal(check(offers, budgets, 340n, [[0, "A"], [1, "B"]]), "price below a seat's code price");
  assert.equal(check(offers, budgets, 300n, [[0, "E"]]), "merchant did not reveal in this round");
  assert.equal(check(offers, budgets, 340n, []), "fill 1 to 100 seats");
  assert.equal(solve(offers, [339n, 100n]), null);
});

test("every refusal the JS check names is a message the contract has", (t) => {
  const lib = read("contract/src/lib.rs");
  // The contract method lives on the branch `clearing` until it is deployed; on a tree whose
  // contract does not have it there is nothing to compare against.
  if (!lib.includes("fn propose_clearing")) return t.skip("propose_clearing is not in this tree's contract (branch clearing has it)");
  for (const m of ["fill 1 to 100 seats", "a participant sits once", "merchant did not reveal in this round", "more seats than the merchant declared for this round", "price below a seat's code price", "price above a participant's budget", "price is not the highest code price among the filled seats"]) {
    assert.ok(lib.includes(`"${m}"`), m);
  }
});

test("agents/clearing.html carries the solver verbatim", () => {
  const cut = (s) => s.slice(s.indexOf("// clearing:begin"), s.indexOf("// clearing:end"));
  const page = read("agents/clearing.html");
  assert.ok(cut(page).length > 500);
  assert.equal(cut(page), cut(read("sdk/clearing.mjs")));
  assert.ok(!/<script[^>]+src=|https?:\/\//.test(page.replace(/https:\/\/github\.com\/DenisDI/g, "")), "no external scripts or requests");
  assert.ok(!/[—–]/.test(page), "no dashes");
});
