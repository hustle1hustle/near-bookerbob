# How this was checked

On 2026-11-14 an independent agent tried to break each block: it read the code, re-derived the
numbers from the chain, and planted tampered records. We fixed what it found, and a second agent
re-audited. Per block: the worst finding, the fix, what is still open.

| block | worst finding | fix | still open |
|---|---|---|---|
| On-chain Jolt verifier (`docs/jolt-onchain.md`) | Malformed proof shapes could panic a job forever; an owner `reset` existed. All 6 Dory forgeries were refused. | Shape bounds, `expire` after 1,200 blocks, setup pinned; `reset` removed, last key deleted. | 826 of 950 Tgas on locked code; GT not subgroup-checked (as upstream); the bazaar does not read the verdict yet. |
| OutLayer referee, arbiter, Jolt verify, TDX attestation (`docs/outlayer.md`, `docs/keyless.md`) | A dispute check passed a run whose resolve failed on chain; a DCAP verification was not tied to its exact quote. | Both txs must succeed (the first run kept as a timeout); the DCAP start tx must carry the exact quote bytes. | OutLayer's keystore is trusted; our arbiter and referee keys stay registered; we own the project. |
| Smith (`docs/smith.md`) | Model-written code slipped past a regex check and ran a command on the build Mac; the first sandbox still reached the keychain service. | Model code runs as import-free wasm or in Jolt's emulator; a syn allowlist, `no_std`, `forbid(unsafe)`, a deny-by-default sandbox. | macOS only; a compiler bug would run inside the sandbox. |
| Coalitions v1 to v3 (`docs/coalitions.md`) | v2: a buyer announced twice and settled the first; the member was paid and slashed. Job C allowed self-delivery. | v3 binds delivery to the announced purchase and closes the nullifier hijack and sock-member grab; PoC tests kept. | A buyer can announce and never settle; a late announce can still slash a paid member; deploy keys held. |
| Standing v2 to v4 (`docs/coalition-prereg-v2.md` to `v4.md`) | Each failed its own pre-registration: v2 on failed legs (23.7 vs 18.3), v3 on legs and fill, v4 on reach (newcomers in 16 of 20 seeds, 18 required). | Published as failed, with anchor txs. Admission stays on v1. | v4 is the next candidate. |
| Economy anchor (`docs/anchor-format.md`) | JSON parsing rounded every record's block timestamp, so records did not match NEAR's RPC byte for byte. | A lossless parse, re-collected and re-posted on a new account; epoch close moved into the contract; counters read at the anchored block; watched contracts 6 to 9. | Discovery trusts an indexer; the `--rpc` archival cross-check is the backstop. |
| Collusion measurement (`docs/collusion.md`) | 45 fallback prices were not re-verified, and the run log under-disclosed how replicate 3 was launched and that the amendment followed interim data. | The check asserts every fallback price; the run log is complete. | Direction only (p 0.25); the prompt binding rests on the disclosed field keys; the talking arm did not run. |
| Who sees what (`docs/leak.md`) | Plaintext reasoning on chain passed the check. | Ciphertext of the right length required; planted tests bite. | The gateway row scans a testnet capture. |
| Buckets (`docs/leak-amount.md`) | The leak drop was counterfactual; the merchant picked leaks bits too. | Both stated up front; costs shown with the cohort unlock. | The prior is ours. |
| MCP (`docs/mcp.md`) | A shell injection through the registrar into a suggested near CLI line, and `verify_standing` accepting with no subject. | Strict patterns, input schema enforced, no subject means reject. | Coalitions v3 is not wired yet. |
| Open mainnet round (`docs/round-mainnet.md`) | One bad sealed reveal could stop relays for every later bidder, and the relayer was the buyer account, drainable by bad delegates. | Per-bidder isolation with one attempt each, a separate 0.05 NEAR relayer, a 0.4 NEAR buyer floor, approvals capped at 60. | The watcher approves accounts and runs on our machine. |
| Dory URS (`docs/smith.md`) | The guard missed unpinned URS files already in the cache, and the trust wording claimed a trapdoor. | The guard fails on any unpinned file; the wording now states provenance: points sampled from random x-coordinates, so nobody learned discrete logs. | A reader trusts the file's origin; hash-to-curve from a public seed is next. |

Every check named in these docs runs without keys. Start with `make verify-all`, or open
`agents/verify.html`.
