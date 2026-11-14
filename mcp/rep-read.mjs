#!/usr/bin/env node
// "REP Read for agents": an MCP server (stdio, JSON-RPC 2.0, one message per line) that
// wraps the bazaar contract's view calls, so any MCP client (Claude, Codex) can check a
// verdict. Read-only: no keys, no transactions. No dependencies.
//
// One more tool, `buy`, is the buyer flow of sdk/buy.mjs: the ask is parsed, every merchant in
// its category is priced by the contract's own price code, and the cheapest bid that fits
// wins or the ask is refused. By default it returns the plan only (still no keys, no
// transactions). It runs the live testnet purchase only when the server was started with
// BOOKERBOB_BUY=1 (the local demo keys, testnet dUSDC) or BOOKERBOB_RELAYER_URL (a hosted
// relayer, once the founder OKs hosting).
//
//   BAZAAR_ACCOUNT_ID=bookerbob.testnet node mcp/rep-read.mjs
//
// Six more tools give any agent agent reputation through the same door (mcp/reputation.mjs,
// docs/mcp.md): get_standing, verify_standing (the Jolt proof in a wasm verifier, the live
// roots, the contract's in_top), commission_check (a spec for the Jolt smith, the registry's
// status), coalition_open_jobs, coalition_job and coalition_member. Testnet views only.
//
// Env: BAZAAR_ACCOUNT_ID (required for the bazaar views), NEAR_RPC (default testnet RPC).
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { action, DEMO_REVEALED, parseAsk, plan } from "../sdk/buy.mjs";
import { REPUTATION_TOOLS } from "./reputation.mjs";

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

export const BUY_TOOL = {
  name: "buy",
  description:
    'Buy as the demo buyer, e.g. "3 nights Lisbon under 450" or "a hoodie under 45": prices every merchant in the category with the contract\'s price code for the revealed bits, picks the cheapest bid that fits, or refuses. Returns the plan; runs the live testnet purchase (dUSDC, a demo token) only if this server was started with BOOKERBOB_BUY=1 or a relayer.',
  inputSchema: { type: "object", properties: { ask: { type: "string", description: "what you want and your budget in USD" } }, required: ["ask"] },
};

/** The plan for an ask, and what runs for it: the same functions as sdk/buy.mjs. */
export function buyPlan(ask, merchants) {
  const a = parseAsk(ask);
  const p = plan(a, merchants);
  return { ask: a, revealed: DEMO_REVEALED, bids: p.bids, outcome: p.outcome, winner: p.winner ?? null, reason: p.reason ?? null, next: action(p) };
}

async function buy(args) {
  const merchants = JSON.parse(readFileSync(new URL("../agents/merchants.json", import.meta.url), "utf8"));
  const out = buyPlan(String(args.ask ?? ""), merchants);
  if (out.outcome !== "winner") return { ...out, ran: null };
  if (process.env.BOOKERBOB_RELAYER_URL) {
    const r = await fetch(`${process.env.BOOKERBOB_RELAYER_URL}/buy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ask: out.ask, winner: out.winner }) });
    return { ...out, ran: "relayer", relayer: await r.json() };
  }
  if (process.env.BOOKERBOB_BUY !== "1" || !out.next.run) return { ...out, ran: null, note: out.next.run ? "plan only: start the server with BOOKERBOB_BUY=1 to run the live testnet purchase" : out.next.why };
  const cwd = new URL("..", import.meta.url).pathname;
  const r = spawnSync(process.execPath, ["scripts/demo-tester.mjs", ...(out.next.run === "hotel-demo" ? ["hotel", out.next.merchant] : ["run"])], { cwd, encoding: "utf8", timeout: 600_000 });
  return { ...out, ran: out.next.run, exit: r.status, log: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-12) };
}

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

/** The tool's inputSchema applied before it runs: an object, required keys, no unknown keys, types, bounds, patterns. */
export function checkArgs(schema, args) {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "arguments must be an object";
  for (const k of schema.required ?? []) if (args[k] === undefined) return `${k} is required`;
  for (const [k, v] of Object.entries(args)) {
    const s = schema.properties?.[k];
    if (!s) return `unknown argument: ${k}`;
    if (v === null || v === undefined) continue;
    const t = s.type === "integer" ? Number.isInteger(v) : s.type === "object" ? typeof v === "object" && !Array.isArray(v) : typeof v === s.type;
    if (!t) return `${k} must be ${s.type === "integer" ? "an integer" : `a${s.type === "object" ? "n" : ""} ${s.type}`}`;
    if (s.minimum !== undefined && v < s.minimum) return `${k} must be at least ${s.minimum}`;
    if (s.maximum !== undefined && v > s.maximum) return `${k} must be at most ${s.maximum}`;
    if (s.pattern && !new RegExp(s.pattern).test(v)) return `${k} does not match ${s.pattern}`;
  }
  return null;
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
      instructions: `Read-only views of the BookerBob bazaar contract ${BAZAAR || "(BAZAAR_ACCOUNT_ID unset)"} on ${RPC}. Agent reputation: get_standing, then verify_standing before trusting a rank; commission_check to ask the Jolt smith for a new zk check; coalition_open_jobs for work that needs standing.`,
    });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: [...TOOLS.map(({ view: _v, ...t }) => t), BUY_TOOL, ...REPUTATION_TOOLS.map(({ run: _r, ...t }) => t)] });
  const rep = method === "tools/call" && REPUTATION_TOOLS.find((t) => t.name === params?.name);
  if (rep) {
    const bad = checkArgs(rep.inputSchema, params.arguments ?? {});
    if (bad) return reply(id, { content: [{ type: "text", text: `error: ${bad}` }], isError: true });
    try {
      const out = await rep.run(params.arguments ?? {});
      return reply(id, { content: [{ type: "text", text: JSON.stringify(out) }], isError: false });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: `error: ${e.message}` }], isError: true });
    }
  }
  if (method === "tools/call" && params?.name === "buy") {
    try {
      const out = await buy(params.arguments ?? {});
      return reply(id, { content: [{ type: "text", text: JSON.stringify(out) }], isError: out.ran != null && out.exit != null && out.exit !== 0 });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: `error: ${e.message}` }], isError: true });
    }
  }
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
