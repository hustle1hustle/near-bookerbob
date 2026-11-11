# BookerBob in depth

The sections the README points to: how a purchase works step by step, the NEAR features used,
the repository layout, what `make verify` checks, measured evidence, and the full threat model
(trust anchors, who sees and links what, attacks, what is not defended). The README keeps the
first screen, the status table, the trust tables and the known limits.

## Problem

Agents can already check out (UCP) and pay (USDC). No rail proves that the customer behind
the agent is real and valuable without handing over their data, so merchants keep paying
ads to find customers. BookerBob turns that ad budget into a discount paid to a proven
customer, and keeps the customer private.

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

The feature table is in the README ("Every feature, its status and its evidence"); the full rows are in `docs/status.md`; both are generated from `docs/status.json`.

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
| `mcp/` | MCP server wrapping the contract views (`nullifier_status`, `verdict`, `quote`, `best_quote`, `merchants`) and `buy` (the sdk/buy.mjs flow) |
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

Then `bookerbob near-ai` re-checks the captured NEAR AI verdict (17 checks, `fixtures/live/near-ai/`), including the contract accepting it with its proof and refusing it without.

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
| `reveal_bid` | merchant | 204 | 0.00204 | 1.004 |
| `storage_deposit (escrow entry)` | agent | 84 | 0.00084 | 0.314 |
| `ft_on_transfer (USDC in)` | USDC contract | 0 | 0.00000 | 0.310 |
| `submit_verdict (ed25519, first in context)` | agent | 1174 | 0.01174 | 2.033 |
| `submit_verdict (p256, same context)` | agent | 559 | 0.00559 | 2.776 |
| `submit_referee_result` | agent, from the record reserve prepaid at submit | 245 | 0.00245 | 0.729 |
| `best_quote (view, 1 merchant)` | free (view) | 0 | 0.00000 | 0.231 |
| `settle (+ ft_transfer receipt)` | agent (gas; bytes from the record reserve) | 14 | 0.00014 | 39.836 |

### Trust anchors

Every key the contract trusts is registered by the contract **owner**: verdict issuers
(enclave keys), the referee worker, the dispute arbiter and the World ID verifier. The
owner is one account today. A stolen owner key can register a rogue issuer or referee.
Mitigation path: a DAO owner, and registering only keys an attestation proves (the OutLayer
worker's TDX-registered key, the NEAR AI model key). The DAO owner runs on a separate test
bazaar (`bookerbob-dao-bazaar.testnet`, Sputnik, 2 of 3 council votes; one council key is
refused, docs/testnet.md); the live bazaar's owner is still one key. Attested-key-only
registration is not built.

Every trust-anchor change can wait out a public delay (`set_anchor_delay`): issuers, model
keys (`register_model_attestation`), the referee, arbiters, the World verifier, the arbiter
threshold, the fee, the Jolt program (`set_graph_program`) and a lower TCB floor are queued,
visible as `anchor_queued`, executable by anyone after the delay and cancellable by the owner
inside it. Raising the TCB floor and removing an issuer apply at once, because they only narrow
trust and are the response to a compromised key. The delay is 5 minutes on the DAO test bazaar
and, since 2026-11-10, 5 minutes on the live bazaar too ([4ztY6viK…](https://testnet.nearblocks.io/txns/4ztY6viKRwRyPmhsc5tDCp2ZjCvqW1fjiZUuQX3Bx6Zt)). It
covers anchors, not the code: the full-access key of `bookerbob.testnet` can still redeploy.

| who holds | what it can do today |
|---|---|
| the full-access key on `bookerbob.testnet` (one key, `ed25519:BDvqs4A7…`, held by REP) | redeploy the contract code at any time, which bypasses every rule above, including the timelock. The contract cannot defend against its own account's full-access key. Fix: hand the account to the DAO and delete the key, so an upgrade is a DAO proposal (planned; it is irreversible, so it waits on the founder) |
| the owner role on `bookerbob.testnet` (the same account) | register trust anchors, each after the 5 minute public delay |
| the DAO test bazaar's account | its full-access key is also REP's; the DAO holds the owner role, not the code |

| layer | what it proves | what it does not |
|---|---|---|
| zkTLS proof | the facts came from the user's real account over TLS | the notary is a single MPC key today, not attested ("notary not attested") |
| NEAR AI TEE | the answer came from the attested model key; the TDX quote verifies to Intel's root and its report_data holds that key and our nonce; under E2EE v2 the signature covers the ciphertext | TEE caveats apply; `tcb_status` is recorded, not hidden; the NVIDIA GPU evidence is checked offline from NVIDIA's signed NRAS reply (8 GPUs, bound to the request nonce, the signing key chained to NVIDIA's pinned root, `scripts/nras.mjs`); the contract trusts the owner's registration of the model key (the TDX quote is now verified on chain, in five calls of 40 to 132 Tgas, by `spike.bookerbob.testnet`, and `register_model_attestation_verified` requires a finalized verification: `tools/dcap-spike/README.md`; the verifier account keeps REP's key) |
| on-chain TDX quote check (`spike.bookerbob.testnet`, a dcap-qvl fork) | the NEAR AI quote chains to Intel's root CA, its TCB Info, QE Identity and PCK chain are Intel-signed and current at the block's time (not the caller's), the quote's signature holds, and report_data is the model key and nonce; five calls of 40, 100, 99, 132 and 69 Tgas; one changed byte in the signed report fails at the last step | the collateral is fetched off chain from Intel's PCS by whoever starts a verification (its signatures are checked on chain); until the lock, the verifier account keeps REP's full-access key, so its code could be replaced; the GPU evidence is checked off chain (NRAS, `scripts/nras.mjs`) |
| verdict issuer | the envelope was signed by a registered key (`ed25519_verify` / `p256_verify`) | that the issuer is honest beyond its key |
| referee (OutLayer worker) | every cited fact is in the proof set, its asserted field and value match, and it proves its line; the price is the code quote | OutLayer is unaudited; a compromised referee key can sign a false receipt (the dispute path exists for that) |
| dispute arbiter | an independent re-run of every check, signed | only as independent as its operator; today it is a fixture seed like the referee |
| World ID verifier | one World ID holder bound one agent | there is no World ID verifier on NEAR; the contract trusts the service key |
| contract | nullifier used once, price from code, cap, receipt required, payout atomic with the burn | it never sees raw facts, by design |

### Who sees what

| party | sees | never sees |
|---|---|---|
| merchants and the board | revealed predicate names, their own quote, the verdict commitment, the cohort size k | raw history, identity, unrevealed predicates, fact values |
| anyone reading the chain | per verdict: nullifier, commitment, revealed predicates, tcb_status, cap; settled amount, merchant, checkout_ref. A sealed verdict shows only the nullifier, the commitments and tcb_status until settle; its amount still narrows which discounts applied | the proof set, the buyer's other contexts (the nullifier is per context) |
| the referee and arbiter | the proof set they judge (synthetic in fixtures) | nothing more; on-chain `input_data` is public, so `request_referee` accepts only input sealed to the worker key (X25519, XChaCha20-Poly1305, `worker/src/sealed.rs`) |
| NEAR AI enclave | the facts, sealed to its key | |
| REP | the older HMAC nullifier key, so it can link accounts on those purchases; on a VOPRF purchase, who asked and when (below) | |

### What each party can link

| party | can link | cannot link | fixed by |
|---|---|---|---|
| a merchant | the verdict to the settle of its own sale (same nullifier, same agent account) | the buyer's other purchases in other contexts (per-context nullifier), the raw history | |
| anyone reading the chain | today, every call one agent account makes (verdict, settle, review-group join); two purchases by the same agent account | which group member wrote a rating (Semaphore); the rating's sender to the buyer (one-time implicit account) | one-time cnf key and account per purchase (planned, panel action 6) |
| the relayer | every sender it pays for, and each rating at reveal time | the buyer behind a one-time review account, unless it also relayed that buyer's purchase | run your own relayer; it is not trusted by the contract |
| REP (VOPRF evaluator) | who asked for an evaluation in which context, and when; for purchases before 2026-11-05, accounts across contexts (an HMAC under a REP key) | which on-chain nullifier an evaluation became (it sees a blinded element only); a person's nullifier in a context it never evaluated (it does not know `x`) | the key in a TDX enclave with 2-of-3 backups, then a committee (decided, not built) |
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
  that merchant and settle up to `max_spend`. Keep caps small; a settle-only function-call
  key (live, `scripts/fc-key-check.mjs`) narrows the blast radius but does not remove this.
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
  build; the GPU is attested off chain only (NVIDIA NRAS, `scripts/nras.mjs`); and `tcb_status`
  on chain comes from the on-chain quote check, while the measurement pin stays off chain
  (docs/near-ai.md).
- TEE side channels: the NEAR AI verdict path trusts Intel TDX. A side-channel break leaks
  the facts sealed to the enclave; it does not let anyone forge a contract-side check
  (signatures, nullifiers, Semaphore, the k floor).
- The zkTLS notary is a single MPC key today, not attested. A compromised notary could sign
  false facts. A verdict is only as good as the notary behind it.
- The VOPRF nullifier (since 2026-11-05) removes REP's ability to recompute a person's nullifier
  in any context or to tie an evaluation to the nullifier it became. It does not remove timing (a
  lone request just before a purchase), REP's view of who asked, or REP's single evaluator key.
- When a TEE output and a Jolt output disagree: today they cover different things (NEAR AI
  derives the verdict predicates; Jolt proves the standing, price, referee and cohort code),
  so they cannot disagree on one value. Where both will exist (planned predicate guest),
  the rule is that the contract refuses on mismatch rather than picking one.
- Jolt results reach the chain through a bonded worker signature, not an on-chain verifier.
  Verifying a Jolt proof on chain was not attempted: a proof here is about 85 KB and its
  verifier is far heavier than the curve checks NEAR exposes as host functions, so it is not
  expected to fit one call's 300 Tgas (not measured). The contract stores sha256 of the proof
  and the worker's signed scores.
  A standing update waits out a window, anyone can challenge it with a bond, and a false one
  slashes the worker's bond; the arbiters rerun the verifier off chain and sign the
  resolution. A threshold of distinct arbiter signatures is built and tested (2 of 3 in the
  tests); the live bazaar runs at threshold 1.
- Who holds the arbiter keys: REP. The one live arbiter key and all three test keys are ours;
  no outside operator holds one yet. A dishonest REP arbiter could uphold a false update or
  overturn an honest receipt; the threshold only helps once the keys sit with different
  operators.
- Jolt is built without its `zk` feature (docs/jolt.md has the per-guest table of what is
  private): the proofs are succinct, and anything the guest reads is assumed public or
  committed elsewhere.
- The verdict TCB floor is enforced (`min_tcb`, UpToDate by default): a verdict below it is
  never quoted or paid. Synthetic `fixture` verdicts pass only on a `.testnet` bazaar.

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

## What is live and what is offline, in detail


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


## Deployments, the first days (2026-11-04)

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

Where testnet stands, as of 2026-11-10:

- Done on testnet: deploy, 30 approved merchants, trust anchors, the agent's settle-only
  function-call key, its World ID binding (placeholder action), the verdict
  ([86XFzy3P…](https://testnet.nearblocks.io/txns/86XFzy3PcJLxqkiVLQAeZSAY7F31BZVzd84yrF4eunXw))
  and the referee receipt
  ([HqhUXgjq…](https://testnet.nearblocks.io/txns/HqhUXgjq9HcLqVLTZTFoa4BmX1sWvs67ueco8vF269J2),
  38.40 USDC: one buyer on testnet, so no group price), three hire edges and a standing update for them (a Jolt proof, signed by a worker).
- Done in demo mode (dUSDC): 31 purchases (21 single settles: one with the 1% fee, two with a
  sealed verdict, four with a verdict a NEAR AI model issued (two refused by an eval gate, one passing it under the v4 point-bucket rule, one countersigned by the verdict evaluator), one under an owner's mandate, one with a returning-buyer discount at 34.20, one with a VOPRF nullifier, one hotel stay at 408, one `make prove-me` pipeline test at 28, one `make try` pipeline test at 28 from a one-time implicit account; 5 in a buying group at the 10% tier; 5 through a buying group's own DAO treasury), 21 replays refused, a settle-only function-call key
  that cannot withdraw, 18 sealed reviews released over 3 rounds at k >= 5 (12 for m01, 6 for h05), the group price at k >= 5, a
  standing update with nonzero merchants, 21 orders in the Shopify test store.
- Not on testnet yet: the OutLayer referee (its registration waits on the founder). The NEP-366
  relayer sends on testnet: it paid every demo purchase call and every sealed rating.
- Demo mode: [docs/demo-mode.md](docs/demo-mode.md), `make demo-tester`.
- Mainnet only on an explicit go.

