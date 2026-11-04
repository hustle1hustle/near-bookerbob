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

Needs Rust (stable, 1.93 or newer) and `make`. No network, no keys.

1. Run `make verify`.
   See one line per link of the chain, each `PASS` or `FAIL`, ending in `nullifier spent`
   for the replayed proof and `ALL PASS`.
2. Run `make test`.
   See the contract and core unit tests, named by behaviour
   (`replayed_nullifier_is_rejected`, `uncited_fact_refuses_receipt`, ...).
3. Read `fixtures/` to see exactly what went in. All fixtures are synthetic. No real user
   data is in this repository.

## How one purchase works

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
    OL->>OL: referee: every cited fact must be in the proof set
    U->>C: settle(nullifier, merchant, checkout_ref)
    C->>C: cap check, burn nullifier, NEP-297 event
    C->>S: ft_transfer USDC to merchant payout; UCP order stores near_tx
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
| deterministic tier, price stack, referee (cheat mode) | security, swarms | `core/src/` | built (19 tests) |
| SUB-ACCOUNTS: one merchant agent per sub-account | swarms | `agents/` | planned |
| NEAR AI Cloud private inference and attestation (TEE ATTESTATION) | privacy | `agents/` | planned |
| OutLayer TDX worker as referee and verification node | security, privacy | `docs/` | planned |
| FUNCTION CALL KEYS: agent key limited to `settle` | security, agents | `contract/` | planned |
| Chain Signatures `domain_id:1` (Ed25519) for a Stellar leg | agents | `fixtures/` | planned |
| NEAR INTENTS / 1Click top-up from any chain | realworld, agents | `docs/` | planned (mainnet only) |

## Repository layout

| path | what |
|---|---|
| `contract/` | `bazaar` contract, near-sdk 5.29.1 |
| `core/` | `bookerbob-core`: verdict envelope v0, tier, price and discount stack, referee. Shared by contract and CLI |
| `cli/` | `bookerbob` CLI: offline end-to-end on fixtures, fixture generator |
| `agents/` | merchant swarm and board |
| `ucp/` | UCP payment handler `xyz.r3p.near_usdc` |
| `fixtures/` | synthetic, deterministic inputs and expected outputs |
| `docs/` | envelope spec, ideas, design notes |

## What `make verify` checks, and what is mocked

`cli/src/verify.rs` runs 17 checks in order: proof set hash, tier from proven fields,
revealed subset, commitment opening, envelope shape, ed25519 and p256 signatures
off-chain, then the real `bazaar` contract code against near-sdk's MockedBlockchain
(host functions run through nearcore's VM logic): enclave keys, merchants, escrow, verdict
submission with both signature schemes, code-computed quotes, the referee (honest receipt,
injected claim refused with `F9 not in proof set`), settle (escrow debit, nullifier burn,
`settled` event, `ft_transfer` receipt to USDC), and the replay from another wallet
(`nullifier spent`).

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
- The bid board can leak coarse buyer traits. Mitigations: category-only bids, blind
  rounds, k>=5 cohorts.
- `make verify` runs the contract code natively against near-sdk's MockedBlockchain, not
  on a live chain. Testnet addresses and tx hashes are listed below once deployed.

## Deployments

None yet. Testnet first; mainnet only on an explicit go.

## License

MIT, see [LICENSE](LICENSE).
