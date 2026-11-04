#!/usr/bin/env node
// "REP Read for agents": an MCP server (stdio, JSON-RPC 2.0, one message per line) that
// wraps the bazaar contract's view calls, so any MCP client (Claude, Codex) can check a
// verdict. Read-only: no keys, no transactions. No dependencies.
//
//   BAZAAR_ACCOUNT_ID=bookerbob.testnet node mcp/rep-read.mjs
//
// Env: BAZAAR_ACCOUNT_ID (required), NEAR_RPC (default testnet RPC).
import { createInterface } from "node:readline";

const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const BAZAAR = process.env.BAZAAR_ACCOUNT_ID ?? "";
const HEX32 = { type: "string", pattern: "^[0-9a-f]{64}$", description: "hex, 32 bytes" };

export const TOOLS = [
  {
    name: "nullifier_status",
    description: "Is this per-context nullifier unknown, pending (verdict submitted) or spent (purchase settled)?",
    inputSchema: { type: "object", properties: { nullifier: HEX32 }, required: ["nullifier"] },
    view: (a) => ["nullifier_status", { nullifier: a.nullifier }],
  },
  {
    name: "verdict",
    description: "The verdict record under a nullifier: revealed predicates, tier, tcb_status, cap, expiry, referee receipt. Never raw history.",
    inputSchema: { type: "object", properties: { nullifier: HEX32 }, required: ["nullifier"] },
    view: (a) => ["verdict", { nullifier: a.nullifier }],
  },
  {
    name: "quote",
    description: "Code-computed price of one merchant for the predicates revealed under a nullifier.",
    inputSchema: { type: "object", properties: { merchant: { type: "string" }, nullifier: HEX32 }, required: ["merchant", "nullifier"] },
    view: (a) => ["quote", { merchant: a.merchant, nullifier: a.nullifier }],
  },
  {
    name: "best_quote",
    description: "Lowest code-computed price across merchants, optionally within a category.",
    inputSchema: { type: "object", properties: { nullifier: HEX32, category: { type: "string" } }, required: ["nullifier"] },
    view: (a) => ["best_quote", { nullifier: a.nullifier, category: a.category ?? null }],
  },
  {
    name: "merchants",
    description: "Registered merchant agents with their category and discount schedule.",
    inputSchema: { type: "object", properties: { from_index: { type: "integer" }, limit: { type: "integer" } } },
    view: (a) => ["merchants", { from_index: a.from_index ?? null, limit: a.limit ?? null }],
  },
];

async function view(method_name, args) {
  if (!BAZAAR) throw new Error("BAZAAR_ACCOUNT_ID is not set");
  const body = {
    jsonrpc: "2.0",
    id: "rep-read",
    method: "query",
    params: { request_type: "call_function", finality: "final", account_id: BAZAAR, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
  };
  const r = await (await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  if (r.error) throw new Error(r.error.cause?.name ?? r.error.message ?? "rpc error");
  if (r.result?.error) throw new Error(String(r.result.error));
  return { block_height: r.result.block_height, value: JSON.parse(Buffer.from(r.result.result).toString() || "null") };
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function fail(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "rep-read", version: "0.1.0" },
      instructions: `Read-only views of the BookerBob bazaar contract ${BAZAAR || "(BAZAAR_ACCOUNT_ID unset)"} on ${RPC}.`,
    });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS.map(({ view: _v, ...t }) => t) });
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return fail(id, -32602, `unknown tool ${params?.name}`);
    try {
      const [m, a] = tool.view(params.arguments ?? {});
      const out = await view(m, a);
      return reply(id, { content: [{ type: "text", text: JSON.stringify({ contract: BAZAAR, ...out }) }], isError: false });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: `error: ${e.message}` }], isError: true });
    }
  }
  return fail(id, -32601, `method not found: ${method}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return fail(null, -32700, "parse error");
    }
    handle(msg).catch((e) => fail(msg.id ?? null, -32603, e.message));
  });
}
