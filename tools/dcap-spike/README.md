# A TDX quote verified on chain, across five calls

`spike.bookerbob.testnet` runs Intel DCAP quote verification as a NEAR contract: the same checks
as dcap-qvl 0.3.12 (Phala-Network/dcap-qvl, commit `a854bd2`, MIT), forked in `dcap-qvl-port/`
with one change, a `split` module at the end of `src/verify.rs` that runs them in five steps.
Each call re-reads the stored quote and collateral; a later step relies only on what an earlier
one verified on the same bytes. The time is the block's, not the caller's.

## Result (testnet, 2026-11-05)

The NEAR AI model's TDX quote (5,006 bytes) with its Intel PCS collateral
(`fixtures/live/near-ai/`) verifies fully, one call per step (`run.json` has every tx):

| step | what it checks | Tgas |
|---|---|---|
| start | the root CA against its CRL; the quote header | 39.6 |
| tcb | the TCB Info chain and signature | 99.8 |
| qe_identity | the QE Identity chain and signature, its id and version | 98.9 |
| pck | the PCK certificate chain | 131.8 |
| finalize | the QE report and quote signatures, the QE report data, the policies, the TCB match | 69.3 |

Every step is under half of one call's 300 Tgas. The result: TCB status `UpToDate`, and
report_data = the model's signing key and the attestation nonce.

The same quote with one byte changed inside its signed TD report passes the first four steps
(they check Intel's collateral, not the quote) and fails at finalize: "ISV enclave report
signature is invalid". A native test (`cargo test` here) also changes the TCB Info JSON: refused
at the TCB step; and checks that the five steps give exactly what the whole check gives.

## Used by the bazaar

`bookerbob.testnet` now takes model keys only through this verifier:

- `set_quote_verifier(spike.bookerbob.testnet)`, a timelocked trust anchor.
- `register_model_attestation_verified(key, attestation, verification_id)` reads the verifier's
  record and admits the key only if it is finalized, its report_data is this key and nonce, and
  its TCB status meets the floor and matches the attestation. The NEAR AI model key was
  registered this way.
- The same verification cited for another key is refused; the old `register_model_attestation`,
  which relied on the off-chain check, refuses once a verifier is set.

## Stated plainly

- **The verifier's code is fixed.** `spike.bookerbob.testnet` has no full-access key since
  2026-11-14 (DeleteKey [7pgUUjnb…](https://testnet.nearblocks.io/txns/7pgUUjnb6qiAwqVF8gZdKXXGysjbtmXymbVfkoJY4Wcv)), so its code cannot be replaced; `make no-owner` and
  `make verify-live` re-check it. The bazaar trusts the account, like any anchor.
- **The collateral is passed in.** It is Intel-signed and its signatures are checked on chain,
  but someone has to fetch it from Intel's PCS; nothing on chain fetches it.
- The NVIDIA GPU evidence is checked off chain, from NVIDIA's signed NRAS reply (`scripts/nras.mjs`), not here.
- `tools/dcap-spike` is not part of the workspace or of `make verify`; `node tools/dcap-spike/run.mjs`
  reruns the calls (testnet NEAR, a 0.5 NEAR storage deposit per verification).

The first spike, the whole check in one call, ran out of gas (301 Tgas burned,
[HwVxmzLM…](https://testnet.nearblocks.io/txns/HwVxmzLMDf6dn9oVdu9xC6YEXhy4htscs7GZ2Wsjp2DQ)).
