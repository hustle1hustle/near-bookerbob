# Security self-audit of the `bazaar` contract (2026-11-04)

A self-audit by the build session, not an external audit. Scope: `contract/src/lib.rs`,
`contract/src/groth16.rs`, and the parts of `core/` the contract calls. Each item is
**pass**, **fixed** (with the commit) or **known limit**.

## Findings

| id | area | finding | status |
|---|---|---|---|
| A1 | callbacks: `ft_transfer` in `settle` | the transfer failing (unregistered payout, USDC paused) restores escrow, the nullifier and `spent_count` in `on_settle_transfer` | pass (`failed_payout_restores_escrow_and_nullifier`) |
| A2 | callbacks: state between `settle` and its callback | `spent` is set before the transfer; a review membership could be added from a purchase whose payout then failed and rolled back | **fixed** `0844882`: `paid` set only by a successful callback, `join_review_group` requires it |
| A3 | callbacks: `withdraw` | escrow is debited first and re-credited in `on_withdraw` if the transfer fails; requires 1 yoctoNEAR (full-access key) | pass |
| A4 | callbacks: OutLayer `request_referee` | a failed or garbled worker run emits `referee_failed` and changes no state; a panic inside the callback leaves the record as it was | pass; known limit: the deposit sent to OutLayer is spent either way |
| A5 | Groth16 input range | the review nullifier set compared decimal strings; a zero-padded nullifier is the same field element, so a member could rate twice | **fixed** `3209b9e`: nullifier and root must be the canonical decimal of a field element (test fails without the fix) |
| A6 | Groth16 input range | public signals and proof coordinates at or above the modulus: the alt_bn128 host functions reject scalars not in the field and points not on the curve or not in the subgroup, so the call fails; a re-randomized (malleated) proof carries the same nullifier and is refused by the nullifier set | pass |
| A7 | integer overflow: price | `base_price * discount_bps` overflows above about 3.4e34; with overflow checks on, one approved merchant's schedule would make `best_quote` panic for its whole category | **fixed** `f8cec6c`: `base_price` capped at 10^30 base units in `Schedule::validate` |
| A8 | storage: escrow entry | a repeat `storage_deposit` kept the whole deposit | **fixed** `e0ac7d0`: refunded |
| A9 | storage: `publish_reviews` | anyone could add the merchant's totals entry at the contract's cost | **fixed** `e0ac7d0`: payable, charges the caller |
| A10 | storage: every other growth | verdicts (plus a 512-byte reserve for the receipt and settle), merchants, bids, World ID binding, review groups, sealed and revealed ratings, hires: each charged to the caller with the rest refunded; owner-only registrations are paid by the owner | pass (`docs/evidence.md` per method) |
| A11 | integer overflow: escrow | `ft_on_transfer` adds with overflow checks on (release profile `overflow-checks = true`): an overflow panics and the token refunds; debits are behind `require!(bal >= amount)`; re-credits in callbacks restore an amount that was just subtracted | pass |
| A12 | integer overflow: counters | `spent_count` saturating; cohort counters `u32` (+1 per verdict); review totals `u64`; delegation mass `u128` from at most `n * 10^6` | pass |
| A13 | reentrancy via callbacks | NEAR runs the callback in a later receipt; between them: a second `settle` fails (`spent`), `withdraw` sees the debited balance, a dispute after settle only flags the record, a review join waits for `paid` (A2) | pass after A2 |
| A14 | state after a failed promise | settle: fully restored except 14 bytes of the record reserve are not credited back (they are freed, the reserve just stays lower) | known limit (harmless) |
| A15 | access control | see the table below; three callbacks are `#[private]`; owner-only methods use `assert_owner` | pass |
| A16 | trust anchors | the owner registers every issuer, referee, arbiter, World verifier and NEAR AI model key; a stolen owner key can register a rogue one; the TDX quote is checked off chain before `register_model_attestation` | known limit (README threat model) |
| A17 | test-only method | `flush_all` exists only with `cfg(test)` or the `unit-testing` feature; a wasm built by cargo-near does not export it | pass; known limit: never deploy a build with that feature on |
| A18 | views with loops | `best_quote` pages at most 100, `standing_from` at most 24 hops and 4096 visits, rounds at most 100 bids, hires at most 16 per agent | pass |
| A19 | gas of callbacks | `on_settle_transfer` and `on_withdraw` get 10 Tgas static; they write one record and one balance | pass (mocked); confirm on testnet |
| A20 | OutLayer input | `request_referee` puts `input_data` on chain in public | known limit: synthetic fixtures only; real proofs go over OutLayer's HTTPS path |
| E1 | OutLayer TEE evaluator v0 (deployed, testnet): pipelined request | the request past its first line could be hidden, so a second request (`GET /users/<other>`) hidden after `GET /user` could have its answer's `created_at` read as the buyer's: another account's age and nullifier | **fixed in v1 code** (not deployed): request fully revealed except inside the last header's `Authorization` value; facts read only from the first response body, bounded by its revealed `Content-Length` (`pipelined_second_request_is_refused`) |
| E2 | evaluator v0: replay | a presentation was bound to neither agent nor time: the committed founder presentation could be replayed under any `cnf` | **fixed in v1 code**: request line `GET /user?bb=sha256(tag\|cnf\|context)`, session at most 6 h old by the OutLayer worker's system clock, which TDX does not attest (`replay_under_another_agent_or_context_is_refused`, `stale_or_future_sessions_are_refused`) |
| E3 | evaluator v0: nullifier input | the nullifier came from `created_at`, which is not unique per account | **fixed in v1 code**: from the account `id` (`one_account_id_one_nullifier_per_context`) |
| E4 | evaluator v0: cross-context links | `proof_hash` was the same across contexts; refusals published the presentation's sha256 next to the `cnf` | **fixed in v1 code**: `proof_hash` salted by the buyer's salt; refusals name no presentation (`two_contexts_share_nothing_linkable`) |
| E5 | evaluator v0: key binding | the keys are bound to the project (`bind: "project"`), so the project owner can publish other code under them | **changed in v1 code**: `bind: "wasm"` in the manifest, runs by wasm URL; untested on OutLayer (no sends after the audit) |
| E6 | evaluator v0: `verify` | pubkey, submit, register, anchor, funding, buyers, context, keys and the sybil's args were not bound to the record | **fixed**: `scripts/outlayer-eval.mjs verify` binds every tx's signer, receiver, method and args (20 checks; tamper test with 13 cases) |
| E7 | evaluator v0: context | the buyer chose any context, so a new context gave a new nullifier | **fixed in v1 code**: a compiled list of contexts |
| E8 | evaluator v0: claims, and the key that stays | a zero-predicate verdict was described as "one real account per context"; the v0 key remains a registered issuer on the locked `bookerbob.testnet` and cannot be revoked, so verdicts in the E1 shape (another account's facts and nullifier) can still be submitted there | **reworded**: v0 seals the presented facts to the TEE, and under E1 those facts can belong to another account; uniqueness and unlinkability are claimed for v1 code, by its tests; **open on testnet** (not revocable); rule: v0 and v1 keys never both issuers on one bazaar |
| E9 | evaluator v0: errors | some errors echoed input bytes | **fixed in v1 code**: fixed error and refusal strings (`no_clock_no_verdict_and_errors_carry_no_input`) |
| E10 | evaluator v0: clock | without a clock, `issued_at_ms` fell back to the buyer's value | **fixed in v1 code**: no clock, no verdict; the clock is the OutLayer worker's system clock, which TDX does not attest (a NEAR block-timestamp check is a next step) |
| E12 | evaluator v1 re-audit: nested or duplicate `id`; refusals over any `cnf` | a nested `"id"` or a duplicate top-level key could be read as the account; refusals were signed over unchecked agent and context strings | **fixed in v1 code**: the full first body revealed and parsed as one JSON object with unique top-level keys; bad `cnf` or context: an error, nothing signed |
| E11 | evaluator v0: driver header | said the buyer sent the accept run; `bookerbob.testnet` did | **fixed** |

## Access control, method by method

| who may call | methods |
|---|---|
| owner only | `register_issuer`, `remove_issuer`, `register_world_verifier`, `approve_merchant`, `revoke_merchant`, `open_round`, `register_model_attestation`, `register_referee`, `set_outlayer`, `register_arbiter` |
| the contract itself (`#[private]`) | `on_referee_result`, `on_settle_transfer`, `on_withdraw` |
| the USDC contract only | `ft_on_transfer` |
| the verdict's agent (`cnf`) | `submit_verdict`, `submit_near_ai_verdict`, `settle`, `join_review_group` |
| the caller for itself | `register_merchant`, `commit_bid`, `reveal_bid` (approved merchants), `storage_deposit`, `withdraw` (1 yocto), `hire`, `attest_human` (with a verifier signature) |
| anyone, gated by a signature or proof | `submit_referee_result` (referee key), `submit_dispute_decision` (arbiter key), `submit_review` (Semaphore proof), `reveal_review` (opens a sealed hash, k >= 5) |
| anyone, gated by time or state | `publish_reviews` (after the reveal window), `request_referee` (forwards its deposit) |
| views | all others |

## Mutation pass (referee and nullifier)

`cargo-mutants` is not installed, so `scripts/mutate.py` flips 10 hand-picked conditions
and runs the package tests. First run: 8/10 killed. The two survivors were real gaps in
`core`: a claim with no citations and a fact that proves a different line were covered
only by the CLI evals. Two core tests added (`3c292af`); now **10/10 killed**:

| mutant | what it breaks | killed by |
|---|---|---|
| M1 | claims on unrevealed lines accepted | 11 tests |
| M2 | a claim with no citation accepted | `a_claim_without_citations_is_refused` |
| M3 | asserted value not compared | `an_inflated_value_is_refused` |
| M4 | a fact that proves another line accepted | `a_fact_that_proves_a_different_line_is_refused` |
| M5 | text tripwires off | 4 tests |
| M6 | a discount line without a claim accepted | `discount_line_without_claim_is_refused` |
| M7 | duplicate fact ids accepted | `duplicate_fact_ids_are_always_refused` (property) |
| M8 | a pending or spent nullifier accepted again | 4 tests |
| M9 | settle on a spent nullifier | `double_settle_is_rejected` |
| M10 | a second rating in the round accepted | `a_second_rating_by_the_same_member_is_refused_by_the_nullifier` |

## Low-entropy preimages (2026-11-05)

Every hash or commitment that reaches the chain, and whether its preimage could be guessed.
A hash over a small domain (a predicate subset, a trip count) hides nothing unless a secret
salt goes in with it. A quantum computer does not change this table: guessing a small
preimage is a classical attack, and a 256-bit salt stops it either way.

| on chain | preimage | before | now |
|---|---|---|---|
| verdict `commitment` | salt + the full derived predicate set (2^7 subsets) | **live verdicts used the public fixture salt: 128 guesses open it** | a fresh 32-byte salt per live verdict (`cli/src/keys.rs`), kept with the buyer (`commitment-salt.hex`, mode 600); test `a_live_commitment_does_not_fall_to_brute_force_over_every_predicate_subset` |
| receipt hash (`detail` of a receipt) | sha256(quote, claims): public quote, claims with small cited values | **guessable** | salted with the referee input's own 32-byte salt (`WorkerInput::salt`, inside the sealed input) |
| `claims_sha256` | json(claims) | **guessable: a cited value falls out of 100,000 tries** | salted the same way; the arbiter gets the salt in its dispute input; test `a_salted_claims_hash_does_not_fall_to_brute_force_over_the_cited_value` |
| `proof_hash` (make prove-me) | json(proof set): small facts plus each fact's `proof_ref` | **the ref was the published presentation sha256, so the 3 GitHub numbers could be searched** | the ref is blinded with a private salt (`blindRef`, `proof-ref-salt.hex`); test in `scripts/prove-me.test.mjs` |
| sealed verdict `disclosure` | predicates, tier, cap + 32-byte salt | salted | unchanged |
| bid commitment | schedule + 32-byte salt | salted | unchanged |
| intent budget commitment | budget + 32-byte salt | salted | unchanged |
| sealed review | rating, delivered, reason hash + salt | salted | unchanged |
| REP Eval item hashes | 16-byte salt + question + answer | salted | unchanged |
| nullifier | HMAC under REP's key (older purchases), VOPRF output of a 32-byte random input (since 2026-11-05) | keyed, or random input | unchanged (the keys are REP's: README, "Who can lie") |
| liability record, verdict digest, group key | digests of signed messages, or public predicates | high entropy or public | unchanged |

Stated plainly:

- **What is already on chain stays as it is.** The testnet verdicts and receipts made before
  this change keep their guessable hashes. Their facts are synthetic, and the one
  `make prove-me` test proved a public profile, so nothing private leaks from them; new ones
  are salted.
- The parked phone run (not in this public copy) blinds its `proof_ref` the same way.

## Not covered by this audit

The wasm build and its real gas (no deploy yet), the OutLayer worker as deployed, the
Semaphore circuit and ceremony (Semaphore's), dcap-qvl, and the NEP-141 USDC contract.

## A model-issued verdict (2026-11-05)

For a verdict a NEAR AI model issued (`make model-buy`, issuer `near-ai:<key>`), `make audit` adds:
the model key registered on the bazaar against its TDX quote verified on chain (the verifier
contract's `verification` is `verified`, its report data starts with the key, the TCB status
matches); the TEE signature, re-checked from the `submit_near_ai_verdict` tx's own args, over the
model's exact response; and the model's REP Eval v4 bucket on chain, which a merchant's eval gate
compares. Run it on the model-issued purchase:

```
make audit NULLIFIER=19b62e8cd653ccf6f291bb0e7df8c990e0756ae6301cc59b5c7965c92e82cef0
```

The contract's `quote` view prices with the cohort as it is now. A receipt keeps the price of the
cohort it was bought at, so for an older purchase whose cohort has since crossed the k floor the
audit leaves the live quote out of the parity check and prints both.

`make audit-all` runs it on every purchase in the public manifest: on 2026-11-05 all 21 (the
single settles, the prove-me and try pipeline tests, the model-issued purchase and the 5 buying
group members) print PASS.
