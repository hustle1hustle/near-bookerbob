# OutLayer: the referee worker

Source: `worker/` (crate `bookerbob-referee-worker`, binary `bookerbob-referee`).
Interface from app.outlayer.ai/docs (getting-started, near-integration), read 2026-11-04.

## What the worker does

stdin: `WorkerInput` JSON (verdict digest, nullifier, merchant and schedule, revealed
predicates, the model's claims, the proof set). It runs `bookerbob-core`'s quote and
referee and prints a `WorkerResult`: the outcome bound to the verdict digest, nullifier,
merchant and code-computed price, signed with ed25519 over
`"bookerbob/referee/v0\0" || json(body)`. Output is checked to stay within OutLayer's
900 byte cap (507 bytes for the fixture refusal). The signing seed comes from the
`REFEREE_SIGNING_SEED` secret.

## What the contract does with it

`register_referee(key_hex)` (owner) sets the trust anchor. `submit_referee_result` (anyone
may relay) and the OutLayer callback `on_referee_result` both:
check the key is registered, `env::ed25519_verify` the signature, the verdict exists and
is not spent, the digest matches the stored verdict, and the price equals the contract's
own quote. A receipt is stored on the verdict; a refusal emits `receipt_refused` and
stores nothing. `settle` requires a receipt for that merchant and price.

`request_referee(project_id, input_data)` calls `request_execution` on the configured
OutLayer contract (`set_outlayer`) with a `Project` source, default `resource_limits`
and `response_format: "Text"`, then `on_referee_result`.

## Trust

OutLayer is unaudited. It computes the referee; it is not trusted for the outcome
beyond its key. The contract checks every signature. The upgrade path is to register
the key OutLayer's TDX worker registration attests (DCAP), instead of a seed we set.

## Privacy

`input_data` of an on-chain `request_execution` is public. Synthetic fixtures are fine
there. A real proof set must use OutLayer's HTTPS path (Payment Key) or be sealed to the
worker key. Not built yet.

## Not verified yet

- Whether the callback's `promise_result(0)` is the raw stdout or a JSON string. The
  callback accepts both; the testnet hello-world decides.
- Build target: docs show `wasm32-wasip2`; this worker is pure compute and should also
  build for `wasm32-wasip1`. Neither target is installed here yet.

## Disputes (beat 11)

The same worker binary is also the arbiter: an input that carries a contested `result`
is a dispute (`arbitrate` in `worker/src/lib.rs`). The arbiter re-checks independently:
the verdict signature and issuer key, the referee key and signature, the binding of the
result to this verdict (digest, nullifier), that the claims are the ones the referee
signed (`claims_sha256` in the referee result), the code-computed price, and the
referee outcome by re-running it over the proofs. It signs `upheld` or `overturned`
with the reasons, under the same 900 byte cap.

`register_arbiter` (owner) and `submit_dispute_decision` (anyone may relay) in the
contract: the decision must name the stored receipt (`result_sha256`). Overturned before
settle clears the receipt, so `settle` is blocked again; overturned after settle marks
the record `disputed` (refunds are not in v0). `make verify` check 22: a compromised
referee key signs a receipt for the F9 cheat, the contract accepts it (it trusts the key),
the arbiter overturns it with `referee said receipt, re-run says refused: F9 not in proof
set`, the receipt is cleared and settle is blocked.

The arbiter key should be a different worker and operator than the referee, or the
dispute adds nothing. Today both are fixture seeds.
