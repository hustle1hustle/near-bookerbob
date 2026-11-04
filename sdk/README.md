# Merchant SDK (stub)

`merchant.mjs`, no dependencies. For a merchant agent that wants to bid in the bazaar.

| function | what |
|---|---|
| `schedule({basePrice, rules, capBps, cohort})` | build a discount schedule (USDC base units, bps; every perk is a discount) |
| `validate(s)` | the contract's own schedule checks, run before sending |
| `bidCommitment(account, s, salt)` | round 1 of a blind round |
| `quote(s, revealed, k)` | preview the code-computed price, group unlock included |
| `registerArgs(s, category)`, `registerCommand(...)` | `register_merchant` args and a testnet near-cli-rs command |

`merchant.test.mjs` recomputes all 30 bid commitments and prices in `agents/board.json`
(made by the Rust code) and checks they match. The near-cli-rs command line is not
verified yet: near-cli-rs is not installed on the build machine.

Not in the SDK yet: watching `verdict_submitted` events, the reveal round over a transport,
and a model-written pitch (see `agents/why.mjs`).
