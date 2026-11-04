import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { config, guard, plan, describe, hoodiePrice } from "./demo-live.mjs";

const base = { BAZAAR_ACCOUNT_ID: "bookerbob.testnet", KEYS_DIR: "/nonexistent/bookerbob-keys" };
const script = new URL("./demo-live.mjs", import.meta.url).pathname;
const cwd = new URL("..", import.meta.url).pathname;

test("mainnet in any form is refused", () => {
  assert.equal(guard(config(base)), null);
  assert.match(guard(config({ ...base, NEAR_NETWORK: "mainnet" })), /testnet only/);
  assert.match(guard(config({ ...base, NEAR_RPC: "https://rpc.mainnet.near.org" })), /not testnet/);
  assert.match(guard(config({ ...base, BAZAAR_ACCOUNT_ID: "bookerbob.near" })), /not a \.testnet account/);
  assert.match(guard(config({ ...base, MPC_SIGNER_ID: "v1.signer" + ".near" })), /mainnet contract/);
  assert.match(guard(config({ ...base, USDC_CONTRACT_ID: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" })), /mainnet token/);
  const r = spawnSync("node", [script], { cwd, env: { ...process.env, ...base, DRY_RUN: "1", NEAR_NETWORK: "mainnet" }, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing/);
  assert.equal(r.stdout, "");
});

test("dry path: every step listed, tool steps marked, nothing read or sent", () => {
  const c = config({ ...base, DRY_RUN: "1" });
  const steps = plan(c, "36000000");
  assert.deepEqual(steps.map((s) => s.id), ["board", "deployed", "sign", "agents", "fckey", "world", "verdict", "quote", "referee", "receipt", "escrow", "settle", "replay", "outlayer"]);
  const text = describe(c, steps, { near: false, keys: true });
  assert.match(text, /dry run, nothing is sent/);
  assert.equal((text.match(/ NEEDS /g) ?? []).length, 8);
  assert.equal((describe(c, steps, { near: true, keys: false }).match(/ NEEDS /g) ?? []).length, 2);
  assert.match(text, /needs: near-cli-rs \(cargo install --locked near-cli-rs\)/);
  assert.match(text, /14  skip .*OutLayer/);
  assert.match(text, /grant-function-call-access --allowance 0.25 NEAR --receiver-account-id bookerbob\.testnet --method-names settle/);
  assert.match(text, /\+ near contract call-function as-transaction bookerbob\.testnet settle json-args <settle args>/);
  assert.match(text, /ft_transfer_call json-args \{"receiver_id":"bookerbob\.testnet","amount":"36000000","msg":""\}/);
  assert.equal(steps.find((s) => s.id === "replay").expectFail, "nullifier spent");
  assert.equal(describe(c, steps, { near: true, keys: true }).includes(" NEEDS "), false);
});

test("dry run end to end exits 0 without tools, keys or network", () => {
  const r = spawnSync("node", [script], { cwd, env: { ...process.env, ...base, DRY_RUN: "1", NEAR_CLI: "/nonexistent/near", NEAR_RPC: "http://127.0.0.1:9/testnet" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^demo-live on testnet: bazaar bookerbob\.testnet, agent agent\.bookerbob\.testnet \(dry run/);
  assert.match(r.stdout, /escrow 36 testnet USDC/);
  const live = spawnSync("node", [script], { cwd, env: { ...process.env, ...base, NEAR_CLI: "/nonexistent/near" }, encoding: "utf8" });
  assert.equal(live.status, 3);
  assert.match(live.stderr, /near-cli-rs is not installed/);
});

test("price comes from the board", () => {
  assert.equal(hoodiePrice({ categories: [{ category: "hotel-lisbon", rows: [{ price: "1" }] }, { category: "hoodie", rows: [{ price: "36000000" }] }] }), "36000000");
});
