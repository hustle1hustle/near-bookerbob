# Jolt zkVM for BookerBob (status 2026-11-04)

Status: **the graph and the on-chain side are built and tested; the Jolt prover itself is
not built yet.** Fetching and compiling the Jolt git dependency (a16z/jolt) was blocked by
the build session's permission check as external code. The command for the founder is in
`RESUME.md` ("Blocked"). Nothing below claims a proof that has not been made.

## Why Jolt here

The contract cannot afford to recompute standing over the whole hire graph on chain,
and OutLayer's output is capped at 900 bytes. Jolt proves an arbitrary Rust computation
(RISC-V) and the proof is checked off chain; the chain keeps a root and a signed result.

## Guests (planned in this order)

| guest | proves | status |
|---|---|---|
| `standing` ("verifiable PageRank for agents") | from the graph events (hire edges, released review seeds), the hash-chained root they produce, and the merchant scores plus every account's standing with conserved transport, w = 1/2 (following a design rule in REP's unpublished draft "(title withheld) for a World of Agents") | source written (`zk/guests/standing`), not built |
| price stack | `price = f(verdict, schedule)`; the receipt carries the proof hash | not started |
| referee | the citation check, as a second path beside the TEE | not started |
| cohort matching | the answer came from a committed cohort with k >= 5 | not started |

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

## The flow once Jolt builds

1. Rebuild the events from the contract's `graph_event` logs.
2. `cargo run --release -- prove-standing fixtures/graph/standing-events.json zk/out/standing`
   (in `zk/`): proof, verifier preprocessing, `result.json` (root, scores hash, program
   hash, prove time, proof size).
3. The worker verifies the proof (`verify-standing`), recomputes the scores natively,
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
