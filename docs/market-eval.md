# Market eval (a simulation, not market data)

**What this model says, in one line:** a better price for proven customers, without a public
price cut. Against no competition at all, merchants lose money here. Against the same merchants
fighting with one public price, they keep more of it, and the buyer pays a little more.

**Against no disclosure with fixed prices, the merchants lose.** Total merchant profit falls
57.9%, from 369,000 to 155,173 under BookerBob, after the 1% market fee and counting an assumed
lifetime-value uplift. With that uplift at zero the fall is 76.2%. Competition moves the margin
to the buyer: the buyer saves 11.87 a sale, and that is the merchants' money. This baseline
cannot move its price, so it overstates the saving.

| merchant side | no disclosure | BookerBob | BookerBob, LTV = 0 |
|---|---|---|---|
| total profit | 369,000 | 155,173 | 87,892 |
| against no disclosure | | down 57.9% | down 76.2% |
| profit per sale | 18.45 | 7.76 | 4.39 |

**Against a price war, the merchants gain.** Here buyers still reveal nothing, and each merchant
adapts one public price by the same rule BookerBob's merchants use on discounts: a loser cuts it
by a step, a winner raises it 25 bps, never below its floor.

| price war step | avg price, war | merchant profit, war | BookerBob against it | BookerBob, LTV = 0, against it |
|---|---|---|---|---|
| 60 bps | 26.85 | 80,386 | up 93.0% | up 9.3% |
| 100 bps | 26.45 | 74,386 | up 108.6% | up 18.2% |
| 150 bps | 26.22 | 70,874 | up 118.9% | up 24.0% |

The buyer pays 29.13 under BookerBob, so a price war is better for the buyer by 2.28 to 2.91 a
sale. What BookerBob gives a merchant is that the lower price goes only to a proven customer.

**Forged claims.** If no notary check stood behind a claim, a buyer could claim every bit and
bring none of the value behind it. With forgers claiming all seven bits and adding no LTV:

| buyers forging | merchant profit under BookerBob |
|---|---|
| none (a notary check on every claim) | 155,173 |
| 25% | 129,528 |
| 50% | 103,018 |
| all | 53,238 |

It breaks even against no disclosure at any one of these, and nothing here shows any of them
holds:

- **LTV:** 4.18 times the assumed uplift, with volume unchanged;
- **volume:** 2.38 times the sales (4.20 times with LTV 0);
- **demand:** a price elasticity of 2.53, where the lower price itself makes that volume.

| demand, assumed | volume | merchant profit | against no disclosure |
|---|---|---|---|
| fixed, as simulated (elasticity 0) | 1.00x | 155,173 | down 57.9% |
| elasticity 1 | 1.41x | 218,403 | down 40.8% |
| elasticity 2 | 1.98x | 307,399 | down 16.7% |
| elasticity 3 | 2.79x | 432,660 | up 17.3% |

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
adaptive merchants under three disclosure regimes (the price war is above):

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
- The market fee is 1% of a BookerBob sale (`set_fee`, 100 bps), taken from the merchant; the
  other regimes pay none.
- A forger claims every bit with no proof and brings no lifetime value; with a notary check
  behind every claim the forged share is 0.
- Prices are the shared code's quote (`sdk/merchant.mjs`, which mirrors `core/src/price.rs`).
- The model does not let a full-disclosure merchant price upward per buyer; with thin
  competition it could, so the table understates what full disclosure costs a buyer.
- The demand rows scale the simulated BookerBob profit by (41.00 / 29.13) to the elasticity, a
  constant-elasticity assumption with the unit margin held fixed. The simulation itself has fixed
  demand: 20 buyers a round whatever the price.
- Not modelled yet: merchant budgets and inventory, a model (NEAR AI) proposing schedules
  from public cohort counts, group prices at k >= 5.
