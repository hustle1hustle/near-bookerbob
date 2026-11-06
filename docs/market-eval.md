# Market eval (a simulation, not market data)

**The merchants lose money in this model.** Total merchant profit falls 56%, from 369,000 with
no disclosure to 160,999 under BookerBob, and that already counts an assumed lifetime-value
uplift. With that uplift at zero the fall is 75%. Competition moves the margin to the buyer:
the buyer saves 11.87 a sale, and that is the merchants' money.

| merchant side | no disclosure | BookerBob | BookerBob, LTV = 0 |
|---|---|---|---|
| total profit | 369,000 | 160,999 | 93,718 |
| against no disclosure | | down 56.4% | down 74.6% |
| profit per sale | 18.45 | 8.05 | 4.69 |

It breaks even at any one of these, and nothing here shows any of them holds:

- **LTV:** 4.09 times the assumed uplift, with volume unchanged;
- **volume:** 2.29 times the sales (3.94 times with LTV 0);
- **demand:** a price elasticity of 2.43, where the lower price itself makes that volume.

| demand, assumed | volume | merchant profit | against no disclosure |
|---|---|---|---|
| fixed, as simulated (elasticity 0) | 1.00x | 160,999 | down 56.4% |
| elasticity 1 | 1.41x | 226,603 | down 38.6% |
| elasticity 2 | 1.98x | 318,941 | down 13.6% |
| elasticity 3 | 2.79x | 448,904 | up 21.7% |

The case for one merchant is not the case for all of them. With no disclosure the single lowest
base price takes every sale: m22 made all 20,000, and the other 21 merchants made none. A
merchant that loses that race can do better by bidding here even while the total falls.

**Against paid acquisition, all assumed.** The discount is paid only on a sale, so it reads as a
cost per sale of 11.87. But every buyer gets it, including those who would have bought anyway:

| share of these sales that are new customers (assumed) | cost per new customer |
|---|---|
| all | 11.87 |
| half | 23.74 |
| a quarter | 47.48 |

Set that against what the merchant pays for a customer elsewhere. We have no merchant's real
figure, and no merchant has told us it would pay this. Simulated, with no real demand behind it.

## The buyer side

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
value a proven customer brings, so everyone pays the lowest base price. The buyer's saving
is the merchant's loss above.

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
- The demand rows scale the simulated BookerBob profit by (41.00 / 29.13) to the elasticity, a
  constant-elasticity assumption with the unit margin held fixed. The simulation itself has fixed
  demand: 20 buyers a round whatever the price.
- Not modelled yet: merchant budgets and inventory, a model (NEAR AI) proposing schedules
  from public cohort counts, group prices at k >= 5.
