# Real attestations in this repo

Most inputs here are synthetic (the facts behind every verdict, the buyers, the World ID action).
These are the ones signed by a real key or service, each with the command that checks it.


## The gallery: proofs of real web data

| source | what it proves | revealed | signed by | check it |
|---|---|---|---|---|
| GitHub, signed in | the founder holds a GitHub account with these fields: `GET api.github.com/user` with his own token, which stays hidden | `public_repos` 12, `followers` 4, `created_at` 2024-09-18 (the same account as the public hustle1hustle profile) | the REP notary, `02114d7e…ab25ef`, MPC-TLS | `make verify-presentation` |
| GitHub, public profile | what api.github.com returned for `/users/hustle1hustle` | the same three fields | the REP notary | `make verify-presentation` |
| GitHub, public profile, twice | the prove-me pipeline test on `/users/octocat`, MPC and proxy mode | the same three fields | the REP notary | `make verify-presentation` |
| QFEX, the founder's own account | a zero-knowledge proof of a QFEX referral volume floor, made in the browser over a notarized MPC-TLS session (`GET /users/me/referrals/activity`, 2026-11-13); the notary saw only hash commitments of the request and the answer; the account is not identified | floors only: 30-day and lifetime referral volume at least $1,000,000; referrals per level 1+ / 25+ / 0+; plus the request line and the lengths of request and answer | REP's TEE notary (Phala, key `0307293878…aaed32`, valid until 2026-12-11) over the session; a Jolt proof (guest `57f74108…`, reproducible build) over the two commitments | `node scripts/verify-receipt.mjs fixtures/live/qfex/referral-zk-bundle.json` checks the notary's signed receipt with no REP code; the Jolt proof checks with REP's gallery verifier kit (VALID against its rules registry head `411362e97f477f5a…`) |
| QFEX, public leaderboard | what api.qfex.com returned for `/public/leaderboard`, no account | `"count":100`; the request is hidden | REP's notary on Phala (`rep-notary-ext`, `0307293878…aaed32`), a signed session receipt | `node scripts/verify-receipt.mjs` |

The TLSNotary presentations carry the server's certificate chain, so anyone re-checks them
against GitHub's certificate with upstream code. The QFEX receipt is the notary's signed word
over a session it relayed: it is checked against the notary's key, and the notary's Intel TDX
attestation is published ([attestation](https://cc7da91b37b31c4ba114f4d2e67d4446f77339ec-7048.dstack-pha1-prod13.phala.network/notary/attestation));
it cannot be re-checked against QFEX's certificate. That key was made while the machine briefly
ran Phala's dev image, so the claim is "signed by REP's notary", not "a key that never left an
enclave".

## Other real signatures in the repo

| what | signed by | file | check it |
|---|---|---|---|
| NEAR AI verdict under E2EE v2: Intel TDX quote, NVIDIA GPU evidence, the model's TEE signature over the request and response (the facts it judged are synthetic) | NEAR AI Cloud's TEE model key | `fixtures/live/near-ai/` | `make verify` (`PASS  NEAR AI verdict: 17 checks`); the TDX quote on chain: `spike.bookerbob.testnet` |
| the E2EE v2 signature covers the ciphertext | NEAR AI Cloud | `fixtures/live/e2ee-signature.json` | `node scripts/spikes/e2ee-signature.mjs` (needs a NEAR AI key) |
| a recorded NEAR AI run, 33 of 33 response signatures over the exact bytes | NEAR AI Cloud | `agents/out/live-run.json` | `make judge` (status check) |
| NEAR Chain Signatures `sign` (Ed25519, domain 1) | NEAR's MPC network, `v1.signer-prod.testnet` | `fixtures/live/mpc-sign.txt` | tx [2yHrL9YW…](https://testnet.nearblocks.io/txns/2yHrL9YWdF5ev7ArUaPM7HG8dJCxWECVLEiWcnhM7SVe) |
| every testnet purchase, bid, reveal and settle | the accounts that sent them | `docs/testnet.md`, `fixtures/live/testnet-manifest.json` | `make verify-live` |

## The TLSNotary presentations

A presentation is what a TLSNotary prover hands a verifier: the notary's signature over a
commitment to the TLS session, the server's certificate chain, and openings for the bytes the
prover chose to reveal. Everything else in the request and response stays hidden (shown as `X`).

`make verify-presentation` builds `tools/verify-presentation`, a 40-line checker that uses only
upstream TLSNotary (`tlsnotary/tlsn`, tag `v0.1.0-alpha.15`), and for each file checks:

- the notary's signature, and that its key is the pinned `02114d7e15cb2a93ad88997af3394d00008dae381b601f31379d638de492ab25ef`;
- the server's certificate chain against Mozilla's roots, and that the server is `api.github.com`;
- the request line, and that exactly three fields of the response are revealed;
- for the two prove-me runs, that the file's sha256 equals the one recorded at the time.

The first build takes about a minute and a half. Then:

```
PASS  verify-presentation: 4 real presentations, signed by the notary key 02114d7e..
```

What they show and what they do not:

- The public-profile ones prove what api.github.com returned for a public profile at that time;
  the endpoint needs no login, so they do not show the prover owns the account. The signed-in
  one does: `GET /user` answers only with the token's own account.
- The notary is one key REP holds, not TEE-attested, so REP could sign a false presentation.
- The prover that made them is REP's (prior work) and is not in this repo; checking needs
  only the presentation and the notary key.

A Claude spend proof from the founder's phone was planned (a "device run") and never produced
a presentation, so there is none here.

## Signed by our own keys (real signatures, synthetic content)

`fixtures/verdict-*.json` and `fixtures/world-attestation*.json` are signed with fixed test seeds
(`cli/src/fixtures.rs`); the World ID action is a placeholder. `fixtures/live/voprf/run.json` is
a real testnet redemption under our own anchored VOPRF key; `make verify` re-derives its nullifier.
