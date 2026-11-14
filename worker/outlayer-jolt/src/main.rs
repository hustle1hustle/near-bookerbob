//! Jolt verification inside OutLayer's TEE.
//!
//! stdin, one of:
//!   {"cmd":"pubkey"}
//!   {"program_hash":"<hex>","proof":"<base64 of the serialized RV64IMACProof>","io":"<hex of the
//!    serialized JoltDevice: inputs, outputs, panic, memory layout>"}
//!
//! The program is looked up in `programs/` by its hash (sha256 of the serialized verifier
//! preprocessing, the hash a contract pins); the bytes are re-hashed before use. The proof is
//! verified with a16z/jolt 997c1543's verifier (`RV64IMACVerifier`, as the guest macro's
//! `build_verifier_*` does). The verdict is signed by the project's host key `jolt-verify`:
//!
//!   ed25519 over "bookerbob/jolt-verify/v0\0" || json(statement)
//!   statement = {"inputs_sha256","output_sha256","panic","program_hash","proof_sha256","verdict"}
//!   (keys sorted, as serde_json writes a json! object)
//!
//! `verdict` is "accept" only when the program is pinned here and the proof verifies against it
//! for exactly these inputs, outputs and panic flag. A parseable request that fails gets a signed
//! "reject", with a `reason` beside the statement (not signed); an unparseable one exits 1. The module signs only statements it composes.
//! Native builds run the same check and print the statement unsigned (for tests).

use base64::Engine;
use jolt_core::zkvm::{verifier::JoltVerifierPreprocessing, RV64IMACProof, RV64IMACVerifier, Serializable};
use common::jolt_device::JoltDevice;
use sha2::{Digest, Sha256};

pub const TAG: &[u8] = b"bookerbob/jolt-verify/v0\x00";

/// The pinned programs: (program hash, serialized verifier preprocessing).
const PROGRAMS: &[(&str, &[u8])] = &[(
    "c780ceabae4decfa59703a9988ab2483313c6c1d2f15c7c0ad8fc60255a5c3a5",
    include_bytes!("../programs/c780ceabae4decfa59703a9988ab2483313c6c1d2f15c7c0ad8fc60255a5c3a5.dat"),
)];

fn sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

type Pre = JoltVerifierPreprocessing<jolt_core::ark_bn254::Fr, jolt_core::curve::Bn254Curve, jolt_core::poly::commitment::dory::DoryCommitmentScheme>;

/// (statement, reason): the statement the module signs, and why a reject is a reject.
pub fn check(raw: &str) -> Result<(serde_json::Value, String), String> {
    let v: serde_json::Value = serde_json::from_str(raw).map_err(|e| format!("bad input: {e}"))?;
    let program_hash = v["program_hash"].as_str().ok_or("program_hash missing")?.to_ascii_lowercase();
    let proof_bytes = base64::engine::general_purpose::STANDARD.decode(v["proof"].as_str().ok_or("proof missing")?).map_err(|e| format!("proof: {e}"))?;
    let io_bytes = hex::decode(v["io"].as_str().ok_or("io missing")?).map_err(|e| format!("io: {e}"))?;
    let mut statement = serde_json::json!({
        "program_hash": program_hash,
        "proof_sha256": sha(&proof_bytes),
        "inputs_sha256": serde_json::Value::Null,
        "output_sha256": serde_json::Value::Null,
        "panic": serde_json::Value::Null,
        "verdict": "reject",
    });
    let io = match JoltDevice::deserialize_from_bytes(&io_bytes) {
        Ok(io) => io,
        Err(e) => return Ok((statement, format!("io does not parse: {e}"))),
    };
    statement["inputs_sha256"] = sha(&io.inputs).into();
    statement["output_sha256"] = sha(&io.outputs).into();
    statement["panic"] = io.panic.into();
    let Some((_, pp_bytes)) = PROGRAMS.iter().find(|(h, _)| *h == program_hash) else {
        return Ok((statement, "program not pinned in this module".into()));
    };
    if sha(pp_bytes) != program_hash {
        return Ok((statement, "pinned preprocessing does not hash to its name".into()));
    }
    let pp = match Pre::deserialize_from_bytes(pp_bytes) {
        Ok(p) => p,
        Err(e) => return Ok((statement, format!("preprocessing does not parse: {e}"))),
    };
    let proof = match RV64IMACProof::deserialize_from_bytes(&proof_bytes) {
        Ok(p) => p,
        Err(e) => return Ok((statement, format!("proof does not parse: {e}"))),
    };
    let ok = match RV64IMACVerifier::new(&pp, proof, io, None, None) {
        Ok(verifier) => verifier.verify().map_err(|e| format!("{e:?}")),
        Err(e) => Err(format!("{e:?}")),
    };
    match ok {
        Ok(()) => {
            statement["verdict"] = "accept".into();
            Ok((statement, String::new()))
        }
        Err(e) => Ok((statement, format!("proof does not verify: {}", e.chars().take(120).collect::<String>()))),
    }
}

/// The exact bytes signed for a statement.
pub fn message(statement: &serde_json::Value) -> Vec<u8> {
    let mut m = TAG.to_vec();
    m.extend(serde_json::to_vec(statement).expect("serializes"));
    m
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    use std::io::Read;
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).expect("stdin");
    match check(&raw) {
        Ok((s, reason)) => println!("{}", serde_json::json!({ "statement": s, "reason": reason, "signature": null })),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1)
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn main() {
    component::main()
}

#[cfg(target_arch = "wasm32")]
mod component {
    use super::*;
    use std::io::{Read, Write};

    wit_bindgen::generate!({ world: "jolt-verify", path: "wit", generate_all });
    use outlayer::signing_keys::api as sig;

    #[used]
    #[link_section = "outlayer.manifest"]
    static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");

    const KEY: &str = "jolt-verify";

    fn sign(msg: &[u8]) -> Result<String, String> {
        Ok(hex::encode(sig::sign(KEY, None, msg)?))
    }

    fn answer(raw: &str) -> Result<String, String> {
        let v: serde_json::Value = serde_json::from_str(raw).map_err(|e| format!("bad input: {e}"))?;
        if v.get("cmd").and_then(|c| c.as_str()) == Some("pubkey") {
            let key = hex::encode(sig::public_key(KEY, None)?);
            let body = serde_json::json!({ "jolt_verify_key": key, "programs": PROGRAMS.iter().map(|(h, _)| *h).collect::<Vec<_>>() });
            let mut m = b"bookerbob/jolt-verify-keys/v0\x00".to_vec();
            m.extend(serde_json::to_vec(&body).expect("serializes"));
            return Ok(serde_json::json!({ "keys": body, "signature": sign(&m)? }).to_string());
        }
        if v.get("cmd").is_some() {
            return Err("unknown cmd".into());
        }
        let (statement, reason) = check(raw)?;
        let signature = sign(&message(&statement))?;
        let key = hex::encode(sig::public_key(KEY, None)?);
        Ok(serde_json::json!({ "statement": statement, "reason": reason, "key": key, "signature": signature }).to_string())
    }

    pub fn main() {
        let mut raw = String::new();
        if std::io::stdin().read_to_string(&mut raw).is_err() {
            std::process::exit(1)
        }
        match answer(&raw) {
            Ok(out) => {
                let _ = std::io::stdout().write_all(out.as_bytes());
            }
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1)
            }
        }
    }
}
