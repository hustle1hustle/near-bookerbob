//! A TDX quote checked on chain with dcap-qvl (Intel root CA, PCS collateral passed in): the
//! spike that measures whether it fits one call. Returns the TCB status and report_data.
use near_sdk::near;

#[near(contract_state)]
#[derive(Default)]
pub struct Spike {}

#[near]
impl Spike {
    /// `quote_hex`: the TDX quote; `collateral_json`: dcap-qvl's QuoteCollateralV3 as JSON;
    /// `now_secs`: the time the collateral is checked at.
    pub fn verify_quote(&self, quote_hex: String, collateral_json: String, now_secs: u64) -> String {
        let quote = hex::decode(quote_hex).expect("hex quote");
        let col: dcap_qvl::QuoteCollateralV3 = serde_json::from_str(&collateral_json).expect("collateral");
        match dcap_qvl::verify::rustcrypto::verify(&quote, &col, now_secs) {
            Ok(v) => format!("ok {} report_data {}", v.status, v.report.as_td10().map(|t| hex::encode(t.report_data)).unwrap_or_default()),
            Err(e) => format!("refused: {e}"),
        }
    }

    // The pieces a split verifier would spread over several calls, measured one by one.

    /// Step 1: parse the PCS collateral (what a first call would parse and store).
    pub fn step_parse_collateral(&self, collateral_json: String) -> u32 {
        let col: dcap_qvl::QuoteCollateralV3 = serde_json::from_str(&collateral_json).expect("collateral");
        (col.tcb_info.len() + col.qe_identity.len()) as u32
    }

    /// Step 2: parse the quote.
    pub fn step_parse_quote(&self, quote_hex: String) -> u32 {
        let q = dcap_qvl::quote::Quote::parse(&hex::decode(quote_hex).expect("hex")).expect("quote");
        q.signed_length() as u32
    }

    /// Step 3: one P-256 ECDSA check, the quote's own signature by its attestation key (one of
    /// about ten a full check needs: the PCK chain, the CRLs, TCB info, QE identity, QE report).
    pub fn step_one_p256(&self, quote_hex: String) -> bool {
        use p256::ecdsa::signature::Verifier;
        let raw = hex::decode(quote_hex).expect("hex");
        let q = dcap_qvl::quote::Quote::parse(&raw).expect("quote");
        let a = match &q.auth_data {
            dcap_qvl::quote::AuthData::V4(a) => (a.ecdsa_signature, a.ecdsa_attestation_key),
            dcap_qvl::quote::AuthData::V3(a) => (a.ecdsa_signature, a.ecdsa_attestation_key),
        };
        let mut pk = [0x04u8; 65];
        pk[1..].copy_from_slice(&a.1);
        let key = p256::ecdsa::VerifyingKey::from_sec1_bytes(&pk).expect("key");
        let sig = p256::ecdsa::Signature::from_slice(&a.0).expect("sig");
        key.verify(&raw[..q.signed_length()], &sig).is_ok()
    }
}

// Signature verification needs no randomness: any request for it fails.
fn no_rng(_: &mut [u8]) -> Result<(), getrandom::Error> {
    Err(getrandom::Error::UNSUPPORTED)
}
getrandom::register_custom_getrandom!(no_rng);
