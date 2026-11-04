//! `bookerbob zk-results <fixtures-dir> <zk-out-dir>`: the committed Jolt results
//! (zk/out/<guest>/result.json) against the native computation of the same shared code,
//! and each program hash against the committed verifier preprocessing. This does not check
//! the Jolt proofs themselves (that needs the Jolt build: `make zk-verify`); it checks that
//! what the proofs claim is what the contract's code computes.
use std::path::Path;
use std::process::ExitCode;

use serde_json::Value;
use sha2::{Digest, Sha256};

fn bytes_hex(v: &Value) -> Option<String> {
    let b: Vec<u8> = v.as_array()?.iter().map(|x| x.as_u64().map(|n| n as u8)).collect::<Option<_>>()?;
    Some(hex::encode(b))
}

pub fn run(fixtures: &Path, out: &Path) -> ExitCode {
    let load = |p: &Path| -> Option<Value> { serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok() };
    let mut failed = 0;
    for g in ["standing", "price", "referee", "cohort"] {
        let (Some(r), Some(input)) = (load(&out.join(g).join("result.json")), load(&fixtures.join("zk").join(format!("{g}-input.json")))) else {
            println!("FAIL  zk {g}: missing result.json or input");
            failed += 1;
            continue;
        };
        let e = &input["expected"];
        let o = &r["output"];
        let output_ok = match g {
            "standing" => bytes_hex(&o[0]) == e["root"].as_str().map(String::from) && bytes_hex(&o[1]) == e["scores_hash"].as_str().map(String::from),
            "price" => {
                o[0].as_u64().map(|x| x.to_string()) == e["price"].as_str().map(String::from)
                    && o[1] == e["discount_bps"]
                    && bytes_hex(&o[2]) == e["input_hash"].as_str().map(String::from)
            }
            "referee" => o[0] == e["receipt"] && bytes_hex(&o[1]) == e["input_hash"].as_str().map(String::from),
            "cohort" => bytes_hex(&o[0]) == e["root"].as_str().map(String::from) && o[1] == e["k"],
            _ => false,
        };
        let pp = std::fs::read(out.join(g).join("jolt_verifier_preprocessing.dat")).unwrap_or_default();
        let program_ok = !pp.is_empty() && r["program_hash"].as_str() == Some(hex::encode(Sha256::digest(&pp)).as_str());
        let ok = output_ok && program_ok;
        failed += !ok as usize;
        println!(
            "{}  zk {g}: committed Jolt output = native output, program hash = sha256(verifier preprocessing)  (proved in {:.2} s, proof {} bytes, program {}..)",
            if ok { "PASS" } else { "FAIL" },
            r["prove_seconds"].as_f64().unwrap_or(0.0),
            r["proof_bytes"],
            &r["program_hash"].as_str().unwrap_or("")[..16.min(r["program_hash"].as_str().unwrap_or("").len())]
        );
    }
    if failed == 0 {
        println!("PASS  Jolt results: 4 guests consistent with the contract's code (proof check: make zk-verify)");
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
