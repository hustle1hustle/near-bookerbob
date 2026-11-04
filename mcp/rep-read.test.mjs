// Drives the MCP server over stdio against a local fake NEAR RPC. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";

async function fakeRpc() {
  const seen = [];
  const srv = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const args = JSON.parse(Buffer.from(body.params.args_base64, "base64").toString());
    seen.push({ account: body.params.account_id, method: body.params.method_name, args });
    const value = body.params.method_name === "nullifier_status" ? "Spent" : { echo: args };
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { block_height: 42, result: [...Buffer.from(JSON.stringify(value))] } }));
  });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  return { srv, seen, url: `http://127.0.0.1:${srv.address().port}` };
}

function client(env) {
  const p = spawn(process.execPath, [new URL("./rep-read.mjs", import.meta.url).pathname], { env: { ...process.env, ...env } });
  let buf = "";
  const waiting = new Map();
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(m.id)?.(m);
    }
  });
  let n = 0;
  const call = (method, params) =>
    new Promise((ok) => {
      const id = ++n;
      waiting.set(id, ok);
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return { call, close: () => p.kill() };
}

test("initialize, list tools, call nullifier_status", async () => {
  const rpc = await fakeRpc();
  const c = client({ NEAR_RPC: rpc.url, BAZAAR_ACCOUNT_ID: "bookerbob.testnet" });
  try {
    const init = await c.call("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.result.serverInfo.name, "rep-read");
    const list = await c.call("tools/list", {});
    assert.deepEqual(list.result.tools.map((t) => t.name), ["nullifier_status", "verdict", "quote", "best_quote", "merchants"]);
    const n = "1e".repeat(32);
    const r = await c.call("tools/call", { name: "nullifier_status", arguments: { nullifier: n } });
    assert.equal(r.result.isError, false);
    const out = JSON.parse(r.result.content[0].text);
    assert.equal(out.value, "Spent");
    assert.equal(out.contract, "bookerbob.testnet");
    assert.deepEqual(rpc.seen[0], { account: "bookerbob.testnet", method: "nullifier_status", args: { nullifier: n } });
  } finally {
    c.close();
    rpc.srv.close();
  }
});

test("unknown tool is an error, missing contract is a tool error", async () => {
  const c = client({ NEAR_RPC: "http://127.0.0.1:9", BAZAAR_ACCOUNT_ID: "" });
  try {
    const bad = await c.call("tools/call", { name: "book_hotel", arguments: {} });
    assert.equal(bad.error.code, -32602);
    const r = await c.call("tools/call", { name: "merchants", arguments: {} });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /BAZAAR_ACCOUNT_ID/);
  } finally {
    c.close();
  }
});
