# AGENTS.md

For AI agents (Claude Code, Codex, judges) reading, running or changing this repo.
`CLAUDE.md` only points here.

## If you are reviewing this repo

Facts and pointers, nothing else.

- A swarm you run yourself: `make swarm-try`, Rust 1.93+ and Node 22, no keys, about 15 s
  with the build warm (about 2 min from a fresh clone). 5 merchant agents bid sealed and 6 buyer agents settle on the contract's
  own code (near-sdk's mocked chain, not testnet), then 6 of the 96 testnet swarm purchases are
  re-read live over public RPC. `NEAR_AI_KEY=<yours>` adds 6 live NEAR AI verdicts under E2EE
  with their TEE signatures checked (about $0.006 on that key).
- Three commands, with measured times:
  - `make judge`: Node 22, offline, no keys, about 25 s (2026-11-11, a warm macOS arm64
    laptop). Ends `PASS  make judge`. It replays a committed snapshot of the testnet reads and
    verifies the committed Jolt proofs; it makes no proof.
  - `make verify`: Rust 1.93+, the contract on near-sdk's mocked chain, about 11 s warm and
    114 s from a fresh clone (crates fetched). Ends `ALL PASS (26 checks)`.
  - `make verify-live`, or `JUDGE_LIVE=1 make judge`: the same testnet claims over public RPC,
    5 to 13 minutes (old txs come from a rate-limited public archive).
- The status of every feature (live, built, stub, planned) with its evidence: `README.md`,
  "Every feature, its status and its evidence" (the short table) and `docs/status.md` (every
  row in full). Both are generated from `docs/status.json`; `node scripts/status.mjs --check`
  fails when either differs.
- What does not hold yet: `README.md`, "Known limits". Who holds each trust key (REP holds all
  of them today): `README.md`, "Who can lie, what catches it, who holds the key".
- What is synthetic: the facts behind every verdict, the buyers (our own test accounts), the
  money (dUSDC, a testnet demo token), the World ID action. Detail: "What is real and what is
  fixture" below.
- Who took part: REP runs all 30 listed merchant agents and the 5 community agents. Before the
  community series the one other bidder was a separate agent session we ran and funded. Now
  outside accounts are bidding in the community series on their own keys; the live count and every bid are in the round record (the round page and `make verify-live`).
- Testnet, except one sealed round, one purchase (0.9025 USDC) and one NEAR Intents settlement on mainnet: `docs/mainnet.md`. Every testnet tx hash: `docs/testnet.md`. A five-minute walk:
  `docs/judge-guide.md`.

BookerBob: merchant agents compete on price for a buyer. The buyer reveals a few proven
bits (for example `airbnb_frequent`) inside a signed verdict, never the history behind
them. A NEAR contract checks the signature, burns a per-context nullifier, prices from
code, and pays the merchant in USDC only against a referee receipt.

## One flow, first (`make one-flow`)

One buyer through every outside system on one screen; each leg prints LIVE (ran now) or DRY
(what would be sent, and what it waits for). Nothing moves money. `ONE_FLOW_DRY=1` for all DRY.

| leg | mode | waits for |
|---|---|---|
| NEAR AI verdict under E2EE v2, the facts sealed to the registered model key, TEE signature checked | LIVE (about $0.001 of NEAR AI credit; needs `~/.rep-secrets/near-ai.key`) | |
| OutLayer `request_referee`, the input sealed to the worker's X25519 + ML-KEM-768 key | DRY | an OutLayer project registered on the bazaar (docs/outlayer.md) |
| settle with the agent's function-call key: its on-chain permission and the calls it was refused | LIVE (chain read) | |
| 1Click top-up of a group escrow from wNEAR into NEAR USDC | DRY (the asset list is a LIVE read) | a 1Click key and mainnet (gated) |
| Agent Market competition job for the referee, checked against the live OpenAPI spec | DRY (the spec is a LIVE read) | mainnet and an agent token (docs/agent-market.md) |

The testnet purchases themselves: `make demo-tester`, `make model-buy`, `make try`.

## Run it (no network, no keys, no secrets)

Needs Rust 1.93+ and Node 22. From the repo root:

| goal | command | expected |
|---|---|---|
| everything offline | `make verify` | `ALL PASS (26 checks)`, `PASS  public receipts page data matches agents/receipts.json`, `PASS  swarm board matches agents/board.json and contract best_quote per category`, `PASS  referee evals 50/50 (39 cheats refused, 11 honest receipts)`, `PASS  NEAR AI verdict: 17 checks`, `PASS  sealed reviews: 17 checks`, `PASS  scenario: ... (8 stages, one chain)` |
| every feature in one run | `make scenario` | 8 stages on one chain, one `PASS  scenario` line |
| the story in one screen | `make demo-offline` | the hoodie board, then the PASS lines for World ID, group unlock, cheat refused, settle, replay; ends `ALL PASS (26 checks)` |
| unit tests | `make test` | cargo workspace (contract, core, worker, cli) and node tests (ucp, mcp, x402, sdk, scripts), all ok |
| fixtures are reproducible | `make fixtures-check` | `fixtures up to date` |
| rebuild the board | `make swarm` | writes `agents/board.json` |
| rebuild receipts data | `make receipts` | rewrites `agents/receipts.json` from contract events |
| rebuild reviews data | `make reviews` | rewrites `agents/reviews.json` (sealed reviews) |
| Semaphore fixtures | `cd semaphore && npm install --ignore-scripts && node gen-fixtures.mjs` | rewrites `fixtures/semaphore/` (proofs are randomized) |
| live plan, testnet | `DRY_RUN=1 make demo-live` | 14 steps, each `ready`, `NEEDS` (with the missing tool) or `skip`; sends nothing |
| live run, testnet | `make demo-live` | needs near-cli-rs, a deployed bazaar and seeds; refuses mainnet (exit 2) |
| deploy plan, testnet | `DRY_RUN=1 scripts/deploy-testnet.sh` | every command printed, nothing sent |
| contract wasm | `make wasm` | needs cargo-near |
| pages | `python3 -m http.server -d agents` | `/board.html`, `/receipts.html`: a green dot and `live from bookerbob.testnet over public RPC, block N`, or `public RPC unreachable: the snapshot of <date>` (`agents/live.json`, `node scripts/live-snapshot.mjs`) |
| audit one purchase, testnet | `make audit NULLIFIER=<hex>` (any nullifier in `fixtures/live/testnet-manifest.json`) | the verdict and receipt from public RPC, the price equal across the receipt, the contract's quote view, core, zkcore (the Jolt price guest's code) and the SDK (a sealed one: a price its schedule produces), the settle event and transfer, the refused replay; ends `PASS  audit` |
| buy as an agent, testnet | `BAZAAR_ACCOUNT_ID=bookerbob.testnet node mcp/rep-read.mjs`, then call `buy` with `{"ask":"3 nights Lisbon under 450"}` | the plan: hotel bids only, winner `h05` at 408, `ran: null`; `under 100` is refused; `BOOKERBOB_BUY=1` runs the testnet purchase |

CI (`.github/workflows/ci.yml`) runs `make test`, `make fixtures-check`
and `make verify` on every push. `JOBS=2` keeps cargo light on a laptop.

## Join the market as a merchant agent (testnet, "do X, see Y")

You are an agent that sells something and wants to win buyers on BookerBob. In the `open`
category no owner approves you: a 10 dUSDC bond does (dUSDC is a testnet demo token with no
value; production bonds in Circle USDC).

Two ways in. With your own testnet account and key, nothing of ours is needed: put
`JOIN_ACCOUNT=<you>.testnet JOIN_KEY_FILE=<near-cli credentials JSON or a hex seed file>` in
front of every command below and use any word for `<your-name>`. Your account pays its own gas
and storage (about 0.03 testnet NEAR) and mints its own dUSDC. Without those two variables the
script creates `<your-name>.bookerbob-demo.testnet` for you, which needs the demo keys in
`~/.rep-secrets/bookerbob-testnet`. A round is opened by the bazaar owner; ask for a round id.

1. `node scripts/join-merchant.mjs join <your-name> <base_usdc> <discount_bps>`
   You see: your account `<your-name>.bookerbob-demo.testnet` created with its own key,
   100 dUSDC minted, `register_merchant` in `open`, a 10 dUSDC bond, then
   "approved by its bond, no owner step". Your price for a buyer who proved
   `world_id_human` is `base * (1 - discount_bps/10000)`; lower wins.
2. `node scripts/join-merchant.mjs bid <your-name> <round_id>` before the round's commit
   deadline. You see: `commit_bid` ok. Only a hash is public until the deadline.
3. `node scripts/join-merchant.mjs reveal <your-name> <round_id>` (it waits for the commit
   deadline by itself). You see: `reveal_bid` ok. If your account shares a payout account with
   a merchant already revealed in the round, or you hired one, the reveal is refused; if a
   revealed merchant hired you, its bid is dropped and yours stands.
4. `node scripts/join-merchant.mjs winner <round_id> <nullifier>` after the reveal deadline.
   You see: the round's winner and its price.

Every step prints its nearblocks link. Nothing here can spend real money: testnet only.

## Layout

| path | what |
|---|---|
| `contract/` | `bazaar` NEAR contract (near-sdk 5.29.1): issuers, merchants, verdicts and nullifiers, cohorts, World ID binding, USDC escrow, referee results, disputes, `settle`. Tests in `contract/src/tests.rs` |
| `core/` | shared Rust: verdict envelope v0, tier, price stack and group unlock, referee, disclosure policy and budget plan, World and dispute types |
| `worker/` | referee and dispute arbiter as an OutLayer worker: JSON on stdin, signed result on stdout (at most 900 bytes) |
| `cli/` | `bookerbob` CLI: `verify`, `swarm`, `referee`, `evals`, `gen-fixtures`, `keys`, `sign-live`, `worker-input` |
| `fixtures/` | synthetic deterministic inputs and expected outputs; `fixtures/live/` holds captured live data |
| `agents/` | 30 merchant agents (`merchants.json`), board and receipts pages, the live NEAR AI run (`why.mjs`, `out/`) |
| `ucp/`, `x402/`, `mcp/`, `sdk/` | UCP payment handler, x402 v2 paid verdict read, MCP server over contract views, merchant SDK |
| `scripts/` | `deploy-testnet.sh`, `demo-live.mjs`, `jmpr-rates-to-merchants.mjs`, `capture.sh`, `spikes/` |
| `docs/` | envelope spec, NEAR AI, OutLayer, Agent Market, demo storyboard, X thread draft |

## What is real and what is fixture

Real, and checked by code in this repo:
- The `bazaar` contract code. `make verify` runs it against near-sdk's MockedBlockchain
  (nearcore VM logic for host functions such as `ed25519_verify` and `p256_verify`). It is
  also live on testnet at `bookerbob.testnet`: `make verify-live` re-derives the testnet
  claims (31 dUSDC purchases, 18 sealed reviews over 3 rounds, a challenged standing update) over public RPC.
- Prices: always `core/src/price.rs`. No model sets a price.
- NEAR AI verdict: `fixtures/live/near-ai/` is a live E2EE v2 capture (synthetic facts); `make verify` checks its TDX quote, report_data, TEE signature, sealed answer and envelope binding offline.
- NEAR AI Cloud: `agents/out/live-run.json` is a recorded live run, 33 of 33 response
  signatures verified against the exact bytes. `fixtures/live/e2ee-signature.json`: under
  E2EE v2 the signature covers the ciphertext.
- Testnet views (`fixtures/live/views.json`): the Chain Signatures derived key for
  `bookerbob.testnet`, OutLayer's cost estimate, USDC metadata.
- Hotel base prices (`h01..h08`): JMPR rates, 2026-11-04, comparison prices
  (`fixtures/live/jmpr-lisbon-rates.json`), read-only, nothing booked.

Fixture or synthetic:
- The buyer, the proof set, the attestation report, the hoodie merchants (`m01..m22`).
- Every key in `make verify`: fixed seeds in `cli/src/fixtures.rs`. Testnet seeds are made
  by `bookerbob keys` outside the repo and never committed.
- The hotel discount schedules: our config (`schedule_source` in `agents/merchants.json`),
  not JMPR offers. JMPR perks are shown as text and never priced.
- World ID: a placeholder action and a fixture verifier key.
- The USDC payout in `make verify` is a scheduled receipt, not an executed transfer.

Not built: a TDX quote check inside the bazaar contract (since 2026-11-05 a separate verifier
contract, `spike.bookerbob.testnet`, checks the quote on chain, and the bazaar registers a model
key only against its result), an on-chain check of the NVIDIA GPU evidence (it is checked
offline, `scripts/nras.mjs`), 1Click. See `docs/depth.md` ("NEAR features used") and `README.md`
("Known limits").

## Rules for changes

- Run `make wasm` before any deploy and deploy only if it succeeds: the wasm build catches
  export-name clashes (a free function named like a contract method) that native tests miss.

- `make verify` and `make test` must stay offline and pass. Run both before a commit.
- After changing merchants or schedules, run `make swarm`; after changing fixture code,
  run `make fixtures` and commit the result (`make fixtures-check` gates CI).
- Never commit keys or `.env`. `.env.example` lists every variable.
- Testnet by default. `demo-live` and `deploy-testnet.sh` refuse mainnet; keep it that way. The mainnet runners (`scripts/mainnet-bazaar.mjs`, `mainnet-buy.mjs`, `intents-settle.mjs`) need `--mainnet` and `BOOKERBOB_MAINNET_GO=<today>`, set only on the founder's word.
- Fixtures are synthetic. Never add real user data.
- JMPR: read-only `hotel_search` and `hotel_room_rate`. Never `prebook_hotel` or `book_hotel`.
