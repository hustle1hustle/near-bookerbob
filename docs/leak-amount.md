# L10 measured and shrunk: bucketed schedules

L10 (`docs/leak.md`) says a settled amount decodes to the buyer's proven bits. A schedule is
public and the amount is public. When each bit set gives its own price, the amount names the set.
A sealed verdict hides its predicates in the tx and the price gives them back.

This page measures that leak per merchant, and shrinks it at the schedule level. The contract
is unchanged: a bucketed schedule is an ordinary schedule that the deployed code already prices.

The headline, with its scope. In the amount channel, the sales the swarm made leak 1.00 bit per
sale given the merchant. With each merchant's bucket they leak 0.00, because every swarm set
holds world_id_human, which those buckets price. Across all 30 schedules, with every swarm set
assumed at every merchant, the mean is 1.03 bits before and 0.41 after; 14 of the 16 schedules
that leak 0 after do so only because every swarm set holds world_id_human. The merchant a buyer picks is a second
channel: in hoodie it tells 1.50 of the 2 bits, and bucketing does not change it.

## The measure

For one sale, the leak is the mutual information between the buyer's bit set and the amount:

    leak = H(bits) - H(bits | amount)

The amount is a function of the bits (`core/src/price.rs`, the same math in `sdk/merchant.mjs`),
so the leak equals H(amount) under the prior. It is counted in bits per sale. The leak column is
at k = 0: a single purchase, no group unlock.

Two priors, both stated in the output:

- **swarm**: the bit sets the testnet swarm's buyers proved, from the 96 purchases in
  `fixtures/live/swarm/s1.json`. Four synthetic sets, 1/4 each: frequent {airbnb_frequent,
  claude_spender, world_id_human}, traveller {airbnb_frequent, booking_genius, world_id_human},
  builder {claude_spender, github_builder, world_id_human}, regular {steam_veteran, uber_regular,
  world_id_human}. All four prove world_id_human. That makes the prior degenerate for any
  merchant that prices world_id_human: every buyer holds a priced bit, so a bucket there scores 0.
  14 of the 16 "0 after" results below rest on this; m07 and m22 price no bits at all.
- **uniform**: every subset of the merchant's priced predicates is equally likely. This is the
  worst case for a schedule with distinct prices: n priced bits leak n bits.

The function is `amountLeak(schedule, prior)` in `scripts/leak-amount.mjs`. The second channel is
`merchantChannel(sales, price)`, measured on the sales the swarm made.

## Two channels on the sales that happened

The swarm bought at 4 merchants: m01, m02 and m04 in hoodie, h05 in hotel-lisbon. On those 96
sales (`fixtures/live/swarm/s1.json`, a 2-bit set per sale):

| scope | sales | I(set; merchant) | I(set; merchant, amount) | amount given the merchant, exact | amount given the merchant, bucketed |
|---|---|---|---|---|---|
| hoodie | 48 | 1.50 | 2.00 | 0.50 | 0.00 |
| hotel-lisbon | 48 | 0.00 | 1.50 | 1.50 | 0.00 |
| all | 96 | 0.75 | 1.75 | 1.00 | 0.00 |

- In hoodie, m01 saw only the frequent and builder sets, m02 only traveller, m04 only regular.
  The merchant's name alone tells 1.50 bits. Bucketing removes the 0.50 the amount adds on top.
- In hotel-lisbon every set bought at h05, so the merchant tells nothing and the amount told 1.50
  bits. The bucket removes it.
- Weighted by sales, given the merchant: 1.00 bit per sale before, 0.00 after. At m01 the swarm's
  sales leaked 1 bit through the amount (two sets, two prices); the 2 bits in the table below
  assume all four sets bought there.

## The design: the "any" bucket

Every rule pays the same discount b, and the cap equals b. A buyer with one priced bit and a
buyer with all of them pay one price. Only "no priced bit" pays the base.

b is chosen so the merchant's expected revenue under the swarm prior stays the same at k = 0
(floored to a whole bps, so the merchant never earns less). Buyers with many bits pay more than
before, and buyers with few bits pay less. At k = 0 the mean change is 0.00 for 29 merchants and
0.04 dUSDC for h07, from the floor.

A bucket carries no cohort line, since the group unlock adds a bit. Two merchants have one, m01
and h08. At k >= k_min their exact schedule adds the group discount and the bucket does not, so
the bucket costs more there: the frequent set pays 4.92 more at m01, which is 10.25% of base, and
63.55 more at h08, 9.50%. The mean rise at k >= k_min is 2.40 at m01 and 46.83 at h08. The swarm's
m01 sales settled at the group price (36.00 and 36.96), so this is the cost that applied.

The alternative that costs no buyer anything at k = 0 is b = the exact cap. Then the merchant
pays the difference. Both costs are in the table.

Bounds come from the design. "any" has at most two prices, so one sale's amount tells at most
1 bit under every prior: every design entry carries `bound_bits` 1. A bound of 0 is a claim about
who buys. Only the live entry makes it, written by hand with its reason (`bound_why`): bkt-m01
prices world_id_human, and every swarm buyer proves it.

## Before and after, per merchant

Amount channel only. Bits leaked per sale, with every swarm set assumed at every merchant (the
swarm bought at 4 of these 30). "worst set pays more": the largest price rise for one swarm set
against the exact schedule, in dUSDC and as a share of the base, at k = 0 and, for a cohort line,
at k >= k_min. "no-loss cost": what b = cap would cost the merchant per sale, in dUSDC, under the
swarm prior at k = 0.

| merchant | before (swarm) | before (uniform) | after (swarm) | after (uniform) | b, bps | worst set pays more, k = 0 | worst set pays more, k >= k_min | no-loss cost to merchant, k = 0 |
|---|---|---|---|---|---|---|---|---|
| m01 | 2.00 | 3.00 | 0.00 | 0.54 | 1475 | 2.52 (5.3%) | 4.92 (10.25%) | 2.52 |
| m02 | 0.81 | 1.00 | 0.81 | 1.00 | 1000 | 0.00 (0.0%) | no cohort line | 0.00 |
| m03 | 1.00 | 2.00 | 0.00 | 0.81 | 1400 | 3.00 (6.0%) | no cohort line | 5.50 |
| m04 | 0.81 | 1.00 | 0.81 | 1.00 | 1800 | 0.00 (0.0%) | no cohort line | 0.00 |
| m05 | 0.81 | 1.00 | 0.81 | 1.00 | 1200 | 0.00 (0.0%) | no cohort line | 0.00 |
| m06 | 1.00 | 2.00 | 0.00 | 0.81 | 1250 | 3.90 (7.5%) | no cohort line | 3.90 |
| m07 | 0.00 | 0.00 | 0.00 | 0.00 | 0 | 0.00 (0.0%) | no cohort line | 0.00 |
| m08 | 0.00 | 1.00 | 0.00 | 1.00 | 1500 | 0.00 (0.0%) | no cohort line | 0.00 |
| m09 | 1.50 | 1.81 | 0.00 | 0.54 | 600 | 1.35 (3.0%) | no cohort line | 1.35 |
| m10 | 0.81 | 1.41 | 0.00 | 0.54 | 2250 | 1.50 (2.5%) | no cohort line | 1.50 |
| m11 | 1.50 | 1.50 | 1.00 | 0.81 | 1250 | 1.23 (2.5%) | no cohort line | 0.61 |
| m12 | 0.81 | 1.50 | 0.81 | 0.81 | 1600 | 0.00 (0.0%) | no cohort line | 0.00 |
| m13 | 1.00 | 2.00 | 0.00 | 0.81 | 1200 | 0.97 (2.0%) | no cohort line | 0.97 |
| m14 | 1.50 | 2.00 | 0.81 | 0.81 | 1000 | 1.01 (2.0%) | no cohort line | 3.03 |
| m15 | 1.50 | 1.81 | 0.81 | 0.54 | 1200 | 3.18 (6.0%) | no cohort line | 3.18 |
| m16 | 0.81 | 1.00 | 0.81 | 1.00 | 500 | 0.00 (0.0%) | no cohort line | 0.00 |
| m17 | 0.81 | 2.33 | 0.00 | 0.12 | 1100 | 0.49 (1.0%) | no cohort line | 6.43 |
| m18 | 1.00 | 1.00 | 1.00 | 1.00 | 1000 | 0.00 (0.0%) | no cohort line | 0.00 |
| m19 | 1.00 | 1.50 | 0.00 | 0.81 | 900 | 1.40 (3.0%) | no cohort line | 1.40 |
| m20 | 1.50 | 2.00 | 1.00 | 0.81 | 1700 | 1.62 (3.0%) | no cohort line | 0.81 |
| m21 | 0.81 | 2.00 | 0.81 | 0.81 | 1500 | 0.00 (0.0%) | no cohort line | 0.00 |
| m22 | 0.00 | 0.00 | 0.00 | 0.00 | 0 | 0.00 (0.0%) | no cohort line | 0.00 |
| h01 | 1.50 | 3.00 | 0.00 | 0.54 | 1125 | 139.39 (8.8%) | no cohort line | 139.39 |
| h02 | 1.00 | 1.00 | 1.00 | 1.00 | 800 | 0.00 (0.0%) | no cohort line | 0.00 |
| h03 | 1.50 | 2.00 | 1.00 | 0.81 | 1000 | 55.95 (5.0%) | no cohort line | 55.95 |
| h04 | 1.00 | 1.50 | 0.00 | 0.81 | 1500 | 72.60 (5.0%) | no cohort line | 72.60 |
| h05 | 1.50 | 2.25 | 0.00 | 0.54 | 1500 | 25.50 (5.0%) | no cohort line | 25.50 |
| h06 | 1.00 | 2.00 | 0.00 | 0.81 | 1150 | 84.83 (6.5%) | no cohort line | 84.83 |
| h07 | 1.50 | 1.81 | 0.81 | 0.54 | 666 | 27.76 (3.3%) | no cohort line | 51.94 |
| h08 | 1.00 | 2.00 | 0.00 | 0.81 | 1750 | 16.73 (2.5%) | 63.55 (9.50%) | 16.73 |

Summary, mean over 30 schedules, every swarm set assumed at every merchant, amount channel only:

- swarm prior: mean 1.03 bits per sale before, 0.41 after. 16 merchants leak 0 after (3 before),
  14 of them because every swarm set holds world_id_human; m07 and m22 price no bits. 25 leak under 1 bit after. 5 leak exactly 1
  bit (m11, m18, m20, h02, h03): each prices only a bit that half the swarm holds, so the discount
  itself is the bit. None leaks more than 1.
- uniform prior: mean 1.61 bits before, 0.72 after. The worst before is 3 bits (m01, h01); after,
  every merchant is at or under 1 bit.
- m01, the store the demo buys from, amount channel: 2 bits to 0 (swarm prior, all four sets
  assumed there), 3 bits to 0.54 (uniform). On the swarm's own m01 sales: 1 bit to 0.

## The check

    node scripts/leak-amount.mjs            prints both tables; FAILS if a merchant flagged
                                            bucketed: true leaks more than its bound_bits, if a
                                            bound is above its design's, if an "any" schedule is
                                            not one bps with the cap equal to it, or if
                                            agents/merchants-bucketed.json is stale
    node scripts/leak-amount.mjs --write    rewrites agents/merchants-bucketed.json
    node --test scripts/leak-amount.test.mjs

Offline, no keys. `agents/merchants-bucketed.json` is a separate file. `agents/merchants.json`
and every fixture are unchanged, so `make verify` and `make fixtures-check` see the same inputs.
Each entry carries `bucketed: true`, `design`, `bound_bits` (swarm and uniform) and its schedule.
An entry with `account: null` is a design. An entry with an account is registered on testnet. A
bucketed schedule with a cohort line fails the check. A test feeds a prior with a set that holds
no priced bit: the bound is 1, the leak is above 0, and a hand-written bound of 0 fails.

## Live on testnet

`bkt-m01.bookerbob-demo.testnet` joined the open category with m01's bucket: base 48 dUSDC,
claude_spender, world_id_human and airbnb_frequent at 1475 bps each, cap 1475. No owner step: a
10 dUSDC bond approved it (`scripts/join-merchant.mjs` with `JOIN_SCHEDULE`).

| step | tx |
|---|---|
| create account | [FgrwXYhM…](https://testnet.nearblocks.io/txns/FgrwXYhMxwxPUqLVfiRXxQdLsoCKDSXQBJX4TM8poyk2) |
| register_merchant, category open | [H9o4MTXV…](https://testnet.nearblocks.io/txns/H9o4MTXVRMpGpeRXWDNnVs1TG5BiNdMfQ327yNU9Wu9y) |
| bond 10 dUSDC | [5qCd4CZB…](https://testnet.nearblocks.io/txns/5qCd4CZBgtRxD1X3GeoxQHCg1xGJ2ZVDHZkQUzDsoppy) |

Five buyers then bought from it, each a fresh one-time implicit account, each with a sealed
verdict (hashes only on chain). Each sealed a different bit set, as we recorded it in
`fixtures/live/bucketed/run.json`. The chain holds only the hashes and we keep the salts, so the
sets cannot be checked on chain. All five paid 40.92 dUSDC. The equal price is by construction:
under this schedule any set with a priced bit gives 40.92. The run shows the deployed contract
pricing a bucketed schedule and settling it. At m01's exact schedule the same five sets would pay
44.16, 38.40, 41.76, 43.20 and 39.36.

| sealed bit set (as recorded) | buyer | verdict | receipt | settle | paid |
|---|---|---|---|---|---|
| {world_id_human} | `b8c15f87aadf..` | [7L2PvqGs…](https://testnet.nearblocks.io/txns/7L2PvqGs3P2x8sZ3U4Mwft6gfT3RyTAN9wvsnGetrQo4) | [6EMo4Uyr…](https://testnet.nearblocks.io/txns/6EMo4Uyr2mA5Rd4rC2xxs9fP2JcKgcWNaMkNyAPrWBr8) | [FBYsGHKD…](https://testnet.nearblocks.io/txns/FBYsGHKDTDu5ttDpZzeDbQRSxQA5YDAt3AsdCm1je74V) | 40.92 |
| {airbnb_frequent, claude_spender, world_id_human} | `6787f5ad4171..` | [6CHhBGyA…](https://testnet.nearblocks.io/txns/6CHhBGyAhma5CMMwA5vcbFA7ok1jmCsWuhEr3XK7nA4r) | [Bff6YYiA…](https://testnet.nearblocks.io/txns/Bff6YYiAxDGaA9kgE2DQdj7vWVkGPLDWgpwcEa1UC9sA) | [AgA3sMSi…](https://testnet.nearblocks.io/txns/AgA3sMSiaF1Y5skBd9KYV5ZTwJStdiRAhEJUZfjToGDa) | 40.92 |
| {airbnb_frequent, world_id_human} | `c3330cf072f1..` | [B35iJs6V…](https://testnet.nearblocks.io/txns/B35iJs6VVkr9cLxwCsBQPPVAEhfkUF3Z4RJdS7AB91he) | [8LXTk1gN…](https://testnet.nearblocks.io/txns/8LXTk1gNRRF7Zc1Hke2stjw52PbqFUo6oYoqMhwr2Pu4) | [3QPQkfnG…](https://testnet.nearblocks.io/txns/3QPQkfnGgPpXxEFz6Vq5sKDZZJV8cK48DeVS8rSumfru) | 40.92 |
| {claude_spender} | `0eb5cdf06120..` | [HMjwL5Nd…](https://testnet.nearblocks.io/txns/HMjwL5NdXbeu8GSukzTVn97CgycPUn3RGJHmc6Fci2L1) | [FNgtnmqS…](https://testnet.nearblocks.io/txns/FNgtnmqSoKuJ3anabXapgmpzVybPq9EPTrt18FiBCLQf) | [6Z16Z1wn…](https://testnet.nearblocks.io/txns/6Z16Z1wnzHMfcGw2MPhVfTJFe9T6R3V7B2Psgdcbvd3H) | 40.92 |
| {claude_spender, world_id_human} | `7808e03777a9..` | [AUTc4ZdM…](https://testnet.nearblocks.io/txns/AUTc4ZdMrkEsChB344Ywx8B3GwRwAMzZ1JBVoEmksoaQ) | [7uh4Wjzd…](https://testnet.nearblocks.io/txns/7uh4WjzdG5FEzacaEWUUoKxARZQWdB1WTa68NGsWai6g) | [27NwBG3j…](https://testnet.nearblocks.io/txns/27NwBG3jAqsroRqa2Wiq2ahKgrmdBECiU9mLHrxTtQYP) | 40.92 |

Read back over public RPC, no keys:

    node scripts/bucketed-buy.mjs check

It checks:
- that the schedule on chain equals the record;
- each settle's `settled` event (nullifier, merchant, amount);
- that each amount is non-empty and equals the schedule's quote for its recorded set;
- that the merchant received the amount less the bazaar fee (100 bps: 40.5108);
- that each verdict on chain is sealed with no predicates;
- that the recorded sets differ and the amount is one.

L10 on 40.92 at bkt-m01 leaves 7 of 8 bit sets; at m01 every amount leaves 1 of 8. The record
holds account ids, nullifiers, tx hashes and the synthetic predicates each buyer sealed. No seed
and no opening salt is in it.

The five buyers share one amount at one merchant, so this merchant's amount set is 5, at the
k-gate's floor (L6, k = 5). The testnet manifest lists their tx hashes; `make leak` does not
analyse them yet.

## Limits

- Merchant choice leaks about 1.5 bits in hoodie, and bucketing does not touch it. Which merchant
  a buyer picks follows the buyer's bits. A bucketed merchant next to exact ones adds to this: a
  buyer with many bits pays less at exact m01 (38.40) than at the bucket (40.92), so buyers sort
  by bits, and the "revenue kept" sum, which assumes every set buys at the bucket, no longer holds.
- The headline numbers are counterfactual. The 30-merchant mean assumes all four swarm sets buy
  at every merchant; the swarm bought at 4.
- The prior is ours and degenerate: every swarm set proves world_id_human. A real population
  differs, and the leak is re-measured against it with the same function.
- The merchant knows the bucket. A buyer who pays 40.92 holds at least one priced bit. Under a
  prior where some buyers hold none, that is up to 1 bit, and it is the bit the discount is for.
- The referee sees the opening. It prices from the sealed predicates, so it learns the exact set.
  The referee key is held by us (the BookerBob operator) today, see `docs/details.md`.
- Timing, funding and account links (L1 to L8) are untouched. The five buyers here were funded by
  one treasury, minutes apart.
- The group unlock adds a bit. A cohort line pays more once k verdicts reveal its predicate, so a
  bucketed schedule carries none, and the check refuses one. Against a group price the bucket
  costs the worst set up to 10.25% of base (m01).
- The bucket costs someone. Revenue-neutral b moves money from buyers with many bits to buyers
  with few: at k = 0 up to 8.8% of base for one set (h01), at k >= k_min up to 10.25% (m01).
  b = cap costs no buyer at k = 0, and the merchant pays instead.
- A merchant chooses its schedule. Nothing on chain makes a merchant bucket. The check covers the
  schedules in this repo, and a buyer agent can read any merchant's schedule and run the same
  measure before buying.
- The live sets are as we recorded them, and the equal price follows from the schedule.
- Ours are synthetic accounts: the buyers, the facts, the merchant and dUSDC (a testnet demo
  token). Testnet only.
