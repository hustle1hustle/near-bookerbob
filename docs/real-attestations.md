# Real attestations in this repo

Most inputs here are synthetic (the facts behind every verdict, the buyers, the World ID action).
These are the ones signed by a real key or service, each with the command that checks it.

| what | signed by | file | check it |
|---|---|---|---|
| TLSNotary presentation: GET api.github.com/users/octocat, 3 fields revealed (`public_repos`, `followers`, `created_at`), the prove-me pipeline test | the REP notary, key `02114d7e…ab25ef` (MPC-TLS) | `fixtures/live/prove-me/public-test.presentation` (its sha256 is in `public-test.json`) | `make verify-presentation` |
| the same request, notary in proxy mode | the REP notary | `fixtures/live/prove-me/try-public-test.presentation` | `make verify-presentation` |
| TLSNotary presentation: the founder's own GitHub profile, GET api.github.com/users/hustle1hustle, the same 3 fields | the REP notary | `fixtures/live/prove-me/founder-github.presentation` | `make verify-presentation` |
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
PASS  verify-presentation: 3 real presentations, signed by the notary key 02114d7e..
```

What they show and what they do not:

- They prove what api.github.com returned for a public profile at that time. The public
  endpoint needs no login, so they do not show the prover owns the account; an authenticated
  `GET /user` would (`docs/prove-me.md`).
- The notary is one key REP holds, not TEE-attested, so REP could sign a false presentation.
- The prover that made them is REP's (prior work) and is not in this repo; checking needs
  only the presentation and the notary key.

A Claude spend proof from the founder's phone was planned (a "device run") and never produced
a presentation, so there is none here.

## Signed by our own keys (real signatures, synthetic content)

`fixtures/verdict-*.json` and `fixtures/world-attestation*.json` are signed with fixed test seeds
(`cli/src/fixtures.rs`); the World ID action is a placeholder. `fixtures/live/voprf/run.json` is
a real testnet redemption under our own anchored VOPRF key; `make verify` re-derives its nullifier.
