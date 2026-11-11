# The swarm run: 96 buyer agents, 30 merchant agents, 7 sealed rounds (testnet, 2026-11-11)

One run on `bookerbob.testnet`, by `scripts/swarm-run.mjs`. Its public record is
`fixtures/live/swarm/s1.json`; `make swarm-verify` re-checks it over public RPC with no keys.

| what | number |
|---|---|
| merchant agents that opened a bid | 30 |
| rounds (sealed bids, then reveals) | 7: six with a hoodie and a hotel round each, one hotel-only |
| sealed bids committed and opened | 178 of 188 possible |
| buyer agents, each a fresh one-time account | 96 |
| verdicts issued by a NEAR AI model (z-ai/glm-5.3-flash, E2EE v2, TEE signature checked on chain) | 96 |
| purchases settled against a referee receipt | 96, for 22,589.76 dUSDC |
| replays of a spent verdict, refused on chain | 7 of 7 tried |
| NEAR AI credit used | about $0.014 |
| wall time | 6,038 s |

Each buyer carries one of four sets of proven bits. The winner and the price differ by set,
because code prices each sealed bid for the verdict in front of it: hoodie buyers paid 36.00
or 36.96 to m01, 37.80 to m02 and 37.72 to m04; hotel buyers paid 408.00, 433.50 or 459.00 to
h05.

## What it is, and what it is not

- Every agent here is ours. The 30 merchant agents are the price rules in
  `agents/merchants.json`, committed blind in each round. The 96 buyers are scripted test
  accounts. No outside party took part in this run.
- The facts behind every verdict are synthetic. A real model ruled on them under E2EE and the
  contract checked its signature, but the proof sets come from fixtures.
- dUSDC is a test token with no value. 22,589.76 dUSDC is a count of test tokens moved, not
  revenue.
- The run skipped the Shopify test order and the review group that the one-buyer demo makes.

## What went wrong on the first pass, kept in the record

32 of the 96 buyers failed on the first pass and settled on a retry (`failures_first_pass`,
`retried_ok` and `retried: true` on each such purchase):

- 24 hoodie buyers failed at settle with "receiver not registered". For two of the four bit
  sets the round's winner was m02 or m04, and 28 of the 30 merchant accounts had never been
  registered for the test token: every earlier purchase had gone to m01 or h05. The script now
  registers every merchant that can win before buyers start. The 24 settled with the verdict,
  receipt and escrow they already had.
- 8 hotel buyers of round 1 had no round to buy in: its `open_round` went through a
  rate-limited RPC and failed. They bought in a seventh, hotel-only round. The same RPC cost
  10 of the 188 possible sealed bids.

## Run it or check it

```
node scripts/swarm-run.mjs plan <tag> --rounds 6 --buyers 96    # prints the plan, sends nothing
make swarm-verify                                               # no keys: rounds, nullifiers, a sample of 25 txs
```

`run` needs the testnet keys outside the repo and a NEAR AI key. Testnet only.
