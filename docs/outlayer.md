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
worker key. The second is built: `request_referee` refuses anything but
`{"sealed":{epk,nonce,ct,commitment}}` (X25519 to the worker key, HKDF-SHA256,
XChaCha20-Poly1305, sha256 commitment; `worker/src/sealed.rs`, `bookerbob seal-input`).
Since 2026-11-05 the default is v1, a post-quantum hybrid in the X-Wing style: the worker key
is also an ML-KEM-768 key (FIPS 203, RustCrypto `ml-kem`), and the shared secrets of both go
into HKDF, so opening needs both X25519 and ML-KEM-768 broken (`bookerbob referee-pub` prints
the `pq1:` key; `request_referee` checks a v1 input carries a 1,088-byte KEM ciphertext). v0
inputs still open.

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

## Staged: an attested referee key (panel round 4, action 10; not run)

What OutLayer allows, read from its source and docs on 2026-11-05 (`fastnear/near-outlayer`,
`app.outlayer.ai/docs`):

- **Worker keys are OutLayer's, not ours.** `register_worker_key(public_key, tdx_quote_hex)` on
  `worker.outlayer.testnet` is callable only by OutLayer's operator, and a worker key serves
  every project. So "register the referee worker" means registering a **project**.
- **A project:** `create_project(name, source)` on `outlayer.testnet`, payable (storage deposit,
  the excess refunded), id `<caller>/<name>`, source `WasmUrl { url, hash, build_target:
  "wasm32-wasip2" }`. It is reversible: `delete_project`, `add_version`, `set_active_version`.
- **An attested key for it:** the project manifest declares `signing_keys` (bind to the wasm
  hash or the project); inside the TEE the module gets signatures from `outlayer:signing-keys`
  and never the private key. The binding to hardware is per run: a run's TDX quote commits to
  code, input and output, fetched from `testnet-api.outlayer.ai/attestations/by-tx/<tx>` and
  checked with `outlayer-verify tx <hash>`.

The staged steps:

1. Build the referee worker for `wasm32-wasip2` with a `signing_keys` entry (`bind: "wasm"`),
   signing receipts through the host interface instead of `REFEREE_SIGNING_SEED`.
2. `create_project("bookerbob-referee", WasmUrl)` from `bookerbob.testnet` (reversible).
3. One run with input `{"cmd":"pubkey"}`: the module prints its public key; the run's
   attestation is fetched and checked off chain (`outlayer-verify`).
4. `register_referee(<that key>)` on the bazaar, as today, but for a key a TDX quote covers.
5. One live receipt: `request_referee` with a sealed input; `make verify-live` records it.

Open before it can run (stated plainly):

- **Sealed input.** `request_referee` accepts only input sealed to the worker's X25519 key, and
  `outlayer:signing-keys` signs; it does not decrypt. A key the TEE can decrypt with is not in
  the docs read. Until one is, the run uses a synthetic proof set in the clear or OutLayer's
  HTTPS path, which `docs/outlayer.md` "Privacy" already allows for synthetic data only.
- The attestation response schema is not documented; the deposit amount is not either
  (`estimate_execution_cost` gives the run cost: 0.0070001 NEAR measured).
- The worker today builds for wasip1; the wasip2 build is untested.

Founder OK needed for step 2 onward (an outside service, irreversible on its side only in
its deposit). About 3 to 4 hours after the OK, most of it the wasip2 build.
