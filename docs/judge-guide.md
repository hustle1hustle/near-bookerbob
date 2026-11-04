# Judge guide: BookerBob in 5 minutes

What it is: merchant agents bid on price for a buyer who reveals a few proven bits
(for example "frequent airbnb guest"), never the history behind them. A NEAR contract
checks the verdict, burns a nullifier so the same account cannot buy twice with it,
prices from code, and pays the merchant in USDC only against a referee receipt. Buyers
who paid can leave sealed ratings that name nobody.

Honest status: everything runs on the real contract code against near-sdk's mocked
chain, on synthetic fixtures. **Nothing is deployed yet** (the testnet deploy waits on a
tool install). One NEAR AI verdict and the merchant pitches are real live captures.

## Minute 1: open

- `README.md`, the "NEAR features used" table: every row says built, stub or planned.
- `docs/evidence.md`: measured numbers (time, eval pass rate, storage and gas per method,
  who pays).

## Minutes 2 and 3: run

```sh
make verify          # Rust stable; about 40 s from a cold build, 4 s warm; no keys
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
| `PASS  NEAR AI verdict: 14 checks` | a real NEAR AI E2EE v2 capture: TDX quote to Intel's root (dcap-qvl), report_data binds key and nonce, TEE signature over the exact bytes, the sealed answer, predicates equal to the code's, and the contract accepting it only with that binding (4 refusals) |
| `PASS  sealed reviews: 15 checks` | 10 real purchases join Semaphore groups; Groth16 proofs checked on alt_bn128 host functions; double rating, non-member and swapped ratings refused; sealed during the round, revealed after it; a group of 4 stays sealed; a spawned ring of 8 sub-agents gains at most w/(1-w) of the merchant's standing (R10); equal prices go to the better-reviewed merchant |

## Minute 4: look

```sh
python3 -m http.server -d agents     # then open /board.html and /receipts.html
```

- `/board.html`: 30 bids, the buyer column shows only k and the bits revealed, merchant
  asks answered by rule, the red refused receipt, and the sealed reviews panel.
- `/receipts.html`: every verdict and purchase from the contract's own NEP-297 events, and
  the released sealed reviews.

Also tested offline (`make test`): the NEP-366 relayer policy for gasless ratings
(`relayer/`), with synthetic SignedDelegate actions; sending waits on testnet.

## Minute 5: check what is not claimed

- Not deployed; no USDC has moved; no real zkTLS proof (the facts are synthetic).
- The NEAR AI TDX quote is checked off chain before the owner registers the model key,
  not inside the contract; NVIDIA GPU evidence is not checked.
- Gas numbers are mocked host gas (lower bounds), labelled as such.
- The Jolt zkVM prover is not built yet: the graph root and the signed-update check are on
  chain and tested, but no Jolt proof exists (`docs/jolt.md`).
- The Stellar leg is unreachable today (see `RESUME.md`).
- Prior work is listed in `PRIOR_WORK.md`.

Deeper reading: `docs/near-ai.md`, `docs/semaphore.md`, `docs/outlayer.md`, and the threat
model in the README.
