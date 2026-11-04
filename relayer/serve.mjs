#!/usr/bin/env node
// STAGED. The relayer as an HTTP service for "you are the buyer": POST /buy runs one demo
// purchase (scripts/demo-tester.mjs: a fresh tester account, dUSDC, gasless, settle, review
// join) and returns its tx links. Rate limit: one run per client per 60 s and the
// demo-tester's own cap of 20 testers a day.
//
// It binds 127.0.0.1 only. Binding a public interface needs RELAYER_PUBLIC=1 and
// RELAYER_PUBLIC_GO=<today's date> (the founder's OK to host it), because a public relayer
// spends the treasury's testnet NEAR. Testnet only, like everything it calls.
import { createServer } from "node:http";
import { spawn } from "node:child_process";

export function bindHost(env, today = new Date().toISOString().slice(0, 10)) {
  if (env.RELAYER_PUBLIC !== "1") return "127.0.0.1";
  if (env.RELAYER_PUBLIC_GO !== today) throw new Error(`RELAYER_PUBLIC=1 needs RELAYER_PUBLIC_GO=${today} (the founder's OK to host it)`);
  return "0.0.0.0";
}

export function limiter(windowMs = 60_000, now = Date.now) {
  const last = new Map();
  return (client) => {
    const t = now();
    if (last.has(client) && t - last.get(client) < windowMs) return false;
    last.set(client, t);
    return true;
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = bindHost(process.env);
  const port = Number(process.env.PORT ?? 8787);
  const allow = limiter();
  let running = false;
  createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "http://127.0.0.1:" + port }); res.end(JSON.stringify(body)); };
    if (req.method !== "POST" || req.url !== "/buy") return send(404, { error: "POST /buy" });
    if (!allow(req.socket.remoteAddress)) return send(429, { error: "one run per minute" });
    if (running) return send(409, { error: "a run is in progress" });
    running = true;
    const p = spawn("node", ["scripts/demo-tester.mjs", "run"], { cwd: new URL("..", import.meta.url).pathname });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      running = false;
      send(code === 0 ? 200 : 500, { ok: code === 0, links: [...out.matchAll(/https:\/\/testnet\.nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]+/g)].map((m) => m[0]), last: out.trim().split("\n").at(-1) });
    });
  }).listen(port, host, () => console.log(`relayer serve: http://${host}:${port}/buy (testnet, rate limited)`));
}
