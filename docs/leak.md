# make leak: what a passive observer links

`make leak` reads only public testnet data (signers, receivers, args, events, block heights,
funding) for the txs in `fixtures/live/testnet-manifest.json` and applies four rules:

| rule | signal |
|---|---|
| L1 same account | calls signed or delegated by one account belong to one actor |
| L2 timing order | the k-th sealed rating follows the k-th review-group join |
| L3 funding | review senders funded by the same relayer as the buyers |
| L4 reveal | a revealed rating opens one sealed hash, so it is tied to its sender |

## Before (2026-11-05, round 5979413, `docs/leak-before.json`)

6 buyers, 6 sealed ratings for m01, each rating a valid Semaphore proof from a fresh one-time
account through the relayer.

- L1: each buyer's verdict, settle and review-group join are one account (expected: one
  purchase, one demo account).
- **L2: 6 of 6 ratings linked to the buyer who wrote them, by order alone.** The demo
  script sealed the ratings in the order the buyers had joined. Semaphore hid which member
  rated; the sending pattern gave it back.
- L3: one funder (the relayer) for all review senders and all buyers: narrows a rating to
  the relayer's buyers (6), no further.
- L4: by design; harmless unless combined with L2.

Verdict: a leak. Ratings were not anonymous in practice, though every proof was valid.

## Fix

- The demo funds each rating's one-time account in one random order and sends the ratings
  in another (crypto randomness), independent of the order buyers joined
  (`scripts/demo-reviews.mjs`).
- The manifest lists rating senders sorted, so the published data never pairs a rating with
  a buyer; `make leak` scores its guesses against the demo operator's local state only.
- The k floor counts distinct World-bound persons (`review_persons`), not purchases: one
  person buying twice is one member for release. `join_review_group` needs a World binding.
  Redeployed: [9jYWreQZ…](https://testnet.nearblocks.io/txns/9jYWreQZN16Q2CWuymWa55swScHTn2yPuSRNqeVGcaFg).

## After (2026-11-05, round 5979416, `docs/leak-report-5979416.json`)

Same 6 buyers, a new round: 6 sealed ratings, revealed, released by
[BnC8mMa4…](https://testnet.nearblocks.io/txns/BnC8mMa4t6RaPpxbptTLzrpDDN7nXhJbtvW2EFHoH59F) (m01 now 12 ratings, score 4.00).

- L2: the order adversary gets 1 of 6 right, what a random guess gets. Unlinked; the
  anonymity set is back to the group.
- L1, L3, L4 unchanged (see Before).

## L5: plaintext facts in tx args (added 2026-11-05)

`make leak` decodes the args of every recorded tester tx, delegate actions included (66 txs),
and searches them for the proof set's field names and proof refs; it first checks that a
plaintext referee input would be caught. Result: none. The verdict carries predicate bits and
hashes, the receipt a price and hashes, never a fact. The one call that would carry facts,
`request_referee`, now refuses anything but input sealed to the worker's X25519 key
(`worker/src/sealed.rs`; `bookerbob referee-pub`, `bookerbob seal-input`).

## L6: the amount oracle (added 2026-11-05)

A settled amount is public, and an exact price can reveal which discount lines a buyer had.
Before (6 single buyers): 38.40 x3 and 36.00 x3, so the smallest set of buyers sharing an
amount was 3, under the k floor. After a live buying group of 5 on one fixed tier: the 5
members all paid 32.40, a set of 5; the single buyers stay at 3. Fixed tiers (10%, 20%) are
what keep a group's amount from saying more than the tier.

## Still open, stated plainly

- L1: one demo account per purchase links that purchase's verdict, settle and review-group
  join. Two purchases by the same agent account would be linked; demo mode makes a new
  account per purchase, a real agent would need a one-time cnf key and account per purchase
  (planned).
- L3: one relayer funds every one-time account and every buyer, so a rating is narrowed to
  the relayer's buyers (6 here). More buyers per relayer, or several relayers, widen it.
- Timing across rounds: a buyer who joins and the group's next rating round are still close
  in time when the group is small. The k floor (5 persons) bounds what that reveals.
- World binding per context: the World nullifier is one per person across contexts, so the
  same person's agents in two contexts share it on chain. A per-context World action fixes
  this (planned).
