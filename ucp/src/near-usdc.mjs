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
export function readPayment(result, { bazaar, usdc }) {
  if (!result?.transaction) throw new PaymentError("no transaction in rpc result");
  const tx = result.transaction;
  if (tx.receiver_id !== bazaar) throw new PaymentError("transaction was not sent to the bazaar contract");
  const call = (tx.actions ?? []).find((a) => a.FunctionCall)?.FunctionCall;
  if (!call || call.method_name !== "settle") throw new PaymentError("transaction does not call settle");
  if (!result.status || !("SuccessValue" in result.status)) throw new PaymentError("transaction did not succeed");

  const outcomes = result.receipts_outcome ?? [];
  const all = outcomes.flatMap((o) => events(o).map((e) => ({ e, executor: o.outcome.executor_id })));
  const settled = all.find(({ e, executor }) => e.event === "settled" && executor === bazaar)?.e?.data?.[0];
  if (!settled) throw new PaymentError("no settled event from the bazaar contract");
  if (all.some(({ e, executor }) => e.event === "settle_reverted" && executor === bazaar)) {
    throw new PaymentError("payout failed and the contract reverted the settle");
  }
  const ft = outcomes.find((o) => o.outcome.executor_id === usdc);
  if (!ft || !ft.outcome.status || !("SuccessValue" in ft.outcome.status)) {
    throw new PaymentError("USDC ft_transfer did not succeed");
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
  return {
    note: `Paid ${usdc} USDC on NEAR ${network}, tx ${paid.tx_hash}. Discount ${paid.discount_bps / 100}% from proven predicates, nullifier burned in the same call.`,
    customAttributes: [
      { key: "near_tx", value: paid.tx_hash },
      { key: "checkout_ref", value: paid.checkout_ref },
      { key: "nullifier", value: paid.nullifier },
    ],
    tags: ["near-usdc"],
    explorer: `https://${network === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${paid.tx_hash}`,
  };
}

/**
 * Write the paid order to the store (draft order, completed as paid).
 * TODO(founder): needs the Shopify test store Admin API credentials, a the founder item. Until then
 * this returns the order it would write and does not call Shopify.
 */
export async function recordPaidOrder(lines, fields, { adminFetch } = {}) {
  if (!adminFetch) return { stub: true, would_write: { lines, ...fields } };
  throw new Error("Shopify write-back not wired yet");
}
