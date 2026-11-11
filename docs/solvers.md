# How an outside solver sees BookerBob today

For an engineer who knows batch auctions and solver competition. Source of truth is the code;
refs are `file:line` at the working tree of 2026-11-10. Testnet only, dUSDC has no value.
The contract is `contract/src/lib.rs` (abbreviated `lib.rs`).

## How the pieces link (all exist, one market)

```
 buyer agent: verdict (submit_verdict) + ask (off chain)         INTENT
      | nullifier, predicates, cohort counters
      v
 open_round(owner) -> commit_bid -> reveal_bid                   ROUND / SOLVER
      | revealed schedules; round_best_quote(round, nullifier)
      v
 post_intent -> offer_group (fixed tiers, persons >= 5)          GROUP (optional)
      | quote_for / group_tier
      v
 request_referee | submit_referee_result                         REFEREE: receipt or refusal
      | verdict.receipt = (merchant, price)
      v
 settle | settle_demo | settle_group_demo | pledge_group_demo    SETTLE: nullifier burned,
      |   on_settle_transfer (pays, or rolls back)                merchant paid, or reverted
      v
 join_review_group -> submit_review -> reveal_review             STANDING: sealed ratings from
      -> submit_graph_scores (Jolt-proven, challengeable)         buyers who paid
      .
      . planned, not built: an anchor that records round roots
```

## 1. What an intent is today

There is no intent object for a single purchase. An intent is a signed verdict plus an ask
that the buyer's agent handles off chain. The verdict (`submit_verdict`, `lib.rs:2225`; envelope
`docs/envelope.md`) carries a per-context nullifier, up to seven predicate bits, a spend cap,
an expiry and the agent account allowed to act (`cnf`). The ask ("3 nights Lisbon under 450")
is parsed and ranked by the buyer's own code, from `agents/merchants.json`, not from chain
(`sdk/buy.mjs:30-56`). The chain never sees the ask or the budget.

`post_intent(nullifier, category, budget_commitment)` (`lib.rs:1667`) exists only for buying
groups. It needs an unspent, non-sealed verdict (`:1673-1674`), a World-bound agent (`:1675`),
and stores a sha256 budget commitment in a group keyed by `sha256(category, context, sorted
predicates)` (`:1677-1678`, `core` type `BuyingGroup` `:575`). A single purchase never calls
it. A sealed verdict (hashes only) cannot join a group or be quoted on chain (`:1673`, `:776`).

## 2. What a solver (merchant agent) sees

| item | visible on chain | where |
|---|---|---|
| buyer agent account, context, predicate bits, tier, TCB status, issuer, `max_spend`, expiry, spent flag, receipt | yes, per nullifier | `VerdictRecord` `lib.rs:35`, view `verdict` `:2492` |
| cohort size k per (context, predicate) and a hash-chain root | yes | `cohort_size` `:787`, `cohort_root` `:781` |
| group: category, context, predicates, member nullifiers, distinct persons, best offer | yes | `BuyingGroup` `:575`, view `buying_group` `:1706` |
| group member budgets | commitment only, `sha256(budget||salt)` | `:1694` |
| round: category, both deadlines, committed hashes, who revealed | yes | `Round` `:159`, view `round` `:2186` |
| rival schedules | hash until `reveal_bid`, then plain | `:2054-2089` |
| price for a (merchant, verdict) | computed by view | `quote` `:2542`, `best_quote` `:2557` |
| raw history, the proof set, the buyer's budget, a sealed verdict's bits | never | `docs/envelope.md`; `core/src/envelope.rs:77` |

A buyer is an account plus bits, not a quote request. A round names no buyer: it is per
category (`lib.rs:2020`). Merchants bid before any buyer is known to the round.

## 3. The round, step by step

1. `open_round(round_id: String, category: String, commit_until_ms: u64, reveal_until_ms: u64)`.
   Owner only (`lib.rs:2020`, `assert_owner` `:791`). Requires `now < commit_until < reveal_until`,
   id 1..=64 bytes. Deadlines are block time in ms. Live view: section 7.
2. `commit_bid(round_id, commitment: String)` (`:2034`), payable for storage only (excess is
   refunded, `:389-398`). Caller must be an approved merchant of the round's category, once per
   merchant, before `commit_until_ms`, at most 100 commits (`MAX_ROUND_BIDS` `:151`).
   Preimage (`core/src/bid.rs:7-13`, SDK `sdk/merchant.mjs:60`):
   `sha256("bookerbob/bid/v0\0" || account_id || 0x00 || json(schedule) || salt32)`, where json
   is serde field order `base_price` (decimal string), `rules[{predicate,bps}]`, `cap_bps`,
   optional `cohort{predicate,k_min,bps}`.
3. `reveal_bid(round_id, schedule: Schedule, salt: String hex32)` (`:2054`), payable for storage.
   Window `commit_until_ms <= now < reveal_until_ms` (`:2062-2063`). Checks: schedule valid
   (`price.rs:68-103`), a commit exists, not yet revealed, hash opens the commitment (`:2068`),
   base not above the merchant's price anchor if one is set (`:2069`, `:680`). In category
   `open` only: a merchant is refused if its payout account equals an already revealed one, or a
   `hire` edge links the two either way (`:2071-2079`). The reveal overwrites the merchant's
   stored schedule (`:2086`), so it also becomes its quote outside the round. A commit never
   revealed costs the merchant since the 2026-11-10 redeploy (the paragraph after this list).
4. Winner: `round_best_quote(round_id, nullifier) -> Option<{merchant, quote}>` (`:2192-2209`).
   Panics before `reveal_until_ms`. For each revealed merchant still approved, price the verdict
   with that merchant's current schedule; lowest price wins; a tie keeps the earlier entry in
   reveal order (strict `<`, `:2204`). The round stores no schedule (`Round`, `:159-166`), so
   in category `open`, where a bonded merchant stays approved on a re-register (`:1207-1210`),
   a merchant can reveal, read its rivals, register a lower schedule and be returned as the
   winner. Status: open as of 2026-11-11, not fixed in the deployed contract (README, Known
   limits). It does not check the TCB floor (`best_quote` does,
   `:2563`) and does not check that the verdict's context matches the round's category.
5. Receipt. `request_referee(project_id, input_data)` (`:2713`, sealed input only, forwards to
   OutLayer) or any relayer calling `submit_referee_result(result: WorkerResult)` (`:2706`).
   The contract checks a registered referee key, its ed25519 signature, that the result names
   this verdict digest, and that the price equals `quote_for` (`:2783-2836`). Outcome
   `receipt` stores `(merchant, price)` on the verdict; `refused` only logs `receipt_refused`.
   Not live on testnet yet (README Deployments: "Not on testnet yet: the OutLayer referee").
6. `settle(nullifier, merchant, checkout_ref, amount: U128)` (`:2986`; `settle_demo` `:2997`
   pays in dUSDC). Caller is the verdict's agent. `take_payment_at` (`:3028-3136`) requires:
   merchant approved, not spent, agent match, TCB floor, not expired, a receipt for this
   merchant, `amount == receipt price`, price <= `max_spend`, mandate limits (`:3146-3166`),
   escrow >= price. Then: escrow debited, `spent = true` (the nullifier burn), fee taken out of
   the price (`fee_rate`), liability hash written, event `settled`. Then an `ft_transfer` to
   the merchant payout; `on_settle_transfer` (`:3127`) sets `paid`, or `on_settle_rollback`
   restores escrow, mandate count, fee and `spent = false` (`:3162-3191`).
   The round does not bind the payment: only a mandate with `round` set makes `settle` require
   the round winner (`:3158-3164`; README Known limits).

A commit never revealed (live on both bazaars since the 2026-11-10 redeploy, run once in
round `silent-1`, docs/testnet.md; finding: Dan). The commitment stops a merchant
from changing its bid, not from withholding it after it saw the others. `mark_unrevealed(round_id,
merchant)` (`:2099`) is open to anyone once `now >= reveal_until_ms`, for 24 hours
(`UNREVEALED_MARK_WINDOW_MS` `:175`), once per merchant and round, only for a merchant in
`commits` and not in `revealed`. It takes `UNREVEALED_FORFEIT` (`:170`, 1 token, a tenth of
`OPEN_BOND`) from the merchant's bond, USDC first, then dUSDC, or what the bond holds if less,
and `commit_bid` refuses the merchant until 24 hours after the marking (`UNREVEALED_BAR_MS`
`:172`, checked at `:2040`). The forfeit moves to a counter (`forfeited_bonds(token)`) that no
method pays out: the caller, the owner and the rival bidders gain nothing, so there is no race
to mark and no reason to cause a default. Approval, schedule, earlier rounds and purchases are
not touched. Views: `unrevealed_defaults`, `unrevealed_in_round`, `barred_until`, `is_barred`;
event `bid_unrevealed`. Why not a deposit per commit: only `open` merchants hold a bond, and a
new deposit would change `commit_bid` for the 30 live merchants and their scripts. What it
does not cover: a merchant with no bond only sits out, and in an `open` round a merchant linked
to one already revealed is not marked (`:2110-2113`), because its reveal would have been
refused (`:2071-2079`) and the other side can make that link alone. So an operator with two
linked accounts still chooses freely between two bids, and a merchant that hires a rival and
reveals first still shuts that rival out of the round. That needs a rule on who made the link
and when, not a forfeit. The forfeit is also flat, 1 token whatever the sale, and the
one-operator rule sees only declared links: two accounts with no shared payout and no hire
edge keep the choice to withhold the lower bid for 1 token.

What a merchant chooses: a `Schedule` = `base_price`, one discount `bps` per known predicate
(seven, `docs/envelope.md`), `cap_bps`, and optionally one cohort rule with `k_min >= 5`
(`price.rs:58-102`). What code does: price = base minus capped sum of the matching rules, plus
the cohort line when k >= `k_min`, never above base (`price.rs:116-142`, shared guest
`bookerbob-zkcore`). A merchant cannot choose a price per buyer, cannot see the buyer's
non-revealed bits and cannot raise a price above its base. In an owner-approved category it
cannot change a schedule after committing without losing the round: a re-register drops its
approval and `round_best_quote` skips it, unless the owner approves the new schedule. In
`open` it can today: a bonded merchant stays approved on a re-register and the round prices
its current schedule, so the sealed bid does not bind after the reveal (step 4 above). It can
choose a different base each round, subject to the owner's price anchor.

## 4. Buying groups

- Join: `post_intent` per member verdict (section 1). Persons are counted once per World-bound
  person (`:1687-1692`); `group_tier(persons)` = 10% at 5 persons, 20% at 10 (`GROUP_TIERS`
  `:697`, `:711`). There is no leave method; persons never decrease.
- Offer: `offer_group(group, bps: u16)` (`:1716`): an approved merchant of the category offers
  10% or 20%, at most the unlocked tier, and the lowest member price stands (price from the
  first member's verdict, `:1727-1730`). Public, not sealed. Refused while non-refunded
  pledges stand (`:1726`).
- One price: every member pays `receipt price minus the tier` (`take_payment_at` `:3049`,
  `group_bps`). One merchant per group: `offer` is a single `(merchant, bps, price)`
  (`BuyingGroup.offer` `:586`). A solver cannot bundle merchants into one fill.
- Pay: `settle_group_demo` (`:1741`, dUSDC only; no USDC group path) pays the merchant per
  member, or `bind_group_treasury` (`:1758`) + `pledge_group_demo` (`:1777`) hold the pot under a
  DAO that calls `release_group` (`:1835`, needs standing pledges >= the tier's k) or
  `refund_group` (`:1809`).
- Dropout: a member who never settles is simply absent. In the DAO path the DAO refunds the
  pledge; if fewer than k pledges stand, `release_group` is refused (`:1841`). In the direct
  path the tier is not rechecked against paid members (`:1745` checks persons only), so a group
  can settle partly.
- Each member still needs its own referee receipt for the offering merchant (`:3049-3051`).

## 5. Mapping (honest)

Reviewed by Dan (DenisDI, who runs a solver on CoW Protocol), 2026-11-10. His verdict, which
this table follows: of the three mappings we first drew, one is honest. The referee and its
receipts are checkable settlement, with one caveat: the referee key is ours, and the contract
checks its signature and the schedule price, not how the referee matched the claim to the
proofs. Sealed bids are a contest of schedules, not solver competition. The group tier is an
announced discount (367.20 is 408 minus a fixed 10%, a number in the tier table before the
group formed), not a clearing price. A batch with one price is a third mechanism, not built
into the deployed contract; it matters only when the cheap merchant runs out of seats.

| CoW / NEAR Intents | BookerBob today | where the analogy breaks |
|---|---|---|
| intent | verdict (bits, cap, expiry, nullifier) + off-chain ask | no signed order with sell/buy amounts; the chain never holds the ask or a limit price |
| solver | a merchant agent with a registered schedule | it sells its own goods; it does not route liquidity or fill other parties |
| solver competition (sealed bids) | commit/reveal of a schedule per round (`:2034`, `:2054`) | bids a pricing function, not a price per intent; round precedes any buyer; a commit never revealed costs 1 token of bond and a 24 hour bar since 2026-11-10 (section 3); in `open` the schedule can still change after the reveal |
| batch | a round = one category, two deadlines | not a set of orders; one buyer is priced at a time, after the fact |
| uniform clearing price | group tier: one discount for all members of a group (`:1727`) | a fixed 10%/20% off one merchant's receipt, not a market-clearing price |
| settlement | `settle`: escrow debit, nullifier burn, `ft_transfer`, rollback | one buyer, one merchant, one token, one call; no multi-party atomic batch; round not enforced without a mandate |
| solver bonding and slashing | open category: 10 dUSDC bond approves a merchant (`:1210`, `OPEN_BOND` `:280`) | bond refunds disputed buyers up to its size (`:2904`); live since 2026-11-10: `mark_unrevealed` (`:2099`) takes 1 token of it per skipped reveal, held by the contract and paid to no one, and bars the merchant from `commit_bid` for 24 hours; a merchant with no bond only gets the bar; nothing is slashed for losing |
| surplus | buyer pays the code-computed price; no surplus split | no limit price, so no surplus measure |
| who can be a solver | open category: anyone who bonds; other categories: owner approves (`:1219`) | revealing is also gated by the same-operator rule only in `open` (`:2071`) |
| cross-chain | none; NEAR only, dUSDC on testnet | no solver bridge or foreign-chain settlement in the contract |

## 6. What an outside solver would need that does not exist yet

- A machine-readable intent feed: not built. Today only events (`verdict_submitted`
  `lib.rs:2468`, `intent_posted` `:1701`, `bid_committed`, `round_opened`) and views.
- An intent format compatible with NEAR Intents (signed messages with amounts): not built.
- Multi-merchant fills, a bundle of merchants in one fill: not built (`offer` is one merchant).
- A clearing price across bids or buyers: not built.
- Per-intent bids (a price for this verdict) instead of a schedule: not built.
- A forfeit sized to the sale for committing and not revealing: not built. A flat forfeit of
  1 token and a 24 hour bar are live (section 3).
- A revealed schedule pinned in the round, so that a bid binds in `open`: not built.
- Group settlement in USDC (only the dUSDC `_demo` paths exist): not built.
- An anchor recording round roots: planned, not built.

## If this grows into a batch auction: what is reused, what would change

The rule is to build on the existing bazaar, never beside it: no new contract, no second market.

| goal | extends (exists today) | what would really change |
|---|---|---|
| uniform clearing price | `group_tier` / `GROUP_TIERS` (`lib.rs:697-713`), `offer_group` (`:1716`), receipt price minus `group_bps` in `take_payment_at` (`:3049`); price code `bookerbob-zkcore` | `offer_group` and `group_tier` would become a computed tier instead of two fixed ones; the Jolt price guest would need to prove it. No new contract, no second market |
| multi-merchant fills | `BuyingGroup.offer` (`:586`), `release_group` pays one `payout` (`:1835`), receipt `RefereeReceipt` is one merchant (`:65`) | `offer` becomes a list and `release_group` splits the pot; `take_payment_at` already checks one receipt per nullifier, so one receipt per fill stays. No new contract, no second market |
| intent feed | events `verdict_submitted`, `intent_posted`, `round_opened`; views `buying_group`, `round`, `verdict`, `cohort_size` | read side only (an indexer over these events); `post_intent` stays the one write. No new contract, no second market |

## 7. Try it (testnet, no money)

From `AGENTS.md` ("Join the market as a merchant agent"). With your own testnet account and
key (`JOIN_ACCOUNT`, `JOIN_KEY_FILE`, see AGENTS.md) nothing of ours is needed; without them
the script needs the demo keys in `~/.rep-secrets/bookerbob-testnet`. The own-account path has
unit tests only so far (`scripts/join-merchant.test.mjs`); no live run of it is recorded in
docs/testnet.md. The owner opens rounds, you cannot.

```
node scripts/join-merchant.mjs join <your-name> <base_usdc> <discount_bps>
node scripts/join-merchant.mjs bid <your-name> <round_id>      # before the commit deadline
node scripts/join-merchant.mjs reveal <your-name> <round_id>   # waits for the commit deadline
node scripts/join-merchant.mjs winner <round_id> <nullifier>   # after the reveal deadline
```

Read-only, no keys (live output of 2026-11-10 from `bookerbob.testnet`):

```
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"bookerbob.testnet","method_name":"round","args_base64":"eyJyb3VuZF9pZCI6ImIzMC1ob3RlbC1saXNib24ifQ=="}}'
```
(result bytes decode to JSON) `{"category":"hotel-lisbon","commit_until_ms":1793828800670,"reveal_until_ms":1793829340670,"commits":[["h01.bookerbob.testnet","3539d60c..."], ... 8 commits],"revealed":[h01 ... h08]}`

For `round_best_quote` use args `{"round_id":"b30-hotel-lisbon","nullifier":"bdd29821...9039"}` (full nullifier in
`fixtures/live/testnet-manifest.json:688`), base64-encoded the same way. Output:

```
{"merchant":"h05.bookerbob.testnet","quote":{"base_price":"510000000","lines":[{"predicate":"airbnb_frequent","bps":500},{"predicate":"claude_spender","bps":500},{"predicate":"world_id_human","bps":1000}],"discount_bps":2000,"price":"408000000"}}
```
`cohort_size {"context":"bookerbob:v0:lisbon-hotel","predicate":"world_id_human"}` returned `0`.

## Mismatches found

- README says the group price unlocks "at k >= 5" as one thing. Code has two: a merchant's own
  cohort rule counts verdicts per (context, predicate) with `k_min >= 5` (`price.rs:96`), and
  buying groups count distinct World-bound persons with tiers at 5 and 10 (`lib.rs:697`).
- The demo buyer's verdict context is `bookerbob:v0:demo-hoodie`, yet `round_best_quote` prices
  it in the hotel round and returns h05 at 408: the round does not check context against
  category (`lib.rs:2196-2209`). The README presents this as the hotel winner for that buyer.
- `offer_group` prices the offer from the first member's verdict only (`:1727`), while each
  member pays its own receipt minus the tier (`:3049`); the offer price is advisory.
