# Pre-registration: coalitions against single agents

Written 2026-11-14, before the first run of the registered seeds 1 to 20. The sha256 of this
file, up to the marker line at the end, is anchored in a testnet transaction. The tx hash is
below the marker. Nothing above the marker changes after the anchor.

Code: `cli/src/coalition_sim.rs`, run by `bookerbob coalition-sim`. Result:
`fixtures/coalition/result.json`.

## Claim under test

1. Coalitions of agents with proven standing and bonds fill more multi-leg bundles than single
   agents bought leg by leg, with fewer failed legs and a lower net buyer loss.
2. A sybil coalition with fabricated hire edges and no attested seed gets 0 standing and is
   refused on every attempt.

## What the simulation uses from the repo

- `bookerbob_graph::compute(events)` for every account's standing and every merchant's score.
- `bookerbob_core::standing::graph(root, merchants)` for the standing tree and each `TopProof`.
- Admission is the bazaar's `in_top` view rule, called as is:
  `proof.n == n && bookerbob_core::standing::in_top(&root, GRAPH_CONTEXT, &proof, pct)`.
  A unit test runs the bazaar contract's own `in_top` view on near-sdk's mocked chain, with the
  same tree in its storage, and checks it agrees with the sim on every agent and every forgery.
- No network, no keys. Randomness is a sha256 counter keyed by the seed.

## Design

Market. 3 categories: hotel (base 120 dUSDC), transfer (30), tour (50). Per category: 12 honest
agents and 2 sybils. Of the 12 honest, 4 are unreliable (chosen by a seeded shuffle).

Agents. Honest price is base x U(0.85, 1.25). Reliability is the chance a leg taken is
delivered: U(0.93, 0.99) for reliable agents, U(0.50, 0.80) for unreliable ones. Price does not
depend on reliability. Capacity is 10 legs per agent per epoch. A sybil prices at 0.75 x base
and never delivers.

History. Each honest agent enters with 4 prior legs, each drawn from its own reliability and
reviewed 5 stars if delivered, 1 star if not. These are its released reviews, its seed in the
graph. Sybils are fresh accounts: no seed. Every sybil hires every other sybil (fabricated edges
in the real event log).

Jobs. 40 jobs per epoch, 8 epochs. A job is a bundle: one leg per category. Budget is the sum of
bases x U(1.05, 1.40). A job counts as filled only if all 3 legs are delivered. Each delivery is
one draw per (agent, epoch, leg slot), shared by all arms, so the arms differ only in who gets
the leg.

Arm `singles`. For each job, each leg goes to the cheapest agent in its category with capacity
left. No bond, no standing check. If the 3 prices exceed the budget, the job is unserved. The
buyer pays for each delivered leg. A no-show fails the bundle, and the buyer has paid for the
delivered legs. This arm runs twice: `singles` with the sybils in the market, and
`singles_clean` without them.

Arm `coalitions`. At the start of each epoch the event log is run through `compute`, the tree is
built with `standing::graph`, and each agent presents its own `TopProof`. An agent is admitted
if the rule above holds at pct = 67 (top two thirds of the tree). For each job, each leg goes to
the cheapest admitted agent in its category with capacity left. A member's leg price is its price
plus the cost of holding its bond: bond = 50% of its price, carry = 4% of the bond per job, so
+2%. Each member posts its bond into escrow. A delivered leg is paid and the bond returned. A
no-show's bond is slashed to the buyer. At the end of the epoch: for each filled bundle the lead
(the hotel member) hires the other two (hire edges), and each leg's buyer review is released (5
stars delivered, 1 star no-show) as the member's cumulative seed. A slashed member gains no 5-star
review for that leg. Standing is recomputed next epoch from the new log.

Arm `sybil attack` (inside `coalitions`, every epoch, for each of the 6 sybils). A sybil has no
leaf, so it presents forgeries: (1) the rank 1 proof with its own name, (2) the last-ranked
proof with its own name and rank 1, (3) a proof from a forged graph where every sybil gets a
50-review, 250-star seed. Proof (3) opens against the forged tree. Its root differs from the
real root, so it fails against the real one. A unit test also shows a forged hire edge or a
changed seed weight changes the graph root, and no proof from that forged tree opens against
the real root.

## Parameters (frozen)

| parameter | value |
|---|---|
| categories, base price (dUSDC) | hotel 120, transfer 30, tour 50 |
| honest agents per category, of them unreliable | 12, 4 |
| sybils per category | 2 |
| reliability, reliable / unreliable | U(0.93, 0.99) / U(0.50, 0.80) |
| honest price / sybil price | base x U(0.85, 1.25) / base x 0.75 |
| capacity per agent per epoch | 10 legs |
| jobs per epoch, epochs | 40, 8 |
| budget | sum of bases x U(1.05, 1.40) |
| prior history per honest agent | 4 legs, 5 or 1 stars |
| admission | `in_top` at pct = 67 over the graph tree, every epoch |
| bond, carry | 50% of leg price, 4% of the bond per job |
| review | 5 stars delivered, 1 star no-show |
| seeds | 1 to 20 |

The parameters were chosen after smoke runs on seeds 995 to 999, which are outside the
registered seeds. In those runs a tighter pct (30 to 50) starved a whole category: the tree is
one global ranking, and ties at a perfect record are broken by account name. 67 avoided that in
all 5 smoke seeds. This choice is disclosed here because it was made after looking.

## Metrics (per seed, totals over the 8 epochs; per epoch means and spreads also published)

- Fill rate: filled bundles / jobs posted.
- Failed legs per 100 bundles formed: no-show legs x 100 / (jobs posted - unserved jobs).
- Mean price to the buyer per filled bundle, dUSDC.
- Buyer loss from failed bundles net of slashed bonds, dUSDC per 100 jobs posted: paid for
  delivered legs of failed bundles, minus bonds slashed to buyers.
- Sybil admissions: forged proofs admitted, summed over every epoch and seed.
- Also published: unserved jobs, admitted agents and admitted unreliable agents per epoch, legs
  sold to sybils.

## Pass rule

The comparator is `singles_clean` (single agents in a market with no sybils), the harder one.
PASS only if all of these hold:

1. Coalition fill rate is higher than `singles_clean` in at least 18 of 20 seeds.
2. Coalition failed legs per 100 bundles formed is lower than `singles_clean` in at least 18 of
   20 seeds.
3. Coalition buyer loss net of slashed bonds is lower than `singles_clean` in at least 18 of 20
   seeds.
4. Sybil admissions = 0, and every sybil's standing from `compute` = 0, in every seed and epoch.

Not in the rule, published whichever way it lands: price per filled bundle. We expect coalitions
to cost more per filled bundle (the bond carry, and cheaper unreliable agents left out).

`make coalition-check` re-runs all 20 seeds, requires the output to equal the committed result
byte for byte, and prints `PASS  coalition: ...` or `FAIL  coalition: ...` by this rule. The
result is published either way.

## Known limits, stated before the run

- Synthetic agents and buyers. Reliability is a fixed number per agent; nobody changes behavior.
- A singles buyer who remembers past no-shows is not modeled. That buyer would be running a
  private standing system.
- A sybil that buys from itself with real proven buyers to earn seeds is out of scope here. The
  bazaar prices that through World ID binding and the cost of each purchase.
- Ties in the global tree are broken by account name, which can favor one category.
- Agents with no record in the top two thirds stay out: there is no exploration step.

<!-- anchored above this line -->

Anchored on NEAR testnet in tx `4KZDqTwjUAT7Yq3pX2wXfTzawYGVQ6Mk35kEr1W289z5` (block time
2026-11-14T13:14:35Z), memo `bookerbob/prereg/v1 sha256:8bc81698a58b2199ed99df9b7bc00c8afe33a05416b61933ac5a996da57cdbfa coalition-prereg.md`.
The registered seeds 1 to 20 were first run at 2026-11-14T13:14:57Z, after this tx. That time is
from our run log, so it is our word; the tx's time is the chain's.

Keyless check (it hashes the part above the marker):
`node scripts/prereg-anchor.mjs check docs/coalition-prereg.md 4KZDqTwjUAT7Yq3pX2wXfTzawYGVQ6Mk35kEr1W289z5 2026-11-14T13:14:57Z`

The anchor covers this design text only. The code was not anchored. `fixtures/coalition/result.json`
records, under `code_sha256`, the sha256 of the code that wrote it: `cli/src/coalition_sim.rs`
`7968811045945633db2fecb0ca3a7716d90c181d5cf1839ada5a15887e6c07b3` and `Cargo.lock`
`4e78305b2b57f58f44e02b47d2453152df522f06f277a0ad3d42d2bf47780d26`. After the registered run
the code gained exploratory arms (an audit asked for them); the registered numbers are equal to
the numbers recorded before the extension (prior audit) and are re-run byte for byte by
`make coalition-check`. The hashes do not cover the crates the sim calls; the run was made on
git HEAD `0d5011d` with uncommitted changes. The exploratory arms are beyond this
pre-registration and do not enter its pass rule (docs/coalitions.md, "Exploratory").
