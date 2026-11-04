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

## Fix and after

See the "after" section once the fix has run on testnet.
