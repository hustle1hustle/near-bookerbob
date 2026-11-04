# Sealed reviews with Semaphore (spec, 2026-11-04)

Status: **spec only.** Nothing below is built yet. This file states the design, the trusted
setup, the limits and the gas plan before any code.

## Goal

A buyer who paid a merchant through the bazaar can rate it. Nobody, including the
merchant and the bazaar, can tell which buyer wrote which rating, and a buyer cannot rate
the same purchase twice. A merchant cannot farm ratings without real settled purchases.

## Semaphore v4, the parts we use

From the circuit source (`packages/circuits/src/semaphore.circom`, semaphore-protocol):
- Identity: an EdDSA (Baby Jubjub) key; `commitment = Poseidon(Ax, Ay)` of the public key.
- Group: a LeanIMT (binary Merkle tree, Poseidon(2) per node; a lone left child is carried
  up unhashed). Depth 1 to 32.
- Proof: Groth16 on BN254. Public signals, in order: `[merkleRoot, nullifier, message,
  scope]` (outputs first, then the public inputs). `nullifier = Poseidon(scope, secret)`.
  Off-circuit, message and scope are hashed: `hash(x) = keccak256(x as 32 bytes) >> 8`
  (`packages/proof/src/hash.ts`).
- One verification key per tree depth (`vk_delta_2` and `IC` differ by depth, the rest is
  shared), from `@semaphore-protocol/proof`'s `verification-keys.json`.

## Trusted setup, disclosed

Proofs and verification keys come from the Semaphore V4 trusted setup ceremony
(https://ceremony.pse.dev/projects/Semaphore%20V4%20Ceremony), completed with over 400
participants on 13 July 2024, artifacts at https://snark-artifacts.pse.dev. Its security
rests on at least one participant having destroyed their toxic waste. We do not run our
own ceremony. We commit the verification keys we use and their source.

## Design

1. **Groups.** One group per merchant (`group m01`). Only the contract adds members: after
   `settle`, the record's agent may call `join_review_group(nullifier, commitment)` once
   per settled record. The verdict nullifier is checked (spent, this agent, not joined
   yet), so one purchase is one membership. The contract keeps the LeanIMT side nodes and
   computes the new root itself (Poseidon in wasm; NEAR has no Poseidon host function).
   It keeps the last 32 roots, so a proof made against a slightly older root still works.
2. **Signal.** `submit_review(merchant, round, rating, delivered, reason_hash, proof)`.
   - `message = hash(json([rating, delivered, reason_hash]))`, rating 1 to 5, delivered
     true or false, `reason_hash` = sha256 of a reason kept off chain;
   - `scope = hash("bookerbob/review/v0" || merchant || round)`: one rating per member, per
     merchant, per round;
   - the contract recomputes message and scope from the arguments, checks the root is one
     of the group's recent roots, checks the nullifier is unused for that scope, and
     verifies the Groth16 proof with `env::alt_bn128_g1_multiexp` (vk_x), and
     `env::alt_bn128_pairing_check` (`e(-A,B) e(alpha,beta) e(vk_x,gamma) e(C,delta) = 1`).
3. **Privacy rules.**
   - k-floor: a round's ratings are released only if the group had at least 5 members
     when the round closed (same floor as the cohorts). Below that they stay sealed.
   - Batch release: ratings are stored per round and become readable together after the
     round closes (`publish_round`), never one by one as they arrive, so the time of a
     rating does not point at the purchase that just settled.
   - Separate scopes: the review nullifier is `Poseidon(review scope, secret)` with a fresh
     Semaphore identity; the verdict nullifier is an account nullifier from the proof of
     history. They share no input, so the rating cannot be linked to the verdict by the
     nullifiers. What still links is named below.
4. **Ranking.** Within a group every member weighs the same: one settled purchase, one
   membership, one vote (weighting by amount would reveal the amount). Across merchants,
   a merchant's score is shrunk toward a neutral prior by how much settled volume backs
   it, so ratings cannot be minted without purchases:
   `score = (n * mean + c * 3) / (n + c)`, `n` = released ratings, `c` a fixed prior
   weight. The weight a merchant can carry into the board is bounded by its settled
   volume `V`: transported, not minted. If weight is passed on with a damping factor `w`
   per hop, a ring of colluding accounts can reach at most `w + w^2 + ... = w / (1 - w)`
   of the weight it started with. This is the standard geometric damping bound, stated
   by us; we have not checked it against the exact theorem in REP's working paper
   "On (an unpublished REP draft)" (2026-09), which we cite as the motivation, not as the source
   of this formula. `best_quote` uses the score only as a tiebreak among equal prices,
   and a filter (`min_score`) the buyer may set.
5. **Checks.** A `make verify` step: 5+ buyers settle, join, and rate; a second rating by
   one member in a round is refused by the nullifier; a proof from a non-member (another
   tree) is refused; a group of 4 stays sealed. Evals for the attack cases. The board and
   receipts pages show released sealed reviews.

## Limits, stated plainly

- Group membership is public: anyone sees that a purchase from merchant m happened and
  that a commitment joined group m right after. The rating hides which member wrote it,
  among the members at release time. With k = 5 the anonymity set is 5 at worst.
- Timing: joining right after `settle` links the commitment to that purchase. That is
  fine (the commitment is not the rating), but an agent that joins and rates in the same
  round with few other buyers narrows the set. The batch release and k-floor limit this;
  they do not remove it.
- The merchant learns aggregate ratings per round, not who rated.
- The trusted setup is Semaphore's, as above.
- Poseidon runs in wasm on chain; its gas is measured on the mocked chain as a host-gas
  lower bound only (it is mostly wasm work, so the real number needs the testnet deploy).
  The Groth16 check is mostly host functions, so its mocked number is closer to real.

## Build plan (small commits)

1. Node: `@semaphore-protocol/core` and `snarkjs` in `semaphore/` (testnet only, no
   money). If installing them is blocked, stop and hand over the command.
2. Fixtures: identities, a group, proofs, the verification keys (committed).
3. Rust: Poseidon matching circomlib, LeanIMT root matching the JS group.
4. Contract: Groth16 verifier on alt_bn128 against the fixture proof; groups, join,
   submit, publish; tests.
5. `make verify` step, evals, pages, evidence (gas), README and threat model.
