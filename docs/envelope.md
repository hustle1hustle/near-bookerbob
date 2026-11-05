# Verdict envelope v0

The envelope is what leaves the enclave. It carries coarse predicates, never raw history.
Source of truth for the types: `core/src/envelope.rs`.

## Fields

| field | type | meaning |
|---|---|---|
| `v` | u8 | always `0` |
| `context` | string, 1..64 | purchase context, e.g. `bookerbob:v0:lisbon-hotel`. The nullifier is per context |
| `nullifier` | hex, 32 bytes | per-context account nullifier: `sha256(TAG || F_k(x))`, the RFC 9497 VOPRF output of a fresh input `x = context || random` the buyer blinded (`cli/src/voprf.rs`, live since 2026-11-05 via `DEMO_VOPRF=1`). Earlier purchases and the fixtures use an HMAC or a labelled placeholder |
| `commitment` | hex, 32 bytes | `sha256("bookerbob/commit/v0\0" || salt || json(all derived predicates))`; lets the buyer later prove what was held back |
| `proof_hash` | hex, 32 bytes | `sha256(json(proof set))` the verdict was computed over |
| `predicates` | string[] | predicates revealed for this purchase; sorted, unique, each in `KNOWN_PREDICATES` |
| `tier` | string | `none`, `silver` or `gold`; a function of the derived predicate count, computed by code |
| `attestation.model` | string | model id, e.g. `z-ai/glm-5.3-flash` |
| `attestation.tcb_status` | string | TCB status from the attestation, recorded as is (`UpToDate`, `OutOfDate`, `fixture`) |
| `attestation.report_hash` | hex, 32 bytes | sha256 of the attestation report the issuer checked |
| `cnf` | NEAR account id | the agent allowed to act on the verdict (submit and settle) |
| `max_spend` | decimal string (u128) | spend cap in token base units (USDC: 6 decimals) |
| `issued_at_ms`, `expires_at_ms` | u64 | unix ms; the contract rejects an expired verdict |

## Signature

```
message = "bookerbob/verdict/v0" || 0x00 || json(envelope)   // serde field order as declared
digest  = sha256(message)
```

| `alg` | `issuer_key` | `signature` | contract check |
|---|---|---|---|
| `ed25519` | 32 bytes hex | 64 bytes hex, R \|\| S over `digest` | `env::ed25519_verify(sig, digest, key)` |
| `p256` | 33 bytes hex, compressed SEC1 | 64 bytes hex, r \|\| s over prehash `digest`, low-S required | `env::p256_signature_is_low_s` and `env::p256_verify(sig, digest, key)` |

P-256 exists so an iPhone Secure Enclave key or a passkey can sign directly; `p256_verify`
is a host function since protocol 85.

## Predicates

Defined in `core/src/tier.rs` (`RULES`): `airbnb_frequent`, `booking_genius`,
`claude_spender`, `github_builder`, `steam_veteran`, `uber_regular`, `world_id_human`. A model cannot add one.
