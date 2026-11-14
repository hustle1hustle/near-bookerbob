# OutLayer: the referee worker

Source: `worker/` (crate `bookerbob-referee-worker`, binary `bookerbob-referee`) and
`worker/outlayer/` (the same referee as an OutLayer component, wasm32-wasip2).
Interface read from OutLayer's public source, `fastnear/near-outlayer` at commit `e954d4a`
(2026-11-10), and `app.outlayer.ai/docs`. The file paths are named where a fact is used.

State on 2026-11-14: live on NEAR testnet. The component runs on OutLayer as the project
`bookerbob.testnet/bookerbob-referee`, its key is a registered referee of `bookerbob.testnet`,
one dUSDC purchase settled under a receipt OutLayer signed, and one cheat claim was refused by
OutLayer's referee and its settle blocked. `make verify-live` re-derives all of it keylessly
(see "The live run, 2026-11-14" below). On mainnet the same wasm runs as a project owned by the mainnet bazaar, whose referee key signed one purchase's receipt (2026-11-14, `docs/keyless.md`, `node scripts/mainnet-outlayer.mjs check`). Each run's TDX quote is
verified on chain by our own DCAP verifier and bound to that run's wasm, input and output
("Attestation" below); OutLayer's keystore, which derives the key, is still trusted, and the key is
bound to the project, whose owner (REP) can publish a version that signs with it. The same
project's arbiter key decided one live dispute: `docs/keyless.md`. The same
OutLayer setup also verifies Jolt proofs ("Jolt verification on OutLayer" below).

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
beyond its key. The contract checks every signature. Since 2026-11-14 the registered referee on
`bookerbob.testnet` includes a key OutLayer's keystore derives inside the TEE for our project
(the seed referee registered earlier is still listed). That key belongs to the project across all its builds: whoever owns the project
(`bookerbob.testnet`) can publish a new version that signs with the same key, so the owner of
the project stays trusted for what the code is. OutLayer issues a key bound to one exact build
(`bind: "wasm"`) only to a direct run of a wasm URL; `request_referee` calls a project, so the
project-bound key is the one in use.

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

Corrections to what this file said before: the manifest lives inside the wasm, as a custom
section; a project run gets project-bound keys, so the key is `bind: "project"`; the
`Text` response reaches the calling contract as a JSON string (`on_execution_response` in
`contract/src/execution.rs`), which `on_referee_result` already accepts; the 900 byte cap is our
own margin (OutLayer returns up to 1024 bytes in one call and more through a second one).

## Local run with a mock host (`make outlayer-local`)

`worker/outlayer/build.sh` builds the component (local paths remapped) and prints its sha256.
The active version on chain is `6fca1eaa09b2c1ca583a6914bdff7256d73a3d9f4469bd55f1eb00446be8dbb6`
(412,235 bytes, rustc 1.96.0 on macOS arm64, the code of public `near-bookerbob` `1d39cd6`,
built at the fixed path; "The live run" below); `45af89f9…` (v0) and the `f1bc9b91…` this file
named on 2026-11-10 are superseded. Another toolchain may give another
hash; the hash that goes on chain is always the hash of the file that is uploaded.

`worker/outlayer-host` then runs it in wasmtime 36, the runtime major OutLayer's worker uses.
The two host interfaces are a mock in that crate: fixed test keys, no TEE, no keystore. The
WIT files are OutLayer's own. Nine checks, each a PASS line: the manifest section and the
imports; the pubkey statement; an honest result stored by the real contract code
(`submit_referee_result` on near-sdk's MockedBlockchain, with the mock key registered as the
referee) and byte-identical to the native worker for the same key; the injected claim refused
(`receipt_refused`, nothing stored); a rewritten result and an unregistered key rejected by the
contract; the `fixtures/` worker input and `claims-cheat.json`; a sealed input; a dispute signed
by the arbiter key; an unknown command.

The mock leaves out OutLayer's keystore, its limits and the attestation. The live run (below)
shows the keystore issuing the keys and the runs fitting the limits; the attestation is still
unchecked.

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
version that prints it. The live run sealed synthetic facts only (X25519, v0); a real proof set
should wait until the attestation is checked.

## Open items around the live run

- **`resource_limits` through the bazaar.** Settled on 2026-11-14: the deployed
  `request_referee` passes `{max_instructions: 1000000000, max_memory_mb: 128,
  max_execution_seconds: 60}` (OutLayer's own defaults), OutLayer's `execution_requested` event
  shows them as numbers, and the request was picked up and answered (the live run below).
- **The attestation record's schema** is not in OutLayer's public OpenAPI. The check is
  `outlayer-verify tx <hash>` (`github.com/out-layer/outlayer-verify`), which reads the record,
  Intel's collateral and the chain itself.
- **Cost.** `create_project` takes a storage deposit by size (the excess is refunded, and
  `delete_project` returns it). A run at default limits is estimated at 0.0070001 NEAR
  (`fixtures/live/views.json`); the fuel the referee really burns is unmeasured.
- **A consumed receipt.** The staged `request_referee` is a hello-world: its nullifier has no
  verdict, so the bazaar logs `referee_failed` with `unknown nullifier` and the result's hash.
  A receipt that a `settle` consumes needs a fresh purchase whose referee step is
  `request_referee`: written as `make outlayer-buy` and run on 2026-11-14 (below).

## The setup steps (`node scripts/outlayer-go.mjs`)

Steps 1 to 4 and 6 ran on 2026-11-14 (`release` by the founder's session; `sealkey` failed, see
the live run below); 5 and 7 have not; 8 is superseded by `make outlayer-buy`.

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

### What verify-live records

Written: see "The live run, 2026-11-14" below. Not yet recorded: the `outlayer-verify` bundle and
the market bazaar's DAO proposal.

## The live run, 2026-11-14 (testnet)

Record: `fixtures/live/outlayer/run.json`, copied into the `outlayer` block of
`fixtures/live/testnet-manifest.json`. Driver: `make outlayer-buy` (`scripts/outlayer-buy.mjs`,
which plugs a referee hook into `scripts/demo-tester.mjs`). It signed its verdicts with REP's testnet issuer
key, removed from `bookerbob.testnet` on 2026-11-14 (`docs/keyless.md`), so a rerun needs another verdict path
(the recorded run stays valid: `verify` reads only what is on chain). Check: `node scripts/outlayer-buy.mjs
verify`, and the same lines inside `make verify-live` and the `make judge` snapshot.

The wasm. The active version, v1, is the referee code of the public repo
`hustle1hustle/near-bookerbob` at `1d39cd6`, built by `sh worker/outlayer/build.sh` (rustc
1.96.0, macOS arm64): sha256 `6fca1eaa09b2c1ca583a6914bdff7256d73a3d9f4469bd55f1eb00446be8dbb6`,
412,235 bytes, the release asset `outlayer-referee-v1` (which also carries that `build.sh`).
`build.sh` copies the sources to `/tmp/bookerbob-outlayer-build` (override:
`OUTLAYER_BUILD_DIR`), clears its target directory, and builds there, so the hash does not
depend on where the repo is checked out. The staging path is part of the hash: the default is the
pinned one, and another `OUTLAYER_BUILD_DIR` gives another hash. Checked: four checkouts at four paths (a fresh clone of
`1d39cd6` with this `build.sh` among them) gave this hash. No path appears in the wasm. The
build was checked on macOS arm64 only; there `/tmp` resolves to `/private/tmp`, so another OS
may give another hash.

v0, the first version (`45af89f9…8329`, 413,126 bytes, release `outlayer-referee-v0`), is the
same code built inside the checkout. Cargo's crate metadata hash takes in the absolute path of
the workspace's path dependencies, which `--remap-path-prefix` does not reach, so that hash
reproduces only at the path it was built at (checked at 15:00 UTC: same path, same hash; another
path, `a5318fa4…`). It stays on the project, inactive; the keys belong to the project, so both
versions print the same keys.

| step | tx | what it shows |
|---|---|---|
| `create_project` | [GBX3r8Bu…](https://testnet.nearblocks.io/txns/GBX3r8Bumwfa3w4AfUkUkZWeAoLAwdn45GNee6evm7nG) | project uuid `p000000000000018b`, version = the wasm sha256 |
| pubkey run (v0) | [9d8SVnxG…](https://testnet.nearblocks.io/txns/9d8SVnxGHRPoYmHgR9QYoFezQXXTi2FwCutd9Eb14eYC) | `referee_key 5863e39d…feca`, `arbiter_key 16173914…0e4a`, `seal_x25519 4af85c30…877e`, signed by the referee key; 11.1M instructions, 758 ms, 0.00116 NEAR |
| `set_outlayer` | [AFfTUsJW…](https://testnet.nearblocks.io/txns/AFfTUsJWvSb3jy2Bpb329ArkfhbKPdDzWUbwXXyjLSrf) | `request_referee` calls `outlayer.testnet` |
| `register_referee` | [BbSSa4CB…](https://testnet.nearblocks.io/txns/BbSSa4CB4NKfur9P9W2ZHeZg6RnEBoyroaneeWCDf3Jp), then `execute_anchor` [429EVoXJ…](https://testnet.nearblocks.io/txns/429EVoXJzWJjfNLYbGQ8Y4edxxyHxNq69KKJxRg6D48e) | queued for the 5 minute anchor delay, then applied |
| `add_version` (v1, active) | [EJAJDoaD…](https://testnet.nearblocks.io/txns/EJAJDoaDSpfagqVUwaCbXaPGxYQaqLFVppHB1c74gtvL) | `6fca1eaa…dbb6` added to the same project and made active; v0 stays, inactive |
| pubkey run (v1) | [4rA7TU2z…](https://testnet.nearblocks.io/txns/4rA7TU2zGTjSnWBL1N2N8hNMSfhC2SQDdP6CpBPzLcxF) | the same keys and the same signed statement as v0: the keys belong to the project |
| honest `request_referee` (v1) | [Gsc2QdbZ…](https://testnet.nearblocks.io/txns/Gsc2QdbZrWKHCXGCcRCabac3deSHizzfAfwtTRD1MbUv) | the worker input sealed to `seal_x25519`; OutLayer request 46123 ran `6fca1eaa…`; `on_referee_result` stored the receipt, signed by the OutLayer key, 36 dUSDC (m01, group price) |
| honest `settle_demo` (v1) | [BSk1PZt8…](https://testnet.nearblocks.io/txns/BSk1PZt88jZQ2pfxPypo9mN38cLrPKXKjRvcS8cew79X) | m01 paid under that receipt |
| cheat `request_referee` (v1) | [3FbtcCH8…](https://testnet.nearblocks.io/txns/3FbtcCH8Y9ZA7hwzCrkTS76Fy4PDioDwhavw6U2nQGJ6) | the buyer's model adds `claims-cheat.json` (a claim citing F9, which no proof carries); OutLayer request 46139 signs `refused: F9 not in proof set`; the bazaar logs `receipt_refused`, stores nothing |
| cheat `settle_demo` (v1) | [C9iWCT5c…](https://testnet.nearblocks.io/txns/C9iWCT5cYctsjCTGw4u4GigsfpEQQp7TsWh23y6XJSAU) | refused: `no referee receipt for this quote` (a relayed meta tx: explorers show the outer tx as a success; its inner `settle_demo` receipt panicked) |
| honest `request_referee` (v0) | [7vizVBAU…](https://testnet.nearblocks.io/txns/7vizVBAUGgayrBHd2EkLmELTUpi2now2PgR1FmiBBHEE) | the worker input sealed to `seal_x25519`; OutLayer request 45509; `on_referee_result` stored the receipt, signed by the OutLayer key, 36 dUSDC (m01, group price) |
| honest `settle_demo` (v0) | [9mUHZ4MS…](https://testnet.nearblocks.io/txns/9mUHZ4MSN9BxToD2meJTxBJLpQRLjWhJMMu7F3agrmYj) | m01 paid under that receipt |
| cheat `request_referee` (v0) | [Df38Aiot…](https://testnet.nearblocks.io/txns/Df38AiotQXbFTSCD6Lf1R391B1HBhHJpdT8xpLbVNfK3) | the buyer's model adds `claims-cheat.json` (a claim citing F9, which no proof carries); OutLayer request 45529 signs `refused: F9 not in proof set`; the bazaar logs `receipt_refused`, stores nothing |
| cheat `settle_demo` (v0) | [4fB3HV1w…](https://testnet.nearblocks.io/txns/4fB3HV1wG2U38GeebjcGRNt4ou4inKjfNnXfExMJUcjM) | refused: `no referee receipt for this quote` |

The recorded run (`fixtures/live/outlayer/run.json`) is the v1 one; the v0 rows are the same two legs, run first on v0 at about 13:35 UTC. All four referee steps came back through the yield callback (`via: "callback"`).

What `verify` re-derives over public RPC, no keys: `get_project` names the uuid and the hash,
and `list_versions` holds only the recorded builds (v0 and v1), with v1 the one active version;
each version's pubkey tx returns the recorded keys, its statement verifies under `referee_key`,
and OutLayer's `execution_completed` names that version's hash; `referees` on the bazaar lists the key; each
`request_referee` tx asked for this project and hash, from the bazaar, with a sealed input, and
its `execution_completed` names the v1 hash; the
honest one logged `referee_receipt`, the verdict holds a receipt by the OutLayer key with the
recorded `result_sha256` and price, it is spent, and the settle tx is `settle_demo` for this
nullifier, merchant and price, with a `settled` event and the dUSDC `ft_transfer` from the bazaar
to m01; the cheat one logged `receipt_refused` with the reason, the verdict has no receipt and is
not spent, and the settle tx is `settle_demo` for this nullifier and merchant, failed with
`no referee receipt`. `scripts/outlayer-buy.test.mjs` (in `make test`) replays the same check
against the committed RPC snapshot and tampers each of those facts.

What happened on the way, plainly:

- **The full post-quantum seal key does not fit one output.** `{"cmd":"sealkey"}` prints the
  `pq1:` key (2,436 hex characters); OutLayer returns at most 1,024 bytes in one call, so that run
  failed ([8qhMH4wL…](https://testnet.nearblocks.io/txns/8qhMH4wLTVgnecabEKgUqLA47xTE1GKSLFbMB6zLmRqW)).
  The live inputs are therefore sealed v0, X25519 only, to `seal_x25519`, which the signed pubkey
  statement carries (with `seal_pq1_sha256`). The v1 hybrid needs the key read in parts or
  from OutLayer's second output call; not done.
- **The yield window.** Between about 13:20 and 13:32 UTC OutLayer testnet took 180 to 250 s per
  run, past NEAR's 200-block yield window: the callback fired as a timeout
  (`referee_failed: unparseable worker output`, e.g.
  [GAD62cHS…](https://testnet.nearblocks.io/txns/GAD62cHS4aEDya2fsP67DjHLJJPfXGXoUsFWsimn7chs))
  while the worker's correct, signed result landed later in its own `resolve_execution` tx
  ([6zo13oqK…](https://testnet.nearblocks.io/txns/6zo13oqKn3RzmJfEu1MdvqWBrFA6PycoPPC6q4PusAJ8)).
  The driver handles this: when the callback times out it reads that tx and relays the exact
  output with `submit_referee_result` (anyone may relay; the contract checks the same signature
  under the same key), and records `via: "relay"`; `verify` then also checks that the relayed
  result equals the worker's output for that request id. The recorded run did not need it.
- Other runs in that window, all testnet and refunded except about 0.001 NEAR each: a sealed and a
  plaintext synthetic input sent straight to `request_execution`, and two pubkey reruns, used to
  find the timeout above.

What the runs' TDX quotes show is in "Attestation" below. Two parties stay trusted for the key:
OutLayer's keystore, which derives it (its own attestation is outside these checks), and the
project's owner (`bookerbob.testnet`), who can publish a new version that signs with the same key
(see "Trust").
The market bazaar (`market.bookerbob.testnet`) does not list the key yet (one DAO proposal,
step `market`). The facts behind both verdicts are synthetic.

## Jolt verification on OutLayer (testnet, 2026-11-14)

A second component, `worker/outlayer-jolt/`, runs a Jolt verifier inside OutLayer's TEE and signs
the verdict, so a contract that cannot afford to verify a Jolt proof itself (the standing proof's
verifier preprocessing alone is 4.18 MB) can take a signed statement instead.

- **What it verifies.** a16z/jolt `997c1543`, the pin of `zk/` and of the standing guest, verifier
  only (`jolt-core`'s `minimal` feature, the verifier the guest macro's `build_verifier_*` uses).
  The programs it accepts are a table compiled in, keyed by program hash (sha256 of the serialized
  verifier preprocessing, the hash the bazaar pins as `graph_program`); each is re-hashed before
  use. Today: `c780ceab…` only. An unknown hash gets a signed reject.
- **Input:** `{program_hash, proof (base64), io (hex of the JoltDevice: inputs, outputs, panic)}`,
  about 119 KB; OutLayer keeps an input over 10 KB in its state while the run is pending, with a
  storage deposit it returns.
- **Output:** `{statement, reason, key, signature}`, about 600 bytes. `signature` is ed25519 by the
  project's host key `jolt-verify` over `"bookerbob/jolt-verify/v0\0" || json(statement)`,
  statement = `{inputs_sha256, output_sha256, panic, program_hash, proof_sha256, verdict}` (keys
  sorted, compact). `verdict` is `accept` only when the program is pinned and the proof verifies
  for exactly those inputs, outputs and panic flag.
- **Build:** `sh worker/outlayer-jolt/build.sh`, fixed path like the referee's v1: sha256
  `cad8d2e12500315b9bef983b6983489d46b958f6be2784f18af1229c839fbb65`, 8,435,520 bytes (two checkout
  paths, one with a space, same hash; rustc 1.96.0, macOS arm64), release asset `jolt-verify-v0`.
  The wasm holds six `/Users/…` path strings; all six are inside the pinned standing preprocessing
  (the guest's memory image, part of program hash `c780ceab…`, public in `zk/out/`), and
  `build.sh` fails if the module adds any other.
- **Local:** `make outlayer-jolt-local` (`node worker/outlayer-jolt/cases.mjs`, then `worker/outlayer-host` in `jolt` mode
  (wasmtime 36, mock signing host): the honest proof gives a signed accept (about 0.3 s), a flipped
  proof byte, one changed bit of the claimed root and an unknown program each a signed reject).

Live (`node scripts/outlayer-jolt.mjs verify`, record `fixtures/live/outlayer/jolt.json`, also in
`make verify-live` and the `make judge` snapshot):

| step | tx | what it shows |
|---|---|---|
| `create_project` | [CdEiShbp…](https://testnet.nearblocks.io/txns/CdEiShbpK6Cm1jfLSmskfxrH9yN8oUp9b9BKDBNNWwN8) | `bookerbob.testnet/bookerbob-jolt-verify`, one version, `cad8d2e1…` |
| pubkey | [AZkVdDGm…](https://testnet.nearblocks.io/txns/AZkVdDGms2HtmCDxrDw1xC9tQ7T8CakfQJFGUovsRw8U), output in OutLayer's resolve [9FVqb3A7…](https://testnet.nearblocks.io/txns/9FVqb3A72XnLTZem7HYUoGmDa8t6KGMw4H6srQVTNFZF) | `jolt_verify_key 954d224e…9464`, programs `[c780ceab…]`, signed by that key |
| honest | [D7yPc1vu…](https://testnet.nearblocks.io/txns/D7yPc1vuqoqznbs2smmLiZN9pJrpLHKSTSusNGAFFvFW) | the proof (`5619f62d…`) that the bazaar's `submit_graph_scores` [8AmCe4FN…](https://testnet.nearblocks.io/txns/8AmCe4FNKXafMqZpeohNEK51bAtDDTm27pPDS8rSWBDD) names, the root on chain at the time (`3b5db5e9…`, graph root `7f1bf041…`); signed accept, its `output_sha256` = sha256 of that submit's graph root and scores hash; returned through the callback |
| forged | [EP1BATKs…](https://testnet.nearblocks.io/txns/EP1BATKsqhtFMhyP1P5AdksYz7yt8uLL1jNGcQuAsFvk), resolve [G7CwEL7e…](https://testnet.nearblocks.io/txns/G7CwEL7eEZAkL9YLbcZCfW8Yo9tdZaZMvSf4fcWJgLsz) | one proof byte flipped: signed reject (`SumcheckVerificationError`) |
| consumer accepts | [BKL3fsBz…](https://testnet.nearblocks.io/txns/BKL3fsBzKmtWcHX5V7bHDTLMiXMiEMi78fzJJiJLs2h8) | `smith-reg.bookerbob-demo.testnet` `attest_use` (the smith registry, docs/smith.md: verifier key registered by its owner, program `c780ceab…` recorded as `standing-graph`) takes the signed accept |
| consumer refuses | [HtErk3Am…](https://testnet.nearblocks.io/txns/HtErk3AmcHxPbMUs9kr34r5qjEAPdntKEBtgWARn1Erg) | the same call with the signed reject: `not an accept` |

The 8-event update before it (`submit_graph_scores` [5jgLWwxz…](https://testnet.nearblocks.io/txns/5jgLWwxzwZEAegQkLfsfMcnifjbvKwTHCeNQpvUyeY61)) was verified first, its output from OutLayer's resolve tx because the callback timed out, and taken by the registry ([DZfSmqd7…](https://testnet.nearblocks.io/txns/DZfSmqd74t9s4VXspo2adEaoXcJe9i5z2iRKhAYtAV64)); it stays in the record under `history`.

What `verify` re-derives: one version, active; the pubkey statement under the recorded key; the
honest request named this project and hash, its proof hashes to the `proof_sha256` the bazaar's
submit carries, the accept is signed by the key and its output is that submit's root; the forged
one is a signed reject of a different proof; the registry's accept and refusal. When the yield
callback times out, the output is read from OutLayer's resolve tx, which must be by
`worker.outlayer.testnet` to `outlayer.testnet` for the same request id (`via` in the record).

Stated plainly: the signed statement carries the referee's trust model (keystore trusted, project
owner trusted). This component verifies Jolt `997c1543` proofs; the `b4eb6248` browser pin gets
its own component. The contract that consumes it here is a registry; the bazaar keeps its own
challengeable graph updates.

## Attestation (testnet, 2026-11-14)

OutLayer publishes an attestation record for each execution
(`testnet-api.outlayer.ai/attestations/by-tx/<tx>`): the TDX quote of the worker that ran it and
the task's fields (task id and type, wasm hash, input hash, output hash, block height, caller,
project, timestamp). `node scripts/outlayer-attest.mjs verify` (keyless, also in
`make verify-live`) checks three runs: the referee's honest purchase and its cheat on v1, and the
Jolt verifier's honest run. The records are saved in `fixtures/live/outlayer/attest/`. For each:

Five runs: the three above, a dispute the arbiter key decided (request 46342, tx
[AjfwNan6…](https://testnet.nearblocks.io/txns/AjfwNan6WZ5vSgrfw8FSSnrLebzTnUba6vGYP34xKwXh), a direct
`request_execution` by the bazaar's owner, no callback; its output also checked against OutLayer's
resolve tx for the same request id), and the mainnet bazaar's
OutLayer referee purchase (request
[AWeGAm2u…](https://nearblocks.io/txns/AWeGAm2uAYnV3Hz8Hz5mbYHMacPNYoHDov39Kt8bDD7V) on
`outlayer.near`, record from `api.outlayer.ai`, reads from mainnet RPC; its quote verified on the
testnet DCAP verifier, so no mainnet spend). And once: the verifier is pinned, code hash
`7ZabqCJb…` and no access keys (locked).

1. **The record is that run's.** Request id, project, caller and wasm hash equal the tx's
   `execution_requested` event; `input_hash` is sha256 of the input the tx sent; `output_hash` is
   sha256 of the output the run returned to the chain (for the referee, the string
   `on_execution_response` resumed the bazaar with; for the Jolt run, its Json return value).
2. **The quote commits to the record.** sha256 of the task fields (format per OutLayer's
   outlayer-verify source, `preimage.rs`, V1) equals `report_data[0..32]` of the quote, and
   `report_data[32..64]` is zero.
3. **The quote is Intel's.** Each quote was verified on chain by our own DCAP verifier,
   `spike.bookerbob.testnet` (`tools/dcap-spike`, dcap-qvl 0.3.12 in five calls), with the Intel
   collateral OutLayer's register contract `worker.outlayer.testnet` publishes (`get_collaterals`;
   of the two it holds, the first has an expired TCB Info, the second verifies). Result: verified,
   TCB `UpToDate`, report_data as above. Txs in `fixtures/live/outlayer/attest/dcap.json`. The
verification is tied to this exact quote: its `start` tx to the verifier carried exactly these
quote bytes and returned the verification id that later reads `verified`.
4. **The worker build is an approved one.** The quote's MRTD and RTMR0..3 return `true` from
   `is_measurements_approved` on `worker.outlayer.testnet` (`worker.outlayer.near` for the mainnet
run), read now.

What that binds: genuine TDX hardware, running a worker image whose measurements OutLayer
approved on chain, ran exactly this wasm on exactly this input and produced exactly this output.
The output carries our signed result (the referee's `WorkerResult`, the Jolt statement) and the
key that signed it, so the signature was produced inside that attested run. MRTD and the RTMRs
measure the worker VM (firmware, kernel, the worker image), not our wasm; the wasm is bound
through the task hash.

The collateral used (TCB Info issued 2026-11-08, nextUpdate 2026-12-08) covers the executions
(2026-11-14, testnet and mainnet runs between 15:00 and 16:00 UTC).

What is still trusted: OutLayer's keystore, a separate service that derives the project key (its
own attestation is outside these checks, so the key's confinement to TEEs rests on it); OutLayer's
choice of approved measurements (we take its list; we do not rebuild the worker image); that
approval as read now, not at the execution's block; and the project owner, as above.

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
