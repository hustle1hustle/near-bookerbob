# Pre-registration: coalition admission by standing v2

Written 2026-11-14, before the first run of the registered seeds 1 to 20 with this design. The
sha256 of this file, up to the marker line at the end, is anchored in a testnet transaction. The
tx hash is below the marker. Nothing above the marker changes after the anchor.

This is a second, separate pre-registration. The first (`docs/coalition-prereg.md`, anchored in
tx `4KZDqTwjUAT7Yq3pX2wXfTzawYGVQ6Mk35kEr1W289z5`), its result
(`fixtures/coalition/result.json`), its check and its numbers stay as they are.

Code: `cli/src/coalition_sim_v2.rs`, run by `bookerbob coalition-sim --v2`. It leaves
`cli/src/coalition_sim.rs` unchanged and calls its population, jobs, history, singles arm and
admission rule. Result: `fixtures/coalition/result-v2.json`.

## Why

An audit found that v1's tree ranks only merchants with released reviews, by their shrunk
review average. Hire edges take no part, so "admission by proven standing" in the v1 run is
admission by review score. The bazaar on testnet moves its graph program to standing v2
(`standing-v2/`, `bookerbob_standing_v2::compute`): every account with an own seed or conferred
standing gets a leaf. Its score is its own seed weighted by quality above neutral, ratings x one
seed x max(shrunk average - 3 stars, 0) / 2 stars, plus the standing other seeds confer on it
along hire edges (w = 1/2 per hop, at most one seed's worth per seed, mass returned to its own
merchant excluded). A seed confers with the same weight, so a merchant reviewed at or below 3
stars confers nothing. An account whose own released reviews average 3 stars or under (shrunk) gets
no leaf, whatever its hirers confer; an account with no reviews of its own can still get a leaf
through its hirers. This is related to EigenTrust's max(satisfied - unsatisfied, 0) local
trust. Admission on chain will be by v2. This run measures what that changes.

## Claim under test

1. v2 admits newcomers that v1 cannot: accounts with no reviews of their own, hired by a lead
   that delivers. Reliable newcomers get in under v2.
2. It does so with no rise in failed legs and no fall in filled bundles against v1, in the same
   market.
3. A sybil ring (fabricated hire edges among fresh accounts, no seed upstream) gets no leaf, 0
   standing and no admission under v2, as under v1.

## Design

Market: v1's, unchanged (docs/coalition-prereg.md, "Design" and "Parameters"): 3 categories, 12
honest agents per category (4 unreliable), 2 ring sybils per category, the same prices,
reliabilities, prior histories (4 legs each), jobs, budgets, capacity, bond, carry, reviews and
delivery draws. The honest agents and their draws are byte for byte v1's (a unit test checks
ids, prices and reliabilities). Added to it:

- Newcomers: 3 per category (9 in all), `new-<category><j>.sim.testnet`. No prior history, no
  seed. Price base x U(0.85, 1.25); the first 2 per category draw reliability from the reliable
  band U(0.93, 0.99), the third from the unreliable band U(0.50, 0.80). Draws are keyed by the
  seed and the newcomer's id.
- Trials and hire edges: at the close of each epoch, the delivering leads of that epoch (the
  hotel member of each filled bundle, distinct, in order of first filled bundle) are L. Newcomer
  j (0 to 8) gets one trial job from lead L[(j + epoch) mod |L|]. The trial is one delivery
  draw from the newcomer's reliability (a slot no buyer leg uses). If delivered, the lead's hire
  edge to the newcomer is logged; if not, nothing is logged. No buyer pays for a trial. Edges are
  deduplicated, as in v1. A newcomer that is itself that lead gets no trial that epoch.
- The hired sybil: `sybil-hired.sim.testnet`, hotel category, priced at 0.75 x base like the
  ring, never delivers, outside the ring (it hires nobody and nobody in the ring hires it). At
  the close of the first epoch with a filled bundle, the first delivering lead of that epoch
  hires it once. It has no seed of its own until it takes legs.
- The ring: the 6 ring sybils hire each other (every one hires every other), from the start, as
  in v1. A ring sybil with no leaf presents v1's 3 forgeries every epoch (the rank 1 proof
  renamed, the last proof renamed with rank 1, a proof from a forged graph that gives every ring
  sybil a 50-review seed, built with the arm's own rule). A ring sybil with a leaf would present
  its real proof.

Arms, all over this same market:

- `singles_clean`: v1's singles arm (`coalition_sim::singles`) with no sybils; newcomers are in
  the market and sell to anyone.
- `coalitions_v1`: v1's coalition mechanics, admission `proof.n == n && in_top(root,
  GRAPH_CONTEXT, proof, 67)` over the tree `bookerbob_core::standing::graph` builds from
  `bookerbob_graph::compute(events).merchants`.
- `coalitions_v2`: the same, the tree built from `bookerbob_standing_v2::compute(events).merchants`
  (the crate is called as is), pct 67.
- `coalitions_v2_at_v1_count` (secondary, outside the pass rule): v2's tree with the pct set each
  epoch to the largest pct whose `in_top` cut admits at most 25 leaves, v1's admitted count.
  This separates v2's ranking from the wider cut a longer list gives at a fixed pct.

The coalition mechanics are v1's: cheapest admitted agent per category with capacity, bond 50%
of price, carry 2%, slash to the buyer on a no-show, 5 or 1 star reviews released at the epoch
close, the lead hires the other two members of each filled bundle, standing recomputed every
epoch. Money is conserved in every arm (ledger sum 0, recorded per seed).

Seeds 1 to 20. No network, no keys; randomness is v1's sha256 counter.

## Metrics

Per seed, totals over the 8 epochs, for each arm:

- v1's: fill rate, failed legs per 100 bundles formed, price per filled bundle, buyer loss net of
  slashed bonds per 100 jobs posted, unserved jobs, admitted agents, admitted unreliable agents.
- Newcomers admitted: newcomer-epochs admitted, and distinct newcomers ever admitted, reliable
  and unreliable apart.
- Newcomer legs and newcomer delivered legs.
- Trials given and delivered.
- Ring: forged proofs tried and admitted, ring members with a leaf, the ring's max standing from
  `compute`.
- Hired sybil: epochs with a leaf, epochs admitted, legs taken, its max leaf score.
- Legs taken by unreliable agents (honest and newcomers).

## Pass rule

`coalitions_v2` against `coalitions_v1`. PASS only if all of these hold:

1. Reliable newcomers ever admitted: more under v2 than under v1 in at least 18 of 20 seeds.
2. Failed legs per 100 bundles formed: the mean over the 20 seeds under v2 is at most the mean
   under v1 plus 1.0.
3. Fill rate: the mean over the 20 seeds under v2 is at least the mean under v1 minus 0.01.
4. The ring: 0 forged or real ring proofs admitted, 0 ring leaves, and ring standing 0 from
   `compute`, in every seed, epoch and coalition arm.

The hired sybil is outside the pass rule. What happens to it, stated before the run: under v1 it
has no seed, so no leaf, and it is refused in every state. Under v2 the one honest hire confers
standing on it, so it gets a leaf from the next epoch on; it is admitted only when that leaf
ranks inside the cut. When admitted it is the cheapest hotel, takes up to 10 legs an epoch,
delivers none, is slashed on each, and gets 1-star reviews that become its own seed. Its legs
count as failed legs in clause 2. Published: epochs with a leaf, epochs admitted, legs, seeds
where it was admitted at least once, its max score.

Published whichever way it lands: price per filled bundle, net buyer loss, the secondary arm,
and v2 against `singles_clean`.

`make coalition-v2-check` re-runs the 20 seeds, requires every number to equal the committed
result, and prints `PASS  coalition v2: ...` or `FAIL  coalition v2: ...` by this rule.
`node scripts/coalition-check-v2.mjs --anchor` recomputes the totals and the rule from the
committed per-epoch records and checks this file's anchor over public testnet RPC.

## Smoke runs, disclosed

Seeds 995 to 999, outside the registered seeds, were run before this design was frozen. They
were used to build the secondary arm and to add the unreliable-legs metric, and they changed the
v2 rule itself:

- First smoke, with the earlier v2 rule (own seed = ratings x one seed x shrunk average / 5
  stars, conferring the full seed): a leaf grew with the count of ratings, so a cheap unreliable
  agent taking 10 legs an epoch at 65% delivery outranked a reliable agent left with its 4 prior
  ratings. Legs to unreliable agents per seed ranged 0 to 220 under v1 and 150 to 410 under v2.
  Failed legs per 100 bundles: 36.9 under v2 against 18.9 under v1; fill 0.668 against 0.806.
  Because of this, `standing-v2` was changed to the quality-above-neutral weight described in
  "Why" before anything went on chain. The rule under test here is the changed one.
- Second smoke, with the quality-above-neutral weight and no other change: v2 admitted all 6
  reliable newcomers in every seed, v1 none. Legs to unreliable agents fell to 40 to 250 per
  seed. Failed legs per 100 bundles: 35.3 under v2 against 18.9 under v1; fill 0.659 against
  0.806. The main source was the hired sybil: its own 1-star reviews weighed 0, and nothing
  removed the standing its hirer conferred, which grew with the hirer's reviewed volume. It was
  admitted in every smoke seed (1 to 5 of 8 epochs, 10 to 50 legs, all failed). Because of this,
  `standing-v2` was changed a second time: an account whose own reviews average 3 stars or under
  gets no leaf. The rule under test here includes both changes.
- Third smoke, with the rule under test: v2 admitted all 6 reliable newcomers in every seed, v1
  none. The hired sybil was admitted in 1 epoch in each seed (10 legs, all failed) and had no
  leaf after its reviews were released. Failed legs per 100 bundles: 27.6 under v2 against 18.9
  under v1; fill 0.721 against 0.806. Clauses 2 and 3 failed in all 5 seeds on the
  per-seed numbers, and we expect them to fail on the registered seeds. What remains: a leaf
  still adds up over ratings, so an unreliable agent that averages above 3 stars and sells 10
  legs an epoch outranks a reliable agent left with its 4 prior ratings (seed 998: 250 legs to
  unreliable agents under v2 against 90 under v1), and the hired sybil gets one admitted epoch
  before its own reviews remove its leaf.

The pass rule was written before the first smoke and was not changed after any of them.

## Known limits, stated before the run

- Synthetic agents; reliability is fixed; nobody changes behavior.
- The trial is a model of a lead vetting a newcomer with one private job. Real leads may vet more
  or less.
- One hired sybil, one hire. A sybil hired by several leads, or a ring hired once, gets more
  conferred standing (bounded by one seed per hiring seed).
- The tree is one ranking across categories; ties break by account name.
- pct 67 is v1's registered cut, kept for comparison; a coalition on chain sets its own pct.

<!-- anchored above this line -->

Anchored on NEAR testnet in tx `7stwAQ6QJaZdf4aJD8ERngkvN8k3jkSqU3ecTAbijz3J` (block time
2026-11-14T15:16:33Z), memo `bookerbob/prereg/v1 sha256:bbe0934ffc763bf2533957fa1307179c037480b667f9674275c0db8f4ee9fef6 coalition-prereg-v2.md`.
The registered seeds 1 to 20 were first run at 2026-11-14T15:16:51Z, after this tx. That time is
from our run log, so it is our word; the tx's time is the chain's.

Keyless check (it hashes the part above the marker):
`node scripts/prereg-anchor.mjs check docs/coalition-prereg-v2.md 7stwAQ6QJaZdf4aJD8ERngkvN8k3jkSqU3ecTAbijz3J 2026-11-14T15:16:51Z`

The anchor covers this design text only. The code was not anchored. `fixtures/coalition/result-v2.json`
records, under `code_sha256`, the sha256 of `cli/src/coalition_sim_v2.rs`, `cli/src/coalition_sim.rs`,
`standing-v2/src/lib.rs` and `Cargo.lock` as they were when it was written.
After the first run, one unit test in `cli/src/coalition_sim_v2.rs` gained assertions (the hired
sybil's result in seed 999), and the result was written again: every number equal to the first
run, only that file's recorded sha256 changed (first run `e709ea75b33e..`).
