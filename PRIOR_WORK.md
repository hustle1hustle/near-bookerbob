# Prior work disclosure

This repository was created on 2026-11-04, inside the NEAR HACKATHON window
(2026-11-01T00:00Z to 2026-11-14T23:59Z). Every commit in its history was made in the
window and is pushed as it is written.

## Written during the hackathon (in this repo)

Everything in this repository: the `bazaar` contract, the `bookerbob-core` library (verdict
envelope v0, deterministic tier, price and discount stack, referee), the `bookerbob` CLI,
fixtures, the swarm and board, the UCP handler under `ucp/`, docs and CI.

## Prior REP work, used only as named services or dependencies

None of this code is copied into the repository. Where a component is used, it is called
as a service or pinned as a versioned dependency, and named here.

| prior work | what it is | how BookerBob uses it | status in this repo |
|---|---|---|---|
| REP zkTLS prover and MPC notary (TLSNotary lineage) | proves facts over a user's own accounts; notary sees ciphertext only | external service that produces the proof a verdict is issued over | not used by `make verify`; fixtures are synthetic |
| rep-attest | verdict and SD-JWT-VC issuance, tier-issuer | the envelope v0 format here is written fresh and is compatible in spirit; the service is not called today | spec only |
| rep-concierge (NEAR AI attestation, E2EE v2) | private inference pipeline | reference for request shapes; the NEAR AI client in this repo is written in the window | planned |
| rep-world-verify | World ID 4.0 off-chain verify | service that will sign the `WorldBody` (`core/src/world.rs`) the contract checks in `attest_human` | contract side built on fixtures; service not called yet |
| HackMeridian UCP module (BookerBob, 2026-10-25, local repo `ucp-module`, commit `97d9320`) | UCP bridge to our Shopify test store `jwq0dd-rp`, Stellar USDC payment handler, draft-order write-back | the NEAR handler `ucp/src/near-usdc.mjs` is new code written in the window; the bridge surface will be ported file by file, each with a header naming its source | handler built; bridge port not started |
| HackMeridian Proof of Stay Soroban contract (Oct 2026) | Semaphore-based Stellar contract | not used; `stellar/` is a new, much smaller contract written in the window | none |
| REP iOS app (NearTrust / NearSeal) | on-device proofs and enclave check | closed client in the demo | not in this repo |

## Open source dependencies

| dependency | license | use |
|---|---|---|
| near-sdk-rs 5.29.1 | MIT / Apache-2.0 | contract, host functions `ed25519_verify` and `p256_verify`, MockedBlockchain for offline runs |
| ed25519-dalek, p256 (RustCrypto) | BSD-3 / MIT / Apache-2.0 | fixture signing and independent off-chain signature checks |
| serde, serde_json, borsh, sha2, hex | MIT / Apache-2.0 | encoding and hashing |
| soroban-sdk 28.0.0 | Apache-2.0 | Stellar leg contract in `stellar/` |

## AI assistance

Code in this repository is written with Claude Code sessions directed by the team. Commits
carry a `Co-Authored-By` trailer where an AI session wrote the change.
