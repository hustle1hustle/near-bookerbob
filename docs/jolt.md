# Jolt zkVM for BookerBob (numbers measured 2026-11-04 to 2026-11-10)

Status: **all four guests are proven and verified** (first on 2026-11-04; standing and referee
re-proved on 2026-11-05, see below; referee re-proved on 2026-11-13 after the rule table gained `qfex_referrer`, program hash `6d4c5afb..` before).

Measured 2026-11-04 on this Mac (Apple Silicon, 11 cores, cargo -j4, AC power), Jolt a16z@997c1543e; peak RAM from `/usr/bin/time -l`. Proved and verified in the founder-approved build session; the committed files are in `zk/out/<guest>/`.

| guest | prove (s) | verify (ms) | proof (bytes) | peak RAM (MB) | wall incl. guest build (s) | verifier preprocessing (bytes) | program hash |
|---|---|---|---|---|---|---|---|
| `standing` | 8.94 | 70 | 92,716 | 3,230 | 15.1 | 4,180,340 | `c780ceabae4decfa..` |
| `price` | 1.27 | 59 | 80,380 | 375 | 3.4 | 3,284,109 | `6a35b5c3a8c1fe69..` |
| `referee` | 2.77 | 63 | 84,796 | 665 | not measured | 4,684,271 | `f502874be1bd72c1..` |
| `cohort` | 2.91 | 63 | 84,724 | 560 | 5.0 | 2,876,057 | `50eb77d3d5c13c68..` |

The standing row is the re-proof of 2026-11-05 (`zk/out/standing/result.json`: 8.94 s, 92,716
bytes). `zk/out/standing.prove.log` and `zk/out/standing.time.txt` are older: they record the
first proof of 2026-11-04 over a graph of hires only (4.69 s, 88,300 bytes, peak RSS
1,392,508,928 bytes). The 3,230 MB peak in the table was read in the re-proof session and has
no committed log behind it.

The referee row was re-proved on 2026-11-05 after the rule `github account_age_years >= 3` (`github_builder`) joined the rule table, which is part of the referee guest; the other three guests are unchanged.

Challengeable on chain since 2026-11-05: an update is posted pending with sha256 of its proof; anyone can challenge it inside one review round with a 0.1 NEAR bond; a registered arbiter re-runs the verifier and signs the resolution; a false update slashes the worker's 0.5 NEAR bond to the challenger. Run live once (valid, docs/testnet.md). Round 2 (3 hires + 2 seeds, `zk/out/standing-testnet-2`): prove 2.71 s, verify 61 ms, proof 84,796 B, peak RSS 999 MB.

Live testnet graph 3 (3 hires, m01's 2 seeds, h05's first seed; `zk/out/standing-testnet-3`, 2026-11-05): prove 4.05 s, verify 64 ms; finalized on chain after its challenge window, and the bazaar built the proven standing tree from its score list (m01 rank 1, h05 rank 2).

Live testnet graph (3 hires + 1 seed, root `ad42980d…`, `zk/out/standing-testnet`): prove 3.32 s, verify 66 ms, proof 84,796 B, peak RSS 998 MB (on battery); its worker-signed update was accepted on chain (tx `5Us18yJb…`, docs/testnet.md).

Standing was re-proved on 2026-11-05 after `publish_reviews` started pushing the Seed graph event: the fixture graph is now 20 hires and 1 seed (before, hires only, so the standing list was empty). Same program hash.

`make verify` checks natively that each committed output equals what the contract's code
computes and that each program hash is the sha256 of its committed verifier
preprocessing (`bookerbob zk-results`). `make zk-verify` verifies the proofs themselves
offline from the committed files (needs the Jolt build in `zk/`).

## Why Jolt here

The design reason: recomputing standing over a large hire graph does not fit a contract
call, and OutLayer's output is capped at 900 bytes. Jolt proves an arbitrary Rust computation
(RISC-V) and the proof is checked off chain; the chain keeps a root and a signed result.

What is true at today's size: the live graph has 6 events and the fixture 21. The `standing`
guest sets no `max_input_size`, so Jolt's default at this pin applies (4,096 bytes for the
whole event list); a larger graph needs a larger limit, which changes the program hash, and no
run at scale exists. The contract also receives and hashes the full score list on every update
(`submit_graph_scores`).

## Guests

| guest | proves | status |
|---|---|---|
| `standing` (a bounded, damped fan-out of standing from each seed along hire edges, `graph/src/lib.rs` `conferred`; not a stationary PageRank) | from the graph events (hire edges, released review seeds), the hash-chained root they produce, and the merchant scores plus every account's standing with conserved transport, w = 1/2 (following a design rule in REP's unpublished draft "(title withheld) for a World of Agents"); output (root, scores hash) | proved and verified (`zk/out/standing`) |
| `price` | `price = f(schedule, revealed, cohort size)` with `bookerbob-zkcore::price`, the contract's own function; output (price, discount_bps, input hash), so a receipt can carry the proof hash next to its price | proved and verified |
| `referee` | the structured-claim check with `bookerbob-zkcore::referee`, as a second path beside the TEE worker; output (receipt?, input hash); a refusal proves too | proved and verified |
| `cohort` | the answer came from a committed cohort of at least 5 distinct members: the hash chain over their nullifiers equals the contract's `cohort_root`; output (root, k); below 5 the guest panics. Jolt can prove a panicking run with the panic flag set, so what holds is that both verifiers here require panic = false (`zk/src/main.rs`, `zk/browser/verify-wasm/src/lib.rs`): no proof they accept exists. The guest comments that say "no proof exists" mean this; they are left as they are so the program hashes do not move | proved and verified |

Shared no_std code, unit-tested natively without Jolt: `bookerbob-graph` (standing) and
`bookerbob-zkcore` (price, referee, cohort). `bookerbob-core` and the contract call the same
functions, so a proof covers exactly what the chain runs. The guest inputs come from the
contract's own data (`bookerbob zk-inputs`, `fixtures/zk/`, checked in `make verify`): the
price input reproduces the contract's quote (36 USDC), the cohort input reproduces its
`cohort_root` (k = 6), the honest referee input passes and the injected one is refused.

## What each guest reads, and what stays private (built without the `zk` feature)

Jolt 997c1543e is built here without its optional `zk` feature, so a proof is succinct but not
zero-knowledge: treat everything a guest reads as visible to whoever holds the proof.

| guest | reads | where that input already is | private? |
|---|---|---|---|
| `standing` | graph events (hire edges, released review seeds) | logged on chain as `graph_event`, hashed into `graph_root` | no, all public |
| `price` | the merchant schedule, the revealed predicates, the cohort size | schedule and predicates on chain; k from `cohort_root` | no, all public |
| `referee` | the proof set (fact ids and values) and the agent's claims | synthetic fixtures only | would leak real facts, so the referee guest is not run on real data until the `zk` feature is on; real facts go to the sealed TEE referee instead |
| `cohort` | the members' nullifiers | on chain, per verdict | no, all public |

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
registers. The doc comment on `set_graph_program` in `contract/src/lib.rs` says "sha256 of its
ELF"; that comment is wrong and this paragraph is the definition. The contract source stays as
deployed until after the submission (code parity with the tagged build).

Nothing in CI rebuilds a guest and re-derives a program hash from source:
`.github/workflows/zk-verifier.yml` builds the host and verifies the committed proofs against
the committed preprocessing. Whether a guest build gives the same hash on another machine is
not tested.

## A fifth guest, proved in the browser (separate pin)

`agents/prove.html` proves one more guest, `decide`, in the visitor's own browser: it reprices
the 8 hotel offers with the same `zkcore` price rule and checks the agent's pick (listed, priced
by code, inside the budget, the cheapest that fits). 39,159 cycles, padded to 2^16; native
prove 1.53 s, verify 28 ms, proof 78,527 bytes (Apple M3 Pro, 11 threads); headless Chrome
5.7 to 15 s on 8 threads across runs and about 21 s on one, and the browser's proof is byte for byte the native
one. A static host sends no cross-origin isolation headers, so the page registers its own
small service worker (`agents/coi-prove-sw.js`, scope `prove` only) that adds them; without it
the page falls back to one thread and says so. The page then
verifies the same proof against a claim changed by one unit and shows it refused.

Who proves to whom: in use, the agent's operator makes this proof and anyone checks it. On the
page the visitor's browser plays both sides, with the buyer's rules and nothing uploaded. With
inputs this small and all public (a 3,109 byte `public.json`, 39,159 cycles), rerunning the
rule natively is faster than the check, which costs about 360 ms and a 1.88 MB download. A
proof matters when an input is hidden or the checker is a contract; neither is true here yet.

It is a separate crate set (`zk/browser/`) on a newer Jolt, rev `b4eb62480d76`, because that
revision has the known wasm32 fixes (a16z/jolt issue #1913 and 0xAndoroid/jolt-wasm-prover;
applied here as `zk/browser/jolt-wasm32.patch`, not ours). The four guests above stay on
`997c1543efd4`, the program the contract anchors. This proof is checked in the page, not on
chain, and is not zero-knowledge (every input is public). No phone has been timed on it yet.
Build and numbers: `zk/browser/README.md`.

## Dependency and prior work

- Jolt: upstream a16z/jolt pinned to `997c1543efd49eb193ca403bb7722fc4b2f8e65b`
  (2026-03-24), the commit the installed `jolt` CLI was built from; arkworks patches at the
  revisions upstream's `Cargo.lock` uses. The REP fork (REP's private Jolt fork) is private, so a
  judge could not fetch it; upstream is public.
- REP's earlier Jolt guests (the JMPR Elite family, `jmpr-elite-*` in REP's private Jolt fork, last
  changed 2026-10-01 to 2026-10-14) are prior work, disclosed in `PRIOR_WORK.md`, and are
  not used. Every BookerBob guest is new code written in the window.
- Measurements (prove time, peak RAM, proof size) per guest are in the table at the top and
  in `docs/evidence.md`.

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
