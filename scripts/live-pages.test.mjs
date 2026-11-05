// agents/live.js, the live read behind board.html and receipts.html, run in a VM with a fake
// fetch: the live path (public RPC answers) and the dated snapshot fallback (it does not).
// No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { purchases } from "./live-snapshot.mjs";

const snap = JSON.parse(readFileSync("agents/live.json", "utf8"));

function page(rpc) {
  const fetch = async (url, opts) => {
    if (url === "live.json") return { ok: true, json: async () => structuredClone(snap) };
    const body = JSON.parse(opts.body);
    const v = rpc(body.params.method_name, JSON.parse(atob(body.params.args_base64)));
    const bytes = [...new TextEncoder().encode(JSON.stringify(v))];
    return { json: async () => ({ result: { block_height: 999, result: bytes } }) };
  };
  const ctx = vm.createContext({ fetch, btoa, atob, TextDecoder, AbortSignal, structuredClone, Promise, JSON, Math, Date, Uint8Array });
  vm.runInContext(readFileSync("agents/live.js", "utf8"), ctx);
  return ctx;
}

test("the snapshot covers every testnet purchase in the manifest", () => {
  const m = JSON.parse(readFileSync("fixtures/live/testnet-manifest.json", "utf8"));
  assert.deepEqual(snap.purchases.map((p) => p.nullifier), purchases(m).map((p) => p.nullifier));
  assert.ok(snap.purchases.every((p) => p.tx && p.paid), "every row carries the tx that paid");
  assert.match(snap.taken_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("live: statuses and counts come from the chain, not the snapshot", async () => {
  const ctx = page((m) => (m === "spent_count" ? 77 : m === "merchants" ? [["m01.bookerbob.testnet", { category: "hoodie", approved: true }]] : "Pending"));
  const l = await ctx.loadLive();
  assert.equal(l.source, "live");
  assert.equal(l.data.spent_count, 77);
  assert.ok(l.data.purchases.every((p) => p.status === "Pending"));
  assert.match(ctx.liveBanner(l), /^live from bookerbob\.testnet over public RPC, block 999\. 77 nullifiers spent/);
});

test("RPC down: the dated snapshot, said plainly", async () => {
  const ctx = page(() => {
    throw new Error("unreachable");
  });
  const l = await ctx.loadLive();
  assert.equal(l.source, "snapshot");
  assert.equal(l.data.spent_count, snap.spent_count);
  assert.match(ctx.liveBanner(l), new RegExp(`^public RPC unreachable: the snapshot of ${snap.taken_at.slice(0, 10)}`));
  assert.match(ctx.liveBanner(l), /the facts are synthetic/);
});
