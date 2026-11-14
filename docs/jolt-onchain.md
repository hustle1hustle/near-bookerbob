# A Jolt proof verified by a NEAR contract

The standing proof (`zk/out/standing-testnet-3`, a16z/jolt `997c1543e`, Dory over BN254) is
verified on NEAR testnet by the contract `verifier.bookerbob-jolt-a.testnet` itself, over 8
transactions. The contract runs Jolt's own verifier code compiled to wasm. No TEE, no operator, no
signature stands between the proof and the verdict: the chain re-executes every check. The
account has no access key (deleted in tx
[EVRobx8K..](https://testnet.nearblocks.io/txns/EVRobx8K5h4H145c7tCUU1KmTiJx3Bke17sqmJPaMaFQ))
and the contract has no owner method, so nobody, REP included, can change the code or a verdict.

Check it without keys (about 30 s, public RPC):

```
node scripts/jolt-onchain-check.mjs
```

It ends `PASS  jolt-onchain-check` after 38 checks (39 when a local build is present):

- The verifier's embedded program is the standing program the bazaar registered
  (`graph_program` on `bookerbob.testnet`, `c780ceab..`).
- The code on chain is the recorded build: wasm sha256 `29ae5c01..` (code hash
  `3ohvMhiF..`), and the same as `zk/onchain/target/jolt_onchain.wasm` when a local build exists.
- The account has no access keys, so the code is permanent.
- Job 4 (the live standing proof behind the bazaar's tree, `zk/onchain/live`) is `verified`.
- Job 1 (the honest proof) is `verified`; job 2 (a Dory forgery) is
  `refused at unit 56: dory final: InvalidProof`; job 3 (one byte of the claim changed) is
  `refused at unit 1: stage 1: SumcheckVerificationError`.
- For each job: the proof and claim on chain are the files in this repo, the statement hash and
  `outputs_sha256` re-derive locally, the tx count is the submit plus the job's advances, every tx
  is a call on the contract (`submit` with that proof and claim, then `advance(id)`), the submit
  tx emitted `submitted(id, statement)`, and the last tx emitted `verified` or `refused` with the
  job's status and statement. For job 1 the emitted outputs are the standing result.

## How it fits in NEAR's gas

One NEAR receipt may burn 1 PGas (protocol 88, testnet). A full Jolt verify costs about 6 PGas in
NEAR wasm, so the contract runs the verifier as a sequence of units and stores a checkpoint between
transactions. Every unit is the pinned verifier's own code, in the same order:

| unit | code | measured gas |
|---|---|---|
| `submit` | proof deserialized with every G1/G2 point check, shape and size checks, stored | 329 Tgas |
| stages | preamble, Jolt stages 1 to 7, stage 8 up to the PCS call | 824 Tgas, one tx |
| combine | one term of the random linear combination of the 42 GT commitments | ~18 Tgas each |
| Dory init | `verify_evaluation_proof` up to its round loop | ~20 Tgas |
| Dory round | `DoryVerifierState::process_round` (10 GT exponentiations, 3 G2 and 3 G1 muls) | ~300 Tgas each, 11 rounds |
| Dory final | `verify_final` (4 Miller loops, 1 final exponentiation) | ~250 Tgas |

The checkpoint (18.7 KB) carries the Fiat-Shamir transcript as its 32-byte Blake2b state and
round counter, the opening point, the joint claim, the combination's progress, and the Dory
verifier state (`c, d1, d2, e1, e2`, the folded scalars). It lives only in contract state.
`advance(id)` can be called by anyone; it runs as many units as fit under the attached gas.

The live run of job 1 on the final contract (`advance` logs):

| tx | units | gas |
|---|---|---|
| submit | | |
| advance 1 | stages 1-7 | 826 Tgas |
| advance 2 | 32 combine terms | 956 Tgas |
| advance 3 | 10 combine terms, Dory init, round 1 | 643 Tgas |
| advance 4-6 | 3 Dory rounds each | 909-916 Tgas |
| advance 7 | round 11, final check: `verified` | 557 Tgas |

Total 6.07 PGas, about 0.6 NEAR of gas at the testnet gas price. Storage: the 3.63 MB contract
(about 36 NEAR staked, once) and about 1.3 NEAR per job while it runs (proof, claim, checkpoint).
When the job ends those are removed and the deposit comes back minus the job record that stays
(about 490 bytes, 0.005 NEAR), so ended jobs are paid for by their submitters.

## The same verifier on NEAR mainnet

The identical wasm (sha256 `29ae5c01..`, code hash `3ohvMhiFS2PUuKkBPMU1BFbXcSAFbMYkEsg1RUpRpqEh`,
the locked testnet verifier's) runs on mainnet at the implicit account
`bf54e11d3abe7fa8a440ccf1534759ca7e96a91930504aa095a0f65808e02be3`. It was deployed on
2026-11-14 on the founder's word, funded with 41.85 NEAR.

Check it without keys: `make jolt-onchain-mainnet-check` (`node scripts/jolt-onchain-check.mjs
--mainnet`, 26 checks with a local build, 25 without, ends `PASS  jolt-onchain-check`). It checks:

- The mainnet code hash equals the locked testnet verifier's, and the embedded program is
  `c780ceab..`, the hash `bookerbob.testnet` registers.
- The staged deploy: the loader, 6 `put` txs that reassemble to exactly the recorded wasm, and
  `deploy(sha256)`.
- Both jobs as on testnet: every tx bound to its job, the statement re-derived, the events matched.

| step | tx |
|---|---|
| loader, 6 chunks, deploy | [86oSc8s6..](https://nearblocks.io/txns/86oSc8s64nFu6ZQtE3PKzL4zawVrvfhqusB591Nz2Ex9), ..., [8g1awM7g..](https://nearblocks.io/txns/8g1awM7gg6WzScxU4DXFXj3NcGePPBnYUN3Byw1Epcqy) |
| job 1: the live standing proof (the proof behind the bazaar's tree, as testnet job 4): `verified`, 8 txs, 6.44 PGas | submit [GSm6sFUS..](https://nearblocks.io/txns/GSm6sFUSoa8pEUp7QxmnEBXYWJwP5cxK3cedKumUb4rd), last [DzzyBuE8..](https://nearblocks.io/txns/DzzyBuE8CRTSiQtr4JGfrHZ4GbkG2eWLhy9nHXft31rg) |
| job 2: the Dory forgery (as testnet job 2): `refused at unit 56: dory final: InvalidProof`, 8 txs | submit [E9vNuYoo..](https://nearblocks.io/txns/E9vNuYooUmWQiruqpLbZSVhZoQBu1ufsoj59M64eEBba), last [4ZCrg8cq..](https://nearblocks.io/txns/4ZCrg8cqN1B4G4CWefM398ak8cvrCxv46qGqTfuRNrXk) |

Cost: 1.32 NEAR left the account (41.848 to 40.528). Of that, about 1.31 is gas: 0.08 for the
deploy and about 1.23 for the two jobs. The other 0.011 is the two ended job records. About 36.3
NEAR stays as code storage.

Unlike the testnet copy, the mainnet account keeps its full-access key, so the ~36 NEAR of code
storage can be reclaimed after judging. Until then the key's holder (REP) could redeploy the
code. The keyless check prints the key count; the permanence claim belongs to the testnet copy.
The runner is `zk/onchain/scripts/mainnet.mjs`: it refuses without `--mainnet` and
`BOOKERBOB_MAINNET_GO=<today>`, and records every tx in `zk/onchain/onchain-run-mainnet.json`.

## A contract that acts on it: coalition version 4

`coalition-v4.bookerbob-demo.testnet` (source `coalition/v4/`, wasm sha256 `47e3fa11..`, created
with no access key) admits a merchant agent into a coalition job only on a standing proof the
verifier above checked on chain. It is coalition version 3 (docs/coalitions.md) with one change:
each join names a verifier job and the proof's public inputs. Next to the bazaar's `in_top` and
`merchant` answers, the coalition reads `status(id)` from the verifier and `standing_root()` from
the bazaar, and admits only if the job is `verified`, did not panic, and its statement re-derives
in the coalition as sha256(program `c780ceab..` || inputs || graph root || scores hash || panic=0
|| proof sha256). The graph root and scores hash are the bazaar's live ones. The bazaar built its
standing tree (root `3b5db5e9..`) from the scores with that hash, so the tree that `in_top`
answers from is the one the verified proof covers: there is no worker signature between the
tree and the proof.

On testnet (`make coalition-jolt-check`, keyless, 24 checks with the local build and 23 without, ends `PASS  coalition-jolt-check`):

| step | tx |
|---|---|
| the live standing proof (`zk/onchain/live`, sha256 `5619f62d..`, the proof behind the bazaar's tree) verified as verifier job 4 | 8 txs, last `AhKSKWAC..` |
| create the coalition account (no key), deploy, `new(dUSDC, bazaar, treasury, verifier)` | `FxSuj7Hs..` |
| `cl-lead-1df7` opens job 0 (hoodie leg, hotel-lisbon leg, bond 1, budget 2 dUSDC, min_top_pct 100) and funds it | `3Mt3TQwc..`, `8f324e3H..` |
| h05 joins with verifier job 1: verified, but over an older graph. Refused: "the verifier's job is not a verified standing proof of the bazaar's live standing root", bond refunded | `FZaJwtKo..` |
| m01 joins with verifier job 4: admitted, `joined` carries job 4's statement `61effb83..` and tree root `3b5db5e9..` | `DsHD55CM..` |
| `finalize` after the deadline, no purchase made: m01's bond released, the budget back to the lead, nothing slashed | `uxVh2YBP..` |

`coalition/v4/src/tests.rs` adds six tests to version 3's suite (35 pass). One re-derives job 4's
on-chain statement from the live inputs. The others refuse an older root, an unverified,
refused or panicked job, another statement or proof hash, other inputs, and a join that names
no verifier job.

Limits:

- The coalition trusts the bazaar's views (`in_top`, `merchant`, `standing_root`). The bazaar
  account holds no access key since 2026-11-14 (DeleteKey
  [28EvzuBN…](https://testnet.nearblocks.io/txns/28EvzuBNzLPPHd9kLX3jctGhC9xhcuGaykwGofSX7SaZ)), so
  its code cannot change.
- The bazaar's root still comes from a worker-signed update with a challenge window. Only this
  coalition consumes the on-chain verdict.
- `in_top` and `standing_root` are separate view receipts of one join. If a bazaar standing update
  lands between them, the rank can be read from a newer tree than the one the proof matched. The
  bazaar's `in_top` requires the TopProof's n to equal the live tree's n. The coalition does not
  compare the TopProof's n to `standing_root`'s n itself (its code is locked; a later version
  would). The keyless check confirms both were 3 here.
- Job 0 uses min_top_pct 100: any member with a leaf in the proven tree qualifies on rank.
- A verified proof of the graph the bazaar holds says the scores are the program's output over those graph events. It
says nothing about whether the events are honest (that is the bazaar's paid-review rule). The
coalition reads the verifier through a cross-contract view; a verifier job never expires once
verified, and it is valid exactly while the bazaar's root is the one it proves.

## Measurements behind the design

Measured on testnet with `env::used_gas()` (a measurement contract on `bookerbob-jolt-a.testnet`,
since replaced; txs `Dkxzri8Y..`, `DCwZ5orx..`):

| operation | Tgas |
|---|---|
| inflate the 4.18 MB preprocessing (267 KB deflated in the code) | 82 |
| sha256 of the 4.18 MB preprocessing | 117 |
| deserialize the preprocessing (4.10 MB of it is the bytecode) | 235-255 |
| deserialize the proof with point checks / without | 305 / 5 |
| Jolt stages 1-5 (sumchecks) | ~40 in total |
| Jolt stage 6 (bytecode read-RAF, evaluates the whole bytecode) | 443 |
| Jolt stage 7 | 3 |
| GT exponentiation (Fq12, full Fr scalar) | 18.2 |
| G2 scalar mul / G1 scalar mul | 16.3 / 3.6 |
| Fq12 mul | 0.10 |
| one pairing | ~30 |

Natively the same verifier takes 65 ms, of which stage 8 (Dory) is 57 ms. NEAR wasm gas is about
2,000 times the V8 wall time of the same wasm, which is why the Dory part is the bulk: its GT and
G2 arithmetic has no NEAR host function (NEAR has `alt_bn128_g1_multiexp`, `alt_bn128_g1_sum` and
`alt_bn128_pairing_check`, which only checks that a product of pairings is 1, while Dory compares
a multi-pairing to an arbitrary GT element).

## What changed from upstream Jolt

Nothing in a check. The vendored copies (`zk/onchain/vendor/`) differ from a16z/jolt `997c1543e`
and dory-pcs 0.3.0 as follows:

- jolt-core: `verify_stage1..8` and their result types are `pub`; `verify_preamble` is the
  pre-stage part of `verify` as a function; `verify_stage8_prefix` is `verify_stage8` up to the
  PCS call, returning the opening point, the joint claim and the (coefficient, commitment) pairs;
  `Blake2bTranscript::n_rounds`, the dory `wrappers` and `commitment_scheme` modules and
  `reorder_opening_point_for_layout` are `pub`; `chrono` without default features.
- jolt-platform: `getrandom` without the JS backend on wasm32 (NEAR has no JS host; the verifier
  draws no randomness).
- dory-pcs: the fields of `DoryVerifierState` are `pub`, so the state can be checkpointed.

The driver is `zk/onchain/src/resumable.rs`; the contract is `zk/onchain/src/contract.rs`.

## Soundness review (coordinating session, 2026-11-14, two rounds)

An independent audit found the split equivalent to upstream `verify`, with the proof bound at
submit and no state shared between jobs. Six Dory-targeted forgeries were all refused at the last
unit (`zk/onchain/src/bin/audit.rs`). The fixes from both rounds are in the deployed contract:

- Malformed shapes are refused at submit or in the first Dory unit, so they cannot panic forever:
  `trace_length` and `ram_K` must be powers of two within bounds, nu <= sigma, and the round counts
  must equal sigma.
- `expire(id)`, callable by anyone, ends a job that has run 1,200 blocks without a verdict:
  refused, storage freed, deposit returned.
- Proof at most 128 KB, io at most 8 KB, inputs and outputs within the program's 4,096-byte
  bounds, and a deposit of at least the job's measured storage plus 40 KB.
- A proof whose io says the program panicked is refused at submit. This is stricter than upstream
  Jolt, which verifies a panicked run; this contract only records successful ones.
- Each job carries `statement` = sha256(program_hash, inputs, outputs, panic, proof_sha256), with
  inputs and outputs length-prefixed and trailing zero bytes trimmed. Zero-padded outputs verify
  in Jolt, and the trimmed statement makes them the same claim. The record keeps only hashes;
  the inputs and outputs are in the `submitted` event, and the outputs are also in the final one.
- No owner method: the one-time `reset` used during the audit is gone. The final contract was
  deployed to a fresh account (`verifier.bookerbob-jolt-a.testnet`, created by
  `bookerbob-jolt-a.testnet`, which has no power over it).
- The build fails unless the embedded preprocessing hashes to `c780ceab..` and the embedded Dory
  setup to `425f8024..` (`zk/onchain/build.rs`).
- `zk/onchain/scripts/mock-test.mjs` runs the contract wasm under a mocked NEAR host. It checks
  submit's refusals (a small deposit, trace_length 0 and usize::MAX, nu > sigma, panic=true,
  outputs over 4,096 bytes, a 140 KB proof), `expire` before and after 1,200 blocks, a full
  honest run, and the refund equal to the deposit minus the kept record. It ends
  `PASS  mock-test`.

## Trust model and limits

- The verdict trusts the NEAR validators' execution, Jolt's soundness at the pin, and the
  contract code. The code on chain is the local build: wasm sha256 `29ae5c01..`, code hash
  `3ohvMhiFS2PUuKkBPMU1BFbXcSAFbMYkEsg1RUpRpqEh`, from `zk/onchain/scripts/build.sh`.
  A second checkout at another path on the same machine rebuilt it byte for byte (2026-11-14,
  `scripts/build.sh`, 3,626,218 bytes, sha256 `29ae5c01..`); another machine is not shown.
- No key, no owner power: after the final audit the only full-access key of
  `verifier.bookerbob-jolt-a.testnet` was deleted on the founder's OK (tx `EVRobx8K..`). The
  account has no access keys, so its code is permanent; `submit`, `advance`, `expire` and the
  views are open to anyone. `jolt-onchain-check` prints the key count.
- Gas headroom: stages 1-7 run in one tx at 826 Tgas against the 950 Tgas the contract requires
  and the 1 PGas protocol cap. A future NEAR gas repricing that pushes that unit over 1 PGas would
  stop new proofs from verifying, with no way to update the locked code. Past verdicts stay.
- Anyone can call `expire` on a job that has run 1,200 blocks without a verdict, including an
  honest one that nobody advanced: it ends refused and the deposit is returned. Advancing takes
  8 txs, about a minute.
- Storage: an ended job keeps a record of about 490 bytes, paid from its deposit. The contract's
  own balance pays for nothing per job.
- GT elements in the proof (the 42 commitments and Dory's GT messages) are not subgroup-checked,
  the same as upstream Jolt; G1 and G2 points are checked at submit.
- One program per deployment: the contract embeds the standing program's preprocessing. Another
  guest needs its own build, or the preprocessing in state (about 42 NEAR of storage uncompressed).
- Classical security only (BN254); Jolt's `zk` feature is off at this pin, as in `zk/`.
- Testnet only. The bazaar does not read this verdict yet: `submit_graph_scores` still takes a bonded
  worker's signed update, which anyone can challenge and an arbiter key re-checks by rerunning the
  verifier off chain. Wiring it is a cross-contract read of
  `status(id)`, checking that `statement` matches the update.
- The staged deploy needs a loader (`zk/onchain/loader`), because the 3.63 MB contract is larger
  than one transaction (1.5 MiB). The code is uploaded in 700 KB chunks, checked by sha256, and
  deployed by the account onto itself.

## The other routes, checked

- A Groth16 wrap: a16z merged a gnark Groth16 transpiler for Jolt stages 1-7 only (a16z/jolt PR
  1322, 2026-04). It leaves out stage 8 (Dory) as too expensive in-circuit, needs a trusted setup
  per program, and has no on-chain verifier. The Spartan+HyperKZG wrapper (PR 1837) was closed
  unmerged. Nothing wraps a full Jolt proof today.
- HyperKZG as Jolt's PCS: implemented in jolt-core at the pin, with pairing-only verification that
  `alt_bn128_pairing_check` would make cheap. Stage 8 assumes Dory's matrix layout, and the SDK
  hard-codes Dory, so the standing proof cannot use it without changing the prover.
- A hybrid (stages 1-7 on chain, Dory under a signed verdict or a challenge) is not needed: the
  Dory check runs on chain in 6 of the 8 transactions.

## Reproduce

```
cd zk/onchain
scripts/build.sh                     # Rust 1.95, wasm32, wasm-opt (binaryen); about 3 min
cargo run --release --features native --bin jolt-onchain-native -- ../out/standing-testnet-3
cargo run --release --features native --bin audit -- ../out/standing-testnet-3
for m in "" trace0 tracehuge nusigma; do AUDIT_OUT=forged target/release/audit ../out/standing-testnet-3 $m; done
node scripts/mock-test.mjs           # submit refusals, expire, a full run, the refund
node scripts/mock-run.mjs target/jolt_onchain.wasm program_hash   # wasm under a mocked host
# testnet (needs a funded account in ~/.near-credentials):
scripts/staged-deploy.sh <acct>.testnet target/jolt_onchain.wasm
SIGNER=<you>.testnet scripts/run-job.sh <acct>.testnet ../out/standing-testnet-3/proof.bin ../out/standing-testnet-3/io_device.bin
```
