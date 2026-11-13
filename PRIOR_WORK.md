# Prior work disclosure

This repository was created on 2026-11-04, inside the NEAR HACKATHON window
(2026-11-01T00:00Z to 2026-11-14T23:59Z). Every commit in its history was made in the
window and is pushed as it is written.

## Written during the hackathon (in this repo)

Everything in this repository: the `bazaar` contract, the `bookerbob-core` library (verdict
envelope v0, deterministic tier, price and discount stack, referee, Semaphore pieces,
conserved delegation), the `bookerbob` CLI, fixtures, the swarm and board, the UCP
handler under `ucp/`, the relayer, docs and CI.

How it was built: Claude Code sessions directed by the founder, one coordinating session
and one build session, with each commit pushed as it was written. Most of the repository
(about 116 commits) landed on 2026-11-04 in one long AI build session: that is why the
history is dense, not because code was imported. Every commit is in the window; nothing
predates 2026-11-01. From 2026-11-05, small commits each carry a testnet transaction.

## Ideas taken from our ETHGlobal Mumbai build (2026-11-05 to 2026-11-07), code written here

Our own entry at ETHGlobal Mumbai (BookerBob on another chain, same team, in this hackathon's
window but for another event) proved a Jolt guest in a phone browser. No file from it is copied
here. `zk/browser/` and `agents/prove.html` are this repo's own code; these ideas came from it:

- Compile jolt-sdk's host prover to `wasm32-unknown-unknown` behind wasm-bindgen and run it in a Web Worker.
- Pin Jolt `b4eb62480d76` with Rust 1.95 and wasm-bindgen 0.2.114, and the linker flags (2 GB max memory, 8 MB stack).
- Keep the wasm32 fixes as a patch file applied to a fetched copy of Jolt at build time.
- Ship the guest ELF and the serialized prover preprocessing as static files, so the browser neither compiles nor preprocesses.
- Report prover stages from Jolt's own tracing spans (`prove_stage*`) over a BroadcastChannel, panics too.
- Count downloaded bytes against a published `sizes.json` for a real progress bar.
- A verifier with a plain C ABI and no JS glue, which rebuilds the public inputs from `public.json`.
- Show a refusal by verifying the same proof against a statement with one number changed.
- The threaded build recipe (atomics, `-Z build-std`, wasm-bindgen-rayon, the worker import fix), kept in `build.sh` and not run here.
- The iPhone timing above, as that build's reference number.

Also from that build, as ideas only: a page a stranger can use without a wallet (the swarm page
and the prove page), a "change one number, see it refused" check, and a daily recheck of live
claims (`.github/workflows/live.yml`). The two wasm32 fixes in `zk/browser/jolt-wasm32.patch`
are upstream's, not ours: a16z/jolt issue #1913 and 0xAndoroid/jolt-wasm-prover.

Also from that build, for the history anchor (`anchor/`, `scripts/anchor.mjs`, own code; that
build kept its history on Ethereum Sepolia, here NEAR holds it):

- Keep a market's public history on a second chain as a hash chain of round roots, so changing an old round changes every later root and a round cannot be skipped.
- A round is every public log in blocks whose `timestamp / epochLength` is the round number, in (block, logIndex) order; a round with no logs gets no post.
- A post proves only who sent it, so a reader trusts one named poster, and a rebuild from the source chain is what makes that poster worth trusting.
- A posted round can never be posted again or replaced.
- Nullifiers appear in no event: read them from the calldata of the `join`, `review` and `proveReturn` calls, found by selector through any wrapper.
- Rebuild the market state by replaying logs in order: contexts, members and replacements, receipt groups, join queues and their closing, reviews, mints, lists.
- Use the Semaphore group roots as a check that members were inserted in the same order.
- One documented byte format that the poster and the rebuild both follow, and a `make anchor-rebuild` that checks one against the other.

## Prior REP work, used only as named services or dependencies

None of this code is copied into the repository. Where a component is used, it is called
as a service or pinned as a versioned dependency, and named here.

| prior work | what it is | how BookerBob uses it | status in this repo |
|---|---|---|---|
| REP zkTLS prover and MPC notary (TLSNotary lineage, tlsn 0.1.0-alpha.15; `rep-notary.fly.dev`, signing key `02114d7e…ab25ef`) | proves facts over a user's own accounts with MPC-TLS; the notary sees ciphertext only and signs the presentation | the device run (not in this public copy): the REP app proves one real fact (Claude spend) on the founder's phone and the REP notary signs it | not used by `make verify`; the device run uses it as a service |
| REP public-fact prover (`prove_public_fact.rs`, 2026-09, on `tlsn-mobile`'s `notarize` / `verify_presentation`) | notarizes any HTTPS GET and reveals only the fields a regex selects | `make prove-me`: REP's prover (not in this repo)src/main.rs` is adapted from it (an Authorization header from a token file, the request never revealed, the notary configurable, exactly 3 fields of api.github.com/user); it builds against the local `tlsn-mobile` crate, whose code is not copied | adapted file in this repo, marked as such in its header; the crate is a path dependency outside the repo |
| dcap-qvl 0.3.12 (Phala-Network/dcap-qvl, commit `a854bd2`, MIT, public) | Intel DCAP quote verification | `tools/dcap-spike/dcap-qvl-port/` is a fork of the published crate; the one change is a `split` module at the end of `src/verify.rs` that runs the same checks in five steps for a NEAR contract (`tools/dcap-spike/README.md`); the rest is unchanged | forked in this repo, the change marked in the file |
| REP iOS app (TestFlight) and `rep-verify` (REP's presentation verifier, built 2026-07-02) | the phone prover and the Mac-side check of a notary-signed presentation against the pinned key | the device run: the phone capture script (not in this public copy) receives the presentation the app POSTs, the phone run's script (not in this public copy) verifies it with `rep-verify` | called as a tool, no code copied |
| rep-attest | verdict and SD-JWT-VC issuance, tier-issuer | the envelope v0 format here is written fresh and is compatible in spirit; the service is not called today | spec only |
| rep-concierge (NEAR AI attestation, E2EE v2) | private inference pipeline | reference for request shapes; the NEAR AI client in this repo is written in the window | planned |
| rep-world-verify | World ID 4.0 off-chain verify | service that will sign the `WorldBody` (`core/src/world.rs`) the contract checks in `attest_human` | contract side built on fixtures; service not called yet |
| HackMeridian UCP module (BookerBob, 2026-10-25, local repo `ucp-module`, commit `97d9320`) | UCP bridge to our Shopify test store `jwq0dd-rp`, Stellar USDC payment handler, draft-order write-back | the NEAR handler `ucp/src/near-usdc.mjs` is new code written in the window; the bridge surface will be ported file by file, each with a header naming its source | handler built; bridge port not started |
| Shopify test store `jwq0dd-rp` (same store as the HackMeridian entry) | our own test store, not a real merchant | demo-mode settles write a paid order there through the Admin API (draft order completed as paid, `near_tx` in the note); credentials live outside the repo | live on testnet settles (docs/testnet.md) |
| HackMeridian Stellar entry: its own testnet USDC issuer ("On testnet we use our own USDC issuer so seed guests can be funded") | the approach, not the code | demo mode's dUSDC follows the same idea on NEAR: a testnet demo token with no value, so testers need no faucet; production uses Circle USDC. dUSDC is new code (`dusdc/`) | built, live on testnet |
| HackMeridian Proof of Stay Soroban contract (Oct 2026) | Semaphore-based Stellar contract | not used | none |
| REP Jolt fork and the JMPR Elite guests (REP's private Jolt fork, `examples/jmpr-elite-*`, last changed 2026-10-01 to 2026-10-14) | Jolt zkVM guests proving hotel elite status from signed sources | not used; BookerBob's Jolt guests (`zk/`) are new code, and the dependency is upstream a16z/jolt pinned to a public commit | none |
| REP iOS app (NearTrust / NearSeal) | on-device proofs and enclave check | closed client in the demo | not in this repo |

## External data

| source | what | how |
|---|---|---|
| JMPR (public hotel rates) | 8 Lisbon hotel "from" rates and elite perks, 2026-12-10 to 12-13, queried 2026-11-04 | read-only `hotel_search`; nothing prebooked or booked; stored in `fixtures/live/jmpr-lisbon-rates.json` as comparison prices, hotel names and prices only |

## Open source dependencies

| dependency | license | use |
|---|---|---|
| near-sdk-rs 5.29.1 | MIT / Apache-2.0 | contract, host functions `ed25519_verify` and `p256_verify`, MockedBlockchain for offline runs |
| ed25519-dalek, p256 (RustCrypto) | BSD-3 / MIT / Apache-2.0 | fixture signing and independent off-chain signature checks |
| serde, serde_json, borsh, sha2, hex | MIT / Apache-2.0 | encoding and hashing |

| proptest | MIT / Apache-2.0 | property tests (dev only) |
| dcap-qvl 0.3 (Phala) | MIT | Intel TDX quote verification for the NEAR AI attestation, offline with committed collateral |
| chacha20poly1305, hkdf, curve25519-dalek (RustCrypto, dalek) | MIT / Apache-2.0 / BSD-3 | opening the NEAR AI E2EE v2 answer (contract and CLI) |
| light-poseidon 0.4.1 (data only), sha3 | Apache-2.0 / MIT | Semaphore Poseidon: the width-3 circomlib round constants are extracted from light-poseidon's parameter file into `core/src/poseidon_params.rs`; the field arithmetic and permutation in `core/src/poseidon.rs` are new code (the crate itself made the contract wasm 2 MB, over NEAR's transaction limit); sha3 for Semaphore's message hash |
| voprf 0.5.0 (facebook/voprf) | MIT | RFC 9497 VOPRF, ristretto255-SHA512: the account nullifier (`cli/src/voprf.rs`); used as published, with its `danger` feature for the deterministic blind behind the public redemption record; vendored in `vendor/crates.tar.xz` |

## AI assistance

Code in this repository is written with Claude Code sessions directed by the team. Commits
carry a `Co-Authored-By` trailer where an AI session wrote the change.
| @semaphore-protocol/core 4.14.5, snarkjs 0.7.6 (npm, `semaphore/`) | MIT / GPL-3.0 | generating the Semaphore identities, groups and proofs for the fixtures only; not shipped in the contract |
| Semaphore V4 trusted setup (PSE ceremony, 2024-07-13) | public artifacts | the verification keys compiled into the contract (`fixtures/semaphore/verification-key.json`) |
