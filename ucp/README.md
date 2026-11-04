# ucp: payment handler `xyz.r3p.near_usdc`

A UCP checkout paid by the bazaar contract's `settle` in USDC on NEAR.

| file | what |
|---|---|
| `src/near-usdc.mjs` | handler manifest entry, `fetchTx` (NEAR RPC `tx`), `readPayment` (NEP-297 `settled` event from the bazaar contract, USDC `ft_transfer` succeeded, no `settle_reverted`), `acceptPayment` (checkout, merchant, amount, one tx per checkout), `orderFields` (Shopify note, `near_tx` and `checkout_ref` attributes, `near-usdc` tag) |
| `test/near-usdc.test.mjs` | 11 tests, `make test-ucp` |
| `fixtures/tx-settled.synthetic.json` | SYNTHETIC RPC result shaped like NEAR's `tx`, carrying the exact `settled` log `make verify` produces. Replaced by a real testnet tx after deploy |

Written in the hackathon window, no dependencies (Node 22).

## Not done yet

- The UCP bridge surface (store manifest proxy, MCP tools, claim flow, draft order
  write-back) comes from the HackMeridian `ucp-module` (prior work, local repo, commit
  `97d9320`, 2026-10-25, see `PRIOR_WORK.md`). It is not copied here. Ported files will
  be committed one by one with a header naming the source file.
- `recordPaidOrder` is a stub: Shopify test store Admin API credentials are a team item.
- Shopify does not let an agent call `complete_checkout` with a custom handler, so the
  order is recorded through the Admin API as a draft order completed as paid.

## Wording

Our Shopify test store, not a real merchant. Shopify does not accept USDC on NEAR; the
bridge settles on NEAR and records the order.
