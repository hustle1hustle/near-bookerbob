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

`agents/why.mjs`: 32 calls, 32/32 signatures valid, hashes equal the wire bytes. Same
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
sha256 of the committed request and response bytes; the sealed answer opens with the
disclosed one-time client X25519 secret; the attested predicates equal what
`core/src/tier.rs` derives; the answer echoes the envelope's binding; the envelope
reveals a subset of the attested predicates and names this model, report and TCB status.
Tamper tests: one changed response byte, a raised predicate set, another nullifier, a
wrong disclosed key.

What the disclosure gives away: the one-time client secret opens only answers sealed to
it (this one). The request, which holds the facts, is sealed to the model key and stays
sealed. Chat ids to look up: verdict `08af1d014f2d4f379dba94094562d9ba`; buyer "why"
runs `68657600d12549518664defcf8fb0dd1` (honest), `bfbb3d0db39447918285c8b6570ddc7f`
(injected), `b7b3a69052d84f938b2702e435ef41ff` (direct). NEAR AI's no-code page is
https://cloud.near.ai/verify; we have not confirmed whether it takes these ids without
our account.

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

Still open: NVIDIA GPU evidence (NRAS is online, not run here); the TDX quote is checked
off chain, not inside the contract.

## Not checked yet

- The NVIDIA payload of the attestation report (NRAS).
- Whether all instances of a model share one key (docs say so).
