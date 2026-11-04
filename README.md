# BookerBob

merchants compete for you. none of them learns who you are.

**A certified result over private data, settled on a shared ledger.** Your agent proves a
fact about your own history without showing it, code turns the fact into a price, merchants
compete for it blind, and NEAR records that the proof was used once and pays the winner.
Commerce is the first use: a proven customer gets a better price and stays unknown.

TEE for privacy, SNARK for correctness, chain for uniqueness and settlement.

Three flows, everything else is plumbing:

1. **Prove.** zkTLS facts go sealed to an attested enclave (NEAR AI, E2EE v2), which returns a
   verdict: a few predicate bits, a commitment and a per-context nullifier. The contract
   checks its signature and the enclave's TCB floor.
2. **Compete blind.** Merchant agents, ours or outside ones that bonded in, commit sealed bids
   and reveal after a deadline; code (not a model) computes every price, a referee refuses
   any claim the proofs do not back, and buyers form groups that unlock a price at k >= 5.
3. **Settle.** One contract call debits escrow, burns the nullifier and pays the merchant, or
   rolls back; buyers who paid rate it anonymously (Semaphore), and standing flows along hire
   edges under a Jolt proof anyone can challenge.

Plumbing: USDC (dUSDC on the testnet demo), the NEP-366 relayer, x402, MCP, UCP and Shopify,
World ID, Semaphore, the Sputnik DAO owner.

BookerBob is a market on NEAR where merchant agents bid for a buyer who has proven facts
about their own history (zkTLS), while the buyer stays unknown to every merchant. Code, not
a model, computes the price. A deterministic referee refuses any claim whose asserted value is not
exactly what the proof set holds. An on-chain nullifier set stops the same proof from being used twice. The
winning merchant is paid in USDC on NEAR.

Built at NEAR HACKATHON (2026-11-01 to 2026-11-14). Prior work is disclosed in
[PRIOR_WORK.md](PRIOR_WORK.md). Judging in 5 minutes: [docs/judge-guide.md](docs/judge-guide.md). Security
self-audit: [docs/audit.md](docs/audit.md).

## Problem

Agents can already check out (UCP) and pay (USDC). No rail proves that the customer behind
the agent is real and valuable without handing over their data, so merchants keep paying
ads to find customers. BookerBob turns that ad budget into a discount paid to a proven
customer, and keeps the customer private.

## Why a chain, not a server

A server run by us could compute the same prices. It could not give these three properties
to parties that do not trust us or each other:

- **One spent-set shared by distrusting merchants.** A proof used at m01 cannot be used again
  at m02. With 30 independent merchant agents, the only place all of them can check "this
  nullifier is spent" without trusting one operator is a shared ledger
  (`submit_verdict`, `settle`).
- **Atomic settle gated on a receipt.** Escrow debit, nullifier burn and the payout to the
  merchant happen in one contract call that refuses without a referee receipt for exactly
  that merchant and price, with a rollback callback if the transfer fails. Nobody, us
  included, can pay a merchant without the receipt or reuse it.
- **Proof checks anyone can rerun.** Verdict signatures (`ed25519_verify`, `p256_verify`),
  Semaphore Groth16 proofs on `alt_bn128` and the k >= 5 release rule run inside the
  contract, so a merchant or a judge does not take our word for a rating or a verdict.

| | our own server | a consortium log run by the merchants | NEAR (this repo) |
|---|---|---|---|
| one spent-set all merchants trust | they trust us | they trust the consortium's operators | the contract; anyone can read it |
| pay only on a receipt, atomically with the burn | our code, unauditable from outside | per operator | one public contract call, with rollback |
| rerun the proof checks (signatures, Semaphore, k floor) | on our word | per operator | inside the contract |
| who can rewrite history or censor | us | a majority of operators | nobody can rewrite; a relayer can refuse, anyone can run another |
| trust still left | everything | the operators | the owner key: it registers trust anchors (verdict issuers, referee, arbiter, World verifier), approves merchants outside the open category and sets `min_tcb`. One key on the live bazaar; a 2-of-3 Sputnik DAO with a timelock on the test bazaar |

## What is live and what is offline

Exact as of 2026-11-05. The contract is deployed on NEAR testnet (`bookerbob.testnet`, every
tx hash in [docs/testnet.md](docs/testnet.md)); nothing is on mainnet. On testnet, 6 purchases
settled in dUSDC (a testnet demo token with no value; production uses Circle USDC), 6 sealed
reviews were released and a standing update from a Jolt proof was accepted; `make verify-live`
re-derives all of it over public RPC. "Live" means captured once from the real service and
committed; `make verify` then re-checks it offline.

| live, captured from the real service | where |
|---|---|
| NEAR AI Cloud: 30 merchant pitches and 3 buyer "why" runs, 33/33 response signatures verified | `agents/out/live-run.json` |
| NEAR AI E2EE v2: one verdict issued in the enclave, its attestation report and TEE signature | `fixtures/live/near-ai/` |
| Intel PCS collateral for that TDX quote (status UpToDate) | `fixtures/live/near-ai/collateral.json` |
| NEAR testnet views (no transactions): the Chain Signatures derived key, OutLayer's cost estimate, USDC metadata | `fixtures/live/views.json` |
| Jolt standing proof over the live testnet hire graph, its worker-signed update accepted on chain (tx 4nHqu5TW) | `zk/out/standing-testnet/` |
| JMPR hotel rates (read-only search, nothing booked) | `fixtures/live/jmpr-lisbon-rates.json` |

| offline: real code, mocked chain or synthetic inputs | where |
|---|---|
| the `bazaar` contract, every method, run natively on near-sdk's MockedBlockchain (host functions such as `ed25519_verify`, `p256_verify`, `alt_bn128_*` run through nearcore's VM logic) | `contract/`, `make verify` |
| the buyer, the proof set and every key except NEAR AI's | `cli/src/fixtures.rs` |
| Semaphore proofs: real Groth16 proofs from Semaphore's V4 ceremony artifacts, generated locally for synthetic identities | `fixtures/semaphore/` |
| the referee worker, built for OutLayer but run locally | `worker/` |
| the NEP-366 relayer, x402 reads, MCP server, UCP handler, merchant SDK: tested on synthetic inputs | `relayer/`, `x402/`, `mcp/`, `ucp/`, `sdk/` |
| USDC payouts: scheduled as receipts in the mocked chain, never executed | `make verify` check 24 |

## Try it

**Fastest (15 to 30 s, Node 22 only, no keys, no build):** `make judge`. It re-derives every
testnet claim over public RPC (`make verify-live`), checks the six committed Jolt proofs'
outputs and program hashes, and runs the JS suites. With no network it prints SKIP for the
live checks and re-derives the same claims from a committed RPC snapshot
(`fixtures/live/rpc-snapshot/`, sha256-checked); `JUDGE_OFFLINE=1 make judge` forces that path.

The deep path needs Rust (stable, 1.93 or newer) and `make`; `make test` also needs Node 22. No keys.
Measured on an 11-core Apple M3 Pro: `make verify` takes 53 s from a fresh clone on 2026-11-05
(a cold build with the crates already downloaded; a first run also fetches them from
crates.io) and 2 s warm. After the first build it needs no network.

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

<!-- status:begin (generated from docs/status.json by scripts/status.mjs; edit that file) -->
| feature | track ids | where | status |
|---|---|---|---|
| near-sdk-rs contract: merchant registry, nullifier spent-set, enclave key registry | security, swarms | `contract/src/lib.rs` | **live**: unit tests and `make verify`; deployed at `bookerbob.testnet` |
| `env::ed25519_verify` and `env::p256_verify` (low-S) on verdict signatures | security, privacy | `contract/src/lib.rs` `verify_signature` | **live**: every testnet verdict passed it |
| NEP-141 USDC escrow (`ft_on_transfer`, `storage_deposit`) and `ft_transfer` payout in `settle` | realworld, agents | `contract/src/lib.rs` | **live**: payout rollback in `on_settle_transfer`; on testnet the same path ran 6 times in dUSDC (`settle_demo`, its own escrow, testnet only) |
| NEP-297 events (`verdict_submitted`, `settled`, `settle_reverted`, ...) | realworld | `contract/src/lib.rs` `emit` | **live**: every testnet tx above logs them |
| deterministic tier, price stack, referee (cheat mode) | security, swarms | `core/src/` | **built**: `make verify`, 50/50 referee evals |
| disclosure policy: merchants ask, the buyer agent answers by rule (raw history and identity always declined); a budget caps bits per purchase and the plan shows what each bit saved | privacy | `core/src/disclosure.rs`, `fixtures/disclosure-policy.json`, `fixtures/merchant-asks.json` | **built**: `make verify` checks 04 and 05 |
| group unlock: a cohort price opens when k>=5 verdicts in the same context reveal a predicate; only the count is public (`cohort_size`) | swarms, privacy | `core/src/price.rs` `quote_in_cohort`, `contract/src/lib.rs` | **live**: unlocked on testnet once k >= 5 verdicts revealed `world_id_human` (38.40 to 36.00) |
| blind bid rounds on chain: `open_round`, `commit_bid` (sealed hash, approved merchants only, before the commit deadline), `reveal_bid` (must open the commitment, before the reveal deadline), `round_best_quote` (only after the reveal deadline); 30 merchant agents bid through it | swarms | `contract/src/lib.rs`, `core/src/bid.rs`, `cli/src/swarm.rs`, `sdk/merchant.mjs` | **live**: 30 merchant agents bid in two blind rounds on testnet (hoodie and hotel-lisbon), commit before the deadline, reveal after; 8 contract tests |
| NEAR AI Cloud inference for every merchant pitch and the buyer's cited "why", response signatures verified | privacy, swarms | `agents/why.mjs`, `agents/out/live-run.json` | **built**: plain TLS, 33/33 response signatures verified in a recorded live run |
| NEAR AI issues the verdict under E2EE v2: the facts go sealed to the attested model key, the model derives the predicates and echoes a binding of the envelope, and `make verify` checks the TDX quote (dcap-qvl, Intel root, committed PCS collateral), report_data (signing key and our nonce), the TEE signature over the exact wire bytes, the sealed answer (opened with a disclosed one-time key), predicates equal to the code's, and the binding | privacy, security | `scripts/near-ai-verdict.mjs`, `cli/src/near_ai.rs`, `fixtures/live/near-ai/`, `docs/near-ai.md` | **built**: one live capture on synthetic facts (chat `08af1d014f2d4f379dba94094562d9ba`, TCB UpToDate). On chain, `submit_near_ai_verdict` accepts it only with a registered model attestation (same nonce), the TEE signature over the exact response bytes, and a sealed answer that opens with the disclosed key and echoes this envelope's binding; `make verify` runs the contract on it and on 4 refusals. The quote check itself happens before `register_model_attestation`, not in the contract; NVIDIA GPU evidence is not checked |
| OutLayer worker as referee: signed result (<= 900 bytes) checked by the contract with `ed25519_verify`; `settle` requires the receipt | security, privacy | `worker/`, `contract/src/lib.rs` (`submit_referee_result`, `request_referee`, `on_referee_result`), `docs/outlayer.md` | **built**: in `make verify`; not deployed to OutLayer yet (the register step waits on a founder OK). Live `estimate_execution_cost` = 0.0070001 NEAR |
| dispute arbiter: re-checks citations and every signature, signs upheld or overturned; an overturned receipt is cleared and settle is blocked | security | `worker/src/lib.rs` `arbitrate`, `contract/src/lib.rs` `submit_dispute_decision`, `docs/outlayer.md` | **built**: `make verify` check 22; the 2-of-3 arbiter is planned |
| World ID "one person, one agent": the contract checks a verifier's ed25519 attestation and binds one agent per World nullifier; `world_id_human` needs it | security, privacy | `core/src/world.rs`, `contract/src/lib.rs` `attest_human` | **live**: on testnet with a placeholder action and our verifier key; the live World ID service (rep-world-verify) is not wired |
| sealed reviews (Semaphore v4): a settled purchase joins the merchant's group (LeanIMT, Poseidon on chain); during a round a member posts a sealed rating with a Groth16 proof checked on `alt_bn128` host functions, one per member per round (nullifier scoped to merchant and round); after the round members reveal, only if the group has k >= 5; release is batched and sorted by hash; `best_quote` breaks price ties by the score and takes a `min_score` floor | swarms, privacy | `docs/semaphore.md`, `core/src/semaphore.rs`, `contract/src/groth16.rs`, `contract/src/lib.rs`, `cli/src/reviews.rs`, `semaphore/` | **live**: 2 rounds of 6 sealed ratings released on testnet; 13 contract tests on real Semaphore proofs |
| conserved delegation: standing flows from a merchant's released ratings along hire edges to the sub-agents it hires (w = 1/2), following a design rule in REP's unpublished draft "(title withheld) for a World of Agents": the whole chain gets at most w/(1-w) of the seed | swarms, security | `core/src/delegation.rs`, `contract/src/lib.rs` (`hire`, `standing_from`) | **live**: standing flowed from m01's released ratings to m02 and m03 on testnet; property test over random graphs with rings |
| verifiable compute (Jolt zkVM), four guests: standing graph, price stack, referee, cohort k >= 5. The contract keeps the graph root and per-cohort roots; for the graph, the contract keeps a hash-chained root of the standing graph and accepts score updates only from the registered Jolt program, for the current root, signed by a worker that verified the proof off chain | swarms, security | `graph/`, `contract/src/lib.rs` (`submit_graph_scores`), `zk/`, `docs/jolt.md` | **live**: all four guests proved and verified (prove 1.3 to 9 s, verify about 60 ms, proofs 80 to 93 KB); standing proved twice over the live graph and posted on testnet |
| NEP-366 meta-tx relayer for `submit_review` and `reveal_review`: the rater signs with a one-time key, the relayer pays gas (gasless rating) | privacy, realworld | `relayer/` | **live**: the relayer pays every demo purchase and every rating (demo and review policies), delegate actions on testnet |
| FUNCTION CALL KEYS: agent key limited to `settle` (a function-call key cannot attach a deposit, so `submit_verdict` and `withdraw` stay with the full-access key) | security, agents | `scripts/demo-live.mjs` step `fckey` | **live**: a settle-only key on testnet: withdraws under it refused by NEAR (`DepositWithFunctionCall`, `MethodNameMismatch`) |
| x402 v2 paid verdict read (`exact`, USDC on `near:testnet`, verify and settle through an explicit x402 facilitator) | agents, realworld | `x402/verdict-read.mjs` | **stub**: 7 tests on synthetic payments; no facilitator wired, testnet config only |
| MCP tool "REP Read for agents": read-only contract views for any MCP client | agents | `mcp/rep-read.mjs` | **live**: reads `bookerbob.testnet` over public RPC (`BAZAAR_ACCOUNT_ID=bookerbob.testnet node mcp/rep-read.mjs`); 2 tests on a fake RPC |
| UCP payment handler `xyz.r3p.near_usdc`: reads `settle` from NEAR RPC, NEP-297 event, USDC transfer, builds the order fields with `near_tx` | realworld, agents | `ucp/src/near-usdc.mjs` | **live**: 15 tests; reads `settle_demo` txs from testnet and writes paid orders to the Shopify test store |
| merchant SDK for outside agents (schedule, validate, blind bid commitment, quote preview, register args); Agent Market listing plan | swarms, agents | `sdk/`, `docs/agent-market.md` | **built**: cross-checked against the Rust board; used by the outside agent that won `open-1`; not listed (Agent Market is mainnet only) |
| testnet demo mode: dUSDC (a testnet demo token with no value; production uses Circle USDC), its own escrow, `settle_demo`; a tester account funded by a treasury; every purchase call gasless through the NEP-366 relayer's demo policy | realworld, agents | `dusdc/`, `contract/src/lib.rs`, `scripts/demo-tester.mjs`, `relayer/`, `docs/demo-mode.md` | **live**: 6 settles on testnet, `make verify-live` |
| paid orders in the Shopify test store through the Admin API (draft order completed as paid, `near_tx` in the note) | realworld | `ucp/src/near-usdc.mjs` | **live**: orders #1055 to #1060 |
| review k counts distinct World-bound persons, not purchases (`review_persons`) | privacy, security | `contract/src/lib.rs` | **live** |
| `make leak`: what a passive observer links from public testnet data; found 6 of 6 ratings linked by order, fixed, re-run: 1 of 6 (chance) | privacy | `scripts/leak.mjs`, `docs/leak.md` | **live**: run live before and after |
| challengeable Jolt updates: pending with the proof's sha256, a bonded worker key, `challenge_graph_scores` with a bond, an arbiter's signed resolution slashes a false update | security | `contract/src/lib.rs`, `docs/jolt.md` | **live**: one live challenge on testnet (resolved valid); the arbiter is one registered key |
| liability record per settle (sha256 of verdict digest, receipt, merchant, price, token) and a merchant refund bond that refunds the buyer when a receipt is overturned after settle | security, realworld | `contract/src/lib.rs` (`liability`, `merchant_bond`) | **built**: contract tests; merchant bonds live in the open market |
| `min_tcb`: a verdict below the TDX TCB floor (UpToDate by default) is never quoted or paid | security, privacy | `core/src/envelope.rs` `tcb_meets`, `contract/src/lib.rs` | **live**: deployed; every testnet verdict is the synthetic `fixture` status, which passes only on a `.testnet` bazaar |
| open market: an outside merchant is approved by a 10-token bond, no owner step; in open rounds two bids under one operator (same payout or a hire edge) cannot both reveal | swarms, agents, open | `contract/src/lib.rs`, `scripts/join-merchant.mjs`, AGENTS.md | **live**: a fresh agent with only AGENTS.md won round `open-1` |
| `make market-eval`: 1,000 simulated rounds, no disclosure vs BookerBob vs full disclosure | swarms | `scripts/market-eval.mjs`, `docs/market-eval.md` | **built**: (a model, assumptions stated) |
| NEAR INTENTS / 1Click top-up from any chain | realworld, agents | `docs/` | **planned**: mainnet only; not attempted on testnet |
<!-- status:end -->

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

Then `bookerbob near-ai` re-checks the captured NEAR AI verdict (14 checks, `fixtures/live/near-ai/`), including the contract accepting it with its proof and refusing it without.

Mocked or synthetic today: the proof set (synthetic fixtures; the NEAR AI capture uses the same synthetic facts), the
issuer keys (fixed seeds, `cli/src/fixtures.rs`), the chain (MockedBlockchain, no live
RPC), and the USDC transfer (a scheduled receipt, not executed). `make fixtures-check`
proves the committed fixtures are exactly what the generator produces.

## Evidence (measured, `scripts/evidence.sh`)

Full output in `docs/evidence.md`, rerun to refresh. Headline numbers from 2026-11-04:
`make verify` 3.9 s warm; 26 chain checks, 50/50 referee evals, 14/14 NEAR AI verdict
checks, 2 blind rounds through the contract, 15/15 sealed-review checks (a Semaphore
proof costs about 33 Tgas of mocked host gas); NEAR AI live run 33/33 signatures at about
$0.00024 per call; referee worker about 0.25 ms per run (native). A verdict record costs the
agent 1174 bytes (record, cohort counters and cohort roots) plus a 768-byte reserve for its
receipt, settle and liability record (0.0194 NEAR in all);
the contract balance pays nothing per purchase. Gas below is a mocked lower bound (host
functions only); on testnet every tx's real gas is on nearblocks (docs/testnet.md).

| method | who pays | storage added (bytes) | storage cost (NEAR) | host gas, mocked (Tgas, lower bound; settle includes gas attached to its two receipts) |
|---|---|---|---|---|
| `register_issuer` | owner | 224 | 0.00224 | 0.472 |
| `register_world_verifier` | owner | 229 | 0.00229 | 1.562 |
| `attest_human` | agent | 272 | 0.00272 | 1.195 |
| `register_merchant` | merchant | 291 | 0.00291 | 0.951 |
| `approve_merchant` | owner | 0 | 0.00000 | 0.310 |
| `open_round` | owner | 87 | 0.00087 | 0.378 |
| `commit_bid` | merchant | 93 | 0.00093 | 0.811 |
| `reveal_bid` | merchant | 25 | 0.00025 | 0.868 |
| `storage_deposit (escrow entry)` | agent | 84 | 0.00084 | 0.314 |
| `ft_on_transfer (USDC in)` | USDC contract | 0 | 0.00000 | 0.310 |
| `submit_verdict (ed25519, first in context)` | agent | 1174 | 0.01174 | 2.033 |
| `submit_verdict (p256, same context)` | agent | 559 | 0.00559 | 2.776 |
| `submit_referee_result` | agent, from the record reserve prepaid at submit | 245 | 0.00245 | 0.729 |
| `best_quote (view, 1 merchant)` | free (view) | 0 | 0.00000 | 0.231 |
| `settle (+ ft_transfer receipt)` | agent (gas; bytes from the record reserve) | 14 | 0.00014 | 39.836 |

## Threat model and trust

### Trust anchors

Every key the contract trusts is registered by the contract **owner**: verdict issuers
(enclave keys), the referee worker, the dispute arbiter and the World ID verifier. The
owner is one account today. A stolen owner key can register a rogue issuer or referee.
Mitigation path: a DAO owner, and registering only keys an attestation proves (the OutLayer
worker's TDX-registered key, the NEAR AI model key). The DAO owner runs on a separate test
bazaar (`bookerbob-dao-bazaar.testnet`, Sputnik, 2 of 3 council votes; one council key is
refused, docs/testnet.md); the live bazaar's owner is still one key. Attested-key-only
registration is not built.

| layer | what it proves | what it does not |
|---|---|---|
| zkTLS proof | the facts came from the user's real account over TLS | the notary is a single MPC key today, not attested ("notary not attested") |
| NEAR AI TEE | the answer came from the attested model key; the TDX quote verifies to Intel's root and its report_data holds that key and our nonce; under E2EE v2 the signature covers the ciphertext | TEE caveats apply; `tcb_status` is recorded, not hidden; the NVIDIA GPU evidence is not checked in this repo; the contract trusts the owner's registration of the model key (the quote is checked off chain) |
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

### What each party can link

| party | can link | cannot link | fixed by |
|---|---|---|---|
| a merchant | the verdict to the settle of its own sale (same nullifier, same agent account) | the buyer's other purchases in other contexts (per-context nullifier), the raw history | |
| anyone reading the chain | today, every call one agent account makes (verdict, settle, review-group join); two purchases by the same agent account | which group member wrote a rating (Semaphore); the rating's sender to the buyer (one-time implicit account) | one-time cnf key and account per purchase (planned, panel action 6) |
| the relayer | every sender it pays for, and each rating at reveal time | the buyer behind a one-time review account, unless it also relayed that buyer's purchase | run your own relayer; it is not trusted by the contract |
| REP (nullifier issuer) | today, accounts across contexts (the nullifier is an HMAC under a REP key) | | VOPRF nullifiers (chosen, not built) |
| the NEAR AI enclave | the facts it was sealed (by design) | | |

### Attacks and what stops them

| attack | stopped by | where |
|---|---|---|
| a merchant spawns sub-agents to multiply its standing | conserved transport w = 1/2 along hire edges: the whole chain, rings included, gets at most one seed's worth; unseeded accounts get nothing | `core::delegation`, `standing_from`; `make verify` R10 |
| a merchant farms its own reviews | a rating needs membership, membership needs a settled, paid purchase; one membership per purchase; one rating per member per round | `join_review_group`, `submit_review`; `make verify` R4, R5 |
| linking a rating to the buyer who paid | Semaphore hides which member rated; sealed hash during the round, reveal after it, release sorted by hash; no reveal below k = 5; separate scopes from the verdict nullifier | `docs/semaphore.md`; the anonymity set is the group (5 at worst), and the submitting account must not be the buyer's agent |
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
- Jolt here is succinct, not zero-knowledge (built without its optional `zk` feature), and
  upstream calls it alpha and unaudited; only public or committed inputs are proved
  (docs/jolt.md).
- A valid TDX quote here binds a measured image, but only the one we observed: MRTD, RTMR0-3
  and the compose hash are checked and pinned to our capture, not yet to NEAR AI's published
  build; the GPU is not attested; and `tcb_status` on chain is what the owner registered after
  the off-chain check (docs/near-ai.md).
- TEE side channels: the NEAR AI verdict path trusts Intel TDX. A side-channel break leaks
  the facts sealed to the enclave; it does not let anyone forge a contract-side check
  (signatures, nullifiers, Semaphore, the k floor).
- The zkTLS notary is a single MPC key today, not attested. A compromised notary could sign
  false facts. A verdict is only as good as the notary behind it.
- REP can link a user's accounts across contexts while the nullifier is an HMAC under a REP
  key (Known limits). VOPRF removes that; it is not built.
- When a TEE output and a Jolt output disagree: today they cover different things (NEAR AI
  derives the verdict predicates; Jolt proves the standing, price, referee and cohort code),
  so they cannot disagree on one value. Where both will exist (planned predicate guest),
  the rule is that the contract refuses on mismatch rather than picking one.
- Jolt updates are challengeable, but the arbiter is one registered key today: a standing
  update waits out a window with sha256 of its proof, anyone can challenge it with a bond,
  and a false one slashes the worker's bond; the resolution is signed by our arbiter key after
  it reruns the verifier. An arbiter set, or verifying the proof on chain, would remove that
  trust; neither is built.
- The verdict TCB floor is enforced (`min_tcb`, UpToDate by default): a verdict below it is
  never quoted or paid. Synthetic `fixture` verdicts pass only on a `.testnet` bazaar.

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
- Sealed reviews: group membership is public (a commitment joins right after a settle),
  the anonymity set is the group size (5 at worst), the sender of `submit_review` and
  `reveal_review` is public (use a fresh account or a relayer), and a member who skips
  the reveal drops out silently. The trusted setup is Semaphore's V4 ceremony.
- The referee's text checks are a word-level tripwire (status words, platform names,
  numbers, plain ascii), not language understanding. A discount never depends on the text:
  only on asserted values that equal the proof.
- `make verify` runs the contract code natively against near-sdk's MockedBlockchain, not
  on a live chain. The testnet deployment and its tx hashes are below.

## Deployments

**Testnet, 2026-11-04.** The `bazaar` contract is live at
[`bookerbob.testnet`](https://testnet.nearblocks.io/address/bookerbob.testnet) (wasm 600 KB,
sha256 in the build output), with 30 merchant sub-accounts registered and approved, the
trust-anchor keys registered and USDC storage paid. 156 transactions so far, every hash in
[docs/testnet.md](docs/testnet.md). Key ones:

| what | tx |
|---|---|
| account (faucet) | [373gAmQ3…](https://testnet.nearblocks.io/txns/373gAmQ3hLM8snr1xQeY11YVL5Q5Nbaw1CDu7dwgYnbZ) |
| deploy and `new` | [2Dc63333…](https://testnet.nearblocks.io/txns/2Dc63333QfYaP7zdnzoUnWBrz9B8M1trBN8LkSnYu1cy) |
| `register_issuer` | [95mbs6KG…](https://testnet.nearblocks.io/txns/95mbs6KGPHfNYU4RHa5ZQ6jgGq6vNZw7qhXTmA3yyUoG) |
| archived: the first Chain Signatures `sign`, domain 1 (Ed25519), path `stellar-1`, from the Stellar leg cut on 2026-11-04 (branch `stellar-archive`): the 64-byte signature verifies over the payload with the derived key `ed25519:Hni3RKAy…` (`fixtures/live/mpc-sign.txt`) | [2yHrL9YW…](https://testnet.nearblocks.io/txns/2yHrL9YWdF5ev7ArUaPM7HG8dJCxWECVLEiWcnhM7SVe) |
| redeploy (600 KB wasm; it carried the EVM payout leg, cut since) | [2L63k3jZ…](https://testnet.nearblocks.io/txns/2L63k3jZYSXT3AUhukjQyxsbkhqefs7f12Njspte3JfF) |
| Jolt standing program registered (`set_graph_program c780ceab…`) | [BRH8KVo1…](https://testnet.nearblocks.io/txns/BRH8KVo1hURxDDaHCN8ttZpngnv2ek4vnJVGuygS8HaR) |
| worker-signed standing update for the live hire graph (root `782a6b09…`, proved in 1.74 s), accepted; empty score list until a paid purchase seeds the graph | [4nHqu5TW…](https://testnet.nearblocks.io/txns/4nHqu5TWinE2sXpeVkStL3N4mHJSQGm2r7Tgt2dXbGZp) |

Where testnet stands, as of 2026-11-04:

- Done on testnet: deploy, 30 approved merchants, trust anchors, the agent's settle-only
  function-call key, its World ID binding (placeholder action), the verdict
  ([86XFzy3P…](https://testnet.nearblocks.io/txns/86XFzy3PcJLxqkiVLQAeZSAY7F31BZVzd84yrF4eunXw))
  and the referee receipt
  ([HqhUXgjq…](https://testnet.nearblocks.io/txns/HqhUXgjq9HcLqVLTZTFoa4BmX1sWvs67ueco8vF269J2),
  38.40 USDC: one buyer on testnet, so no group price), three hire edges and a standing update for them (a Jolt proof, signed by a worker).
- Done in demo mode (dUSDC): 6 settles, 6 replays refused, a settle-only function-call key
  that cannot withdraw, 6 sealed reviews released at k >= 5, the group price at k >= 5, a
  standing update with nonzero merchants, 6 orders in the Shopify test store.
- Not on testnet yet: the OutLayer referee, the NEP-366 relayer sending.
- Demo mode: [docs/demo-mode.md](docs/demo-mode.md), `make demo-tester`.
- Mainnet only on an explicit go.

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
