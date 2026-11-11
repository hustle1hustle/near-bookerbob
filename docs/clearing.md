# One price for a batch

Design: Dan (DenisDI), who runs an intents solver on CoW Protocol. This page is his method as
it is in the code. Status: built, with tests, on the branch `clearing`; not on testnet and not in the contract on `main`, so the deployed code and `main` stay the same build. A new money path does not go live before the submission. The numbers below are an
illustration, not a testnet round.

It is a third mechanism on the same bazaar, next to the single winner of a round and the fixed
group tiers. It is needed only when the cheapest merchant does not have enough seats for the
group. Nothing else changes: the 10% and 20% tiers, `offer_group`, the live groups and every
earlier method behave as before.

## The method

A buying group is the one `post_intent` already builds: buyers who revealed the same predicate
set in one category and context, each with a budget commitment. A round is the one `open_round`
already runs: merchants commit a hash of a schedule, then reveal it. After the reveal deadline
anyone may call

```
propose_clearing(group, round_id, price, opens[], fills[]) -> bool
```

- `opens[]`: `{nullifier, budget, salt}` per member. Each opens that member's stored commitment,
  `sha256("<budget in base units>|<salt, 64 hex>")`, the bytes `scripts/demo-tester.mjs` has
  posted since groups exist. Budgets open in this call, after the bids are revealed, so no
  schedule can be fitted to an opened budget. The reverse is not prevented: `post_intent` has
  no deadline against the round, so a member can commit its budget after the schedules are
  public and fit it to them.
- `fills[]`: `{nullifier, merchant}` pairs: who sits where.
- `price`: the one price every seat pays.

The contract searches nothing. It checks bounds (`propose_clearing` in `contract/src/lib.rs`
on the branch `clearing`; the method is not in `main`):

| check | refusal |
|---|---|
| the round's reveal deadline has passed | `round still open` |
| the round and the group are in one category | `the round is in another category` |
| each opening is for a member, once, and opens its commitment | `not a member of this group`, `a budget is opened once`, `budget does not open its commitment` |
| each member sits at most once, and has an opening | `a participant sits once`, `no budget opening for this participant` |
| the merchant revealed in this round and is approved | `merchant did not reveal in this round`, `merchant not approved` |
| no more seats at a merchant than it declared for the round | `more seats than the merchant declared for this round` |
| the member's verdict is unspent, unexpired, above the TCB floor | `nullifier spent`, `verdict expired` |
| q = the contract's own quote of the merchant's schedule for the member's verdict; `q <= price` | `price below a seat's code price` |
| `price <= budget` of that member | `price above a participant's budget` |
| `price == max q` over the filled seats | `price is not the highest code price among the filled seats` |

q is never a number from the proposal: it is `quote_for`, the same code as the `quote` view and
the referee's price. The price cannot be raised above the dearest seat taken, so no difference
goes to the proposer. A merchant whose schedule is cheaper is paid the same one price.

A standing proposal is replaced only by one that fills more seats, or the same number at a
lower price. A valid proposal that does not beat it returns `false` and changes nothing (event
`clearing_kept`); one that stands emits `clearing_proposed`. Once opened, the same proposal can
be sent by anyone, and the contract keeps the best. When the first seat pays, the price is
final and no proposal replaces it. There is no proposal window between those two rules: a
member can propose a clearing that seats only itself, pay at once, and lock the group at that
proposal before a fuller one arrives.

Views: `clearing(group)`, `clearing_seat(nullifier) -> (merchant, price)`, `round_seats(round_id, merchant)`.

## Seats

A revealed schedule has a base price and discount rules, and no capacity. A merchant declares
its seats for a round with `declare_seats(round_id, seats)` before the commit deadline, so not
in answer to a rival's schedule. The bid commitment and `reveal_bid` are unchanged. A merchant
that declared nothing has one seat: it never said it can serve more than one buyer of a batch.

## Paying

`settle_clearing_demo(nullifier, checkout_ref, amount)`: a seated member pays the one price to
its assigned merchant in dUSDC. It runs the group settle path: the same private
`take_payment_at`, the same `ft_transfer`, the same `on_settle_transfer` callback and rollback.
The receipt rule is unchanged: the member needs a referee receipt for that merchant, and the
nullifier burns once. The receipt carries the merchant's own code price; the amount paid is the
clearing price, never below the receipt and never above the verdict's cap. A dispute refunds
what was paid.

`settle_group_demo` and `pledge_group_demo` are untouched, so a member can still take a tier
offer; one verdict pays once, whichever path it takes.

## The solver

The code price of a seat is fixed by the schedule, so there is no price to search, only seats
to assign. For one predicate set the price depends on the merchant alone, and the enumeration
is exact (`sdk/clearing.mjs` here, `core/src/clearing.rs` on the branch `clearing`, both tested on `fixtures/clearing.json`):

1. Expand capacity into seats and sort them by code price.
2. For each r take the r cheapest seats. P is the code price of the r-th.
3. The set is valid if at least r budgets are not below P.
4. Take the largest valid r; on a tie the lower P.

The solver only finds an assignment. The contract does not trust it and does not replay it.

## Dan's three examples

| merchant | code price | seats |
|---|---:|---:|
| A | 340 | 2 |
| B | 355 | 2 |
| C | 368 | 2 |
| D | 390 | 3 |

Budgets: 400, 400, 380, 370, 360.

- Cheap seats run out. r = 4, P = 355: A x 2 and B x 2. All five can pay 355 and there are
  four seats; who is left out, the price does not decide. The fifth buyer (budget 360) on D at
  390 is refused: the budget is below the price. The same seating at 365 is refused: 365 is
  above the highest code price, 355. Two seats at 340 pass the checks and do not replace the
  standing proposal: fewer seats.
- The last budget is 368. r = 5, P = 368: A x 2, B x 2, C x 1. All five pay 368.
- A has five seats. r = 5, P = 340, all at A. A fill across merchants adds nothing here: the
  single winner of the round already does this.

Each is a test in `contract/src/tests.rs` (`mod clearing`, on the branch `clearing`) with these numbers, and a case in
`fixtures/clearing.json`. The same enumeration, editable: `agents/clearing.html`.

## How it differs from the fixed tiers

A tier is an announced discount. On testnet the public rate is 510.00, one proven buyer pays
408.00, and a group of five pays 367.20: that is 408 minus the announced 10%, a number in the
tier table before the group formed. It is not a clearing price.

A clearing price runs the other way. It is the dearest code price among the seats really
taken, found after the schedules and the budgets are open.

## What it reuses

- the group and its budget commitments from `post_intent` (until now nothing read them);
- the revealed schedules of a round (`reveal_bid`);
- the contract's price code (`quote_for`);
- the receipt rule and the group settle path (`take_payment_at`, `on_settle_transfer`).

State: the contract's state struct is unchanged. The standing clearing is JSON under the raw
storage key `uc|<group>`, declared seats under `us|<round>|<merchant>`.

## What it does not do

- It is not strategy-proof. The score is seats first, so a fifth buyer can raise what the
  other four pay (355 to 368 in the examples above). The one price is the dearest code price
  among the seats taken, so the marginal merchant sets it, and a merchant that declares fewer
  seats can lift it.
- No search on chain. A proposal is checked, not found.
- No surplus split: nobody is paid a difference between a budget and the price.
- No swaps between buyers. Demand for seats meets merchants' capacity, nothing else.
- No new token, no second market, no outside intent bus.
- The referee key is still ours. The contract checks the referee's signature and the price
  from the schedule. It does not replay how the referee matched a claim to the proofs. The
  receipt covers the merchant's claim, not the seating.
- The price is the merchant's schedule as it stands when the proposal is checked, as in
  `round_best_quote`; a verdict's spend cap is checked when it pays, not when it is seated.
- Cleared seats pay one by one. The DAO pot (`pledge_group_demo`, `release_group`) pays one
  merchant and is not extended to a clearing.
- dUSDC on testnet only, like the group path it extends.
