# Verify a REP zero-knowledge QFEX proof

This folder checks one public proof, `qfex-gallery-bundle.json`: a claim about a QFEX referral account, made in a web
browser and verifiable by anyone, that reveals only floors.

```
npm install
node verify-gallery.mjs qfex-gallery-bundle.json
```

Expected output:

```
VALID (registry head e77bb403acdeeb22...)
  api.qfex.com, GET /users/me/referrals/activity HTTP/1.1, session 2026-11-13T15:51:52.000Z, notary key 1 (Phala Cloud, Intel TDX)
  referral volume, 30 days: at least $1,000,000; lifetime: at least $1,000,000
  referrals per level: 1+ / 25+ / 0+
  account: not identified (public mode); guest 57f74108b49d2d5c... (reproducible build)
```

## What was proven

1. The account holder's browser opened a TLS session with `api.qfex.com` through a notary running in an Intel TDX
   enclave (MPC-TLS). The notary never saw the plaintext. It signed a receipt holding the request line and two hash
   commitments: one over the whole request, one over the whole answer.
2. In the same browser, a Jolt zero-knowledge proof recomputed both commitments from the private bytes and checked:
   - the HTTP framing and the request line;
   - the host and one QFEX login token, with its issuer pinned;
   - every referral row of the answer.

   It outputs only the floors above: the highest step not above each volume, and count floors 1+, 5+, 10+, 25+, ...

## What the bundle reveals

| Revealed | Not revealed |
|---|---|
| host, request line, session time | the account or any identifier of it (public mode carries no account tag) |
| the 30-day and lifetime referral volume, as floors | the exact volumes |
| referrals per level, as floors | the exact counts, referee ids and usernames |
| the length of the request and of the answer | any header, the login token, cookies |

The answer length gives a rough idea of the number of referral rows; the count floors say about as much.

## What the check trusts, and what it does

The check needs no network access and trusts only `registry.jsonl`, a hash-chained list of public rules records.
It:
1. walks the registry chain from the first record (BLAKE3 and SHA-256 links);
2. takes the gallery template (record 11), its guest (record 9, a reproducible build, pinned by ELF hash with its verifier
   data pinned by SHA-256) and notary key 1 (record 8);
3. requires the bundle's guest hash, public mode, and a session inside key 1's validity window;
4. verifies the receipt's secp256k1 signature, that exactly three entries are present (the request line revealed, the
   whole request and the whole answer hashed from byte 0), that the proof's two commitments equal the signed digests,
   and the Jolt proof itself;
5. refuses a bundle that carries an account tag or a fact commitment.

## Contents

| File | What |
|---|---|
| `verify-gallery.mjs` | the check above |
| `verify-zk.mjs`, `verify-receipt.mjs`, `registry-digests.mjs` | receipt, proof and registry checks |
| `wasm/` | Jolt's zero-knowledge verifier compiled to WebAssembly (1.8 MB): verifier only, no prover |
| `verifier-data/57f74108....verifier.bin` | the guest's verifier preprocessing (2.3 MB), as Jolt verification needs it. It is derived from the guest binary and includes its program image (instructions and constants). No source code and no prover data |
| `registry.jsonl` | the rules registry records (unsigned draft; anchoring to OpenTimestamps and Ethereum comes with the signed version) |
| `qfex-gallery-bundle.json` | the proof bundle: receipt, proof, public inputs and outputs |

Notary key 1 is valid from 2026-11-11 to 2026-12-11. The check accepts this session after that date as well, because the
registry records the key with its window.
