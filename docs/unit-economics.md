# Unit economics: what one purchase costs, and what pays for it

Measured on testnet on 2026-11-05 from one ordinary single purchase (`t-7e261e`, 36.00 dUSDC,
the purchase that paid the 1% fee), read back over public RPC: gas burnt per tx, and storage
kept (the deposit attached minus the refund). NEAR's gas price is the same on testnet and
mainnet today, so the NEAR amounts carry over; the dollar amounts need a NEAR price, which is
an assumption and is shown as one.

## Cost per purchase

| step | who pays today | gas burnt (NEAR) | storage kept (NEAR) |
|---|---|---|---|
| `attest_human` (World binding, once per agent) | the relayer (demo) | 0.00044 | 0.00288 |
| `submit_verdict` | the relayer (demo) | 0.00059 | 0.01336 |
| `submit_referee_result` | the relayer (demo) | 0.00043 | 0 |
| `ft_transfer_call` into escrow | the relayer (demo) | 0.00075 | 0 |
| `settle_demo` (burn, pay, fee) | the relayer (demo) | 0.00102 | 0 |
| **on-chain total** | | **0.00323** | **0.01624** |
| escrow entry (once per agent) | the treasury | 0.00027 | 0.01 |
| review-group join (optional) | the relayer | 0.00115 | 0.00293 |

Off chain, per purchase:

- **The verdict:** one NEAR AI call, about $0.001 (`scripts/near-ai-verdict.mjs`).
- **The referee:** on OutLayer it would be one execution, `estimate_execution_cost` = 0.0070001
  NEAR (measured; not run there yet, today it runs on the Mac).

So one purchase costs about **0.0102 NEAR in gas and compute** plus about **0.016 NEAR of storage
locked** in the bazaar. That storage is not burnt, but no call frees a verdict record today, so
it is counted as a cost here.

## What pays for it

- **The market fee:** 1% of the settled amount, to the DAO treasury (`set_fee`, live:
  0.36 dUSDC on a 36.00 purchase, swept to `bookerbob-gov`).
- **Break-even basket** (fee = cost), for a few NEAR prices (assumed, not a forecast):

| NEAR price | cost per purchase, gas + compute | with storage | break-even at 1%, gas + compute | with storage |
|---|---|---|---|---|
| $1 | $0.010 | $0.026 | $1.02 | $2.65 |
| $2.50 | $0.026 | $0.066 | $2.56 | $6.62 |
| $5 | $0.051 | $0.132 | $5.12 | $13.24 |

The hoodie purchases (36 to 38) clear every row; the hotel stay (408) clears the highest by about 30
times. Below about $1 to $13 (by NEAR price, with or without storage), a single purchase does not pay
for itself at 1%; a buying group settles one record per member, so it does not help per buyer.

## The merchant's side

- **What a discount buys:** in the market model (`docs/market-eval.md`, a simulation with
  stated assumptions, not market data) a proven buyer pays 29.13 against 41.00 with no
  disclosure. Against fixed prices total merchant profit falls 57.9% after the 1% fee, and it
  breaks even only at 4.18 times the assumed LTV or 2.38 times the volume. Against the same
  merchants in a price war on one public price, merchants keep 9% to 24% more with LTV 0, and
  the buyer pays 2.28 to 2.91 more. No merchant has shown it is worth paying.
- **The discount is real: the base-price anchor.** A "20% off" means nothing if the merchant
  raised the base first. `set_price_anchor` caps a merchant's base at a public price from a
  named source; `register_merchant` and `reveal_bid` refuse a base above it (contract test
  `an_inflated_base_is_refused`). On testnet the 8 Lisbon hotels are capped at their public
  JMPR rates for the stay, and `make cheat` shows h05 trying to raise 510 to 600, so that 15%
  off would land at the public price: refused on chain ([6M3Bi7RY…](https://testnet.nearblocks.io/txns/6M3Bi7RY6thU4yfbUUQShHz9M9drHSNwrMY683rjB16u)). `make verify-live` re-checks it.
- **Where anchors come from:** the owner sets them, so they are a trust anchor like the issuer
  keys: lowering one applies at once (it only narrows), raising one waits out the anchor delay.
  The hoodie merchants have no public price to anchor to, so they are not anchored; their
  "discount" is relative to a base nobody else checks.

## Not measured, stated plainly

- The relayer's own cost (it pays every demo gas line above) and any hosting.
- Mainnet USDC flows: a Circle USDC settle has the same calls; the token's storage deposit
  differs. Not run on mainnet.
- Acquisition cost, conversion and repeat rates: the market model assumes them.
