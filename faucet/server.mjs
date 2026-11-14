// The mainnet round's starter faucet: the first 10 accounts made on round-mainnet.html get
// 0.07 NEAR each, enough to register and seal one bid. Zero dependencies; it signs with the
// repo's relayer/near.mjs. Its only key is the faucet account's (FAUCET_SEED, a Fly secret), and
// the account was funded with 0.72 NEAR, so 10 payouts is also the most its balance allows.
//
// POST /fund {"address": "<64 hex>"}: the address must be a NEAR implicit account that does not
// exist on chain yet (so it was never funded, by us or anyone), one per IP per 10 minutes, at most
// MAX_PAYOUTS in all. Answers {"ok":true,"tx":"<hash>","left":n} or {"ok":false,"error":"..."}.
// GET /status: {"left":n,"balance":"<yoctoNEAR>","faucet":"<account>"}.
import { createServer } from "node:http";
import { keyFromSeed, rpcClient, send } from "./near.mjs";

const RPC = process.env.NEAR_MAINNET_RPC ?? "https://rpc.mainnet.fastnear.com";
const ORIGINS = ["https://hustle1hustle.github.io"];
const PAYOUT = 70n * 10n ** 21n;
const RESERVE = 5n * 10n ** 21n; // the faucet's own storage and gas
const MAX_PAYOUTS = Number(process.env.MAX_PAYOUTS ?? 10);
const key = keyFromSeed(process.env.FAUCET_SEED ?? "");
const FAUCET = key.pub;
const c = rpcClient(RPC);
const paid = new Map(); // address -> tx (also on chain: every transfer from the faucet account)
const byIp = new Map();
let busy = Promise.resolve();

const out = (res, code, body, origin) => {
  res.writeHead(code, { "Content-Type": "application/json", ...(ORIGINS.includes(origin) && { "Access-Control-Allow-Origin": origin, "Vary": "Origin" }), "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
  res.end(JSON.stringify(body));
};
const balance = async () => BigInt((await c.account(FAUCET))?.amount ?? 0);

async function fund(address) {
  if (!/^[0-9a-f]{64}$/.test(address ?? "")) return { ok: false, error: "address: a NEAR implicit account, 64 hex characters" };
  if (paid.has(address)) return { ok: false, error: "this address was funded already" };
  if (paid.size >= MAX_PAYOUTS) return { ok: false, error: "the starter NEAR is gone: all 10 were given out. send NEAR to your address yourself" };
  if (await c.account(address)) return { ok: false, error: "this account exists already: the faucet funds new accounts only" };
  const bal = await balance();
  if (bal - PAYOUT < RESERVE) return { ok: false, error: "the starter NEAR is gone. send NEAR to your address yourself" };
  paid.set(address, "pending");
  const r = await send(c, { signer_id: FAUCET, key, receiver_id: address, actions: [{ type: "Transfer", deposit: PAYOUT }] });
  if (!r.ok) { paid.delete(address); return { ok: false, error: `the transfer failed: ${String(r.error).slice(0, 160)}` }; }
  paid.set(address, r.hash);
  console.log(JSON.stringify({ at: new Date().toISOString(), address, tx: r.hash, n: paid.size }));
  return { ok: true, tx: r.hash, left: MAX_PAYOUTS - paid.size };
}

createServer(async (req, res) => {
  const origin = req.headers.origin ?? "";
  try {
    if (req.method === "OPTIONS") return out(res, 204, {}, origin);
    if (req.method === "GET" && req.url === "/status") return out(res, 200, { faucet: FAUCET, left: Math.max(0, MAX_PAYOUTS - paid.size), balance: String(await balance()) }, origin);
    if (req.method === "GET" && req.url === "/healthz") return out(res, 200, { ok: true }, origin);
    if (req.method !== "POST" || req.url !== "/fund") return out(res, 404, { ok: false, error: "POST /fund" }, origin);
    if (!ORIGINS.includes(origin)) return out(res, 403, { ok: false, error: "only the round page may ask" }, origin);
    const ip = String(req.headers["fly-client-ip"] ?? req.socket.remoteAddress);
    if (Date.now() - (byIp.get(ip) ?? 0) < 10 * 60_000) return out(res, 429, { ok: false, error: "one starter per 10 minutes from one address" }, origin);
    let body = "";
    for await (const ch of req) { body += ch; if (body.length > 1000) return out(res, 413, { ok: false, error: "too big" }, origin); }
    const { address } = JSON.parse(body || "{}");
    // One payout at a time: the cap and the balance are checked against settled state.
    const result = await (busy = busy.then(() => fund(String(address ?? "").toLowerCase()), () => fund(String(address ?? "").toLowerCase())));
    if (result.ok) byIp.set(ip, Date.now());
    return out(res, result.ok ? 200 : 400, result, origin);
  } catch (e) { return out(res, 500, { ok: false, error: String(e.message).slice(0, 160) }, origin); }
}).listen(Number(process.env.PORT ?? 8080), () => console.log(`faucet ${FAUCET} on ${process.env.PORT ?? 8080}, ${MAX_PAYOUTS} payouts of ${PAYOUT} yocto`));
