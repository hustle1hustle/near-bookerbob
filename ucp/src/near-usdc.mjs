// UCP payment handler `xyz.r3p.near_usdc`: a checkout is paid by the bazaar contract's
// `settle` on NEAR, in USDC. Written in the hackathon window. No dependencies.
//
// Since UCP 2026-08-25 a handler id must sit on a domain we control; there is no
// stablecoin handler in the spec, so this one lives under r3p.xyz.
//
// Flow: the buyer's agent calls `settle(nullifier, merchant, checkout_ref, amount)`, then
// completes the UCP checkout with the credential `{type: "near_tx", tx_hash, signer_id}`.
// The bridge reads the transaction from NEAR RPC and accepts it only if:
//   - it was sent to the bazaar contract and called `settle`,
//   - the contract logged a NEP-297 `settled` event for this checkout_ref and merchant,
//   - the amount equals the quote for this checkout,
//   - the USDC `ft_transfer` receipt succeeded and no `settle_reverted` event followed,
//   - the tx hash has not paid another checkout.

export const HANDLER_NS = "xyz.r3p.near_usdc";
export const HANDLER_ID = "near_usdc";
export const EVENT_STANDARD = "bookerbob";

/** The `payment_handlers` entry the bridge adds to the store's UCP manifest. */
export function handlerManifest({ network, bazaar, usdc, merchant, version = "2026-08-25" }) {
  return {
    [HANDLER_NS]: [
      {
        id: HANDLER_ID,
        version,
        config: {
          network: `near:${network}`,
          contract: bazaar,
          merchant,
          asset: { code: "USDC", contract: usdc, decimals: 6 },
          function: "settle(nullifier, merchant, checkout_ref, amount)",
          credential: { type: "near_tx", tx_hash: "base58", signer_id: "account id" },
        },
      },
    ],
  };
}

export class PaymentError extends Error {}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/** NEAR JSON-RPC `tx` with wait_until FINAL. `rpc` is injectable for tests. */
export async function fetchTx(txHash, signerId, { rpcUrl, rpc = defaultRpc } = {}) {
  if (!B58.test(txHash)) throw new PaymentError("tx_hash must be a base58 NEAR transaction hash");
  return rpc(rpcUrl, { jsonrpc: "2.0", id: "bookerbob", method: "tx", params: { tx_hash: txHash, sender_account_id: signerId, wait_until: "FINAL" } });
}

async function defaultRpc(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) throw new PaymentError(`rpc: ${j.error.cause?.name ?? j.error.message}`);
  return j.result;
}

function events(outcome) {
  return (outcome.outcome.logs ?? [])
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => {
      try {
        return JSON.parse(l.slice("EVENT_JSON:".length));
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.standard === EVENT_STANDARD);
}

/** Parse a `tx` RPC result into the settled payment, or throw PaymentError. */
export function readPayment(result, { bazaar, usdc, demoToken = null }) {
  if (!result?.transaction) throw new PaymentError("no transaction in rpc result");
  const tx = result.transaction;
  if (tx.receiver_id !== bazaar) throw new PaymentError("transaction was not sent to the bazaar contract");
  const call = (tx.actions ?? []).find((a) => a.FunctionCall)?.FunctionCall;
  const demo = call?.method_name === "settle_demo";
  if (!call || (call.method_name !== "settle" && !demo)) throw new PaymentError("transaction does not call settle");
  if (demo && !demoToken) throw new PaymentError("a demo-token settle, but no demo token configured");
  if (!result.status || !("SuccessValue" in result.status)) throw new PaymentError("transaction did not succeed");

  const outcomes = result.receipts_outcome ?? [];
  const all = outcomes.flatMap((o) => events(o).map((e) => ({ e, executor: o.outcome.executor_id })));
  const settled = all.find(({ e, executor }) => e.event === "settled" && executor === bazaar)?.e?.data?.[0];
  if (!settled) throw new PaymentError("no settled event from the bazaar contract");
  if (all.some(({ e, executor }) => e.event === "settle_reverted" && executor === bazaar)) {
    throw new PaymentError("payout failed and the contract reverted the settle");
  }
  if ((settled.token === "demo") !== demo) throw new PaymentError("settled token does not match the method");
  const token = demo ? demoToken : usdc;
  const ft = outcomes.find((o) => o.outcome.executor_id === token);
  if (!ft || !ft.outcome.status || !("SuccessValue" in ft.outcome.status)) {
    throw new PaymentError(`${demo ? "dUSDC" : "USDC"} ft_transfer did not succeed`);
  }
  return {
    tx_hash: tx.hash,
    signer_id: tx.signer_id,
    nullifier: settled.nullifier,
    merchant: settled.merchant,
    payout: settled.payout,
    amount: BigInt(settled.amount),
    discount_bps: settled.discount_bps,
    checkout_ref: settled.checkout_ref,
    token: demo ? "dUSDC" : "USDC",
  };
}

/** Match a settled payment to the checkout's quote. `usedTx` maps tx hash to checkout id. */
export function acceptPayment(paid, quote, usedTx = {}) {
  if (usedTx[paid.tx_hash] && usedTx[paid.tx_hash] !== quote.checkout_ref) throw new PaymentError("this transaction already paid another checkout");
  if (paid.checkout_ref !== quote.checkout_ref) throw new PaymentError("payment is for another checkout");
  if (paid.merchant !== quote.merchant) throw new PaymentError("payment went to another merchant");
  if (paid.amount !== BigInt(quote.amount)) throw new PaymentError("amount differs from the quote");
  return true;
}

/** Fields the Shopify order carries: note, attributes and tag. */
export function orderFields(paid, { network }) {
  const usdc = `${paid.amount / 1_000_000n}.${(paid.amount % 1_000_000n).toString().padStart(6, "0")}`;
  const demo = paid.token === "dUSDC";
  const what = demo ? "dUSDC (testnet demo token, no value; production uses Circle USDC)" : "USDC";
  const discount = paid.discount_bps == null ? "" : ` Discount ${paid.discount_bps / 100}% from proven predicates.`;
  return {
    note: `Paid ${usdc} ${what} on NEAR ${network}, tx ${paid.tx_hash}.${discount} Nullifier burned in the same call.`,
    customAttributes: [
      { key: "near_tx", value: paid.tx_hash },
      { key: "checkout_ref", value: paid.checkout_ref },
      { key: "nullifier", value: paid.nullifier },
    ],
    tags: demo ? ["bookerbob", "near-dusdc-demo", "testnet"] : ["bookerbob", "near-usdc"],
    amount: usdc,
    explorer: `https://${network === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${paid.tx_hash}`,
  };
}

const tokenCache = new Map();

/**
 * A short-lived Admin API token from the app's client credentials (Shopify Dev Dashboard
 * apps: POST /admin/oauth/access_token, grant_type=client_credentials). Cached in memory
 * until shortly before it expires; never written anywhere.
 */
export async function adminToken(admin, { fetchImpl = fetch, now = Date.now } = {}) {
  if (admin.token) return admin.token;
  const hit = tokenCache.get(admin.domain);
  if (hit && hit.expires > now() + 60_000) return hit.token;
  const r = await fetchImpl(`https://${admin.domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: admin.clientId, client_secret: admin.clientSecret }).toString(),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) throw new Error(`Shopify access_token ${r.status}: ${String(body.error_description ?? body.error ?? "no token").slice(0, 200)}`);
  tokenCache.set(admin.domain, { token: body.access_token, expires: now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

const DRAFT_CREATE = `mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id name } userErrors { field message } } }`;
const DRAFT_COMPLETE = `mutation($id: ID!) { draftOrderComplete(id: $id, paymentPending: false) { draftOrder { id order { id name } } userErrors { field message } } }`;

/**
 * Write the paid order to the store through the Admin GraphQL API: a draft order with one
 * custom line at the settled amount, the near_tx in the note, custom attributes and tags,
 * then draftOrderComplete(paymentPending: false), which turns it into a real paid order.
 * (The app holds write_draft_orders, not write_orders.) `admin` = { domain, version, and
 * clientId + clientSecret, or a token }, from SHOPIFY_* settings outside the repo; nothing
 * secret is logged or returned. Without `admin`, returns what it would write.
 */
export async function recordPaidOrder(lines, fields, { admin, fetchImpl = fetch } = {}) {
  const input = {
    lineItems: lines.map((l) => ({ title: l.title, originalUnitPrice: l.price ?? fields.amount, quantity: l.quantity ?? 1, requiresShipping: false, taxable: false })),
    note: fields.note,
    customAttributes: fields.customAttributes,
    tags: fields.tags,
  };
  if (!admin) return { stub: true, would_write: input };
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(admin.domain)) throw new Error("SHOPIFY_STORE_DOMAIN must be <store>.myshopify.com");
  const token = await adminToken(admin, { fetchImpl });
  const gql = async (query, variables) => {
    const r = await fetchImpl(`https://${admin.domain}/admin/api/${admin.version}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.errors) throw new Error(`Shopify graphql ${r.status}: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
    return body.data;
  };
  const c = (await gql(DRAFT_CREATE, { input })).draftOrderCreate;
  if (c.userErrors?.length) throw new Error(`draftOrderCreate: ${JSON.stringify(c.userErrors).slice(0, 300)}`);
  const done = (await gql(DRAFT_COMPLETE, { id: c.draftOrder.id })).draftOrderComplete;
  if (done.userErrors?.length) throw new Error(`draftOrderComplete: ${JSON.stringify(done.userErrors).slice(0, 300)}`);
  const order = done.draftOrder.order;
  const num = order.id.split("/").pop();
  return { id: num, name: order.name, draft: c.draftOrder.name, admin_url: `https://${admin.domain}/admin/orders/${num}` };
}

/** Read the store settings from an env file's KEY=value lines (values are never printed). */
export function adminFromEnv(text) {
  const env = Object.fromEntries(text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^["']|["']$/g, "")]));
  const admin = { domain: env.SHOPIFY_STORE_DOMAIN, version: env.SHOPIFY_ADMIN_API_VERSION || "2025-07" };
  if (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET) Object.assign(admin, { clientId: env.SHOPIFY_CLIENT_ID, clientSecret: env.SHOPIFY_CLIENT_SECRET });
  else if (env.SHOPIFY_ADMIN_ACCESS_TOKEN) admin.token = env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (!admin.domain || !(admin.token || admin.clientId)) throw new Error("SHOPIFY_STORE_DOMAIN and SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (or SHOPIFY_ADMIN_ACCESS_TOKEN) are required");
  return admin;
}
