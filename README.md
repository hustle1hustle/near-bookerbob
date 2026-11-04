# BookerBob

merchants compete for you. none of them learns who you are.

BookerBob is a market on NEAR where merchant agents bid for a buyer who has proven facts
about their own history (zkTLS), while the buyer stays unknown to every merchant. Code, not
a model, computes the price. A deterministic referee refuses any claim that is not in the
proof set. An on-chain nullifier set stops the same proof from being used twice. The
winning merchant is paid in USDC on NEAR.

Built at NEAR HACKATHON (2026-11-01 to 2026-11-14). Prior work is disclosed in
[PRIOR_WORK.md](PRIOR_WORK.md).

## Problem

Agents can already check out (UCP) and pay (USDC). No rail proves that the customer behind
the agent is real and valuable without handing over their data, so merchants keep paying
ads to find customers. BookerBob turns that ad budget into a discount paid to a proven
customer, and keeps the customer private.

## Try it in 2 minutes

Needs Rust (stable, 1.93 or newer) and `make`; `make test` also needs Node 22. No network, no keys.

1. Run `make verify`.
   See one line per link of the chain, each `PASS` or `FAIL`, ending in `nullifier spent`
   for the replayed proof and `ALL PASS`, then the 30-agent board and
   `PASS  swarm board matches agents/board.json and contract best_quote per category`.
   The `EVENT_JSON:` lines on stderr are the contract's own NEP-297 logs.
   `make demo-offline` prints the same story on one screen without them. The last line,
   `PASS  public receipts page data matches agents/receipts.json`, checks the public
   receipts page against the contract's events.
2. Run `make test`.
   See the contract and core unit tests, named by behaviour
   (`replayed_nullifier_is_rejected`, `uncited_fact_refuses_receipt`, ...).
3. Read `fixtures/` to see exactly what went in. All fixtures are synthetic. No real user
   data is in this repository.

## The board

![bookerbob board: 30 merchant agents bid, the buyer column shows only k=6 and the disclosure counter, the injected claim gets a red refused receipt](docs/img/board.png)

`make swarm` writes `agents/board.json`; `python3 -m http.server -d agents` and open
`/board.html`. Synthetic fixtures.

Public receipts (`/receipts.html`, data `agents/receipts.json` from `make receipts`): every
verdict and purchase the contract logged, hashes and public payment fields only, built
from the contract's own NEP-297 events in the `make verify` run and checked there.

![receipts page: nullifier, commitment, status, referee receipt, merchant, amount, event chips](docs/img/receipts.png)

## How one purchase works

This is the target flow. The table below says which parts are built today.

```mermaid
sequenceDiagram
    participant U as user + REP app
    participant N as zkTLS notary (MPC)
    participant AI as NEAR AI Cloud TEE
    participant OL as OutLayer TDX (referee)
    participant C as bazaar contract (NEAR)
    participant M as merchant agents (sub-accounts)
    participant S as Shopify store via UCP
    U->>N: zkTLS proof over own account (notary sees ciphertext)
    U->>AI: proven facts, E2EE v2
    AI-->>U: verdict envelope v0 (coarse predicates, tcb_status, cnf, expiry), signed
    U->>C: submit_verdict(envelope, signature): ed25519_verify / p256_verify, nullifier check
    M->>C: discount schedules (base, per-predicate bps, cap)
    C-->>U: quote = code-computed price per merchant
    OL->>C: signed referee result (receipt, or refusal like F9 not in proof set)
    C->>C: ed25519_verify worker key, store receipt
    U->>C: settle(nullifier, merchant, checkout_ref, amount)
    C->>C: amount = quote, receipt present, cap check, burn nullifier, NEP-297 event
    C->>C: ft_transfer USDC (NEP-141) to the merchant payout
    U->>S: UCP checkout with the near_tx; the bridge reads it and the order stores near_tx
    U->>C: same proof, another wallet
    C-->>U: "nullifier spent"
```

## NEAR features used

Status: `built` means in this repo and covered by `make verify` or tests; `stub` means the
interface exists with a test double; `planned` means not built yet.

| feature | track ids | where | status |
|---|---|---|---|
| near-sdk-rs contract: merchant registry, nullifier spent-set, enclave key registry | security, swarms | `contract/src/lib.rs` | built (unit tests, `make verify`), not deployed |
| `env::ed25519_verify` and `env::p256_verify` (low-S) on verdict signatures | security, privacy | `contract/src/lib.rs` `verify_signature` | built |
| NEP-141 USDC escrow (`ft_on_transfer`, `storage_deposit`) and `ft_transfer` payout in `settle` | realworld, agents | `contract/src/lib.rs` | built; payout rollback in `on_settle_transfer` |
| NEP-297 events (`verdict_submitted`, `settled`, `settle_reverted`, ...) | realworld | `contract/src/lib.rs` `emit` | built |
| deterministic tier, price stack, referee (cheat mode) | security, swarms | `core/src/` | built |
| disclosure policy: merchants ask, the buyer agent answers by rule (raw history and identity always declined); a budget caps bits per purchase and the plan shows what each bit saved | privacy | `core/src/disclosure.rs`, `fixtures/disclosure-policy.json`, `fixtures/merchant-asks.json` | built; `make verify` checks 04 and 05 |
| group unlock: a cohort price opens when k>=5 verdicts in the same context reveal a predicate; only the count is public (`cohort_size`) | swarms, privacy | `core/src/price.rs` `quote_in_cohort`, `contract/src/lib.rs` | built; `make verify` shows `k=6` |
| SUB-ACCOUNTS: 30 merchant agents, one sub-account each, blind commit then reveal | swarms | `agents/merchants.json`, `cli/src/swarm.rs` | built as config and offline board; accounts not created on testnet yet |
| NEAR AI Cloud inference for every merchant pitch and the buyer's cited "why", response signatures verified | privacy, swarms | `agents/why.mjs`, `agents/out/live-run.json` | built (plain TLS) |
| NEAR AI E2EE v2: the TEE signature covers the ciphertext, so it verifies without decrypting | privacy | `scripts/spikes/e2ee-signature.mjs`, `docs/near-ai.md` | checked live; TDX quote verification planned |
| OutLayer worker as referee: signed result (<= 900 bytes) checked by the contract with `ed25519_verify`; `settle` requires the receipt | security, privacy | `worker/`, `contract/src/lib.rs` (`submit_referee_result`, `request_referee`, `on_referee_result`), `docs/outlayer.md` | built and in `make verify`; not deployed to OutLayer yet. Live `estimate_execution_cost` = 0.0070001 NEAR |
| dispute arbiter: re-checks citations and every signature, signs upheld or overturned; an overturned receipt is cleared and settle is blocked | security | `worker/src/lib.rs` `arbitrate`, `contract/src/lib.rs` `submit_dispute_decision`, `docs/outlayer.md` | built; `make verify` check 22 |
| World ID "one person, one agent": the contract checks a verifier's ed25519 attestation and binds one agent per World nullifier; `world_id_human` needs it | security, privacy | `core/src/world.rs`, `contract/src/lib.rs` `attest_human` | built on offline fixtures (placeholder action); live verifier is the rep-world-verify service, not wired |
| FUNCTION CALL KEYS: agent key limited to `settle` | security, agents | `contract/` | planned |
| x402 v2 paid verdict read (`exact`, USDC on `near:testnet`, verify and settle through an explicit x402 facilitator) | agents, realworld | `x402/verdict-read.mjs` | built (7 tests on synthetic payments); no facilitator wired, testnet config only |
| MCP tool "REP Read for agents": read-only contract views for any MCP client | agents | `mcp/rep-read.mjs` | built (2 tests on a fake RPC); points at testnet once deployed |
| UCP payment handler `xyz.r3p.near_usdc`: reads `settle` from NEAR RPC, NEP-297 event, USDC transfer, builds the order fields with `near_tx` | realworld, agents | `ucp/src/near-usdc.mjs` | built (11 tests on a synthetic tx); Shopify write-back stubbed |
| Chain Signatures `domain_id:1` (Ed25519) for a Stellar leg | agents | `scripts/spikes/views.mjs`, `fixtures/live/views.json`, `stellar/`, `docs/stellar.md` | partial: live `derived_public_key` and its Stellar G-address; Soroban contract that only the Chain Signatures key can drive (4 tests); first `sign` and the NEAR signing method not done |
| NEAR INTENTS / 1Click top-up from any chain | realworld, agents | `docs/` | planned (mainnet only) |

## Repository layout

| path | what |
|---|---|
| `contract/` | `bazaar` contract, near-sdk 5.29.1 |
| `core/` | `bookerbob-core`: verdict envelope v0, tier, price and discount stack, referee. Shared by contract and CLI |
| `cli/` | `bookerbob` CLI: offline end-to-end on fixtures, fixture generator, swarm, referee, evals |
| `worker/` | referee as an OutLayer worker (stdin in, signed result out) |
| `scripts/spikes/` | live testnet and NEAR AI spikes, results in `fixtures/live/` |
| `agents/` | 30-agent merchant swarm, board, live NEAR AI layer (see `agents/README.md`) |
| `ucp/` | UCP payment handler `xyz.r3p.near_usdc` (see `ucp/README.md`) |
| `stellar/` | Soroban contract for the Stellar leg (own workspace, `make test-stellar`) |
| `x402/` | x402 v2 resource server for paid verdict reads |
| `mcp/` | MCP server wrapping the contract views (`nullifier_status`, `verdict`, `quote`, `best_quote`, `merchants`) |
| `fixtures/` | synthetic, deterministic inputs and expected outputs |
| `docs/` | envelope spec, ideas, design notes |

## What `make verify` checks, and what is mocked

`cli/src/verify.rs` runs 26 checks in order: proof set hash, tier from proven fields,
revealed subset, the disclosure budget plan, merchant asks declined by rule, commitment opening, envelope shape, ed25519 and p256 signatures
off-chain, then the real `bazaar` contract code against near-sdk's MockedBlockchain
(host functions run through nearcore's VM logic): enclave and referee keys, merchants,
escrow, World ID attestations (and a second agent of the same person blocked), verdict submission with both signature schemes, code-computed quotes, the
group unlock (5 peer verdicts bring the cohort to `k=6` and the cohort price opens), the
referee worker (a signed refusal for the injected claim `F9 not in proof set`, settle
blocked without a receipt, a signed receipt for honest claims), settle (escrow debit,
nullifier burn, `settled` event, `ft_transfer` receipt to USDC), and the replay from
another wallet (`nullifier spent`). Then the 30-agent board check and 20 referee evals.

Mocked or synthetic today: the proof set and attestation report (synthetic fixtures), the
issuer keys (fixed seeds, `cli/src/fixtures.rs`), the chain (MockedBlockchain, no live
RPC), and the USDC transfer (a scheduled receipt, not executed). `make fixtures-check`
proves the committed fixtures are exactly what the generator produces.

## Threat model and trust

| layer | what it proves | what it does not |
|---|---|---|
| zkTLS proof | the facts came from the user's real account over TLS | the notary is a single MPC key today, not attested ("notary not attested") |
| NEAR AI TEE | the verdict was computed by an attested model; the tier is computed by code | TEE trust caveats apply; `tcb_status` is recorded, not hidden (OutOfDate grades exist) |
| OutLayer TDX | the referee ran a known binary | OutLayer is unaudited; it only computes, our contract checks every signature |
| contract | nullifier used once, price within the verdict cap, payout atomic with the burn | it cannot see the raw facts, by design |

Who sees what: merchants see the coarse predicate category and their own quote. The board
shows a commitment, not the buyer. The contract stores nullifiers, commitments and
predicate bits revealed for a discount, never raw history.

## Known limits

- The account nullifier is an HMAC under a REP-held key today, so REP could link accounts.
  VOPRF is the chosen replacement and is not built. In fixtures the nullifier is a
  labelled placeholder.
- World ID: there is no verifier on NEAR. An off-chain service checks World ID and signs
  the binding; the contract trusts that service's key. The fixtures use a placeholder
  action, and say "proven customer", not "verified human", until the live path ships.
- The bid board can leak coarse buyer traits. Mitigations: category-only bids, blind
  rounds, k>=5 cohorts.
- Callers pay for the storage they add (`submit_verdict`, `register_merchant`, unused deposit
  refunded); `storage_deposit` opens an escrow entry for 0.01 NEAR.
- `make verify` runs the contract code natively against near-sdk's MockedBlockchain, not
  on a live chain. Testnet addresses and tx hashes are listed below once deployed.

## Deployments

None yet. Testnet first; mainnet only on an explicit go.

## License

MIT, see [LICENSE](LICENSE).
