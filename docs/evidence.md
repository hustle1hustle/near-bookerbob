# Evidence

Written by `scripts/evidence.sh` on 2026-11-04 (arm64, 11 cores). Rerun it to refresh.

| what | measured |
|---|---|
| `make verify`, warm build | 3.8 s |
| chain checks (contract code on MockedBlockchain) | ALL PASS (26 checks) |
| referee evals | referee evals 50/50 (39 cheats refused, 11 honest receipts) |
| NEAR AI verdict, offline checks | NEAR AI verdict: 14 checks |
| blind rounds run through the contract | 2 (one per category) |
| NEAR AI live run (`agents/out/live-run.json`) | 33 calls, 33/33 signatures valid, $0.0078 total, $0.00024 per call |

## Storage and gas per contract method

Storage is exact: what the contract charges the caller (1 byte = 0.00001 NEAR; the
unused deposit is refunded). Gas is the host-function gas the mocked VM counts, a lower
bound without wasm execution; real gas per method comes with the testnet deploy. The
first verdict in a context also creates its cohort counters, so it costs more.

| method | who pays | storage added (bytes) | storage cost (NEAR) | host gas, mocked (Tgas, lower bound; settle includes gas attached to its two receipts) |
|---|---|---|---|---|
| `register_issuer` | owner | 224 | 0.00224 | 0.467 |
| `register_world_verifier` | owner | 229 | 0.00229 | 1.550 |
| `attest_human` | agent | 272 | 0.00272 | 1.189 |
| `register_merchant` | merchant | 291 | 0.00291 | 0.945 |
| `approve_merchant` | owner | 0 | 0.00000 | 0.304 |
| `open_round` | owner | 87 | 0.00087 | 0.372 |
| `commit_bid` | merchant | 93 | 0.00093 | 0.805 |
| `reveal_bid` | merchant | 25 | 0.00025 | 0.862 |
| `storage_deposit (escrow entry)` | agent | 84 | 0.00084 | 0.308 |
| `ft_on_transfer (USDC in)` | USDC contract | 0 | 0.00000 | 0.304 |
| `submit_verdict (ed25519, first in context)` | agent | 823 | 0.00823 | 1.623 |
| `submit_verdict (p256, same context)` | agent | 557 | 0.00557 | 2.539 |
| `submit_referee_result` | agent, from the record reserve prepaid at submit | 245 | 0.00245 | 0.723 |
| `best_quote (view, 1 merchant)` | free (view) | 0 | 0.00000 | 0.165 |
| `settle (+ ft_transfer receipt)` | agent (gas; bytes from the record reserve) | 14 | 0.00014 | 39.830 |

per verdict: 823 bytes (0.00823 NEAR) plus a 512 byte reserve for its receipt and settle (0.00512 NEAR), paid by the agent from its 0.05 NEAR deposit, rest refunded; referee worker run: 235 us (native)

## Who pays

- Agent: its verdict record plus a 512-byte reserve for that record's referee receipt
  and settle fields (0.05 NEAR attached, about 0.013 used, the rest refunded), its escrow
  entry (0.01 NEAR), its World ID binding, and the gas of `settle`.
- Merchant: its registration and its sealed and revealed bids.
- Owner: issuer, referee, arbiter and World verifier keys, and rounds.
- Contract balance: nothing per purchase. Growth past a record's reserve is refused.
- NEAR AI inference is paid with the buyer side's API key (per call cost above).
