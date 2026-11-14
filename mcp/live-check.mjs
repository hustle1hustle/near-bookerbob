#!/usr/bin/env node
// The agent reputation tools against NEAR testnet over public RPC, through the MCP server over
// stdio exactly as an outside agent calls them. Views only: no keys, no transactions. Prints the
// MCP exchange (TRANSCRIPT=1 for the full JSON) and one PASS or FAIL per claim.
//   node mcp/live-check.mjs        (make mcp-live)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const p = spawn(process.execPath, [new URL("./rep-read.mjs", import.meta.url).pathname], {
  env: { ...process.env, BAZAAR_ACCOUNT_ID: process.env.BAZAAR_ACCOUNT_ID ?? "bookerbob.testnet" },
});
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
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (process.env.TRANSCRIPT) console.log(`> ${line}`);
    p.stdin.write(line + "\n");
  });
const tool = async (name, args) => {
  const r = await call("tools/call", { name, arguments: args });
  const text = r.result.content[0].text;
  if (process.env.TRANSCRIPT) console.log(`< ${text}\n`);
  return r.result.isError ? { error: text } : JSON.parse(text);
};

let bad = false;
const say = (ok, t) => { console.log(`${ok ? "PASS" : "FAIL"}  ${t}`); bad ||= !ok; };

await call("initialize", { protocolVersion: "2025-06-18" });
const g = await tool("get_standing", { account: "h05.bookerbob.testnet" });
say(g.found && g.checks?.opening_opens_to_live_root && g.checks?.score_opens_its_commitment, `get_standing h05: rank ${g.rank} of ${g.n}, score ${g.score}, opening opens to the live root ${g.standing_root?.slice(0, 12)}.. (block ${g.block_height})`);
const v = await tool("verify_standing", { account: "h05.bookerbob.testnet" });
say(v.verdict === "accept", `verify_standing h05: ${v.verdict} (Jolt proof, live roots, contract in_top(${v.in_top?.pct}) = ${v.in_top?.contract_says})${v.reasons?.length ? `: ${v.reasons.join("; ")}` : ""}`);
const proof = Buffer.from(readFileSync(new URL("../agents/standing/proof.bin", import.meta.url)));
proof[proof.length >> 1] ^= 1;
const f = await tool("verify_standing", { account: "h05.bookerbob.testnet", proof_base64: proof.toString("base64") });
say(f.verdict === "reject", `verify_standing with one proof bit flipped: ${f.verdict}`);
const t = await tool("verify_standing", { account: "m02.bookerbob.testnet", pct: 50 });
say(t.verdict === "reject" && t.in_top?.contract_says === false, `verify_standing m02 in the top 50%: ${t.verdict} (rank 3 of 3; the contract says ${t.in_top?.contract_says})`);
const spec = JSON.parse(readFileSync(new URL("./fixtures/spend-bucket.json", import.meta.url), "utf8"));
const c = await tool("commission_check", { spec });
say(c.spec?.valid && c.request?.actions?.[0]?.FunctionCall?.method_name === "post_request", `commission_check spend-bucket: valid, spec_hash ${c.spec?.spec_hash?.slice(0, 12)}.., registry status "${c.registry_status?.status}"`);
const r = await tool("commission_check", { request_id: "standing-graph" });
say(typeof r.registry_status?.status === "string", `commission_check standing-graph on ${r.registry}: "${r.registry_status?.status}"`);
const j = await tool("coalition_open_jobs", {});
say(Array.isArray(j.open) && j.contracts?.length >= 1, `coalition_open_jobs: ${j.contracts?.map((x) => `${x.contract} ${x.jobs_read} jobs`).join(", ")}; ${j.open?.length} open`);
const d = await tool("coalition_job", { id: 0 });
say(d.job && ["open", "complete", "failed"].includes(d.job.status), `coalition_job 0 on ${d.contract}: ${d.job?.status}, seats ${d.seats?.map((x) => x.state).join("/")}`);
const m = await tool("coalition_member", { account: "m01.bookerbob.testnet" });
say(m.coalitions?.every((x) => x.record), `coalition_member m01: ${m.coalitions?.map((x) => `${x.contract.split(".")[0]} completed ${x.record?.completed} slashed ${x.record?.slashed}`).join(", ")}`);
p.kill();
console.log(bad ? "FAIL  make mcp-live" : "PASS  make mcp-live");
process.exit(bad ? 1 : 0);
