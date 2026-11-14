# Pre-registration: coalition admission by standing v3, cut by count (v4)

Written 2026-11-14, before any run of this design. No seed from 21 to 40 has been run under any
arm of any coalition simulation, and no smoke run is made for this one. The sha256 of this file,
up to the marker line at the end, is anchored in a testnet transaction. The tx hash is below the
marker. Nothing above the marker changes after the anchor.

This is the fourth and last registered attempt in the series, and it is confirmatory: it tests,
on fresh seeds, a hypothesis that an exploratory arm of the third suggested.

| attempt | pre-registration | anchor tx | result |
|---|---|---|---|
| v1 | docs/coalition-prereg.md | 4KZDqTwjUAT7Yq3pX2wXfTzawYGVQ6Mk35kEr1W289z5 | PASS |
| v2 | docs/coalition-prereg-v2.md | 7stwAQ6QJaZdf4aJD8ERngkvN8k3jkSqU3ecTAbijz3J | FAIL |
| v3 | docs/coalition-prereg-v3.md | kCHZBSZZ1u89h4HKG9HV7RNjSHQwJ1Rbe7pj9KPfcoQ | FAIL |

Code: `cli/src/coalition_sim_v2.rs`, run by `bookerbob coalition-sim --v4`. Result:
`fixtures/coalition/result-v4.json`.

## Hypothesis and where it came from

v3 ranks accounts with their own reviews by quality per rating (v1's score) and lets an account
with no reviews in through the fan-out, capped at 350 (`bookerbob_standing_v2::compute_v3`). On
seeds 1 to 20 it failed its registered rule at pct 67: fill 0.800 against v1's 0.834, failed legs
21.6 against 17.3 per 100 bundles. The newcomer leaves lengthen the tree, so a cut of 67% of a
longer list admits about 30 agents an epoch against v1's 25, and the extra ones are low-ranked
unreliable incumbents.

v3's secondary arm, "v3 held at v1's admitted count" (exploratory, outside v3's pass rule), on the
same seeds 1 to 20:

| metric | v3 at v1's count | v1 |
|---|---|---|
| bundles filled | 83.8% (sd 4.7) | 83.4% (5.4) |
| failed legs per 100 bundles formed | 17.1 (5.3) | 17.3 (6.1) |
| net buyer loss per 100 jobs, dUSDC | 1,243.3 | 1,269.5 |
| reliable newcomers ever admitted, per seed | 1.95 | 0 |
| seeds with more reliable newcomers than v1 | 16 of 20 | |
| hired sybil admitted epochs | 0 of 160 | 0 |
| legs to unreliable agents | 1,444 | 1,492 |

Hypothesis: v3's ranking, cut at the same count v1 admits, admits reliable newcomers that v1
cannot, with no rise in failed legs and no fall in fill against v1. This was seen after looking,
on seeds 1 to 20, so it is tested here on seeds that have not been run.

## Design

Seeds 21 to 40. The market, the newcomers, the trials, the hired sybil and the ring are v2's and
v3's, unchanged (docs/coalition-prereg-v2.md, "Design"): v1's 36 honest agents with their prior
histories and draws, 6 ring sybils hiring each other, 9 newcomers (3 per category, 2 reliable)
given one trial job per epoch by a delivering lead, one hired sybil hired once. Same jobs,
budgets, capacity, bond, carry, slash and reviews; 8 epochs of 40 jobs.

Arms, all over that market:

- `singles_clean`: v1's singles arm with no sybils.
- `coalitions_v1`: the comparator, admission by `in_top` at pct 67 over the tree from
  `bookerbob_graph::compute`, run on the same seeds 21 to 40.
- `coalitions_v4`: the tree from `bookerbob_standing_v2::compute_v3` (no crate change), admission
  by `in_top` at the largest pct whose cut admits at most 25 leaves. 25 is v1's admitted count:
  v1's tree in this market holds the 36 honest agents (newcomers and sybils never get reviews
  under v1), and `in_top` at 67 admits ranks up to 25 of 36. The run records v1's admitted count
  in every epoch state, so this is checkable. For n leaves of 25 or more, some pct from 1 to 100
  admits exactly 25 (each pct step moves the cut by n/100 of a rank, below one rank for n up to
  100).
- `coalitions_v3_pct67` (reported, outside the pass rule): v3's arm as registered, pct 67.

Ring sybils with no leaf present v1's 3 forgeries every epoch, the third from a forged graph built
with the arm's own rule. No network, no keys.

## Pass rule

`coalitions_v4` against `coalitions_v1`, on seeds 21 to 40. v2's and v3's clauses and tolerances,
unchanged. PASS only if all of these hold:

1. Reliable newcomers ever admitted: more under v4 than under v1 in at least 18 of 20 seeds.
2. Failed legs per 100 bundles formed: the mean over the 20 seeds under v4 is at most the mean
   under v1 plus 1.0.
3. Fill rate: the mean over the 20 seeds under v4 is at least the mean under v1 minus 0.01.
4. The ring: 0 forged or real ring proofs admitted, 0 ring leaves, and ring standing 0 from
   `compute`, in every seed, epoch and coalition arm.

Stated before the run: clause 1 is at risk. The exploratory arm had more reliable newcomers than
v1 in 16 of 20 seeds, below the 18 this rule asks. At a cut of 25 a newcomer at the 350 cap
enters only when fewer than 25 reviewed agents score above 350. We keep the clause as it was.

The hired sybil, expected: it enters at most at 350, below the reliable incumbents (388 with a
clean history), so at a cut of 25 we expect it to be admitted in few or no epoch states (0 of 160
in the exploratory arm). Its legs count as failed legs in clause 2.

## How this maps on chain

The coalition contract takes the cut as the lead's per-job parameter `min_top_pct` (1 to 100) in
`open_job`; the bazaar answers `in_top(proof, min_top_pct)` over its proven tree. A cut by count
means the lead sets min_top_pct = the pct that admits 25 of the tree's n leaves, which changes as
n changes. Nothing on chain enforces that choice: a lead could pick it badly, and a pct of 67 over
a longer tree is the v3 result. This run tests the rule with the pct chosen correctly every epoch.

## Reproduce

`make coalition-v4-check` re-runs the 20 seeds, requires every number to equal the committed
result, and prints `PASS  coalition v4: ...` or `FAIL  coalition v4: ...` by this rule.
`node scripts/coalition-check-v4.mjs --anchor` recomputes the totals and the rule from the
committed per-epoch records and checks this file's anchor over public testnet RPC.

## Known limits, stated before the run

- Synthetic agents; reliability is fixed; nobody changes behavior.
- The trial is a model of a lead vetting a newcomer with one private job.
- One hired sybil, one hire.
- The tree is one ranking across categories; ties break by account name.
- The count 25 is fixed by v1 in this market; in a market where v1's list changes, the count
  would follow it.

<!-- anchored above this line -->

Anchored on NEAR testnet in tx `DwZPkVsiV2qkY1n4WpbV6S5oKUy6A2hjfAbvhhHsAQgX` (block time
2026-11-14T15:26:09Z), memo `bookerbob/prereg/v1 sha256:25f6a35fcf1182c19dfea0c57b4667da98604040343fc980652309ea21f053e1 coalition-prereg-v4.md`.
No smoke run was made. The seeds 21 to 40 were first run at 2026-11-14T15:27:08Z, after this tx.
That time is from our run log, so it is our word; the tx's time is the chain's.

Keyless check (it hashes the part above the marker):
`node scripts/prereg-anchor.mjs check docs/coalition-prereg-v4.md DwZPkVsiV2qkY1n4WpbV6S5oKUy6A2hjfAbvhhHsAQgX 2026-11-14T15:27:08Z`

The anchor covers this design text only. The code was not anchored. `fixtures/coalition/result-v4.json`
records, under `code_sha256`, the sha256 of the files that wrote it.
