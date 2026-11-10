# OutLayer: the referee worker

Source: `worker/` (crate `bookerbob-referee-worker`, binary `bookerbob-referee`) and
`worker/outlayer/` (the same referee as an OutLayer component, wasm32-wasip2).
Interface read from OutLayer's public source, `fastnear/near-outlayer` at commit `e954d4a`
(2026-11-10), and `app.outlayer.ai/docs`. The file paths are named where a fact is used.

State on 2026-11-10: the component is built and runs locally in wasmtime with a mock of
OutLayer's host interfaces (`make outlayer-local`). Nothing has run on OutLayer; no project is
registered. The live steps are staged in `node scripts/outlayer-go.mjs` and wait for the repo to
be public and for the founder's OK.

## What the worker does

stdin: `WorkerInput` JSON (verdict digest, nullifier, merchant and schedule, revealed
predicates, the model's claims, the proof set). It runs `bookerbob-core`'s quote and
referee and prints a `WorkerResult`: the outcome bound to the verdict digest, nullifier,
merchant and code-computed price, signed with ed25519 over
`"bookerbob/referee/v0\0" || json(body)`. Output is checked to stay within OutLayer's
900 byte cap (507 bytes for the fixture refusal). The native binary signs with the seed in
`REFEREE_SIGNING_SEED`; the OutLayer component holds no key and signs through the host (below).

## What the contract does with it

`register_referee(key_hex)` (owner) sets the trust anchor. `submit_referee_result` (anyone
may relay) and the OutLayer callback `on_referee_result` both:
check the key is registered, `env::ed25519_verify` the signature, the verdict exists and
is not spent, the digest matches the stored verdict, and the price equals the contract's
own quote. A receipt is stored on the verdict; a refusal emits `receipt_refused` and
stores nothing. `settle` requires a receipt for that merchant and price.

`request_referee(project_id, input_data)` calls `request_execution` on the configured
OutLayer contract (`set_outlayer`) with a `Project` source, explicit `resource_limits` (see "Open" below)
and `response_format: "Text"`, then `on_referee_result`.

## Trust

OutLayer is unaudited. It computes the referee; it is not trusted for the outcome
beyond its key. The contract checks every signature. The upgrade path, staged below, is to
register a key OutLayer's keystore derives inside the TEE for our project, instead of a seed we
set. That key belongs to the project, not to one build: whoever owns the project
(`bookerbob.testnet`) can publish a new version that signs with the same key, so the owner of
the project stays trusted for what the code is. A key bound to one exact build exists
(`bind: "wasm"`), but OutLayer issues it only to a direct run of a wasm URL, and
`request_referee` calls a project.

## The OutLayer component (`worker/outlayer`)

A crate of its own, outside the workspace, so its one extra dependency (`wit-bindgen`) stays out
of the root `Cargo.lock` that `vendor/SHA256` pins. The referee logic is the workspace crate,
unchanged; `run_with` and `arbitrate_with` in `worker/src/lib.rs` take a `ResultSigner`, which
the native worker fills with its seed key and the component with the host. The native binary
and its tests behave as before.

What OutLayer's source says, and what the component does with it:

- **Input and output.** A wasm32-wasip2 component exporting `wasi:cli/run`; the input is stdin,
  the output is stdout (`worker/src/executor/wasi_p2.rs`). A non-zero exit is a failed run.
- **The manifest** is a wasm custom section named `outlayer.manifest`, covered by the wasm's
  sha256 (`wasi-examples/CONNECTOR_MANIFEST.md`). It is not a field of `create_project`. Ours is
  `worker/outlayer/manifest.json`: two signing keys, one encryption key, no network.
- **Signing.** `outlayer:signing-keys/api@0.1.0` (`worker/wit/deps/signing-keys.wit`):
  `public-key(path, vault) -> result<list<u8>, string>` and
  `sign(path, vault, message) -> result<list<u8>, string>`. For an `ed25519` key the public key
  is 32 bytes and the signature is RFC 8032 over the raw message, 64 bytes, no prehash and no
  prefix. That is what `submit_referee_result` checks with `env::ed25519_verify` over
  `"bookerbob/referee/v0\0" || json(body)`, so the host key is compatible as it is.
- **Which key.** `{"path": "referee", "type": "ed25519", "caller": "none"}` with the default
  `bind: "project"`: one key for every caller of the project, derived from the project's
  on-chain uuid (`signing-key:v1:ed25519:project:{project_uuid}:none:{path}`). It is the key
  `register_referee` pins. A second key, `arbiter`, signs dispute decisions. A project deleted
  and created again has other keys.
- **Commands.** `{"cmd":"pubkey"}` prints `referee_key`, `arbiter_key` and the seal key
  (`seal_x25519`, `seal_pq1_sha256`, `seal_for`), in a statement signed by the referee key under
  the prefix `bookerbob/referee-keys/v0`. `{"cmd":"sealkey"}` prints the full `pq1:` key. The
  module signs only messages it composes; no input can ask for a signature over its own bytes.

Corrections to what this file said before: the manifest is inside the wasm, not in the project;
`bind: "wasm"` cannot be used through a project, so the key is `bind: "project"`; the
`Text` response reaches the calling contract as a JSON string (`on_execution_response` in
`contract/src/execution.rs`), which `on_referee_result` already accepts; the 900 byte cap is our
own margin (OutLayer returns up to 1024 bytes in one call and more through a second one).

## Local run with a mock host (`make outlayer-local`)

`worker/outlayer/build.sh` builds the component (local paths remapped) and prints its sha256:
`f1bc9b914137aeaea22f9349d2ba48d8d2d533e62d06f531dad79148df38e464`, 413,565 bytes, with
rustc 1.96.0 on macOS arm64. Another toolchain may give another hash; the hash that goes on
chain is always the hash of the file that is uploaded.

`worker/outlayer-host` then runs it in wasmtime 36, the runtime major OutLayer's worker uses.
The two host interfaces are a mock in that crate: fixed test keys, no TEE, no keystore. The
WIT files are OutLayer's own. Nine checks, each a PASS line: the manifest section and the
imports; the pubkey statement; an honest result stored by the real contract code
(`submit_referee_result` on near-sdk's MockedBlockchain, with the mock key registered as the
referee) and byte-identical to the native worker for the same key; the injected claim refused
(`receipt_refused`, nothing stored); a rewritten result and an unregistered key rejected by the
contract; the `fixtures/` worker input and `claims-cheat.json`; a sealed input; a dispute signed
by the arbiter key; an unknown command.

What this does not show: that OutLayer's keystore issues the keys, that the run fits its
limits, or anything about the attestation. Those need the live run.

## Privacy

`input_data` of an on-chain `request_execution` is public. `request_referee` refuses anything
but `{"sealed":{epk,nonce,ct,commitment}}` (X25519 to the worker key, HKDF-SHA256,
XChaCha20-Poly1305, sha256 commitment; `worker/src/sealed.rs`, `bookerbob seal-input`).
Since 2026-11-05 the default is v1, a post-quantum hybrid in the X-Wing style: the worker key
is also an ML-KEM-768 key (FIPS 203, RustCrypto `ml-kem`), and the shared secrets of both go
into HKDF, so opening needs both X25519 and ML-KEM-768 broken (`request_referee` checks a v1
input carries a 1,088-byte KEM ciphertext). v0 inputs still open.

Where the decryption key lives on OutLayer. OutLayer has no asymmetric decryption key for a
module, but it has `outlayer:encryption-keys/api@0.1.0` (`worker/wit/deps/encryption-keys.wit`):
symmetric keys the keystore derives inside the TEE, with `mac(path, vault, data)`, an
HMAC-SHA256 that is the same in every run holding the key. The component takes
`mac("sealed-input", none, "bookerbob/referee-seal-seed/v1")` as the 32-byte seed and derives
the X25519 and ML-KEM-768 keys from it exactly as the native worker derives them from its seed.
The seed never leaves the run: it is not printed and not signed. So a buyer seals to a public
key whose secret exists only inside OutLayer's TEE runs of this project.

The limits, plainly. An encryption key cannot be `caller: "none"` (OutLayer refuses it), so the
key is `caller: "predecessor"`: it belongs to the account that called OutLayer. Through
`request_referee` that is the bazaar, so each bazaar has its own seal key, and anyone who can
make the bazaar call OutLayer reaches that key (the worker opens an input and returns only the
signed result, never the plaintext). `bookerbob.testnet` reads its key with a direct
`{"cmd":"sealkey"}` run; `market.bookerbob.testnet` can only ask in the sealed shape
(`{"sealed":{..,"ct":"00",..}}` through `request_referee`), whose answer is too long for the
bazaar's callback and has to be read from OutLayer's side. As with the signing key, a new
version of the project gets the same seed, so the project's owner is trusted not to publish a
version that prints it. And all of it is checked against a mock only: until the live run, a
real proof set should not go through this path.

## Open before and during the live run

- **`resource_limits` through the bazaar.** The deployed `request_referee` passes
  `resource_limits: {}`. The OutLayer contract reads that as limits with every field absent and
  writes them into its event as nulls (`contract/src/lib.rs` `ResourceLimits`,
  `contract/src/execution.rs`), and the worker's event parser has those three fields as plain
  numbers (`worker/src/event_monitor.rs`, `ResourceLimits`). From the source, such a request may
  never be picked up. In code, not deployed: the bazaar now passes all three as numbers,
  `{max_instructions: 1000000000, max_memory_mb: 128, max_execution_seconds: 60}`, the values of
  OutLayer's own `request_execution` example and of its `ResourceLimits::default()`
  (fastnear/near-outlayer `contract/README.md` and `contract/src/lib.rs`, read at commit
  `3ace187`), and the ones `scripts/outlayer-go.mjs` already sends; a contract test reads them
  back from the promise arguments. The coordinator between contract and worker is closed
  source, so this is still not settled until one request is sent. Until a redeploy, a direct
  `request_execution` with explicit limits plus `submit_referee_result` (anyone may relay)
  gives the same receipt.
- **The attestation record's schema** is not in OutLayer's public OpenAPI. The check is
  `outlayer-verify tx <hash>` (`github.com/out-layer/outlayer-verify`), which reads the record,
  Intel's collateral and the chain itself.
- **Cost.** `create_project` takes a storage deposit by size (the excess is refunded, and
  `delete_project` returns it). A run at default limits is estimated at 0.0070001 NEAR
  (`fixtures/live/views.json`); the fuel the referee really burns is unmeasured.
- **A consumed receipt.** The staged `request_referee` is a hello-world: its nullifier has no
  verdict, so the bazaar logs `referee_failed` with `unknown nullifier` and the result's hash.
  A receipt that a `settle` consumes needs a fresh purchase whose referee step is
  `request_referee`; that script is not written.

## Staged: the live run (`node scripts/outlayer-go.mjs`)

Without `--i-have-the-founders-word` the script prints the plan with the real values and sends
nothing. With it, it runs one named step and stops. Testnet only. In order:

1. `build`: `worker/outlayer/build.sh`, `make outlayer-local`.
2. `release` (sends): the wasm as a release asset of the public repo;
   `release-check` compares the URL's sha256 with the build.
3. `project` (sends): `create_project(name, source)` on `outlayer.testnet` from
   `bookerbob.testnet`, `source = {"WasmUrl": {url, hash, build_target: "wasm32-wasip2"}}`;
   the id is `bookerbob.testnet/bookerbob-referee`.
4. `pubkey`, `sealkey` (send): `request_execution(source = {"Project": {project_id,
   version_key: null}}, resource_limits, input_data, response_format)` straight from
   `bookerbob.testnet`; the tx result is the module's JSON.
5. `attest`: `outlayer-verify tx <pubkey tx>`; the record is also at
   `testnet-api.outlayer.ai/attestations/by-tx/<tx>`.
6. `set-outlayer`, `referee` (send): on `bookerbob.testnet` (anchor delay 5 minutes since 2026-11-10: queued, then `execute_anchor`).
7. `market`, `market-execute` (send): one DAO proposal on `bookerbob-gov.sputnikv2.testnet`
   for `market.bookerbob.testnet`, then `execute_anchor` after the 5 minute anchor delay.
8. `request` (sends): one `request_referee` with a sealed input.

### What verify-live should record

Not written (`scripts/verify-live.mjs` and the manifest are outside this change). After the
run, an `outlayer` block in `fixtures/live/testnet-manifest.json`: project id and uuid, wasm
URL and sha256, `referee_key`, `arbiter_key`, the seal key's sha256, the tx hashes
(`create_project`, pubkey, sealkey, `register_referee`, the DAO proposal and `execute_anchor`,
`request_referee`) and the `outlayer-verify` bundle. The check re-derives over public RPC:
`get_project` names that hash as the active version; both bazaars list `referee_key` in
`referees`; the pubkey tx's result carries that key and its statement verifies under it; the
`request_referee` tx logged `referee_failed` with the sha256 of an output that is a
`WorkerResult` signed by `referee_key`.

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
dispute adds nothing. Today both are fixture seeds; in the OutLayer component they are two keys
of one project, which separates the signatures and not the operator.
