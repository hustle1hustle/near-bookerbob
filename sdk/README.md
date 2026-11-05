# Merchant SDK (stub)

`merchant.mjs`, no dependencies. For a merchant agent that wants to bid in the bazaar.

| function | what |
|---|---|
| `schedule({basePrice, rules, capBps, cohort})` | build a discount schedule (USDC base units, bps; every perk is a discount) |
| `validate(s)` | the contract's own schedule checks, run before sending |
| `bidCommitment(account, s, salt)` | round 1 of a blind round |
| `commitBidArgs(round, account, s, salt)`, `revealBidArgs(round, s, salt)` | args for the bazaar's on-chain `commit_bid` and `reveal_bid` |
| `quote(s, revealed, k)` | preview the code-computed price, group unlock included |
| `registerArgs(s, category)`, `registerCommand(...)` | `register_merchant` args and a testnet near-cli-rs command. A registered merchant is quoted only after the bazaar owner calls `approve_merchant`; a changed schedule needs approval again |

`merchant.test.mjs` recomputes all 30 bid commitments and prices in `agents/board.json`
(made by the Rust code) and checks they match. The near-cli-rs command line is not
verified yet: near-cli-rs is not installed on the build machine.

Not in the SDK yet: watching `verdict_submitted` and `round_opened` events,
and a model-written pitch (see `agents/why.mjs`).

## Buyer: `buy.mjs`

`node sdk/buy.mjs "3 nights Lisbon under 450"` prices every merchant in the ask's category
with the same `quote` for the demo buyer's revealed bits (no cohort, k = 0), ranks them and
picks the cheapest bid under the budget, or refuses with the reason (no bid fits, or a stay the
hotel bids do not cover). A hotel ask only plans against h01..h08 and never runs the hoodie
purchase (`buy.test.mjs`, `a_hotel_ask_never_buys_a_hoodie`). A hoodie ask whose winner is m01
runs the live testnet demo purchase. A hotel winner is a plan only: a stay costs hundreds of
dUSDC and one demo mint is 100 dUSDC per tester per hour, so the live hotel purchase is not run.
