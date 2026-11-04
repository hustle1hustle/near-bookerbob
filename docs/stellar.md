# Stellar leg: one verified context, any chain

Status: Soroban contract built and tested locally (`stellar/`, 4 tests, `make test-stellar`).
The NEAR side of the signing flow is designed, not built. Testnet only.

## What exists

| piece | where | status |
|---|---|---|
| Chain Signatures key for the bazaar on Stellar | `fixtures/live/views.json`: `derived_public_key` for predecessor `bookerbob.testnet`, path `stellar-1`, `domain_id: 1` on `v1.signer-prod.testnet`, and its G-address `GD4XBCEC...S3N3` (round-trips through `stellar strkey decode`) | live view |
| Soroban contract `bookerbob-stellar` | `stellar/contracts/bookerbob-stellar/src/lib.rs` | built, 4 tests, 3 KB wasm with `stellar contract build` |
| first MPC `sign` with `domain_id: 1` | not done | needs near-cli (open check B2) |

## The contract

`__constructor(admin, near_signer, usdc)`, where `near_signer` is the Chain Signatures
G-address. `settle_from_near(nullifier, merchant, amount, checkout_ref)` requires
`near_signer`'s auth, rejects a spent nullifier (its own spent-set), pays the merchant from
the contract's USDC balance and emits `settled`. `set_near_signer` (admin) rotates the key
for a new path or MPC key version. Tests: a NEAR-signed settle pays once, a replayed
nullifier is rejected, a bad amount is rejected, and a call authorized by anyone else
fails.

## The flow (design)

1. The purchase settles on NEAR first (`settle`: verdict, referee receipt, cap, nullifier
   burned, USDC from escrow). Nothing on Stellar can happen before that.
2. A relayer builds the Stellar transaction: source account = `near_signer`, one
   `invokeHostFunction` operation calling `settle_from_near` with the same nullifier,
   merchant, amount and checkout_ref. The payload to sign is the 32-byte
   `sha256(network_id || ENVELOPE_TYPE_TX || tx)`.
3. The bazaar gets a new method (planned), `sign_stellar_payout(nullifier, tx_fields)`. It
   checks the record is spent and has a Stellar payout pending, rebuilds the transaction
   hash from a fixed XDR template filled with the record's own values (so the MPC network
   never signs a transaction the record did not authorize), and calls `v1.signer`
   `sign({"request":{"payload_v2":{"Eddsa":"<hex>"},"path":"stellar-1","domain_id":1}})`
   with 1 yoctoNEAR.
4. The relayer takes the 64-byte R||S signature, wraps it as a `DecoratedSignature` (hint =
   last 4 bytes of the public key) and submits to Stellar testnet. The source-account
   signature satisfies `near_signer.require_auth()`.

## Money model and limits

- The Stellar contract pays from a USDC pool it holds; the buyer's USDC stays on NEAR. For
  the hackathon this is a REP-funded testnet pool, said plainly. It is not a bridge.
- Risk named in the plan: the exact XDR encoding and signature handling for a Stellar
  transaction signed by MPC. There is no public Stellar example for Chain Signatures.
- Fallback for the demo frame: 1Click can deliver USDC to a Stellar G-address (mainnet
  only) but cannot call this contract.
