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

    // ---------- the resumable verifier: start, then step until verified ----------

    /// Call 1: check the root CA CRL and the quote header, store quote and collateral. Returns the
    /// verification id, sha256(quote || collateral || now). The time is the block's, not the
    /// caller's, so expired collateral cannot be passed off. Attach storage (about 0.5 NEAR).
    #[payable]
    pub fn start(&mut self, quote_hex: String, collateral_json: String) -> String {
        let now_secs = near_sdk::env::block_timestamp_ms() / 1000;
        let quote = hex::decode(&quote_hex).expect("hex quote");
        let col: dcap_qvl::QuoteCollateralV3 = serde_json::from_str(&collateral_json).expect("collateral");
        if let Err(e) = dcap_qvl::verify::split::start(&quote, &col, now_secs) {
            near_sdk::env::panic_str(&format!("step start: {e}"));
        }
        let mut h = quote.clone();
        h.extend(collateral_json.as_bytes());
        h.extend(now_secs.to_le_bytes());
        let id = hex::encode(near_sdk::env::sha256(&h));
        near_sdk::env::storage_write(format!("q:{id}").as_bytes(), &quote);
        near_sdk::env::storage_write(format!("c:{id}").as_bytes(), collateral_json.as_bytes());
        near_sdk::env::storage_write(format!("t:{id}").as_bytes(), &now_secs.to_le_bytes());
        near_sdk::env::storage_write(format!("s:{id}").as_bytes(), b"tcb");
        id
    }

    /// Calls 2 to 5: run the next step on the stored bytes (tcb, qe_identity, pck, finalize).
    /// A failure panics with the step's name and leaves the stage where it was.
    pub fn step(&mut self, id: String) -> String {
        let read = |k: &str| near_sdk::env::storage_read(format!("{k}:{id}").as_bytes()).unwrap_or_else(|| near_sdk::env::panic_str("unknown verification id"));
        let stage = String::from_utf8(read("s")).expect("stage");
        let quote = read("q");
        let col: dcap_qvl::QuoteCollateralV3 = serde_json::from_slice(&read("c")).expect("collateral");
        let now = u64::from_le_bytes(read("t").try_into().expect("8 bytes"));
        let fail = |e: anyhow::Error| -> ! { near_sdk::env::panic_str(&format!("step {stage}: {e}")) };
        let next = match stage.as_str() {
            "tcb" => dcap_qvl::verify::split::tcb(&col, now).map(|_| "qe_identity").unwrap_or_else(|e| fail(e)),
            "qe_identity" => dcap_qvl::verify::split::qe_identity(&quote, &col, now).map(|_| "pck").unwrap_or_else(|e| fail(e)),
            "pck" => dcap_qvl::verify::split::pck(&quote, &col, now).map(|_| "finalize").unwrap_or_else(|e| fail(e)),
            "finalize" => {
                let v = dcap_qvl::verify::split::finalize(&quote, &col).unwrap_or_else(|e| fail(e));
                let rd = v.report.as_td10().map(|t| hex::encode(t.report_data)).unwrap_or_default();
                near_sdk::env::storage_write(format!("r:{id}").as_bytes(), format!("{} {rd}", v.status).as_bytes());
                "verified"
            }
            other => near_sdk::env::panic_str(&format!("nothing to do at stage {other}")),
        };
        near_sdk::env::storage_write(format!("s:{id}").as_bytes(), next.as_bytes());
        next.to_string()
    }

    /// (stage, "status report_data" once verified).
    pub fn verification(&self, id: String) -> (String, Option<String>) {
        let get = |k: &str| near_sdk::env::storage_read(format!("{k}:{id}").as_bytes()).map(|b| String::from_utf8(b).expect("utf8"));
        (get("s").unwrap_or_else(|| "unknown".into()), get("r"))
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

#[cfg(test)]
mod tests {
    fn fixture() -> (Vec<u8>, dcap_qvl::QuoteCollateralV3, u64) {
        let report: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/live/near-ai/report.json")).unwrap();
        let col: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/live/near-ai/collateral.json")).unwrap();
        let quote = hex::decode(report["model_attestations"][0]["intel_quote"].as_str().unwrap()).unwrap();
        (quote, serde_json::from_value(col["collateral"].clone()).unwrap(), col["checked_at_secs"].as_u64().unwrap())
    }

    #[test]
    fn the_five_steps_give_what_the_whole_check_gives() {
        use dcap_qvl::verify::split;
        let (q, c, now) = fixture();
        let whole = dcap_qvl::verify::rustcrypto::verify(&q, &c, now).unwrap();
        split::start(&q, &c, now).unwrap();
        split::tcb(&c, now).unwrap();
        split::qe_identity(&q, &c, now).unwrap();
        split::pck(&q, &c, now).unwrap();
        let v = split::finalize(&q, &c).unwrap();
        assert_eq!(v.status, whole.status);
        assert_eq!(v.report.as_td10().unwrap().report_data, whole.report.as_td10().unwrap().report_data);
    }

    #[test]
    fn a_tampered_quote_fails_at_finalize_and_tampered_collateral_at_its_step() {
        use dcap_qvl::verify::split;
        let (mut q, c, now) = fixture();
        // A byte inside the signed TD report (the first 632 bytes: header and report) changed:
        // the quote's own signature fails. (Bytes after it are certification data, which the
        // collateral's PCK chain supersedes.)
        q[600] ^= 1;
        assert!(split::start(&q, &c, now).is_ok(), "the header still parses");
        assert!(split::finalize(&q, &c).is_err());
        let (q, mut c2, now) = fixture();
        c2.tcb_info = c2.tcb_info.replacen("\"tcbLevels\"", "\"tcbLevels\" ", 1);
        assert!(split::tcb(&c2, now).is_err(), "TCB Info no longer matches its signature");
        assert!(split::qe_identity(&q, &c2, now).is_ok(), "other steps are unaffected");
    }
}
