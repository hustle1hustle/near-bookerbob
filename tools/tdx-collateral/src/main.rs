//! `cargo run --manifest-path tools/tdx-collateral/Cargo.toml -- <report.json> <out.json>`
//! Reads the model attestation's `intel_quote`, fetches its collateral from Intel PCS
//! (network, once), checks the quote with it now, and writes the collateral plus the check
//! time, so `bookerbob near-ai` can repeat the same check offline at that time.
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let report: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&a[0]).expect("read report")).expect("parse report");
    let quote = hex::decode(report["model_attestations"][0]["intel_quote"].as_str().expect("intel_quote")).expect("hex quote");
    let collateral = dcap_qvl::collateral::get_collateral_from_pcs(&quote).await.expect("fetch collateral from Intel PCS");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let v = dcap_qvl::verify::verify(&quote, &collateral, now).expect("quote verifies");
    let out = serde_json::json!({ "checked_at_secs": now, "status": v.status, "advisory_ids": v.advisory_ids, "collateral": collateral });
    std::fs::write(&a[1], serde_json::to_string_pretty(&out).unwrap() + "\n").expect("write");
    println!("quote verifies against Intel PCS collateral: status {}, advisories {:?}", v.status, v.advisory_ids);
}
