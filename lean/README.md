# Lean proofs for smith programs

- `two-agent-smith/`: coalition-split v2, writer and reviewer specs, `check_ok_iff_spec` and `spec_a_iff_spec_b` (rebuild: `REBUILD.md`). The same sources are the v0 release of near-lean-attest, whose OutLayer TEE run checked their delta.
- `gap-ir-closed/`: coalition-k-of-n and spend-bucket written once as Lean terms; the Rust is printed from them and pinned by the kernel byte for byte (rebuild: `REBUILD.md`).
- Aeneas and hax routes and the TEE worker builds: https://github.com/hustle1hustle/near-lean-attest/releases
- `aeneas-route/` and `hax-route/`: coalition-k-of-n proved on Lean extracted from its Rust (restricted dialect). The vendored Aeneas and hax Lean libraries are left out; full builds are in the near-lean-attest release lean-gap-routes-v0.
