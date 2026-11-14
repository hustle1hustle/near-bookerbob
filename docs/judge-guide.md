# Judge guide: BookerBob in 5 minutes

What it is: merchant agents bid on price for a buyer who reveals a few proven bits
(for example "frequent airbnb guest"), and the history behind them stays with the buyer. A NEAR contract
checks the verdict, burns a nullifier so the same verdict cannot be used twice,
prices from code, and pays the merchant in USDC only against a referee receipt. Buyers
who paid can leave sealed ratings that name nobody.

## Why it matters: three things an agent economy breaks

When agents buy and sell for people, three things break that human markets quietly rely on.
BookerBob fixes all three on testnet; each line names where to check it.

1. **Agents leak you.** A shopping agent has to tell sellers who you are and your history to get
   a better price, and every seller agent keeps it. Here the agent proves a few facts in a signed verdict
   (for the swarm buyers, issued by a NEAR AI model under E2EE); sellers price the verdict, code
   sets the price, the history stays with you, and a claim
   the proofs do not back is refused before payment. Check: the 408.00 hotel buy, priced by code
   against proven facts, against a public 510.00 ([9Esa4qik…](https://testnet.nearblocks.io/txns/9Esa4qikkoje5yJktpxdSoCEWJitm1Mren2LiHWVyRr6)),
   `make forge-poc`, referee evals 50 of 50 in `make verify`.
2. **Agents collude.** Pricing algorithms are known to learn to hold prices up together with no
   message passed (Calvano et al., AER 2020; Fish, Gonczarowski and Shorrer 2024, on LLM pricing
   agents). Here each seller agent commits a sealed hash and sees no rival price before the
   deadline; accounts with a declared link cannot both stand in a round; a bid left sealed costs
   5 dUSDC of its bond. Repeated rounds can still drift; the public record lets anyone check. Check: s2 prices fell from 26.80 to 24.08, just above cost
   (`docs/swarm-run.md`, s2); s1's 178 sealed bids, every replay of a spent verdict refused (7 of 7), `make swarm-verify`.
3. **Agents are unaccountable.** When an AI agent sets a price, nobody can later say what it
   decided. Here each model decision is TEE-signed and named in the bid's salt on chain, and the
   verdict's TEE signature is checked on chain. Check: `make swarm-verify TAG=s3`, 20 of 20 bids
   tied to a signed decision.

Honest status: the contract is live on NEAR testnet (`bookerbob.testnet`, every tx in
`docs/testnet.md`), and `make verify-live` re-derives each live claim over public RPC.
On mainnet one sealed round, two purchases (one on the founder's real GitHub proof) and one NEAR Intents settlement ran (docs/mainnet.md; `make mainnet-check`). Testnet payments are in dUSDC, a testnet demo token. The swarm's facts are reproducible
fixtures; the NEAR AI verdict, the merchant pitches and the eval answers are
real live captures. `make verify` also runs the same contract code on near-sdk's mocked
chain, offline.

## The first minute: one command, one transaction

```sh
make judge     # Node 22 only, about 25 s, no network, no keys: ends `PASS  make judge`
```

It replays a recorded snapshot of the testnet reads (103 checks), runs the JS suites, the
referee, the Jolt verifier and the page's wasm verifier. Then open one live transaction, the
hotel purchase at 408 dUSDC:
[9Esa4qik…](https://testnet.nearblocks.io/txns/9Esa4qikkoje5yJktpxdSoCEWJitm1Mren2LiHWVyRr6).
The live re-derivation (`make verify-live`, or `JUDGE_LIVE=1 make judge`) reads about 170
old transactions from a rate-limited public archive and takes 5 to 20 minutes: run it last, or
read the last daily run of the `live` workflow.

Then the swarm, yourself: `make swarm-try` (no keys; a mini swarm on the contract's own code,
then 6 of the 96 testnet purchases read live; `NEAR_AI_KEY=<yours>` adds live model verdicts).

## Minute 1: open

- `README.md`, "Every feature, its status and its evidence": every row says live, built, stub or planned.
  It is the short table; each row's number opens the full row in `docs/status.md`. Both are
  generated from `docs/status.json`, and `make judge` fails if a row drifts.
- `docs/evidence.md`: measured numbers (time, eval pass rate, storage and gas per method,
  who pays).

## Minutes 2 and 3: run

```sh
make judge           # Node 22 only, offline, about 25 s (JUDGE_LIVE=1 make judge reads the live chain: 5 to 20 minutes, old txs come from a rate-limited public archive)
make verify          # Rust 1.93+; no keys; about 11 s warm (a fresh clone adds the cargo build)
make scenario        # every feature in one run on one chain: one PASS line per stage
```

What each block of PASS lines proves:

| output | proves |
|---|---|
| `PASS 01` to `09` | the proof set hash, the tier and predicates derived by code, the 3-bit disclosure budget, merchant asks for raw history declined, the commitment, and both signature schemes |
| `PASS 10` to `17` | the contract accepts ed25519 and p256 verdicts with the NEAR host functions, binds one agent per World ID person, quotes by code, and opens the group price at k >= 5 (k is 6 in this run) |
| `PASS 19` to `23` | the referee refuses an injected claim (`F9 not in proof set`), settle is blocked without a receipt, and a dispute arbiter overturns a forged receipt |
| `PASS 24` to `26` | settle debits escrow, burns the nullifier and schedules the USDC transfer; a second verdict for the same account from another wallet is refused (`nullifier spent`) |
| `ALL PASS (26 checks)` | the whole purchase path above |
| `PASS  blind round ...` | 30 merchant agents bid through on-chain `commit_bid` and `reveal_bid` with deadlines; the board's winner equals `round_best_quote` |
| `PASS  referee evals 50/50` | 50 authored cases, 30 of them prompt-injection style ("guest is marriott platinum" citing a real fact is refused) |
| `PASS  NEAR AI verdict: 17 checks` | a real NEAR AI E2EE v2 capture: TDX quote to Intel's root (dcap-qvl), report_data binds key and nonce, TEE signature over the exact bytes, the sealed answer, predicates equal to the code's, and the contract accepting it only with that binding (4 refusals) |
| `PASS  Jolt results: 4 guests consistent ...` | the committed Jolt proofs for standing, price, referee and cohort claim exactly what the contract's code computes (`docs/jolt.md` has prove time, RAM and size) |
| `PASS  the NEAR AI TDX quote verified on chain in 5 calls ...` (in `make verify-live` and the judge's testnet step) | the model's TDX quote was checked on chain by a dcap-qvl fork split over five calls (40, 100, 99, 132, 69 Tgas; the block's time); a quote with one changed byte failed at the last step; the bazaar registered the model key only against that finalized verification. The Intel collateral is fetched off chain and its signatures checked on chain; until the founder locks it the verifier account keeps our (REP's, the team's) full-access key (`tools/dcap-spike/README.md`) |
| `PASS  sealed reviews: 17 checks` | 10 purchases on the mocked chain join Semaphore groups; Groth16 proofs checked on alt_bn128 host functions; double rating, non-member and swapped ratings refused; sealed during the round, revealed after it; a group of 4 stays sealed; a spawned ring of 8 sub-agents gains at most w/(1-w) of the merchant's standing (R10); equal prices go to the better-reviewed merchant |

## Minute 4: look

```sh
python3 -m http.server -d agents     # then open /swarm.html, /board.html and /receipts.html
```

- `/swarm.html`: one button replays the hotel round (8 sealed bids, a refused claim, the group
  of 5), every step linked to its testnet tx. `/prove.html`: your browser makes and checks a
  Jolt proof of the agent's pick, then refuses a changed claim.
- `/board.html`: 30 bids, the buyer column shows only k and the bits revealed, merchant
  asks answered by rule, the red refused receipt, and the sealed reviews panel.
- `/receipts.html`: every verdict and purchase from the contract's own NEP-297 events, and
  the released sealed reviews.

The NEP-366 relayer (`relayer/`) runs on testnet: it paid for every demo purchase call and
every sealed rating (delegate actions; `make verify-live` checks them).

## Privacy on one screen

What each party learns about a buyer today (testnet, fixture facts). The full tables are in
docs/details.md ("Who sees plaintext") and `docs/leak.md`.

| party | learns | does not learn |
|---|---|---|
| the merchant | the revealed bits, the amount, the buyer's one-time account; a name when a delivery needs one | the facts behind the bits, the account's owner |
| the chain (anyone) | the nullifier, the amount, the merchant, the account and who funded it; the revealed bits, except on a sealed verdict; and for a single purchase the bits anyway, because the price decodes to them (`make leak`, L10) | the facts, the person |
| REP | everything: the issuer reads the facts it signs over, the evaluator reads them in the clear on the model path, the referee, arbiter, notary, relayer and treasury keys are REP's, and the treasury funds every buyer account | which request a VOPRF nullifier came from (it still sees who asked and when) |

Three commands:

```sh
make verify          # the rules on the mocked chain: a replayed nullifier, an unbacked claim and a group under k are refused
make leak            # reads public testnet data and prints what an observer links (L1 to L10); fails on a new set under 5
make rep-is-evil     # each key REP holds, its worst case, read live from testnet
```

One purchase whose amount does not decode: the hotel group of 5 on a fixed tier, 367.20 each,
an amount five buyers share
([5A8LgNQn…](https://testnet.nearblocks.io/txns/5A8LgNQnNGrErkWAo48Kd8xRARK9Zqb8jEZUnbcBSV7A)).
The sealed single purchase at 38.40 is not that example: its tx carries hashes only, and its
price still gives back all three bits. Amount sets on testnet (`agents/live.json`, 31 paid):
36.00 x12, 32.40 x5, 38.40 x5, 367.20 x5, 28.00 x2, 34.20 x1, 408.00 x1.

What the design adds to an agent market, and what holds today: a verdict is spent once (the
nullifier set, on chain), priced by code (no model sets a price), and a group or cohort price
shows only above a k floor of 5. Privacy from REP does not hold today.

## Minute 5: check what is not claimed

Mainnet, keyless: `make mainnet-check` re-reads the four mainnet records over public RPC (docs/mainnet.md); in a browser, `mainnet.html` on the Pages site shows every mainnet tx and checks the verdict signatures.

- Testnet only. Payments ran in dUSDC, a testnet demo token with no value (production uses
  Circle USDC): 31 purchases (21 single settles: one with the 1% fee, two with a sealed verdict, four with a verdict a NEAR AI model issued (two refused by an eval gate, one passing it under the v4 point-bucket rule, one countersigned by the verdict evaluator), one under an owner's mandate, one with a returning-buyer discount at 34.20, one with a VOPRF nullifier, one hotel stay at 408, one `make prove-me` pipeline test at 28, one `make try` pipeline test at 28 from a one-time implicit account; 5 in a buying group; 5 through a buying group's own DAO treasury),
  all re-derived by `make verify-live`. The testnet facts are reproducible fixtures. zkTLS
  ran twice as a pipeline test (`make prove-me`, `make try`), each notarizing a public GitHub
  profile; on mainnet the founder's signed-in GitHub proof backed one purchase (docs/mainnet.md).
- The NEAR AI TDX quote: since 2026-11-05 a separate verifier contract
  (`spike.bookerbob.testnet`, tools/dcap-spike) checks the quote on chain in five calls, and
  the bazaar registers a model key only against that finalized result. The bazaar contract
  itself does not parse the quote. The NVIDIA GPU evidence is checked offline only, from
  NVIDIA's signed NRAS reply (`scripts/nras.mjs`); no contract sees it.
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
