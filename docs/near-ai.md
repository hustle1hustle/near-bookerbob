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

## Not checked yet

- Verifying the TDX quote and NVIDIA payload of the attestation report (dcap-qvl), and
  the report_data binding of nonce and key.
- Whether all instances of a model share one key (docs say so).
