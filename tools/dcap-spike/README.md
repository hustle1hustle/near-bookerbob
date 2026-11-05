# dcap-spike: a TDX quote checked on chain, measured

Result (2026-11-05): **it does not fit in one call.** `verify_quote` with the NEAR AI model's
TDX quote (5,006 bytes) and its Intel PCS collateral (36 KB of args) burned the whole 300 Tgas
and stopped ("Exceeded the prepaid gas"): [HwVxmzLM…](https://testnet.nearblocks.io/txns/HwVxmzLMDf6dn9oVdu9xC6YEXhy4htscs7GZ2Wsjp2DQ),
on `spike.bookerbob.testnet` (dcap-qvl 0.3.12, pure-Rust crypto, 628 KB wasm).

The fallback, which the bazaar already uses: the quote is checked off chain (`make verify`,
`cli/src/near_ai.rs`), the owner registers the model key with the report's hash
(`register_model_attestation`, timelocked), and the contract checks signatures against that key.
Not tried: splitting the check across several calls (each ECDSA step stored between them), or a
host function for P-256 and P-384 verification.

## Split across calls: the pieces measured (2026-11-05, time-boxed)

Each piece alone, on `spike.bookerbob.testnet`, gas burnt by the function call (`steps.json`):

| step | Tgas | tx |
|---|---|---|
| parse the PCS collateral (36 KB JSON) | 4.3 | [AiaiBUEp…](https://testnet.nearblocks.io/txns/AiaiBUEpA2iiQTkQiA7fjvK1JftgyYxDqe4y6kH34Kj3) |
| parse the quote | 3.1 | [FcPk66e5…](https://testnet.nearblocks.io/txns/FcPk66e52a2nmShwsoZckNYVYbLUYhgJJB4C6Rifa5rK) |
| one P-256 ECDSA check (the quote's own signature, valid) | 34.3 incl. parsing, about 31 for the check | [Cp81xxrn…](https://testnet.nearblocks.io/txns/Cp81xxrn1J92wK3WajRDgba2SSqAfLReDMKQK1DB1xHC) |

A full check needs about ten P-256 checks (the PCK chain, the CRLs, TCB info, QE identity, the
QE report, the quote), so about 310 Tgas: just over one call, which matches the whole-check
run above. No single piece is anywhere near 300 Tgas, so a resumable verifier in about four calls
fits: (1) parse and store collateral and quote, (2) the PCK chain and CRLs, (3) TCB info and QE
identity, (4) the QE report and quote signatures, report_data and the TCB match.

**Not built.** It needs dcap-qvl's verification steps, which are private to the crate, ported
and split with their intermediate results stored between calls. Not done in the time box, so
no claim of an on-chain quote check: the quote stays checked off chain.
