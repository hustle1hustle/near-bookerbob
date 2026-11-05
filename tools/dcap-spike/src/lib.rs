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
}

// Signature verification needs no randomness: any request for it fails.
fn no_rng(_: &mut [u8]) -> Result<(), getrandom::Error> {
    Err(getrandom::Error::UNSUPPORTED)
}
getrandom::register_custom_getrandom!(no_rng);
