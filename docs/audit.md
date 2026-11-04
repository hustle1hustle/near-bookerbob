# Security self-audit of the `bazaar` contract (2026-11-04)

A self-audit by the build session, not an external audit. Scope: `contract/src/lib.rs`,
`contract/src/groth16.rs`, and the parts of `core/` the contract calls. Each item is
**pass**, **fixed** (with the commit) or **known limit**.

## Findings

| id | area | finding | status |
|---|---|---|---|
| A1 | callbacks: `ft_transfer` in `settle` | the transfer failing (unregistered payout, USDC paused) restores escrow, the nullifier and `spent_count` in `on_settle_transfer` | pass (`failed_payout_restores_escrow_and_nullifier`) |
| A2 | callbacks: state between `settle` and its callback | `spent` is set before the transfer; a review membership could be added from a purchase whose payout then failed and rolled back | **fixed** `2b1cc46`: `paid` set only by a successful callback, `join_review_group` requires it |
| A3 | callbacks: `withdraw` | escrow is debited first and re-credited in `on_withdraw` if the transfer fails; requires 1 yoctoNEAR (full-access key) | pass |
| A4 | callbacks: OutLayer `request_referee` | a failed or garbled worker run emits `referee_failed` and changes no state; a panic inside the callback leaves the record as it was | pass; known limit: the deposit sent to OutLayer is spent either way |
| A5 | Groth16 input range | the review nullifier set compared decimal strings; a zero-padded nullifier is the same field element, so a member could rate twice | **fixed** `2ebfa15`: nullifier and root must be the canonical decimal of a field element (test fails without the fix) |
| A6 | Groth16 input range | public signals and proof coordinates at or above the modulus: the alt_bn128 host functions reject scalars not in the field and points not on the curve or not in the subgroup, so the call fails; a re-randomized (malleated) proof carries the same nullifier and is refused by the nullifier set | pass |
| A7 | integer overflow: price | `base_price * discount_bps` overflows above about 3.4e34; with overflow checks on, one approved merchant's schedule would make `best_quote` panic for its whole category | **fixed** `cc4d136`: `base_price` capped at 10^30 base units in `Schedule::validate` |
| A8 | storage: escrow entry | a repeat `storage_deposit` kept the whole deposit | **fixed** `9f64cb2`: refunded |
| A9 | storage: `publish_reviews` | anyone could add the merchant's totals entry at the contract's cost | **fixed** `9f64cb2`: payable, charges the caller |
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
only by the CLI evals. Two core tests added (`d34073e`); now **10/10 killed**:

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

## Not covered by this audit

The wasm build and its real gas (no deploy yet), the OutLayer worker as deployed, the
Semaphore circuit and ceremony (Semaphore's), dcap-qvl, and the NEP-141 USDC contract.
