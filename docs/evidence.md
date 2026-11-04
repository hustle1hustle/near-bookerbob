# Evidence

Written by `scripts/evidence.sh` on 2026-11-04 (arm64, 11 cores). Rerun it to refresh.

| what | measured |
|---|---|
| `make verify`, warm build | 10.5 s |
| chain checks (contract code on MockedBlockchain) | ALL PASS (26 checks) |
| referee evals | referee evals 50/50 (39 cheats refused, 11 honest receipts) |
| NEAR AI verdict, offline checks | NEAR AI verdict: 14 checks |
| blind rounds run through the contract | 2 (one per category) |
| sealed reviews (Semaphore v4, real purchases) | sealed reviews: 15 checks
S7  sealed reviews: 6 buyers who paid join, rate with Semaphore proofs, reveal after the round, released at k >= 5  (score 3.45, 6 ratings, no rater named) |
| NEAR AI live run (`agents/out/live-run.json`) | 33 calls, 33/33 signatures valid, $0.0078 total, $0.00024 per call |

## Storage and gas per contract method

Storage is exact: what the contract charges the caller (1 byte = 0.00001 NEAR; the
unused deposit is refunded). Gas is the host-function gas the mocked VM counts, a lower
bound without wasm execution; real gas per method comes with the testnet deploy. The
first verdict in a context also creates its cohort counters, so it costs more.

| method | who pays | storage added (bytes) | storage cost (NEAR) | host gas, mocked (Tgas, lower bound; settle includes gas attached to its two receipts) |
|---|---|---|---|---|
| `register_issuer` | owner | 224 | 0.00224 | 0.472 |
| `register_world_verifier` | owner | 229 | 0.00229 | 1.562 |
| `attest_human` | agent | 272 | 0.00272 | 1.195 |
| `register_merchant` | merchant | 291 | 0.00291 | 0.951 |
| `approve_merchant` | owner | 0 | 0.00000 | 0.310 |
| `open_round` | owner | 87 | 0.00087 | 0.378 |
| `commit_bid` | merchant | 93 | 0.00093 | 0.811 |
| `reveal_bid` | merchant | 25 | 0.00025 | 0.868 |
| `storage_deposit (escrow entry)` | agent | 84 | 0.00084 | 0.314 |
| `ft_on_transfer (USDC in)` | USDC contract | 0 | 0.00000 | 0.310 |
| `submit_verdict (ed25519, first in context)` | agent | 1174 | 0.01174 | 2.033 |
| `submit_verdict (p256, same context)` | agent | 559 | 0.00559 | 2.776 |
| `submit_referee_result` | agent, from the record reserve prepaid at submit | 245 | 0.00245 | 0.729 |
| `best_quote (view, 1 merchant)` | free (view) | 0 | 0.00000 | 0.231 |
| `settle (+ ft_transfer receipt)` | agent (gas; bytes from the record reserve) | 14 | 0.00014 | 39.840 |

per verdict: 1174 bytes (0.01174 NEAR) plus a 512 byte reserve for its receipt and settle (0.00512 NEAR), paid by the agent from its 0.05 NEAR deposit, rest refunded; referee worker run: 252 us (native)

## Sealed reviews gas

Mocked host gas per call. `submit_review` is mostly alt_bn128 host work (one
multiexp, a 4-pair pairing check); it also parses the committed verification key JSON
in wasm, which is not counted. `join_review_group` runs Poseidon in wasm, also not
counted. Treat both as floors until the testnet deploy.

| method | host gas, mocked (Tgas) | calls |
|---|---|---|
| `join_review_group (LeanIMT insert, Poseidon)` | 0.81 | 10 |
| `publish_reviews (6 ratings)` | 0.81 | 1 |
| `reveal_review` | 0.60 | 6 |
| `submit_review (Groth16 on alt_bn128)` | 33.19 | 10 |

## Jolt zkVM guests

From zk/out/<guest>/result.json and the /usr/bin/time -l logs (this Mac, cargo -j4, AC).

| guest | prove (s) | verify (ms) | proof (bytes) | peak RAM (MB) |
|---|---|---|---|---|
| standing | 8.94 | 70 | 92,716 | 3,230 |
| price | 1.27 | 59 | 80,380 | 375 |
| referee | 2.34 | 61 | 84,796 | 729 |
| cohort | 2.91 | 63 | 84,724 | 560 |

## Who pays

- Agent: its verdict record plus a 512-byte reserve for that record's referee receipt
  and settle fields (0.05 NEAR attached, about 0.013 used, the rest refunded), its escrow
  entry (0.01 NEAR), its World ID binding, and the gas of `settle`.
- Merchant: its registration and its sealed and revealed bids.
- Owner: issuer, referee, arbiter and World verifier keys, and rounds.
- Contract balance: nothing per purchase. Growth past a record's reserve is refused.
- NEAR AI inference is paid with the buyer side's API key (per call cost above).
