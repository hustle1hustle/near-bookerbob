# AGENTS.md

For AI agents (Claude Code, Codex, judges) reading, running or changing this repo.
`CLAUDE.md` has the same content.

BookerBob: merchant agents compete on price for a buyer. The buyer reveals a few proven
bits (for example `airbnb_frequent`) inside a signed verdict, never the history behind
them. A NEAR contract checks the signature, burns a per-context nullifier, prices from
code, and pays the merchant in USDC only against a referee receipt.

## Run it (no network, no keys, no secrets)

Needs Rust stable and Node 22. From the repo root:

| goal | command | expected |
|---|---|---|
| everything offline | `make verify` | `ALL PASS (26 checks)`, `PASS  public receipts page data matches agents/receipts.json`, `PASS  swarm board matches agents/board.json and contract best_quote per category`, `PASS  referee evals 50/50 (39 cheats refused, 11 honest receipts)`, `PASS  NEAR AI verdict: 14 checks`, `PASS  sealed reviews: 13 checks`, `PASS  scenario: ... (8 stages, one chain)` |
| every feature in one run | `make scenario` | 8 stages on one chain, one `PASS  scenario` line |
| the story in one screen | `make demo-offline` | the hoodie board, then the PASS lines for World ID, group unlock, cheat refused, settle, replay; ends `ALL PASS (26 checks)` |
| unit tests | `make test` | cargo workspace (contract, core, worker, cli) and node tests (ucp, mcp, x402, sdk, scripts), all ok |
| Stellar contract tests | `make test-stellar` | all ok (own workspace, `stellar/`) |
| fixtures are reproducible | `make fixtures-check` | `fixtures up to date` |
| rebuild the board | `make swarm` | writes `agents/board.json` |
| rebuild receipts data | `make receipts` | rewrites `agents/receipts.json` from contract events |
| rebuild reviews data | `make reviews` | rewrites `agents/reviews.json` (sealed reviews) |
| Semaphore fixtures | `cd semaphore && npm install --ignore-scripts && node gen-fixtures.mjs` | rewrites `fixtures/semaphore/` (proofs are randomized) |
| live plan, testnet | `DRY_RUN=1 make demo-live` | 14 steps, each `ready`, `NEEDS` (with the missing tool) or `skip`; sends nothing |
| live run, testnet | `make demo-live` | needs near-cli-rs, a deployed bazaar and seeds; refuses mainnet (exit 2) |
| deploy plan, testnet | `DRY_RUN=1 scripts/deploy-testnet.sh` | every command printed, nothing sent |
| contract wasm | `make wasm` | needs cargo-near |
| pages | `python3 -m http.server -d agents` | `/board.html`, `/receipts.html` |

CI (`.github/workflows/ci.yml`) runs `make test`, `make test-stellar`, `make fixtures-check`
and `make verify` on every push. `JOBS=2` keeps cargo light on a laptop.

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
| `stellar/` | Soroban contract driven only by the Chain Signatures key |
| `scripts/` | `deploy-testnet.sh`, `demo-live.mjs`, `jmpr-rates-to-merchants.mjs`, `capture.sh`, `spikes/` |
| `docs/` | envelope spec, NEAR AI, OutLayer, Stellar, Agent Market, demo storyboard, X thread draft |

## What is real and what is fixture

Real, and checked by code in this repo:
- The `bazaar` contract code. `make verify` runs it against near-sdk's MockedBlockchain
  (nearcore VM logic for host functions such as `ed25519_verify` and `p256_verify`). It is
  not deployed yet.
- Prices: always `core/src/price.rs`. No model sets a price.
- NEAR AI verdict: `fixtures/live/near-ai/` is a live E2EE v2 capture (synthetic facts); `make verify` checks its TDX quote, report_data, TEE signature, sealed answer and envelope binding offline.
- NEAR AI Cloud: `agents/out/live-run.json` is a recorded live run, 32 of 32 response
  signatures verified against the exact bytes. `fixtures/live/e2ee-signature.json`: under
  E2EE v2 the signature covers the ciphertext.
- Testnet views (`fixtures/live/views.json`): the Chain Signatures derived key for
  `bookerbob.testnet` and its Stellar address, OutLayer's cost estimate, USDC metadata.
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

Not built: function-call keys for agents, NVIDIA GPU evidence checks, a TDX quote check inside the contract (the owner checks it before registering the model key), the NEAR side of the
Stellar payout, 1Click. See `README.md` "NEAR features used" and `RESUME.md`.

## Rules for changes

- `make verify` and `make test` must stay offline and pass. Run both before a commit.
- After changing merchants or schedules, run `make swarm`; after changing fixture code,
  run `make fixtures` and commit the result (`make fixtures-check` gates CI).
- Never commit keys or `.env`. `.env.example` lists every variable.
- Testnet only. `demo-live` and `deploy-testnet.sh` refuse mainnet; keep it that way.
- Fixtures are synthetic. Never add real user data.
- JMPR: read-only `hotel_search` and `hotel_room_rate`. Never `prebook_hotel` or `book_hotel`.
