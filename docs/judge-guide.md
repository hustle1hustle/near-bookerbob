# Judge guide: BookerBob in 5 minutes

What it is: merchant agents bid on price for a buyer who reveals a few proven bits
(for example "frequent airbnb guest"), never the history behind them. A NEAR contract
checks the verdict, burns a nullifier so the same account cannot buy twice with it,
prices from code, and pays the merchant in USDC only against a referee receipt. Buyers
who paid can leave sealed ratings that name nobody.

Honest status: the contract is live on NEAR testnet (`bookerbob.testnet`, every tx in
`docs/testnet.md`), and `make verify-live` re-derives each live claim over public RPC.
Nothing is on mainnet. Payments are in dUSDC, a testnet demo token. The facts behind the
verdicts are synthetic; the NEAR AI verdict, the merchant pitches and the eval answers are
real live captures. `make verify` also runs the same contract code on near-sdk's mocked
chain, offline.

## Minute 1: open

- `README.md`, the "NEAR features used" table: every row says live, built, stub or planned.
  It is generated from `docs/status.json`, and `make judge` fails if a row drifts.
- `docs/evidence.md`: measured numbers (time, eval pass rate, storage and gas per method,
  who pays).

## Minutes 2 and 3: run

```sh
make judge           # Node 22 only, about 10 s online (up to a minute if public RPC rate-limits), under a second offline
make verify          # Rust stable; no keys; about 11 s warm (a fresh clone adds the cargo build)
make scenario        # every feature in one run on one chain: one PASS line per stage
```

What each block of PASS lines proves:

| output | proves |
|---|---|
| `PASS 01` to `09` | the proof set hash, the tier and predicates derived by code, the 3-bit disclosure budget, merchant asks for raw history declined, the commitment, and both signature schemes |
| `PASS 10` to `17` | the contract accepts ed25519 and p256 verdicts with the NEAR host functions, binds one agent per World ID person, quotes by code, and opens the group price at k=6 |
| `PASS 19` to `23` | the referee refuses an injected claim (`F9 not in proof set`), settle is blocked without a receipt, and a dispute arbiter overturns a forged receipt |
| `PASS 24` to `26` | settle debits escrow, burns the nullifier and schedules the USDC transfer; a second verdict for the same account from another wallet is refused (`nullifier spent`) |
| `ALL PASS (26 checks)` | the whole purchase path above |
| `PASS  blind round ...` | 30 merchant agents bid through on-chain `commit_bid` and `reveal_bid` with deadlines; the board's winner equals `round_best_quote` |
| `PASS  referee evals 50/50` | 50 authored cases, 30 of them prompt-injection style ("guest is marriott platinum" citing a real fact is refused) |
| `PASS  NEAR AI verdict: 17 checks` | a real NEAR AI E2EE v2 capture: TDX quote to Intel's root (dcap-qvl), report_data binds key and nonce, TEE signature over the exact bytes, the sealed answer, predicates equal to the code's, and the contract accepting it only with that binding (4 refusals) |
| `PASS  Jolt results: 4 guests consistent ...` | the committed Jolt proofs for standing, price, referee and cohort claim exactly what the contract's code computes (`docs/jolt.md` has prove time, RAM and size) |
| `PASS  sealed reviews: 15 checks` | 10 purchases on the mocked chain join Semaphore groups; Groth16 proofs checked on alt_bn128 host functions; double rating, non-member and swapped ratings refused; sealed during the round, revealed after it; a group of 4 stays sealed; a spawned ring of 8 sub-agents gains at most w/(1-w) of the merchant's standing (R10); equal prices go to the better-reviewed merchant |

## Minute 4: look

```sh
python3 -m http.server -d agents     # then open /board.html and /receipts.html
```

- `/board.html`: 30 bids, the buyer column shows only k and the bits revealed, merchant
  asks answered by rule, the red refused receipt, and the sealed reviews panel.
- `/receipts.html`: every verdict and purchase from the contract's own NEP-297 events, and
  the released sealed reviews.

The NEP-366 relayer (`relayer/`) runs on testnet: it paid for every demo purchase call and
every sealed rating (delegate actions; `make verify-live` checks them).

## Minute 5: check what is not claimed

- Testnet only. Payments ran in dUSDC, a testnet demo token with no value (production uses
  Circle USDC): 19 purchases (9 single settles: one with the 1% fee, one with a sealed verdict, one hotel stay at 408; 5 in a buying group; 5 through a buying group's own DAO treasury),
  all re-derived by `make verify-live`. No real zkTLS proof yet (the facts are synthetic).
- The NEAR AI TDX quote is checked off chain before the owner registers the model key,
  not inside the contract; NVIDIA GPU evidence is not checked.
- Gas numbers are mocked host gas (lower bounds), labelled as such.
- Jolt: the four proofs are committed (`zk/out/`); `make verify` checks their outputs against
  the contract's code natively, and `make zk-verify` checks the proofs (needs the Jolt
  build). Two more cover the live testnet hire graph. The second, seeded by released sealed
  reviews, carries nonzero standing; it was posted pending, challenged with a bond and
  applied after the arbiter's resolution (docs/testnet.md). The arbiter checks the proof off
  chain; there is no on-chain Jolt verifier.
- Prior work is listed in `PRIOR_WORK.md`.

Deeper reading: `docs/near-ai.md`, `docs/semaphore.md`, `docs/outlayer.md`, and the threat
model in the README.
