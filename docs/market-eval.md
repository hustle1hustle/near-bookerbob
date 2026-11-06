# Market eval (a simulation, not market data)

`make market-eval` (`scripts/market-eval.mjs`, seed 7, about 1 s): 1,000 rounds of 20 buyers
each against the 22 hoodie merchants in `agents/merchants.json`. The same buyers and the same
adaptive merchants under three disclosure regimes:

| regime | what a merchant learns | avg price | saving vs lowest base | bits revealed | anonymity set (of 2,000) |
|---|---|---|---|---|---|
| none | nothing | 41.00 | 0.00 | 0 | 2,000 |
| bookerbob | at most 3 proven bits, picked by the planner | 29.13 | 11.87 | 1.62 | about 541 |
| full | every proven bit and who the buyer is | 29.13 | 11.87 | 1.99 | 1 |

Reading: with competing merchants, BookerBob's buyer gets the same price as a buyer who
gives everything away, while revealing fewer bits and staying one of about 541 people who
match what was revealed, instead of one of one. Without disclosure, nobody can price the
value a proven customer brings, so everyone pays the lowest base price.

## Assumptions, stated

- Predicate shares in the population and the lifetime-value uplift a merchant expects from
  each (`PREDICATES` in the script) are assumptions, not measurements.
- Merchant cost is 0.55 of its base price and its margin floor 0.62; no merchant quotes below
  its floor (code clamps every schedule, the cap is 50%).
- Merchants adapt from public data only: a merchant that lost raises its discount on each
  predicate in proportion to that predicate's assumed value, a winner trims by 25 bps.
- Prices are the shared code's quote (`sdk/merchant.mjs`, which mirrors `core/src/price.rs`).
- The model does not let a full-disclosure merchant price upward per buyer; with thin
  competition it could, so the table understates what full disclosure costs a buyer.
- Not modelled yet: merchant budgets and inventory, a model (NEAR AI) proposing schedules
  from public cohort counts, group prices at k >= 5.
