import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { config, guard, plan, testerId } from "./demo-tester.mjs";

const script = new URL("./demo-tester.mjs", import.meta.url).pathname;
const cwd = new URL("..", import.meta.url).pathname;
const base = { KEYS_DIR: "/nonexistent/bookerbob-keys" };

test("demo mode refuses anything but testnet, dry run included", () => {
  assert.equal(guard(config(base)), null);
  assert.match(guard(config({ ...base, NEAR_NETWORK: "mainnet" })), /testnet only/);
  assert.match(guard(config({ ...base, NEAR_RPC: "https://rpc.mainnet.near.org" })), /not testnet/);
  assert.match(guard(config({ ...base, DUSDC_CONTRACT_ID: "dusdc.near" })), /not a \.testnet account/);
  assert.match(guard(config({ ...base, DEMO_TREASURY_ID: "treasury.near" })), /not a \.testnet account/);
  const r = spawnSync("node", [script, "run"], { cwd, env: { ...process.env, ...base, DRY_RUN: "1", BAZAAR_ACCOUNT_ID: "bookerbob.near" }, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
});

test("tester accounts are sub-accounts of the treasury that the relayer's demo policy accepts", () => {
  assert.equal(testerId(config(base), "a1b2c3"), "t-a1b2c3.bookerbob-demo.testnet");
});

test("dry run lists the whole purchase and sends nothing", () => {
  const r = spawnSync("node", [script, "run"], { cwd, env: { ...process.env, ...base, DRY_RUN: "1" }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dry run, nothing is read or sent/);
  assert.deepEqual(plan(config(base)).map(([id]) => id), ["preflight", "account", "storage", "mint", "sign", "world", "verdict", "receipt", "escrow", "settle", "shopify", "replay", "review"]);
  for (const id of ["settle_demo", "nullifier spent", "Semaphore", "dUSDC"]) assert.match(r.stdout, new RegExp(id));
});
