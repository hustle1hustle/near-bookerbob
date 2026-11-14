# Pre-registration: coalition admission by standing v3

Written 2026-11-14, before any run of the v3 rule: no registered seed and no smoke seed has been
run with it. The sha256 of this file, up to the marker line at the end, is anchored in a testnet
transaction. The tx hash is below the marker. Nothing above the marker changes after the anchor.

This is the third pre-registration in the series. The first (`docs/coalition-prereg.md`, v1
admission) passed; the second (`docs/coalition-prereg-v2.md`, v2 admission) failed on failed
legs and fill. Both stay as published, with their results (`fixtures/coalition/result.json`,
`fixtures/coalition/result-v2.json`) and checks.

Code: `cli/src/coalition_sim_v2.rs`, run by `bookerbob coalition-sim --v3`. Result:
`fixtures/coalition/result-v3.json`.

## Why

v2 failed because a v2 leaf adds up over ratings: an unreliable agent that averages above 3
stars and sells 10 legs an epoch outranks a reliable agent with few ratings, so volume bought
rank (docs/coalitions.md, "Measured: admission by standing v2"). Standing v3
(`bookerbob_standing_v2::compute_v3`, called as is) keeps what v2 added and drops that:

- An account with its own released reviews ranks by v1's quality per rating, the review average
  shrunk toward 3 stars, (sum x 100 + 5 x 300) / (ratings + 5). Volume buys no rank.
- An account with no reviews of its own enters only through the fan-out: 300 + 25 per weighted
  seed conferred on it by other seeds (v2's weighting, only quality above 3 stars confers),
  capped at `V3_ENTRY_CAP` = 350, the score of a 3.5-star merchant.
- A ring with no seed upstream gets no leaf.

The leaf list and the tree go through the same `bookerbob_core::standing::graph` and the same
`in_top` rule as v1 and v2.

## Claim under test

1. v3 admits reliable newcomers that v1 cannot, through the fan-out.
2. It does so with no rise in failed legs and no fall in filled bundles against v1.
3. A sybil ring gets no leaf, 0 standing and no admission.

## Design

The market, the newcomers, the trials, the hired sybil and the ring are v2's, unchanged
(docs/coalition-prereg-v2.md, "Design"): v1's 36 honest agents (12 per category, 4 unreliable)
with their prior histories and draws byte for byte, 6 ring sybils hiring each other, 9 newcomers
(3 per category, the first 2 reliable) given one trial job per epoch by a delivering lead
(L[(j + epoch) mod |L|]), a delivered trial logged as the lead's hire edge, and one hired sybil
(`sybil-hired.sim.testnet`, hotel, 0.75 x base, never delivers, outside the ring) hired once by
the first delivering lead of the first epoch with a filled bundle. Same jobs, budgets, capacity,
bond, carry, slash, reviews, epochs.

Arms, all over that market:

- `singles_clean`: v1's singles arm with no sybils.
- `coalitions_v1`: admission by `in_top` at pct 67 over the tree from `bookerbob_graph::compute`.
- `coalitions_v3`: the same, over the tree from `bookerbob_standing_v2::compute_v3`.
- `coalitions_v3_at_v1_count` (secondary, outside the pass rule): v3's tree with the pct set each
  epoch to the largest pct whose cut admits at most 25 leaves, v1's admitted count.

Ring sybils with no leaf present v1's 3 forgeries every epoch (the third from a forged graph
built with the arm's own rule). Seeds 1 to 20. No network, no keys.

## Metrics

v2's, per arm: fill rate, failed legs per 100 bundles formed, price per filled bundle, net buyer
loss per 100 jobs, unserved, admitted, admitted unreliable, newcomers admitted (reliable and
unreliable, per epoch and ever), newcomer legs and delivered legs, trials, ring attempts,
admissions, leaves and standing, the hired sybil's leaf epochs, admitted epochs, legs and max
score, and legs to unreliable agents.

## Pass rule

`coalitions_v3` against `coalitions_v1`. PASS only if all of these hold:

1. Reliable newcomers ever admitted: more under v3 than under v1 in at least 18 of 20 seeds.
2. Failed legs per 100 bundles formed: the mean over the 20 seeds under v3 is at most the mean
   under v1 plus 1.0.
3. Fill rate: the mean over the 20 seeds under v3 is at least the mean under v1 minus 0.01.
4. The ring: 0 forged or real ring proofs admitted, 0 ring leaves, and ring standing 0 from
   `compute`, in every seed, epoch and coalition arm.

These are v2's clauses and tolerances, unchanged, so the two runs read side by side.

The hired sybil is outside the pass rule; its legs count as failed legs in clause 2. What we
expect, stated before any run: under v1 it never has a leaf. Under v3 the one hire gives it an
entry leaf of at most 350 while it has no reviews. Reliable honest agents with a clean 4-leg
history score 388 and rank above it; agents with one no-show in 4 score 344 and rank below it.
Whether 350 clears the cut depends on how many accounts rank above it in that epoch, newcomers
at the same cap included (ties break by account name, and `new-...` sorts before `sybil-...`).
We expect it to be admitted for at most one epoch per seed, in fewer seeds than under v2 (18 of
20), and then to drop out for good once its 1-star reviews are its own (10 no-shows score 166).
Each seed where it is admitted adds about 3 failed legs per 100 bundles in that seed (10 legs
in about 320 bundles), so if it is admitted in most seeds, clause 2 can fail on it alone. We
state that risk here and leave the tolerance as it was.

What we expect for the rest: newcomers enter at or below 350, so they come in at the margin of
the cut and only when the hirers' weighted seeds lift them; a reliable newcomer that delivers
then climbs on its own reviews, and an unreliable one settles near its delivery rate, like v1's
unreliable incumbents.

## Order, and what happens after the anchor

Nothing with the v3 rule runs before the anchor tx. After it, smoke seeds 995 to 999 may run.
If a smoke result suggests changing the rule, the rule stays as written; the change would need a
new anchor and would be disclosed as post hoc. Then seeds 1 to 20 run once into
`fixtures/coalition/result-v3.json`, published whichever way the rule lands.

`make coalition-v3-check` re-runs the 20 seeds, requires every number to equal the committed
result, and prints `PASS  coalition v3: ...` or `FAIL  coalition v3: ...` by this rule.
`node scripts/coalition-check-v3.mjs --anchor` recomputes the totals and the rule from the
committed per-epoch records and checks this file's anchor over public testnet RPC.

## Known limits, stated before the run

- Synthetic agents; reliability is fixed; nobody changes behavior.
- The trial is a model of a lead vetting a newcomer with one private job.
- One hired sybil, one hire.
- The tree is one ranking across categories; ties break by account name.
- pct 67 is v1's registered cut, kept for comparison.
- The entry cap (350) and the lift (25 per weighted seed) are the crate's constants as written
  before this run; this run tests them and does not tune them.

<!-- anchored above this line -->

Anchored on NEAR testnet in tx `kCHZBSZZ1u89h4HKG9HV7RNjSHQwJ1Rbe7pj9KPfcoQ` (block time
2026-11-14T15:23:18Z), memo `bookerbob/prereg/v1 sha256:93b4a17882c5a248826d12fc478473dd12aede9173ffeee998d45de0e9a94492 coalition-prereg-v3.md`.
Smoke seeds 995 to 999 ran after the tx; no rule changed after them. The registered seeds 1 to
20 were first run at 2026-11-14T15:24:13Z, after this tx. That time is from our run log, so it is
our word; the tx's time is the chain's.

Keyless check (it hashes the part above the marker):
`node scripts/prereg-anchor.mjs check docs/coalition-prereg-v3.md kCHZBSZZ1u89h4HKG9HV7RNjSHQwJ1Rbe7pj9KPfcoQ 2026-11-14T15:24:13Z`

The anchor covers this design text only. The code was not anchored. `fixtures/coalition/result-v3.json`
records, under `code_sha256`, the sha256 of `cli/src/coalition_sim_v2.rs`, `cli/src/coalition_sim.rs`,
`standing-v2/src/lib.rs` and `Cargo.lock` that wrote it.
