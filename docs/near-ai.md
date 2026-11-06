# NEAR AI Cloud: what we checked live

## Response signatures under E2EE v2 (open check B1): ciphertext

`scripts/spikes/e2ee-signature.mjs`, result in `fixtures/live/e2ee-signature.json`
(2026-11-04, `z-ai/glm-5.3-flash`, owned_by nearai):

- The signature from `GET /v1/signature/<chat_id>?signing_algo=ed25519` verifies
  (ed25519), `signature_kind: provider_tee`.
- Its text is `<model>:<sha256(request)>:<sha256(response)>`, and both hashes equal the
  sha256 of the exact **ciphertext** bytes on the wire (request body with sealed fields,
  response body with the sealed answer). Neither matches a plaintext reconstruction.
- The signing key equals the model's E2EE key from the attestation report
  (`signing_public_key`), so one attested key both decrypts and signs.

Consequence for BookerBob: a verifier (contract, OutLayer worker, judge) can check that
an answer came from the attested enclave **without decrypting it**. The envelope binds
`sha256(wire response)`; only the client, holding its X25519 secret, reads the answer.

## Plain TLS path

`agents/why.mjs`: 33 calls, 33/33 signatures valid, hashes equal the wire bytes. Same
scheme without encryption.

## NEAR AI issues the verdict (2026-11-04, evening)

`scripts/near-ai-verdict.mjs` (live, once) and `bookerbob near-ai` (offline, in
`make verify`). Files in `fixtures/live/near-ai/`.

1. `GET /v1/attestation/report?model=...&signing_algo=ed25519&nonce=<32 random bytes>`.
2. One E2EE v2 chat. The system prompt and the user message (rule table, the synthetic
   fixture facts, and `bind`) are sealed to the attested model key. The model answers
   `{"predicates": [...], "bind": "..."}`, sealed to a one-time client key.
   `bind = sha256("bookerbob/near-ai-bind/v0\0" || json([context, nullifier, commitment,
   proof_hash, cnf, max_spend, issued_at_ms, expires_at_ms]))` (`Envelope::near_ai_bind`).
3. `GET /v1/signature/<chat_id>?signing_algo=ed25519`.
4. `tools/tdx-collateral` fetches the quote's collateral from Intel PCS once and commits it
   with the time it was checked.

Offline checks (N1 to N8): the TDX quote verifies to Intel's root CA with that collateral
(dcap-qvl, status `UpToDate`, no advisories); report_data[0..32] is the signing key,
[32..64] our nonce; the ed25519 TEE signature is valid and from that key; it covers
sha256 of the committed request and response bytes; the sealed answer opens with its
disclosed per-field key; the attested predicates equal what
`core/src/tier.rs` derives; the answer echoes the envelope's binding; the envelope
reveals a subset of the attested predicates and names this model, report and TCB status.
Tamper tests: one changed response byte, a raised predicate set, another nullifier, a
wrong disclosed key.

What the disclosure gives away: the buyer discloses `response_key`, the key for the answer
field only. The reasoning field has its own key and stays sealed, and so does the request,
which holds the facts and is sealed to the model key. The disclosed answer is public, so the
model is asked only about the predicates the verdict reveals.

Corrected 2026-11-06. This section used to say a disclosed client secret opens only the
answer. It opens every field of the response, the reasoning too, which restates the facts.
Three responses were exposed that way, the facts all synthetic: `docs/leak.md`, L9.

Chat ids to look up: verdict `08af1d014f2d4f379dba94094562d9ba`; buyer "why"
runs `68657600d12549518664defcf8fb0dd1` (honest), `bfbb3d0db39447918285c8b6570ddc7f`
(injected), `b7b3a69052d84f938b2702e435ef41ff` (direct). NEAR AI's page
https://cloud.near.ai/verify does not take a chat id: checked read-only on 2026-11-04,
its script runs as an embedded widget (it checks `window.parent !== window`) and gets the
completion and signature from the parent NEAR AI app by `postMessage`; its only URL
parameters are `canClose` and `canRequestReports`. So there is no link a judge can open
for these ids. The way to check them is `make verify` (N1 to N14) on the committed bytes,
or `GET /v1/signature/<chat_id>` with a NEAR AI key.

On chain (`submit_near_ai_verdict`): the model key is shared by every user of the model,
so a TEE signature alone proves only that the model said something. The contract accepts
a NEAR AI verdict only when:
- the owner registered that key with an attestation (`register_model_attestation`:
  model, nonce, report hash, TCB status) after checking the quote off chain, and the
  proof names the same nonce;
- the envelope names that model, report and TCB status;
- `env::ed25519_verify` passes over `model:request_sha256:sha256(response)`, with the
  response bytes handed in and hashed by the contract;
- the sealed answer opens (XChaCha20-Poly1305 in wasm) with the disclosed 32-byte field
  key, echoes `Envelope::near_ai_bind`, and lists every revealed predicate.
Then the usual checks (expiry, agent, nullifier, World ID) apply. `make verify` (N10 to
N14) runs it and four refusals: another envelope with the same signature, one changed
response byte, another attestation nonce, a wrong key. 7 contract tests.

The disclosed field key opens only that one answer. The non-committing AEAD is not an
issue here because the TEE made the ciphertext; a different key would have to forge a
Poly1305 tag for it.

Since 2026-11-05 both are closed:

- **The NVIDIA GPU evidence** (8 GH100 GPUs in the same report, `nvidia_payload`) went to
  NVIDIA's Remote Attestation Service once; its signed reply and NVIDIA's key set are saved in
  `fixtures/live/near-ai/nras.json`, and `make verify` checks offline (`scripts/nras.mjs`): every
  token's ES384 signature against that key set, the overall result true, the nonce equal to our
  request nonce (the one the TDX quote binds too), the GPU list equal to the token set by
  digest, and each GPU's measurements, secure boot, debug off, report signature, nonce and
  cert chain. NRAS is public: no account, no cost.
- **The TDX quote** is also verified on chain, in five calls (tools/dcap-spike/README.md).

Each token's signing key is trusted only through its x5c chain: leaf, then NVIDIA's
intermediate, then the root "NVIDIA Attestation Service CA 001", pinned by sha256
(`cde269e3f72c667a…`, `fixtures/live/near-ai/nras-root.crt`, taken from NVIDIA's own PKI, the
mount the certificates' AIA names), each certificate valid at the token's issue time, the key equal
to the leaf's. A test shows a self-signed key set with a validly signed token fails.

Not claimed: that the GPUs and the TDX machine are the same box beyond both carrying our nonce,
or anything about the GPUs after the capture.

## Not checked yet

- Whether all instances of a model share one key (docs say so).
- The GPU evidence on chain: NRAS is checked off chain only (`node scripts/nras.mjs verify`, in
  `make verify`).

## What a valid TDX quote does not prove here

- **Measurements are pinned to what we observed, not yet to NEAR AI's published build.**
  `make verify` (N3 to N5) checks that the quote's MRTD and RTMR0 to RTMR3 equal the report's
  `tcb_info`, that replaying the 33-event log reproduces all four RTMRs (RTMR3 events are
  recomputed from their payloads, so a payload cannot differ from what was measured), that the
  compose file hashes to `compose_hash` and that hash is extended into RTMR3, and that MRTD,
  RTMR0 to RTMR2 and the compose hash equal `fixtures/live/near-ai/measurements.json`. A new
  image fails until that file is updated on purpose. The pinned values are the ones in our
  2026-11-04 capture; comparing them with NEAR AI's published reproducible-build values is
  not done. The pin runs off chain, before `register_model_attestation`; the contract does not
  store the measurement.
- **The GPU is attested off chain only.** The NVIDIA NRAS result in the report is checked by
  `scripts/nras.mjs` (the ES384 JWT, its x5c chain to the pinned NVIDIA root, every GPU in the
  token set, our nonce); the contract does not see it.
- **`tcb_status` on chain comes from the on-chain quote check** since 2026-11-05: with a quote
  verifier set (`spike.bookerbob.testnet`, tools/dcap-spike), the bazaar registers a model key
  only through `register_model_attestation_verified`, which takes the TCB status from the
  verifier's finalized verification and refuses the owner-written path. The `min_tcb` floor
  applies to that value.
- When a TEE output and a Jolt output disagree on the same value, the contract refuses; today
  they cover different outputs (NEAR AI: predicates; Jolt: standing, price, referee, cohort).
