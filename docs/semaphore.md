# Sealed reviews with Semaphore (spec, 2026-11-04)

Status: **built** (2026-11-04), on the mocked chain, not deployed. Written first as the
spec; changes made while building are marked "built:". Run: `make verify` (`bookerbob
reviews`, 17 checks) and `cargo test -p bookerbob-bazaar reviews`.

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

## Buy Twice: the same group, a second use (built on the contract batch)

`claim_returning(merchant, nullifier, proof)`: the agent of an unspent verdict proves membership
of the merchant's group, so a fresh account can show an earlier purchase with no link to it.

- Scope `bookerbob/returning/v0|{merchant}|{epoch}`, epoch 30 days: one claim per membership per
  merchant per epoch. Message: the verdict nullifier, so a proof does not move to another verdict.
  The scope prefix differs from a review's, so neither proof passes as the other.
- A verdict claims once. The group must hold at least k people, and the merchant must offer a
  discount: a claim says something about the buyer and is refused where it buys nothing.
- The discount (`set_returning_bps`, at most 20%) is fixed at the claim, so the merchant cannot
  move the price between claim and settle. It comes off the receipt price in `take_payment`, the
  same place as a group tier. Group settles pass their own tier and ignore it.
- `returning_rate(merchant, epoch)` counts confirmed payments, not claims, so each one cost a
  purchase, and holds the count below k.
- New state is raw storage only (`rt|`, `rc|`, `rn|`, `rb|`), because no migrate method exists.

Limits are in the README. `make buy-twice` runs it live once the batch is deployed.

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
2. **Signal.** `submit_review(merchant, sealed, proof)` during the round (a day,
   `REVIEW_ROUND_MS`), then `reveal_review(merchant, round, rating, delivered, reason_hash,
   salt)` in the next round. Built: the first draft posted the plain rating; chain state
   and tx arguments are public, so that showed the rating the moment it was sent, next to
   the purchase that just settled. Now:
   - `sealed = sha256(json([rating, delivered, reason_hash, salt]))`, the Semaphore
     message is `hash(sealed)`; rating 1 to 5, delivered true or false, `reason_hash` =
     sha256 of a reason kept off chain;
   - `scope = hash("bookerbob/review/v0" || merchant || round)`: one rating per member, per
     merchant, per round;
   - the contract recomputes message and scope from the arguments, checks the root is one
     of the group's recent roots, checks the nullifier is unused for that scope, and
     verifies the Groth16 proof with `env::alt_bn128_g1_multiexp` (vk_x), and
     `env::alt_bn128_pairing_check` (`e(-A,B) e(alpha,beta) e(vk_x,gamma) e(C,delta) = 1`).
3. **Privacy rules.**
   - k-floor: a round's ratings are released only if the group had at least 5 members
     when the round closed (same floor as the cohorts). Below that they stay sealed.
   - k_d floor (`K_RATERS_MIN`, 5): the group floor counts members, not ratings, so a round
     in a large group could still hold one rating, and a merchant that knows its sales could
     tell whose it is. A reveal is refused while the round holds fewer than 5 sealed ratings
     (5 distinct Semaphore nullifiers), and `publish_reviews` holds a round with fewer than 5
     revealed. Both events log the release size (`ratings`, `sealed`, `k_d`). A thin round's
     ratings stay sealed for good; they are not carried into the next round. Live on both bazaars
     since 2026-11-12 (`docs/testnet.md`).
   - Batch release: only sealed hashes exist during the round; reveals happen after it
     closes, and `publish_reviews` (after the reveal window) releases them sorted by sealed
     hash, not by arrival. A reveal is refused while the group has fewer than 5 members,
     so a small group's ratings never appear on chain.
   - Separate scopes: the review nullifier is `Poseidon(review scope, secret)` with a fresh
     Semaphore identity; the verdict nullifier is an account nullifier from the proof of
     history. They share no input, so the rating cannot be linked to the verdict by the
     nullifiers. What still links is named below.
4. **Ranking.** Within a group every member weighs the same: one settled purchase, one
   membership, one vote (weighting by amount would reveal the amount). A merchant's score
   is shrunk toward a neutral prior by how many released ratings back it, and every
   rating is backed by one settled purchase, so ratings cannot be minted:
   `score = (n * mean + 5 * 3) / (n + 5)` (built: `merchant_score`, `REVIEW_PRIOR_WEIGHT`). Built, multi-hop: standing flows from a merchant along hire edges
   (`hire`, at most 16 per agent) to the sub-agents it hires and theirs, with conserved
   transport, w = 1/2: each hop passes on half of what arrived, split evenly, never more.
   Seed: one unit per released rating (each backed by one settled purchase). Following
   a design rule in REP's unpublished draft "(title withheld) for a World of Agents: Costly
   Signals, Conserved Delegation, and the Cost of Attack" (2026, arXiv preprint in
   preparation), one attested fact confers at most w/(1-w) units of seed mass on the
   whole delegation chain, whatever its fanout or depth; for w = 1/2, at most one unit.
   `standing_from(merchant)` computes it (`core::delegation`, at most 24 hops and 4096
   visits; stopping early only drops mass). Checked: a property test over random graphs
   with rings and several w; contract tests; `make verify` R10, where a spawned ring of 8
   sub-agents collects 5.9998 of m01's 6 seed units and an unseeded ring gets nothing.
   `best_quote` uses the score only
   as a tiebreak among equal prices, and a filter (`min_score`) the buyer may set.
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
- The sender of `submit_review` and `reveal_review` is public: use a fresh account or a
  relayer, never the buyer's agent. A member who does not reveal drops out silently.
- Gas (`docs/evidence.md`): `submit_review` about 33 Tgas mocked host gas, mostly the
  alt_bn128 pairing, close to real; Poseidon (in `join_review_group`) and parsing the
  verification key JSON run in wasm and are not counted, so those numbers are floors
  until the testnet deploy.

## Build plan (small commits, done)

1. Node: `@semaphore-protocol/core` and `snarkjs` in `semaphore/` (testnet only, no
   money). If installing them is blocked, stop and hand over the command.
2. Fixtures: identities, a group, proofs, the verification keys (committed).
3. Rust: Poseidon matching circomlib, LeanIMT root matching the JS group.
4. Contract: Groth16 verifier on alt_bn128 against the fixture proof; groups, join,
   submit, publish; tests.
5. `make verify` step, evals, pages, evidence (gas), README and threat model.
