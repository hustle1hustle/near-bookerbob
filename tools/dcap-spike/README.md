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
