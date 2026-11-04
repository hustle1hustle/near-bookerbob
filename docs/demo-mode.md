# Demo mode (testnet)

dUSDC is a testnet demo token with no value; production uses Circle USDC. Demo mode lets
anyone run the whole purchase on NEAR testnet without a faucet: one command makes a fresh
tester agent, funded by a treasury account, and every call it makes is gasless.

This follows the approach of our HackMeridian Stellar entry, which ran its own testnet USDC
issuer ("On testnet we use our own USDC issuer so seed guests can be funded"; see
`PRIOR_WORK.md`).

## Run it

```sh
make demo-tester                              # one tester purchase, about 1 minute
node scripts/demo-tester.mjs resume <tester>  # finish a purchase that already settled
node scripts/demo-tester.mjs reviews seal     # then reveal, then publish (see below)
DRY_RUN=1 node scripts/demo-tester.mjs run    # the plan, nothing read or sent
make verify-live                              # re-derive every testnet claim over public RPC
```

It needs the testnet keys in `~/.rep-secrets/bookerbob-testnet` (the referee, issuer and World
seeds sign the tester's synthetic verdict and receipt; the treasury seed pays). Testnet only:
every script refuses another network before reading anything.

## What one run does

| step | who signs | who pays gas | on chain |
|---|---|---|---|
| create `t-<6 hex>.bookerbob-demo.testnet`, 0.1 NEAR, the tester's own key | treasury | treasury | CreateAccount, Transfer, AddKey |
| bazaar escrow entry, dUSDC registration | treasury | treasury | `storage_deposit` x2 |
| mint 100 dUSDC | tester (NEP-366 delegate) | relayer | `mint` |
| bind one World person (placeholder action) | tester (delegate) | relayer | `attest_human` |
| verdict: 3 bits, a commitment, a nullifier of its own | tester (delegate) | relayer | `submit_verdict` |
| referee receipt for m01's quote (38.40) | tester (delegate) | relayer | `submit_referee_result` |
| escrow 38.40 dUSDC | tester (delegate) | relayer | `ft_transfer_call` |
| pay m01, burn the nullifier | tester (delegate) | relayer | `settle_demo`, then dUSDC `ft_transfer` |
| paid order in the Shopify test store, `near_tx` in the note | the bridge | | Admin API |
| same nullifier from another account | treasury | treasury | `submit_verdict`, refused: nullifier spent |
| join m01's review group with a fresh Semaphore identity | tester (delegate) | relayer | `join_review_group` |

The relayer checks a demo policy before it pays (`relayer/relay.mjs` `checkDemo`): tester
accounts only, the bazaar and dUSDC only, a fixed method list, deposits under a per-method cap
(paid from the tester's own 0.1 NEAR), `ft_transfer_call` only to the bazaar, a gas cap, and
20 actions per tester per day. The treasury refuses a run under 1 NEAR, and the script caps
testers at 20 per day.

## Reviews

After five or more testers joined m01's group, `node scripts/demo-tester.mjs reviews seal`
posts one sealed rating per tester, each with a Semaphore proof, each from a fresh one-time
implicit account through the relayer's review policy (the sender is never the buyer). After
the round closes, `reviews reveal` opens them; after the reveal window, `reviews publish`
releases them together. On testnet the demo bazaar uses 5-minute review rounds
(`set_review_round_ms`, refused off testnet); mainnet keeps 24 hours.

## What stays out

- Mainnet: the contract refuses `set_demo_token` and `set_review_round_ms` unless its own
  account ends in `.testnet`, and reads a stored demo token as none anywhere else. dUSDC
  refuses to initialise off `.testnet`.
- No hosted faucet, no public relayer: both run on the machine running the script.
- The verdict facts are synthetic fixtures, as in `make verify`.

## Contract surface

`set_demo_token`, `demo_token`, `demo_escrow_of`, `settle_demo`, `withdraw_demo`, `paid_in`,
`set_review_round_ms`, `review_round_ms`. dUSDC escrow is its own map: a USDC balance never
pays a demo settle and the reverse; a record pays once, in one token. Tests:
`contract/src/tests.rs` mod `demo` (17), `dusdc/src/tests.rs` (13), `relayer/*.test.mjs`,
`scripts/demo-tester.test.mjs`.
