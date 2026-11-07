# BookerBob

merchants compete for you. none of them learns who you are, until a delivery needs a name.

**The market in three lines.** On NEAR, testnet only so far:

1. A buyer's agent reveals a few proven bits (like `airbnb_frequent`) in a signed verdict.
2. Merchant agents bid blind, and code computes the price from those bits.
3. A contract burns a nullifier and pays the winner against a referee receipt.

**Check it in 3 commands** (Node 22; the first two need no keys and no build):

| command | what you see |
|---|---|
| `make judge` | about 3 s offline, about a minute online (longer when public RPC rate-limits); ends `PASS  make judge` |
| `make verify-live` | every testnet claim re-derived over public RPC, ends `PASS  verify-live` |
| `make verify` | the contract on near-sdk's mocked chain (Rust), ends `ALL PASS (26 checks)`; with no network, `make verify-offline` (the same checks from the vendored crates) |

**Fresh clone, timed** (2026-11-05, a clean clone, an empty `CARGO_HOME`, macOS arm64):
`make judge` 2.1 s offline (about 1 s more since it runs `make market-eval`),
about a minute online (longer when public RPC rate-limits); `make verify-offline` 77 s with no network; `make verify` 114 s with the network
(crates fetched); `make verify-live` 17 s; `make test` 36 s; `make zk-verify-prebuilt` 1.3 s.
All pass. Logs: `fixtures/live/offline-run/`.

**3 live testnet transactions** (dUSDC, a testnet demo token with no value):

- a hotel buying group of 5 on one fixed tier: its own DAO treasury paid h05 367.20 for each
  member, an amount 5 buyers share: [5A8LgNQn…](https://testnet.nearblocks.io/txns/5A8LgNQnNGrErkWAo48Kd8xRARK9Zqb8jEZUnbcBSV7A)
- a sealed verdict (hashes only on chain) settled at 38.40, an amount 5 buyers share, though the price itself decodes to its three bits (`make leak`, L10): [2UVVTmja…](https://testnet.nearblocks.io/txns/2UVVTmjaHGMGazQAvtry4FBxUMUyoPYy2TJCxKVAe4pS)
- a buying group of 5 at the 10% tier on m01, 32.40 each (`make leak` gates every amount and funding set at k >= 5)

**What is synthetic.** Every fact behind every verdict, with two exceptions of one kind: a
`make prove-me` and a `make try` pipeline test each notarized a public GitHub profile (a real
fact about a public account, not proof that the buyer holds it; docs/prove-me.md). The phone run is parked (docs/device-run.md). Also synthetic: the rest of every proof set, the World ID action (a placeholder, our verifier key) and
the money (dUSDC on testnet; nothing is on mainnet). Every trust key is REP's today: the
issuer, the referee, the one live arbiter (and the three test arbiters) and the nullifier key
(see "Who can lie" below).

**A certified result over private data, settled on a shared ledger.** Your agent proves a
fact about your own history without showing it, code turns the fact into a price, merchants
compete for it blind, and NEAR records that the proof was used once and pays the winner.
Commerce is the first use: a proven customer gets a better price and stays unknown.

TEE for privacy from the chain and the merchants, SNARK for correctness, chain for uniqueness
and settlement. Not privacy from REP: REP's verdict issuer reads the facts it signs over, and on
the model path REP's verdict evaluator reads them in the clear to build the request.

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

## Why a chain, not a server

A server run by us could compute the same prices. It could not give these three properties
to parties that do not trust us or each other:

- **One spent-set shared by distrusting merchants.** A nullifier spent at m01 cannot be spent
  again at m02. Merchants who do not trust each other can only check "this nullifier is spent"
  without trusting one operator on a shared ledger (`submit_verdict`, `settle`). Today REP runs
  all 30 listed merchant agents and one outside agent has joined, so this is the design, not
  yet a market of strangers. The set stops reuse of a nullifier, not a second one: on the VOPRF
  path the buyer picks the input, so one person can obtain two.
- **Atomic settle gated on a receipt.** Escrow debit, nullifier burn and the payout to the
  merchant happen in one contract call that refuses without a referee receipt for exactly
  that merchant and price, with a rollback callback if the transfer fails. Nobody can pay a
  merchant without a receipt or reuse one. REP holds the referee key, so REP can sign one, at
  schedule prices only.
- **Proof checks anyone can rerun.** Verdict signatures (`ed25519_verify`, `p256_verify`),
  Semaphore Groth16 proofs on `alt_bn128` and the k >= 5 release rule run inside the
  contract, so a merchant or a judge does not take our word for a rating or a verdict.

| | our own server | a consortium log run by the merchants | NEAR (this repo) |
|---|---|---|---|
| one spent-set all merchants trust | they trust us | they trust the consortium's operators | the contract; anyone can read it |
| pay only on a receipt, atomically with the burn | our code, unauditable from outside | per operator | one public contract call, with rollback |
| rerun the proof checks (signatures, Semaphore, k floor) | on our word | per operator | inside the contract |
| who can rewrite history or censor | us | a majority of operators | nobody can rewrite; a relayer can refuse, anyone can run another |
| what it costs in privacy | only we see the amount and the merchant | the operators see them | everyone sees them, forever: amount, merchant, time and account (`make leak`, L6, L7, L10) |
| trust still left | everything | the operators | the owner key: it registers trust anchors (verdict issuers, referee, arbiter, World verifier), approves merchants outside the open category and sets `min_tcb`. One key on the live bazaar; a 2-of-3 Sputnik DAO with a timelock on the test bazaar |

## What is live and what is offline

Exact as of 2026-11-05. The contract is deployed on NEAR testnet (`bookerbob.testnet`, every
tx hash in [docs/testnet.md](docs/testnet.md)); nothing is on mainnet. On testnet, 28 purchases
settled in dUSDC (a testnet demo token with no value; production uses Circle USDC), 18 sealed
reviews were released over 3 rounds and a standing update from a Jolt proof was accepted; `make verify-live`
re-derives all of it over public RPC. "Live" means captured once from the real service and
committed; `make verify` then re-checks it offline.

The two tables of what is captured live and what runs offline: [docs/depth.md](docs/depth.md).

Every feature with its status and evidence: [the table below](#every-feature-its-status-and-its-evidence).

## Try it

- `make judge`: about 3 s offline, about a minute online (longer when public RPC rate-limits).
  Node 22, no keys, no build. It checks every testnet claim over public RPC, or from
  the committed RPC snapshot with no network (`JUDGE_OFFLINE=1` forces it), the committed Jolt
  proofs' outputs and program hashes, the REP Eval and NVIDIA checks, and the JS suites.
- `make verify` (Rust 1.93+): the contract on near-sdk's mocked chain, one `PASS` line per link,
  ending `ALL PASS (26 checks)`; `make demo-offline` tells the same story on one screen. With no
  network, `make verify-offline` builds from the vendored crates (`vendor/`, pinned with
  `Cargo.lock` in `vendor/SHA256`).
- `make zk-verify-prebuilt`: the Jolt proofs with the committed verifier (macOS arm64 and
  Linux x86_64, the latter built and checked in CI; both hashes in `zk/bin/SHA256` checked first).
- `make try TOKEN=<file>`: you are the buyer. Your own GitHub token proves the fact behind one
  testnet purchase from a one-time implicit account (docs/prove-me.md; needs the testnet keys).
- `make test`: every unit test, named by behaviour (`replayed_nullifier_is_rejected`, ...).

Timings, logs and the fresh-clone run: the first screen above and `fixtures/live/offline-run/`.
The judge guide walks it in five minutes: [docs/judge-guide.md](docs/judge-guide.md). All
fixtures are synthetic; no real user data is in this repository.

## Threat model and trust

The full threat model (trust anchors, who sees and links what, every attack and what stops it,
what is not defended) is in [docs/depth.md](docs/depth.md); the tables below are the summary.

### Post-quantum: what holds and what does not

A future quantum computer breaks discrete logs and elliptic curves (Shor), and halves the
strength of hashes (Grover). Stated per piece:

| piece | against a quantum attacker | why |
|---|---|---|
| sealed referee input (v1, the default) | **holds** | X25519 and ML-KEM-768 (FIPS 203) together (X-Wing style, `worker/src/sealed.rs`): recording ciphertext now and decrypting later needs both broken. v0 inputs already on chain are classical (the testnet ones carry synthetic facts) |
| sha256 commitments with a 256-bit salt (verdict commitment, disclosure, bids, budgets, reviews, eval items, claims and receipt hashes) | **hiding holds** | Grover leaves about 128-bit security; every small-domain hash now has a salt (docs/audit.md, "Low-entropy preimages") |
| Pedersen commitments | not used in this repo | REP's graph uses BN254 Pedersen commitments; there hiding holds (information-theoretic) and binding does not (discrete log). Semaphore's identity commitments here are Poseidon hashes: hiding holds |
| Jolt proofs (Dory over BN254 today) | **integrity does not** | a quantum attacker could forge a new proof of a false standing update; it learns no input (the inputs are public anyway). Proofs already verified on chain stay as they were checked |
| Semaphore (Groth16, BN254) | **integrity does not** | membership proofs could be forged; which member wrote a rating stays hidden (the proof is zero-knowledge) |
| signatures: ed25519 and p256 (issuers, referee, arbiters, World verifier, eval issuer), NEAR account keys, the TDX quote's ECDSA, the notary's secp256k1 | **do not hold** | all classical; a forger could sign verdicts, receipts or presentations. NEAR has no post-quantum account keys today |
| the older nullifier (HMAC-SHA256 under REP's key), the committed standing list (sha256 Merkle) | **holds** | hash-based |
| the VOPRF nullifier (RFC 9497, ristretto255) | **hiding holds, one-per-account does not** | the blinded input is information-theoretically hidden and carries 32 random bytes, so nullifiers stay unlinkable; a discrete-log break yields the evaluator key, and its holder could mint extra nullifiers and forge DLEQ proofs |
| zkTLS sessions and NEAR AI E2EE v2 | **do not hold** unless the server negotiates a hybrid key exchange | classical key exchange, outside this repo |

So: what is hidden stays hidden (sealed inputs, salted commitments), and what
is signed or proven could be forged. Moving the signatures and Jolt to post-quantum schemes is
not done.

### Who can lie, what catches it, who holds the key

Rows in bold are keys REP holds today. All of them are. `make rep-is-evil` lists each one's worst
case, reads live from testnet that the key is trusted today, and names the offline check that shows the power.

| who can lie | the lie | what catches it | who holds the key | if REP turns malicious |
|---|---|---|---|---|
| **the verdict issuer** | predicates the facts do not prove | nothing, against a dishonest issuer: the referee checks claims only against a proof set the same side wrote; on the NEAR AI path the TDX quote and TEE signature bind the answer to the attested model, not to the truth of what it was told | **REP** (the testnet issuer seed; the NEAR AI model key is attested, its registration is REP's) | mints verdicts with any predicates for agents it controls (sybil buyers who take discounts), and with the World key binds each one as a separate human; not to a merchant with an eval gate, which takes only a model-issued verdict (`make model-buy`: one live) |
| **the referee and the Jolt worker** | a false receipt or a false standing update | the contract accepts only a price its own schedule code produces; an arbiter re-runs the receipt check; a standing update can be challenged with a bond and a false one slashes the worker | **REP** (seeds; the OutLayer attested key is not registered yet) | signs receipts for unproven claims, or a false standing list; capped at schedule prices, and a standing update can be challenged (by REP's arbiter today) |
| **the dispute arbiter** | uphold a false update or overturn an honest receipt | nothing on chain beyond its signature; a threshold of distinct arbiters is built (2 of 3 in tests) | **REP**: the one live arbiter key (threshold 1) and all three test keys | with the referee, a false receipt stands and a false update is upheld; nothing outside REP checks it today |
| **a broken TEE** (the NEAR AI enclave: Intel TDX, NVIDIA GPU) | reads the facts sealed to it; signs predicates the facts do not prove; signs eval answers | what still holds: the referee re-checks every claim against the proof set, the contract pays only a price its own schedule code produces, the Jolt proofs (price, referee, standing, cohort) and the VOPRF nullifier do not depend on the TEE; what does not: the sealed facts leak, and model-issued verdicts and eval scores can be forged | Intel and NVIDIA (the attestation roots) and NEAR AI (the operator) | (not REP; REP cannot break it, and it cannot tell from chain that it was broken) |
| **the buyer, on the model path** | facts it made up: a signed answer about a typed fact (`make forge-poc`, one live) | the contract refuses a model verdict without the verdict evaluator's signature on that request and envelope, so a buyer's own chat has no way in (contract tests) | the buyer | (not REP). Bound as well: schedule prices, one spend per nullifier |
| **the verdict evaluator** | signs a request about any facts: the same forgery, from REP | nothing on chain: the key is an anchor behind the public delay, and that is all | REP (one key, `evaluator.seed`) | it reads the facts in the clear and builds the prompt; a worker in a TEE would move this, not built |
| **the zkTLS notary** | a transcript it never saw | nothing at settle: no contract path reads a notary signature; `make try` and `make prove-me` check it off chain, on the buyer's own machine | **REP** (one pinned key on Fly, not TEE-attested) | signs any transcript; nothing on chain notices |
| a merchant after payment | takes the money and ships nothing | nothing on chain: settle pays on the receipt, delivery is not checked; a refund bond covers an overturned receipt, not a missing parcel. The orders so far are test-store orders | the merchant | (not REP) |
| **one operator** | the market looks like many parties | the labels on the board (`REP-run`); nothing else: the relayer, treasury, issuer, referee, arbiter, evaluator and all 30 listed merchants are REP | **REP** | can bid against itself and see every funded account; competition on testnet is simulated, one outside agent aside |
| a merchant agent | a pitch or a claim the buyer never proved | code computes the price, the referee refuses unproven claims, an open-category merchant posts a bond | the merchant | (not REP) |
| **the owner and the full-access key** | change the rules or redeploy the code | anchor changes can wait out a public delay (0 on the live bazaar); a DAO owns a test bazaar; nothing stops a redeploy by the full-access key | **REP** (one key on `bookerbob.testnet`) | on `bookerbob.testnet`: redeploys any code, so every rule above; on `market` after the lock: only DAO-voted, publicly delayed changes |
| **the VOPRF evaluator** | link one person's purchases across contexts | the nullifier is a VOPRF output of a fresh input the buyer blinded; the buyer checks the proof under the bazaar's anchored `voprf_key`, so no per-buyer key | **REP** (one key, `KEYS_DIR/voprf.seed`; enclave and committee decided, not built) | cannot recompute a nullifier or tie one to the request it came from; can refuse to evaluate, evaluate twice for one person (a sybil, like the issuer key), and see who asked when (timing); purchases before the VOPRF stay linkable |

### Who sees plaintext, and how many share it

Set size: how many testnet buyers share the value, so how far it narrows a buyer down
(`agents/live.json`, `docs/leak.md`).

| field | who sees it in plaintext | set size on testnet today |
|---|---|---|
| the facts (proof set) | the NEAR AI enclave and the referee (sealed to their keys); REP as verdict issuer, which reads the facts it signs over, and REP's verdict evaluator on the model path, which reads them in the clear; never the chain. The NEAR AI gateway sees the API key, size and time of each request, not the facts | not public |
| revealed predicates | everyone, for an ordinary verdict; nobody on chain for a sealed one (the referee reads its opening) | the cohort: 29 verdicts on chain reveal `world_id_human` in the demo context (`cohort_size`) |
| the bits behind a price | everyone: the schedule and the amount are public, so 38.40 at m01 can only be all three bits, a sealed verdict included (`make leak`, L10) | 1 of 8 bit sets on m01; the buyers sharing the amount are the only cover |
| settled amount | everyone | 36.00 x10, 38.40 x5, 32.40 x5, 367.20 x5, 28.00 x2, 408 x1: `make leak` fails any new purchase in a set under 5 (L6); the 408 stay and the two 28 pipeline tests came before that gate and are listed |
| merchant and checkout_ref | everyone | m01: 19 buyers, h05: 6, builders: 2, vetted: 1 |
| the agent account | everyone | 1: one account per purchase links its verdict, settle and review join (L1); since 2026-11-06 it is a one-time implicit account, its name says nothing (L8), and the treasury still funds it (L7) |
| a rating | everyone, after release, sorted by hash; before that, the relayer that carries the reveal | the review group, at least 5 (Semaphore, k floor) |
| the person behind the nullifier | REP: by the HMAC key for the older purchases; for a VOPRF purchase (one so far) not by the key, but it sees who asked, in which context and when, so timing can link | 1 |

## In depth

[docs/depth.md](docs/depth.md): the problem, the board, how one purchase works, the NEAR features
used, the repository layout, what `make verify` checks and what is mocked, measured evidence, and
the full threat model.

## What the founder designed

The code here is written with Claude Code sessions (PRIOR_WORK.md, "AI assistance"). The product
and its core architecture are the founder's: agents buy on a verified verdict about a person,
never on their data; price tiers come from verified context; cohorts stay above a k floor; account
nullifiers per context; the verdict path and the DAO-owned market. His calls also include:

- Testnet only, with dUSDC, a demo token; mainnet (Circle USDC, 1Click, Agent Market) only on
  his word, and nothing on mainnet yet ([7889d94](https://github.com/hustle1hustle/near-bookerbob/commit/7889d94), [8f0efd7](https://github.com/hustle1hustle/near-bookerbob/commit/8f0efd7)).
- The account nullifier is an RFC 9497 VOPRF (chosen 2026-09-24, built 2026-11-05); older purchases used an HMAC and stay recomputable ([f68a427](https://github.com/hustle1hustle/near-bookerbob/commit/f68a427)).
- The market bazaar is owned by a 2-of-3 DAO from block one, its anchors behind a public delay
  (2026-11-05, [1ec99ee](https://github.com/hustle1hustle/near-bookerbob/commit/1ec99ee)); the post-quantum pack goes in ([c121717](https://github.com/hustle1hustle/near-bookerbob/commit/c121717)); OutLayer only in
  reversible steps (nothing is registered yet, docs/outlayer.md).
- Hotel prices are JMPR's public rates as of 2026-11-04; JMPR is not a participant and no real room is booked ([85161a9](https://github.com/hustle1hustle/near-bookerbob/commit/85161a9)).

## Known limits

- **The model path trusts one evaluator with the prompt.** The contract cannot read a sealed
  request, so it requires the signature of REP's verdict evaluator, which builds the request
  from the proof set the envelope names. That closes the buyer's forgery (`make forge-poc`) and
  moves the trust to REP: the evaluator reads the facts in the clear, checks that the proof set
  is the one named, not a notary's signature, and no notary proof is checked at settle. Verdicts
  from before the evaluator were not countersigned.
- **Two money bugs are live until the Nov 10 redeploy.** Testnet tokens and merchant bonds only.
  A signed dispute decision can be sent again, and each replay refunds the buyer from the
  merchant's bond. A lower group offer posted after members pledged moves their pot to a merchant
  with no receipt for it. Found by our own audit on 2026-11-06, both fixed in the contract batch
  (`contract-batch`), not yet deployed.
- **A sealed verdict hides predicates, the price does not.** L10 prints which bit sets each
  settled amount leaves; on m01 every amount so far leaves one. Buying groups on a fixed tier
  do not decode, which is why the k-gate routes small sets there.
- A round binds a payment only under a mandate that names it. With no mandate, a buyer can settle
  with a merchant that lost a blind round, given a receipt for it.
- The Leash (`set_mandate`) bounds one account, not a person. It holds what that account pays:
  per purchase, in total, by expiry, to a round's winner, and a live mandate shuts `withdraw`.
  An agent can open another account, and an agent that sets its own key as owner has no leash,
  so check `mandate(agent)`. A round mandate needs a revealed verdict and a fresh receipt: it reads
  the winner from live schedules and refuses a receipt at any other price. After expiry `withdraw` goes to the agent's account, so an owner who
  fears the agent key should drain first. A dispute refund does not give the limit back, and a refund after the owner replaced the mandate
  comes off the new one's count.
- `reveal_bid` has no forfeit: a merchant that committed can skip the reveal and lose nothing,
  so a late look at rivals is free.
- The account nullifier is a VOPRF output since 2026-11-05 (`cli/src/voprf.rs`, RFC 9497): REP's
  evaluator sees a blinded element only. REP still holds the one evaluator key (an enclave and a
  committee are decided, not built), sees who asked and when, and earlier purchases used an HMAC
  it can recompute. In fixtures the nullifier is a labelled placeholder.
- **Delivery reveals a name.** Shipping and hotel check-in need a name and an address, and the
  merchant sees them. The test store's orders set `requiresShipping: false` (`ucp/src/near-usdc.mjs`),
  a test-store shortcut, not a private delivery path.
- **One World ID binds one account.** `attest_human` refuses a second account for one person, so
  a buyer on one-time accounts gets the World bit on one of them only, or reuses that account and
  links its purchases (L1).
- **The referee picks among sealed prices.** For a sealed verdict the referee reads the opening
  and computes the prices; the chain cannot recheck a sealed price, so that pick is trusted.
- **Wash reviews.** A review group admits anyone who settled with the merchant, the merchant's own
  accounts included, so a merchant can buy from itself and rate itself.
- **Ratings and the k floor.** `submit_review` accepts a proof against any of the group's last 32
  roots, so a rating can be made against a root at which the group was still under the floor.
- World ID runs on fixtures with a placeholder action. Say "proven customer", not
  "verified human", until the live path ships.
- Callers pay for the storage they add (`submit_verdict`, `register_merchant`,
  `attest_human`, unused deposit refunded); `storage_deposit` opens an escrow entry for
  0.01 NEAR.
- A dispute that lands after settle refunds the buyer only from a merchant's refund bond, up to
  that bond; with no bond the record is only flagged, and no refund has run live.
- Sealed reviews: group membership is public (a commitment joins right after a settle),
  the anonymity set is the group size (5 at worst), the sender of `submit_review` and
  `reveal_review` is public (use a fresh account or a relayer), and a member who skips
  the reveal drops out silently. The trusted setup is Semaphore's V4 ceremony.
- A pledge counts as paid when `on_group_release` runs. A group's own DAO that starves that
  callback of gas leaves the pot sent and its members unable to dispute.
- Buy Twice (`claim_returning`) proves a past purchase, not loyalty. REP, or anyone, can buy the
  bit for one purchase at price plus fee, and a membership then earns a claim every 30 days. A
  member can hand a proof to a chosen buyer. A person with two purchases holds two memberships
  and claims twice in an epoch, so the repeat count is purchases, not people. The claim tx is
  public: it says this account's buyer is one of the group at the proof's root, at least k people
  when the contract checked, smaller if the client picks an old root. The discount is one more
  bit in the price (L10), and it does not stack with a buying group's tier. `returning_rate`
  holds its count below k, but anyone can count the txs.
- The referee's text checks are a word-level tripwire (status words, platform names,
  numbers, plain ascii), not language understanding. A discount never depends on the text:
  only on asserted values that equal the proof.
- `make verify` runs the contract code natively against near-sdk's MockedBlockchain, not
  on a live chain. The testnet deployment and its tx hashes are below.

## Every feature, its status and its evidence

<!-- status:begin (generated from docs/status.json by scripts/status.mjs; edit that file) -->
| feature | track ids | where | status |
|---|---|---|---|
| near-sdk-rs contract: merchant registry, nullifier spent-set, enclave key registry | security, swarms | `contract/src/lib.rs` | **live**: unit tests and `make verify`; deployed at `bookerbob.testnet` |
| `env::ed25519_verify` and `env::p256_verify` (low-S) on verdict signatures | security, privacy | `contract/src/lib.rs` `verify_signature` | **live**: every testnet verdict passed it |
| NEP-141 USDC escrow (`ft_on_transfer`, `storage_deposit`) and `ft_transfer` payout in `settle` | realworld, agents | `contract/src/lib.rs` | **live**: payout rollback in `on_settle_transfer`; on testnet the same path ran 18 times in dUSDC (`settle_demo`, its own escrow, testnet only) |
| NEP-297 events (`verdict_submitted`, `settled`, `settle_reverted`, ...) | realworld | `contract/src/lib.rs` `emit` | **live**: every testnet tx above logs them |
| Verdict evaluator: a model verdict needs its signature on the request and envelope, so a signed answer about a typed fact is refused | security, privacy | `contract/src/lib.rs` `submit_near_ai_verdict`, `core/src/near_ai.rs` | **built**: `cargo test -p bookerbob-bazaar evaluator`; live with the contract batch; one REP key, see Known limits |
| The Leash: an owner signs limits on an agent (per purchase, total, expiry, a round's winner); the contract refuses a payment outside them and a live mandate shuts withdraw | security, agents | `contract/src/lib.rs` `set_mandate`, `spend_under_mandate`, `core/src/mandate.rs` | **built**: `cargo test -p bookerbob-bazaar leash`; live with the contract batch; `make audit` recomputes `liability` |
| Buy Twice: a past buyer proves it from a fresh account with a Semaphore proof and pays less; a repeat count held below k, with no customer list | privacy, realworld | `contract/src/lib.rs` `claim_returning`, `docs/semaphore.md` | **built**: `make verify` (sealed reviews) and `cargo test -p bookerbob-bazaar`; live with the contract batch |
| deterministic tier, price stack, referee (cheat mode) | security, swarms | `core/src/` | **built**: `make verify`, 50/50 referee evals |
| disclosure policy: merchants ask, the buyer agent answers by rule (raw history and identity always declined); a budget caps bits per purchase and the plan shows what each bit saved | privacy | `core/src/disclosure.rs`, `fixtures/disclosure-policy.json`, `fixtures/merchant-asks.json` | **built**: `make verify` checks 04 and 05 |
| group unlock: a cohort price opens when k>=5 verdicts in the same context reveal a predicate; only the count is public (`cohort_size`) | swarms, privacy | `core/src/price.rs` `quote_in_cohort`, `contract/src/lib.rs` | **live**: unlocked on testnet once k >= 5 verdicts revealed `world_id_human` (38.40 to 36.00) |
| blind bid rounds on chain: `open_round`, `commit_bid` (sealed hash, approved merchants only, before the commit deadline), `reveal_bid` (must open the commitment, before the reveal deadline), `round_best_quote` (only after the reveal deadline); 30 merchant agents bid through it | swarms | `contract/src/lib.rs`, `core/src/bid.rs`, `cli/src/swarm.rs`, `sdk/merchant.mjs` | **live**: 30 merchant agents bid in two blind rounds on testnet (hoodie and hotel-lisbon), commit before the deadline, reveal after; 8 contract tests |
| NEAR AI Cloud inference for every merchant pitch and the buyer's cited "why", response signatures verified | privacy, swarms | `agents/why.mjs`, `agents/out/live-run.json` | **built**: plain TLS, 33/33 response signatures verified in a recorded live run |
| NEAR AI issues the verdict under E2EE v2: the facts go sealed to the attested model key, the model derives the predicates and echoes a binding of the envelope, and `make verify` checks the TDX quote (dcap-qvl, Intel root, committed PCS collateral), report_data (signing key and our nonce), the TEE signature over the exact wire bytes, the sealed answer (opened with its disclosed per-field key), predicates equal to the code's, and the binding | privacy, security | `scripts/near-ai-verdict.mjs`, `cli/src/near_ai.rs`, `fixtures/live/near-ai/`, `docs/near-ai.md` | **live**: one testnet purchase with a verdict glm-5.3-flash issued (`make model-buy`, 2026-11-05): the facts sealed to the model key registered against its on-chain TDX quote verification, `submit_near_ai_verdict` accepted it (issuer `near-ai:5a0210f2..`), the eval-gated merchant refused it (v4 bucket 50, under 70), m01 settled 36 dUSDC, the replay refused; `make verify-live` re-checks it. one live capture on synthetic facts (chat `08af1d014f2d4f379dba94094562d9ba`, TCB UpToDate). On chain, `submit_near_ai_verdict` accepts it only with a registered model attestation (same nonce), the TEE signature over the exact response bytes, and a sealed answer that opens with the disclosed key and echoes this envelope's binding; `make verify` runs the contract on it and on 4 refusals. The quote check itself happens before `register_model_attestation`, not in the contract; the NVIDIA GPU evidence is checked offline from NVIDIA's signed NRAS reply (`scripts/nras.mjs`) |
| OutLayer worker as referee: signed result (<= 900 bytes) checked by the contract with `ed25519_verify`; `settle` requires the receipt | security, privacy | `worker/`, `contract/src/lib.rs` (`submit_referee_result`, `request_referee`, `on_referee_result`), `docs/outlayer.md` | **built**: in `make verify`; not deployed to OutLayer yet (the register step waits on a founder OK). Live `estimate_execution_cost` = 0.0070001 NEAR |
| dispute arbiter: re-checks citations and every signature, signs upheld or overturned; an overturned receipt is cleared and settle is blocked | security | `worker/src/lib.rs` `arbitrate`, `contract/src/lib.rs` `submit_dispute_decision`, `docs/outlayer.md` | **built**: `make verify` check 22; a threshold of distinct arbiter signatures (`set_arbiter_threshold`, `submit_dispute_decisions`, 4 contract tests) is built; the live bazaar runs at threshold 1 with one arbiter key, held by REP |
| World ID "one person, one agent": the contract checks a verifier's ed25519 attestation and binds one agent per World nullifier; `world_id_human` needs it | security, privacy | `core/src/world.rs`, `contract/src/lib.rs` `attest_human` | **live**: on testnet with a placeholder action and our verifier key; the live World ID service (rep-world-verify) is not wired |
| sealed reviews (Semaphore v4): a settled purchase joins the merchant's group (LeanIMT, Poseidon on chain); during a round a member posts a sealed rating with a Groth16 proof checked on `alt_bn128` host functions, one per member per round (nullifier scoped to merchant and round); after the round members reveal, only if the group has k >= 5; release is batched and sorted by hash; `best_quote` breaks price ties by the score and takes a `min_score` floor | swarms, privacy | `docs/semaphore.md`, `core/src/semaphore.rs`, `contract/src/groth16.rs`, `contract/src/lib.rs`, `cli/src/reviews.rs`, `semaphore/` | **live**: 3 rounds of 6 sealed ratings released on testnet (2 for m01, 1 for h05); 13 contract tests on real Semaphore proofs |
| conserved delegation: standing flows from a merchant's released ratings along hire edges to the sub-agents it hires (w = 1/2), following a design rule in REP's unpublished draft "(title withheld) for a World of Agents": the whole chain gets at most w/(1-w) of the seed | swarms, security | `core/src/delegation.rs`, `contract/src/lib.rs` (`hire`, `standing_from`) | **live**: standing flowed from m01's released ratings to m02 and m03 on testnet; property test over random graphs with rings |
| verifiable compute (Jolt zkVM), four guests: standing graph, price stack, referee, cohort k >= 5. The contract keeps the graph root and per-cohort roots; for the graph, the contract keeps a hash-chained root of the standing graph and accepts score updates only from the registered Jolt program, for the current root, signed by a worker that verified the proof off chain | swarms, security | `graph/`, `contract/src/lib.rs` (`submit_graph_scores`), `zk/`, `docs/jolt.md` | **live**: all four guests proved and verified (prove 1.3 to 9 s, verify about 60 ms, proofs 80 to 93 KB); standing proved twice over the live graph and posted on testnet |
| NEP-366 meta-tx relayer for `submit_review` and `reveal_review`: the rater signs with a one-time key, the relayer pays gas (gasless rating) | privacy, realworld | `relayer/` | **live**: the relayer pays every demo purchase and every rating (demo and review policies), delegate actions on testnet |
| FUNCTION CALL KEYS: agent key limited to `settle` (a function-call key cannot attach a deposit, so `submit_verdict` and `withdraw` stay with the full-access key) | security, agents | `scripts/demo-live.mjs` step `fckey` | **live**: a settle-only key on testnet: withdraws under it refused by NEAR (`DepositWithFunctionCall`, `MethodNameMismatch`) |
| x402 v2 paid verdict read (`exact`, USDC on `near:testnet`, verify and settle through an explicit x402 facilitator) | agents, realworld | `x402/verdict-read.mjs` | **stub**: 7 tests on synthetic payments; no facilitator wired, testnet config only |
| MCP tool "REP Read for agents": read-only contract views for any MCP client, plus a `buy` tool on the sdk/buy.mjs flow | agents | `mcp/rep-read.mjs` | **live**: reads `bookerbob.testnet` over public RPC (`BAZAAR_ACCOUNT_ID=bookerbob.testnet node mcp/rep-read.mjs`); `buy` plans by the contract's price code and refuses when no bid fits; it runs the live testnet purchase only with `BOOKERBOB_BUY=1` (local demo keys), plan only otherwise; 3 tests on a fake RPC |
| UCP payment handler `xyz.r3p.near_usdc`: reads `settle` from NEAR RPC, NEP-297 event, USDC transfer, builds the order fields with `near_tx` | realworld, agents | `ucp/src/near-usdc.mjs` | **live**: 15 tests; reads `settle_demo` txs from testnet and writes paid orders to the Shopify test store |
| merchant SDK for outside agents (schedule, validate, blind bid commitment, quote preview, register args); Agent Market listing plan | swarms, agents | `sdk/`, `docs/agent-market.md` | **built**: cross-checked against the Rust board; used by the outside agent that won `open-1`; not listed (Agent Market is mainnet only) |
| testnet demo mode: dUSDC (a testnet demo token with no value; production uses Circle USDC), its own escrow, `settle_demo`; a tester account funded by a treasury; every purchase call gasless through the NEP-366 relayer's demo policy | realworld, agents | `dusdc/`, `contract/src/lib.rs`, `scripts/demo-tester.mjs`, `relayer/`, `docs/demo-mode.md` | **live**: 28 dUSDC purchases on testnet (18 single settles: one with the 1% fee, two with a sealed verdict, three with a verdict a NEAR AI model issued (two refused by an eval gate, one passing it under the v4 point-bucket rule), one with a VOPRF nullifier, one hotel stay at 408, one `make prove-me` pipeline test at 28, one `make try` pipeline test at 28 from a one-time implicit account; 5 in a buying group at the 10% tier; 5 through a buying group's own DAO treasury), plus one pledge the DAO refunded; `make verify-live` |
| paid orders in the Shopify test store through the Admin API (draft order completed as paid, `near_tx` in the note) | realworld | `ucp/src/near-usdc.mjs` | **live**: 18 orders between #1055 and #1073 |
| review k counts distinct World-bound persons, not purchases (`review_persons`) | privacy, security | `contract/src/lib.rs` | **live** |
| `make leak`: what a passive observer links from public testnet data; found 6 of 6 ratings linked by order, fixed, re-run: 1 of 6 (chance) | privacy | `scripts/leak.mjs`, `docs/leak.md` | **live**: run live before and after |
| challengeable Jolt updates: pending with the proof's sha256, a bonded worker key, `challenge_graph_scores` with a bond, an arbiter's signed resolution slashes a false update | security | `contract/src/lib.rs`, `docs/jolt.md` | **live**: one live challenge on testnet (resolved valid); the proof is checked off chain by the arbiter, not by an on-chain verifier; live at threshold 1, one arbiter key, held by REP |
| liability record per settle (sha256 of verdict digest, receipt, merchant, price, token) and a merchant refund bond that refunds the buyer when a receipt is overturned after settle | security, realworld | `contract/src/lib.rs` (`liability`, `merchant_bond`) | **built**: contract tests; merchant bonds live in the open market |
| `min_tcb`: a verdict below the TDX TCB floor (UpToDate by default) is never quoted or paid | security, privacy | `core/src/envelope.rs` `tcb_meets`, `contract/src/lib.rs` | **live**: deployed; every testnet verdict is the synthetic `fixture` status, which passes only on a `.testnet` bazaar |
| open market: an outside merchant is approved by a 10-token bond, no owner step; in open rounds two bids under one operator (same payout or a hire edge) cannot both reveal | swarms, agents, open | `contract/src/lib.rs`, `scripts/join-merchant.mjs`, AGENTS.md | **live**: a fresh agent with only AGENTS.md won round `open-1` |
| `make market-eval`: 1,000 simulated rounds, no disclosure vs BookerBob vs full disclosure | swarms | `scripts/market-eval.mjs`, `docs/market-eval.md` | **built**: (a model, assumptions stated) |
| sealed verdicts (hashes only on chain): the issuer signs an envelope with no predicates, tier or cap in the clear and a `disclosure` commitment to them; the opening goes to the referee, which prices from it and refuses a price over the hidden cap; the contract accepts only a receipt price its own schedule code can produce for some predicate subset (the World discount only for a World-bound agent) | privacy, security | `core/src/envelope.rs` (`Opening`), `worker/src/lib.rs`, `contract/src/lib.rs` (`disclosure`, `verdict`), `bookerbob sign-real-sealed` | **live**: four sealed purchases on testnet (38.40 dUSDC twice on synthetic facts; 28 in the `make prove-me` and `make try` pipeline tests); `make verify-live` checks that their txs, events and records carry no predicate, tier or cap; 6 contract and 3 worker tests. `make prove-me` uses this path; the phone run is parked (docs/device-run.md) |
| `make prove-me`: your own GitHub account as the real fact. Authenticated `api.github.com/user` notarized with MPC-TLS through the REP notary (pinned key, not attested), 3 fields revealed, the facts sealed to NEAR AI (E2EE v2), a sealed verdict, a `github_builder` line that wins a blind round, one dUSDC settle, `make leak` before and after | privacy, realworld, security, agents | `tools/prove-me/`, `scripts/prove-me.mjs`, `docs/prove-me.md` | **built**: the whole pipeline ran live once as a test on a public profile (no token, so a fact about an account, not ownership): builders won `builder-1` at 28 dUSDC (36 without the builder line), `make verify-live` re-checks it; the run on your own `/user` waits on a token; 4 tests |
| Verdict Gate: a Sputnik DAO grants a role to an agent whose verdict reveals a predicate; the DAO opts in by its own proposal and gives the gate only `add_member_to_role` propose and approve | social, agents, privacy | `gate/src/lib.rs`, `scripts/gate-demo.mjs`, `docs/gate.md` | **live**: `gate.bookerbob.testnet` with two consumer DAOs (`lisbon-travellers`: airbnb_frequent, `one-human`: world_id_human), one member admitted to each; refused on chain: another agent's verdict, a reused verdict, a sealed verdict; both DAOs' council is REP's; 3 unit tests, `make verify-live` |
| base-price anchor: a merchant's base is capped at a public price from a named source (`set_price_anchor`), so a discount off an inflated base is refused; unit economics per purchase from measured testnet gas and storage | realworld, business, security | `contract/src/lib.rs` (`set_price_anchor`, `check_price_anchor`), `scripts/cheat.mjs`, `docs/unit-economics.md` | **live**: 8 Lisbon hotels capped at their public JMPR rates on testnet; `make cheat`: h05 raising 510 to 600 refused on chain; 4 contract tests (`an_inflated_base_is_refused`); one purchase costs about 0.0102 NEAR in gas and compute plus 0.016 NEAR storage, against a 1% fee; hoodie merchants are not anchored |
| proven standing tree: the bazaar builds one root from the score list of a Jolt-proven, challengeable graph update and stores no scores; a merchant proves "rank r of n" against it, so the chain answers "is X in the top N%" (`in_top`) | privacy, social, security | `zkcore/src/standing.rs`, `core/src/standing.rs`, `contract/src/lib.rs` (`apply_graph_update`, `standing_root`, `in_top`), `bookerbob standing-proofs`, `scripts/standing-root.mjs` | **live**: live graph of 6 events (hires, m01's two review rounds, h05's first: its 5 group-treasury buyers and the hotel buyer joined its review group), proved in Jolt (zk/out/standing-testnet-3), submitted, unchallenged, finalized: m01 rank 1, h05 rank 2; in_top(m01, 50%) true, h05 on m01's path refused; apply refuses a list that differs from the proven scores hash (test); salts come from the graph root because the scores follow from public events: a rank check, not score privacy |
| post-quantum: the sealed referee input is hybrid (X25519 + ML-KEM-768, v1 default), every small-domain hash on chain carries a 256-bit salt, and the README states per piece what holds against a quantum attacker | security, privacy | `worker/src/sealed.rs`, `docs/audit.md`, README, "Post-quantum" | **built**: v1 sealing tests (round trip, swapped KEM ciphertext, downgrade), the contract checks a v1 input's 1,088-byte KEM ciphertext; brute-force tests on the commitment, claims and proof hashes; signatures and Jolt (BN254) are still classical |
| the NEAR AI model's TDX quote verified on chain: Intel DCAP checks (a dcap-qvl fork) in five calls, and the bazaar registers a model key only against a finalized verification whose report_data is that key and nonce | security, privacy, agents | `tools/dcap-spike/`, `contract/src/lib.rs` (`set_quote_verifier`, `register_model_attestation_verified`) | **live**: five calls of 40, 100, 99, 132 and 69 Tgas; a quote with one changed byte fails at finalize; the bazaar's model key registered through it; the same verification for another key refused; the old off-chain path closed; the verifier account keeps REP's key; the GPU evidence is checked off chain (NRAS) |
| buying groups on sealed intents: World-bound buyers who revealed the same predicates pool for a fixed-tier discount (10% at 5 persons, 20% at 10); budgets stay committed; each member pays one amount | swarms, privacy, social | `contract/src/lib.rs` (`post_intent`, `offer_group`, `settle_group_demo`), `scripts/demo-tester.mjs group` | **live**: one group of 5 on testnet paid the 10% tier; 8 contract tests |
| trust anchors under a DAO and a timelock: a Sputnik DAO owns a test bazaar (one council vote is refused, two apply); every anchor change (issuers, model keys, referee, arbiters, World verifier, arbiter threshold, fee, Jolt program, a lower TCB floor) is queued for a public delay, executable by anyone after it and cancellable inside it | security | `contract/src/lib.rs` (`set_anchor_delay`, `queue_anchor`, `execute_anchor`, `cancel_anchor`), `scripts/dao-bazaar.mjs`, `docs/testnet.md` | **live**: on `bookerbob-dao-bazaar.testnet` (5 min delay; an early execute refused, a later one applied); 7 + 5 contract tests. The live `bookerbob.testnet` still has one owner key, delay 0, and its full-access key can redeploy the code |
| a buying group's own treasury: a Sputnik DAO created per group, its council the members; each member pledges the tier price, which stays in the bazaar under the group; only a passed DAO proposal refunds a member or pays the merchant, never below the tier's member count | social, swarms, security | `contract/src/lib.rs` (`bind_group_treasury`, `pledge_group_demo`, `refund_group`, `release_group`), `scripts/group-dao.mjs` | **live**: `lisbon-g1.sputnikv2.testnet`: 6 World-bound hotel buyers, h05's 10% offer (367.20 each), one dropout refunded by proposal, 5 pledges released to h05 by a second proposal (1817.64 dUSDC after the 1% fee), a direct release refused; 6 contract tests |
| market fee into a DAO treasury: at most 2%, taken from the price (merchant + fee = price), in the liability record, given back on a failed payout, swept by anyone to the treasury; a raise waits out the anchor timelock | business, social, security | `contract/src/lib.rs` (`set_fee`, `sweep_fees`) | **live**: 1% on testnet, swept to the Sputnik DAO `bookerbob-gov.sputnikv2.testnet`; 5 contract tests |
| certified private eval (the envelope's second use): a model answers a sealed 20-item set on NEAR AI Cloud, each answer's TEE signature is checked, code grades, a registered issuer signs the certificate; the bazaar stores the floored score and answers `eval_passes(subject, set, threshold)` | agents, privacy, security | `contract/src/lib.rs` (`register_eval_set`, `submit_eval_certificate`, `eval_passes`), `scripts/eval-run.mjs` | **live**: glm-5.3-flash scored 20/20 (bucket 100) on testnet; the items stay private; 5 contract tests |
| REP Eval, calibrated: 120 sealed items at 4 levels, 3 NEAR AI models in a 400-token budget, every answer TEE-signed, grading and a bootstrap 95% CI in the worker's code, one certificate per model from a separate eval issuer key; a leaderboard page reads the scores from chain | agents, privacy, security, open | `scripts/rep-eval.mjs`, `worker/src/eval.rs`, `agents/eval.html`, `docs/eval.md` | **live**: headline on a held-out set made after the protocol was frozen: glm-5.3-flash 58/120 (CI 39.2 to 56.7), DeepSeek-V4.1-Flash 112/120, Qwen3.6-35B 0/120 (budget-bound, out of tokens on every item); all 360 TEE signatures valid; the tuned calibration set's run is on chain too and within 3 items; `make eval-verify` in about a second. Only one model lands in the 40 to 80% band. v2 (protocol frozen first): 60 referee-claim items, truth from the referee's code, set committed by its own owner account with `commit_eval_set`: glm 44/60, DeepSeek 35/60, Qwen a budget probe at 0; every answer given was right, every miss a reply cut at 600 tokens; v3, the same items at 2,000 tokens (frozen first): DeepSeek 58/60, glm 55/60, again right on every answer given, so the set is too easy to separate them by accuracy |
| REP Eval v4 and the eval gate: 40 harder referee-claim items (truth from the referee's code, protocol frozen before the set), and `set_eval_gate`: a merchant sells only to a verdict issued by a NEAR AI model whose certificate passes `eval_passes` | agents, security, open | `scripts/rep-eval-v2.mjs` (`REP_EVAL_PROTOCOL=v4`), `scripts/eval-gate.mjs`, `contract/src/lib.rs` (`set_eval_gate`), `docs/eval.md` | **live**: v4 on testnet: DeepSeek-V4.1-Flash 29/40 (bucket 70), glm-5.3-flash 22/40 (bucket 50, the first wrong finished answer in any run); `vetted` gated on v4 at 70 until 2026-11-06 (now the v5 lower bound), an ordinary verdict's receipt was refused on chain; a glm-issued verdict was refused by the gate and bought from m01 instead (`make model-buy`); DeepSeek, its key registered against its on-chain TDX verification, passed under the v4 point-bucket rule and bought from `vetted` (the v5 lower-bound rule would refuse it) (`MODEL_BUY_MODEL=... make model-buy`); the 70 was set after the v4 scores; `make eval-gate`, `make eval-verify` |
| REP Eval v5: 120 items, protocol committed first, the gate on the Wilson 95% lower bound (threshold 70 fixed before the set), certified apart as `/ci95-lower` with no contract change, truncation reported apart | agents, security, open | `docs/eval-v5-protocol.md`, `scripts/rep-eval-v2.mjs`, `agents/eval.html` | **live**: both bazaars: DeepSeek 91/120 (lower bound 67.4), glm 88/120 (64.8): both in point bucket 70, neither passes 70 on the bound, and `vetted` gates on the bound, so both are refused live (DeepSeek's verdict refused on chain, `make eval-gate`); `make eval-verify` recomputes the bound and reads `eval_passes` |
| NEAR INTENTS / 1Click top-up from any chain | realworld, agents | `docs/` | **planned**: mainnet only; not attempted on testnet. A buying group's escrow is the natural NEAR Intents target: on mainnet, members would top up through 1Click from any chain into the group's escrow |
<!-- status:end -->

## Deployments

Testnet only; nothing is on mainnet. Every tx hash is in [docs/testnet.md](docs/testnet.md).

- `bookerbob.testnet`: the bazaar, owned by one REP key (the "before" exhibit).
- `market.bookerbob.testnet`: the same bazaar owned by the Sputnik DAO `bookerbob-gov` from block
  one, anchors by 2-of-3 votes and a 5-minute public delay; its full-access key goes in the lock.
- `spike.bookerbob.testnet`: the on-chain TDX quote verifier both bazaars require for model keys.
- `gate.bookerbob.testnet`: the Verdict Gate; `bookerbob-dusdc.testnet`: the demo token.
- Done in demo mode (dUSDC): 28 purchases (18 single settles: one with the 1% fee, two with a
  sealed verdict, three with a verdict a NEAR AI model issued (two refused by an eval gate, one passing it under the v4 point-bucket rule), one with a VOPRF nullifier, one hotel stay at 408, one `make prove-me` pipeline test at 28, one `make try` pipeline test at 28 from a one-time implicit account; 5 in a buying group at the 10% tier; 5 through a buying group's own DAO treasury), 18 replays refused, a settle-only function-call key
  that cannot withdraw, 18 sealed reviews released over 3 rounds at k >= 5 (12 for m01, 6 for h05), the group price at k >= 5, a
  standing update with nonzero merchants, 18 orders in the Shopify test store.
- Not on testnet yet: the OutLayer referee (the register waits on the founder).

## License

MIT, see [LICENSE](LICENSE).
