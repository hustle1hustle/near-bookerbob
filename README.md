# BookerBob

merchants compete for you. none of them learns who you are.

BookerBob is a market on NEAR where merchant agents bid for a buyer who has proven facts
about their own history (zkTLS), while the buyer stays unknown to every merchant. Code, not
a model, computes the price. A deterministic referee refuses any claim whose asserted value is not
exactly what the proof set holds. An on-chain nullifier set stops the same proof from being used twice. The
winning merchant is paid in USDC on NEAR.

Built at NEAR HACKATHON (2026-11-01 to 2026-11-14). Prior work is disclosed in
[PRIOR_WORK.md](PRIOR_WORK.md).

## Problem

Agents can already check out (UCP) and pay (USDC). No rail proves that the customer behind
the agent is real and valuable without handing over their data, so merchants keep paying
ads to find customers. BookerBob turns that ad budget into a discount paid to a proven
customer, and keeps the customer private.

## Try it

Needs Rust (stable, 1.93 or newer) and `make`; `make test` also needs Node 22. No keys.
Measured on 2026-11-04 on an 11-core Apple M3 Pro: `make verify` takes 40 s from a cold
build (crates already downloaded; a first run also fetches them from crates.io) and 2 s
warm. After the first build it needs no network.

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
`/board.html`. The buyer, proofs and hoodie merchants are synthetic fixtures.

Hotel bids (`hotel-lisbon`, h01..h08) use **JMPR rates, 2026-11-04, comparison prices**
(`fixtures/live/jmpr-lisbon-rates.json`): 8 five-star Lisbon hotels, 2026-12-10 to 12-13,
3 nights, read-only `hotel_search`, nothing prebooked or booked. Base price = base nightly
rate (incl. tax) x 3; Valverde has only an elite rate (before tax), so that is used and
marked. These are "from" prices, not quotes. The discount schedules on those hotels are
our config, not JMPR offers; JMPR elite perks are shown as text and never priced. With the
buyer's 3 revealed bits the best hotel bid is Intercontinental at $408.00 against a $510.00
base (our schedule: airbnb 5%, claude 5%, World ID 10%). Each bit saves something, and it
adds up by hand: 25.50 + 25.50 + 51.00 = 102.00 = 510.00 - 408.00. Without any one bit,
Intercontinental is still the cheapest hotel, so each saving is that bit's line.

Public receipts (`/receipts.html`, data `agents/receipts.json` from `make receipts`): every
verdict and purchase the contract logged, hashes and public payment fields only, built
from the contract's own NEP-297 events in the `make verify` run and checked there.

![receipts page: nullifier, commitment, status, referee receipt, merchant, amount, event chips](docs/img/receipts.png)

## How one purchase works

This is the **target flow**, not what runs today. Today `make verify` runs the contract
steps on fixtures: the verdict is signed by a fixture issuer seed (`cli/src/fixtures.rs`),
not by NEAR AI; the referee result is signed by a fixture referee seed, not on OutLayer;
there is no notary proof and no Shopify order. The table below says which parts are built.

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
    AI-->>U: verdict envelope v0 (coarse predicates, tcb_status, cnf, expiry), signed (target; today a fixture issuer key signs)
    U->>C: submit_verdict(envelope, signature): ed25519_verify / p256_verify, nullifier check
    M->>C: discount schedules (base, per-predicate bps, cap)
    C-->>U: quote = code-computed price per merchant
    OL->>C: signed referee result (receipt, or refusal like F9 not in proof set)
    C->>C: ed25519_verify worker key, store receipt
    U->>C: settle(nullifier, merchant, checkout_ref, amount)
    C->>C: amount = quote, receipt present, cap check, burn nullifier, NEP-297 event
    C->>C: ft_transfer USDC (NEP-141) to the merchant payout
    U->>S: UCP checkout with the near_tx; the bridge reads it and the order stores near_tx
    U->>C: a second verdict for the same account (same nullifier), another wallet
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
| blind bid rounds on chain: `open_round`, `commit_bid` (sealed hash, approved merchants only, before the commit deadline), `reveal_bid` (must open the commitment, before the reveal deadline), `round_best_quote` (only after the reveal deadline); 30 merchant agents bid through it | swarms | `contract/src/lib.rs`, `core/src/bid.rs`, `cli/src/swarm.rs`, `sdk/merchant.mjs` | built: 8 contract tests, and the `make verify` board runs both rounds on the contract code (MockedBlockchain); not deployed; merchant sub-accounts are not created yet |
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
| merchant SDK for outside agents (schedule, validate, blind bid commitment, quote preview, register args); Agent Market listing plan | swarms, agents | `sdk/`, `docs/agent-market.md` | SDK built (cross-checked against the Rust board); not listed, Agent Market is mainnet only |
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
| `sdk/` | merchant SDK stub (JS, no dependencies) |
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
another wallet: a second verdict for the same account, same nullifier (`nullifier spent`). Then the 30-agent board check and 50 referee evals.

Mocked or synthetic today: the proof set and attestation report (synthetic fixtures), the
issuer keys (fixed seeds, `cli/src/fixtures.rs`), the chain (MockedBlockchain, no live
RPC), and the USDC transfer (a scheduled receipt, not executed). `make fixtures-check`
proves the committed fixtures are exactly what the generator produces.

## Threat model and trust

### Trust anchors

Every key the contract trusts is registered by the contract **owner**: verdict issuers
(enclave keys), the referee worker, the dispute arbiter and the World ID verifier. The
owner is one account today. A stolen owner key can register a rogue issuer or referee.
Mitigation path: a multisig or DAO owner, and registering only keys an attestation proves
(the OutLayer worker's TDX-registered key, the NEAR AI model key). Not built.

| layer | what it proves | what it does not |
|---|---|---|
| zkTLS proof | the facts came from the user's real account over TLS | the notary is a single MPC key today, not attested ("notary not attested") |
| NEAR AI TEE | the answer came from the attested model key; under E2EE v2 the signature covers the ciphertext | TEE caveats apply; `tcb_status` is recorded, not hidden (OutOfDate grades exist); the TDX quote is not verified in this repo yet |
| verdict issuer | the envelope was signed by a registered key (`ed25519_verify` / `p256_verify`) | that the issuer is honest beyond its key |
| referee (OutLayer worker) | every cited fact is in the proof set, its asserted field and value match, and it proves its line; the price is the code quote | OutLayer is unaudited; a compromised referee key can sign a false receipt (the dispute path exists for that) |
| dispute arbiter | an independent re-run of every check, signed | only as independent as its operator; today it is a fixture seed like the referee |
| World ID verifier | one World ID holder bound one agent | there is no World ID verifier on NEAR; the contract trusts the service key |
| contract | nullifier used once, price from code, cap, receipt required, payout atomic with the burn | it never sees raw facts, by design |

### Who sees what

| party | sees | never sees |
|---|---|---|
| merchants and the board | revealed predicate names, their own quote, the verdict commitment, the cohort size k | raw history, identity, unrevealed predicates, fact values |
| anyone reading the chain | per verdict: nullifier, commitment, revealed predicates, tcb_status, cap; settled amount, merchant, checkout_ref | the proof set, the buyer's other contexts (the nullifier is per context) |
| the referee and arbiter | the proof set they judge (synthetic in fixtures) | nothing more; on-chain `input_data` is public, so real proofs must go over OutLayer's HTTPS path or sealed (not built) |
| NEAR AI enclave | the facts, sealed to its key | |
| REP | today, the HMAC nullifier key, so it could link accounts | |

### Attacks and what stops them

| attack | stopped by | where |
|---|---|---|
| registration flood: cheap fake merchants crowd the board or make `best_quote` unbounded | merchants pay their own storage; only owner-approved merchants are quoted or paid; a changed schedule drops approval; `best_quote` is paged (at most 100 per call) | `approve_merchant`, `revoke_merchant`, `best_quote(.., from_index, limit)`; contract tests |
| a second verdict for the same account (same nullifier) from another wallet | per-context nullifier in a global spent-set | `submit_verdict`, `settle`; `make verify` check 25 |
| model claims a status it cannot prove (prompt injection) | structured claims: each citation asserts a field and value that must equal the proof; text naming an unproven status, another platform or an unasserted number is refused; no receipt, no payment | `core/src/referee.rs`; checks 19 to 21; 50 evals, 30 of them injection-style |
| compromised referee signs a false receipt | arbiter re-runs and signs `overturned`; the receipt is cleared | check 22 |
| merchant asks for raw history or identity | buyer agent policy declines by rule | `core/src/disclosure.rs`; check 05 |
| one person runs many agents | one agent per World nullifier | `attest_human`; check 12 |
| LLM sets the price | prices come only from `bookerbob-core` inside the contract | `quote_in_cohort` |
| tampered envelope, forged or malleable signature | digest over every field, ed25519 / p256 with low-S | contract tests |
| agent overspends | `max_spend` cap in the verdict, amount must equal the receipt price | `settle` |
| agent key drains escrow | `withdraw` needs a full-access key (1 yoctoNEAR); settle only pays a registered merchant with a receipt | `withdraw`, `settle` |
| payout fails after the burn | callback restores escrow and the nullifier | `on_settle_transfer` |

### Not defended, stated plainly

- A stolen agent key plus a merchant the attacker controls can get an honest receipt for
  that merchant and settle up to `max_spend`. Keep caps small; the planned function-call
  key per agent sub-account narrows the blast radius but does not remove this.
- Cohorts on predicates other than `world_id_human` are not sybil-resistant: one person
  with many accounts adds many verdicts. Only the World-bound predicate is one per person.
- Cohort counts never decrease (spent and expired verdicts still count).
- Revealed predicates are public on chain per verdict. Within one context, a rare
  combination can narrow who the buyer is. Category-only bids, blind rounds and k>=5
  reduce this; they do not remove it.
- Owner key centralization (above). Fixture keys are public seeds: test only.

## Known limits

- The account nullifier is an HMAC under a REP-held key today, so REP could link accounts.
  VOPRF is the chosen replacement and is not built. In fixtures the nullifier is a
  labelled placeholder.
- World ID runs on fixtures with a placeholder action. Say "proven customer", not
  "verified human", until the live path ships.
- Callers pay for the storage they add (`submit_verdict`, `register_merchant`,
  `attest_human`, unused deposit refunded); `storage_deposit` opens an escrow entry for
  0.01 NEAR.
- No refunds after a dispute that lands after settle; the record is only flagged.
- The referee's text checks are a word-level tripwire (status words, platform names,
  numbers, plain ascii), not language understanding. A discount never depends on the text:
  only on asserted values that equal the proof.
- `make verify` runs the contract code natively against near-sdk's MockedBlockchain, not
  on a live chain. Nothing is deployed yet; testnet addresses and tx hashes go below.

## Deployments

None yet. Testnet first; mainnet only on an explicit go.

### Deploy to testnet (one command)

```sh
DRY_RUN=1 scripts/deploy-testnet.sh   # prints every command, sends nothing
scripts/deploy-testnet.sh             # needs near-cli-rs and cargo-near
```

Idempotent: each step reads chain state first and skips what is done. It refuses any
network but testnet. Steps: the `bookerbob.testnet` account (faucet), build and deploy
with `new`, register the issuer, referee, arbiter and World verifier keys (seeds created
by `bookerbob keys` in `~/.rep-secrets/bookerbob-testnet`, outside the repo), USDC storage
for the bazaar, 30 merchant sub-accounts (`m01..m22`, `h01..h08`) with their schedules
from `agents/merchants.json` and USDC storage, the first Chain Signatures `sign` with
`domain_id: 1` (raw output to `fixtures/live/mpc-sign.txt`), and, once the worker is
uploaded to OutLayer, one `request_referee` (`OUTLAYER_PROJECT=<owner>/<project>`). Every
transaction hash goes to `docs/testnet.md`. Knobs: `BAZAAR_ACCOUNT_ID`, `MERCHANTS`,
`MERCHANT_FUND` (default 0.1 NEAR each). The near-cli-rs syntax was written before
near-cli-rs was installed here: dry-run first, check the first live step by hand.

## License

MIT, see [LICENSE](LICENSE).
