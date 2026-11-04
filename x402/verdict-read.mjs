// x402 v2 paid verdict read: `GET /verdict/<nullifier>` costs a small USDC payment on NEAR.
// No dependencies. The NEAR-specific checks (NEP-366 signed delegate action, ft_transfer)
// belong to an x402 facilitator that supports `exact` on `near:testnet`, called over its
// standard `/verify` and `/settle` API. There is no default facilitator: set one.
//
// Transport (x402 specs/transports-v2/http.md):
//   402 + `PAYMENT-REQUIRED: base64(PaymentRequired)`  ->  client retries with
//   `PAYMENT-SIGNATURE: base64(PaymentPayload)`        ->  200 + `PAYMENT-RESPONSE: base64(SettlementResponse)`
// Order: decode, match requirements, facilitator verify, read, facilitator settle, respond.
//
// What is paid for: the verdict record is public on chain; the read returns it with the
// contract id, block height and the checks done, for agents that do not run a NEAR client.
import { createServer } from "node:http";
import { createHash } from "node:crypto";

export const USDC_TESTNET = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

export function requirements({ network = "near:testnet", amount = "10000", asset = USDC_TESTNET, payTo }) {
  if (!payTo) throw new Error("payTo is required");
  return { scheme: "exact", network, amount, asset, payTo, maxTimeoutSeconds: 60, extra: {} };
}

const sameRequirement = (a, r) =>
  a && a.scheme === r.scheme && a.network === r.network && String(a.amount) === r.amount && a.asset === r.asset && a.payTo === r.payTo;

/**
 * @param {object} o
 * @param {{verify: Function, settle: Function}} o.facilitator  posts to `<url>/verify` and `<url>/settle`
 * @param {(nullifier: string) => Promise<object|null>} o.readVerdict  contract view `verdict`
 * @param {object} o.req  output of `requirements()`
 */
export function createHandler({ facilitator, readVerdict, req, publicUrl = "http://localhost" }) {
  const used = new Set();
  return async (request, response) => {
    const m = /^\/verdict\/([0-9a-f]{64})$/.exec(new URL(request.url, "http://x").pathname);
    if (request.method !== "GET" || !m) {
      response.writeHead(404).end();
      return;
    }
    const resource = { url: `${publicUrl}/verdict/${m[1]}`, description: "BookerBob verdict read", mimeType: "application/json" };
    const challenge = (error) => {
      response.writeHead(402, { "PAYMENT-REQUIRED": b64({ x402Version: 2, error, resource, accepts: [req] }), "Content-Type": "application/json" });
      response.end(JSON.stringify({ error }));
    };
    const header = request.headers["payment-signature"];
    if (!header) return challenge("PAYMENT-SIGNATURE header is required");
    let payload;
    try {
      payload = unb64(header);
    } catch {
      return challenge("PAYMENT-SIGNATURE is not base64 JSON");
    }
    if (payload.x402Version !== 2) return challenge("x402Version 2 required");
    if (!sameRequirement(payload.accepted, req)) return challenge("payment does not match the requirements");
    const id = createHash("sha256").update(header).digest("hex");
    if (used.has(id)) return challenge("payment already used");
    const v = await facilitator.verify(payload, req);
    if (!v?.isValid) return challenge(`payment invalid: ${v?.invalidReason ?? "unknown"}`);
    used.add(id);
    const verdict = await readVerdict(m[1]);
    if (!verdict) {
      // Nothing to sell: do not settle, and let the client reuse the payment.
      used.delete(id);
      response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unknown nullifier" }));
      return;
    }
    const s = await facilitator.settle(payload, req);
    if (!s?.success) {
      used.delete(id);
      return challenge(`settlement failed: ${s?.errorReason ?? "unknown"}`);
    }
    response.writeHead(200, { "PAYMENT-RESPONSE": b64(s), "Content-Type": "application/json" });
    response.end(JSON.stringify({ nullifier: m[1], ...verdict }));
  };
}

/** Facilitator over HTTP: the standard x402 `/verify` and `/settle` endpoints. */
export function httpFacilitator(url) {
  const post = async (path, paymentPayload, paymentRequirements) => {
    const r = await fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }) });
    return r.json();
  };
  return { verify: (p, r) => post("/verify", p, r), settle: (p, r) => post("/settle", p, r) };
}

/** Contract view `verdict` over NEAR RPC. */
export function rpcVerdictReader({ rpcUrl, bazaar }) {
  return async (nullifier) => {
    const body = {
      jsonrpc: "2.0",
      id: "x402",
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: bazaar, method_name: "verdict", args_base64: Buffer.from(JSON.stringify({ nullifier })).toString("base64") },
    };
    const r = await (await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
    if (r.error || r.result?.error) throw new Error("rpc error");
    const record = JSON.parse(Buffer.from(r.result.result).toString() || "null");
    return record && { contract: bazaar, block_height: r.result.block_height, record };
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { X402_FACILITATOR_URL, X402_PAY_TO, BAZAAR_ACCOUNT_ID, NEAR_RPC = "https://test.rpc.fastnear.com", PORT = "4021" } = process.env;
  if (!X402_FACILITATOR_URL || !X402_PAY_TO || !BAZAAR_ACCOUNT_ID) {
    console.error("set X402_FACILITATOR_URL, X402_PAY_TO and BAZAAR_ACCOUNT_ID (testnet)");
    process.exit(2);
  }
  const handler = createHandler({
    facilitator: httpFacilitator(X402_FACILITATOR_URL),
    readVerdict: rpcVerdictReader({ rpcUrl: NEAR_RPC, bazaar: BAZAAR_ACCOUNT_ID }),
    req: requirements({ payTo: X402_PAY_TO }),
    publicUrl: `http://localhost:${PORT}`,
  });
  createServer((q, s) => handler(q, s).catch(() => s.writeHead(500).end())).listen(Number(PORT));
  console.log(`x402 verdict read on :${PORT} (near:testnet)`);
}
