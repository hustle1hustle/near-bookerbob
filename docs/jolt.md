# Jolt zkVM for BookerBob (status 2026-11-04)

Status: **all four guests are proven and verified** (2026-11-04).

Measured 2026-11-04 on this Mac (Apple Silicon, 11 cores, cargo -j4, AC power), Jolt a16z@997c1543e; peak RAM from `/usr/bin/time -l`. Proved and verified in the founder-approved build session; the committed files are in `zk/out/<guest>/`.

| guest | prove (s) | verify (ms) | proof (bytes) | peak RAM (MB) | wall incl. guest build (s) | verifier preprocessing (bytes) | program hash |
|---|---|---|---|---|---|---|---|
| `standing` | 8.94 | 70 | 92,716 | 3,230 | 15.1 | 4,180,340 | `c780ceabae4decfa..` |
| `price` | 1.27 | 59 | 80,380 | 375 | 3.4 | 3,284,109 | `6a35b5c3a8c1fe69..` |
| `referee` | 2.34 | 61 | 84,796 | 729 | 5.8 | 4,652,009 | `a66f1c29e3b7199a..` |
| `cohort` | 2.91 | 63 | 84,724 | 560 | 5.0 | 2,876,057 | `50eb77d3d5c13c68..` |

Challengeable on chain since 2026-11-05: an update is posted pending with sha256 of its proof; anyone can challenge it inside one review round with a 0.1 NEAR bond; a registered arbiter re-runs the verifier and signs the resolution; a false update slashes the worker's 0.5 NEAR bond to the challenger. Run live once (valid, docs/testnet.md). Round 2 (3 hires + 2 seeds, `zk/out/standing-testnet-2`): prove 2.71 s, verify 61 ms, proof 84,796 B, peak RSS 999 MB.

Live testnet graph (3 hires + 1 seed, root `ad42980d…`, `zk/out/standing-testnet`): prove 3.32 s, verify 66 ms, proof 84,796 B, peak RSS 998 MB (on battery); its worker-signed update was accepted on chain (tx `5Us18yJb…`, docs/testnet.md).

Standing was re-proved on 2026-11-05 after `publish_reviews` started pushing the Seed graph event: the fixture graph is now 20 hires and 1 seed (before, hires only, so the standing list was empty). Same program hash.

`make verify` checks natively that each committed output equals what the contract's code
computes and that each program hash is the sha256 of its committed verifier
preprocessing (`bookerbob zk-results`). `make zk-verify` verifies the proofs themselves
offline from the committed files (needs the Jolt build in `zk/`).

## Why Jolt here

The contract cannot afford to recompute standing over the whole hire graph on chain,
and OutLayer's output is capped at 900 bytes. Jolt proves an arbitrary Rust computation
(RISC-V) and the proof is checked off chain; the chain keeps a root and a signed result.

## Guests (planned in this order)

| guest | proves | status |
|---|---|---|
| `standing` ("verifiable PageRank for agents") | from the graph events (hire edges, released review seeds), the hash-chained root they produce, and the merchant scores plus every account's standing with conserved transport, w = 1/2 (following a design rule in REP's unpublished draft "(title withheld) for a World of Agents"); output (root, scores hash) | proved and verified (`zk/out/standing`) |
| `price` | `price = f(schedule, revealed, cohort size)` with `bookerbob-zkcore::price`, the contract's own function; output (price, discount_bps, input hash), so a receipt can carry the proof hash next to its price | proved and verified |
| `referee` | the structured-claim check with `bookerbob-zkcore::referee`, as a second path beside the TEE worker; output (receipt?, input hash); a refusal proves too | proved and verified |
| `cohort` | the answer came from a committed cohort of at least 5 distinct members: the hash chain over their nullifiers equals the contract's `cohort_root`; output (root, k); below 5 no proof exists | proved and verified |

Shared no_std code, unit-tested natively without Jolt: `bookerbob-graph` (standing) and
`bookerbob-zkcore` (price, referee, cohort). `bookerbob-core` and the contract call the same
functions, so a proof covers exactly what the chain runs. The guest inputs come from the
contract's own data (`bookerbob zk-inputs`, `fixtures/zk/`, checked in `make verify`): the
price input reproduces the contract's quote (36 USDC), the cohort input reproduces its
`cohort_root` (k = 6), the honest referee input passes and the injected one is refused.

## What is built and tested (no Jolt needed)

- `bookerbob-graph` (`graph/`, no_std, sha256 only): the events, their canonical bytes and
  decoder, the hash-chained root `root' = sha256(tag || root || event)`, conserved
  transport, and `compute(events) -> (root, scores, standing)`. The same crate is used by
  `bookerbob-core`, the contract and the guest, so the proven computation is the on-chain
  one bit for bit.
- The contract extends `graph_root` on every `hire` and every review release and emits
  each event's bytes (`graph_event`), so the prover's input can be rebuilt from chain logs.
  `make verify` (sealed reviews R11, R12) checks that the 20 logged events hash to the
  contract's root and match `fixtures/graph/standing-events.json`.
- `submit_graph_scores`: accepted only for the registered program (`set_graph_program`),
  the current root (a stale root is refused), and a registered worker key's ed25519
  signature over `sha256("bookerbob/graph-update/v0\0" || program_hash || root ||
  scores_hash)`. The proof stays off chain. 5 contract tests: accepted, tampered score,
  stale root, other program, unregistered worker.

## The flow (reproduce)

1. Rebuild the events from the contract's `graph_event` logs.
2. In `zk/`: `cargo run --release -- prove <guest> ../fixtures/zk/<guest>-input.json
   out/<guest>` for standing, price, referee and cohort: proof, verifier preprocessing,
   `result.json` (output, program hash, prove time, proof size); peak RAM with
   `/usr/bin/time -l`, on AC power.
3. The worker verifies the proof (`verify <guest> ...`), recomputes the output natively,
   checks their hash, and signs the update. `make verify` reruns the offline verify on the
   committed files.
4. `submit_graph_scores` on chain.

Program hash: sha256 of the serialized Jolt verifier preprocessing, which commits to the
guest bytecode. That is what a proof is verified against, so it is what the contract
registers.

## Dependency and prior work

- Jolt: upstream a16z/jolt pinned to `997c1543efd49eb193ca403bb7722fc4b2f8e65b`
  (2026-03-24), the commit the installed `jolt` CLI was built from; arkworks patches at the
  revisions upstream's `Cargo.lock` uses. The REP fork (REP's private Jolt fork) is private, so a
  judge could not fetch it; upstream is public.
- REP's earlier Jolt guests (the JMPR Elite family, `jmpr-elite-*` in REP's private Jolt fork, last
  changed 2026-10-01 to 2026-10-14) are prior work, disclosed in `PRIOR_WORK.md`, and are
  not used. Every BookerBob guest is new code written in the window.
- Measurements (prove time, peak RAM, proof size) will be recorded per guest in
  `docs/evidence.md`, on AC power, once the prover builds.

## What these proofs are, and are not

- This build is upstream a16z/jolt at `997c1543e`, compiled without Jolt's optional `zk`
  feature (we enable `host` only). The proofs are **succinct, not zero-knowledge**: they show
  the computation was done right, they do not hide its inputs. Every input we prove is public
  or committed anyway (graph events are public chain logs; price, referee and cohort inputs
  are committed by hash).
- Upstream says Jolt "is in alpha and is not suitable for production use" and "has not been
  audited". Treat a Jolt proof here as strong engineering evidence, not an audited guarantee.
- The contract does not verify the proof itself: a bonded worker key signs the update, anyone
  can challenge it, and an arbiter key reruns the verifier (see above).
