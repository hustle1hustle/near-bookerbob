//! BookerBob Jolt host.
//!
//!   cargo run --release -- prove-standing <events.json> <out-dir>
//!   cargo run --release -- verify-standing <events.json> <out-dir>
//!
//! prove: compiles the guest, preprocesses, proves the standing graph over the events,
//! verifies, and writes the verifier preprocessing, the proof and `result.json` (root,
//! scores hash, program hash, timings, sizes).
//! verify: loads only the committed files (no guest compile) and checks the proof against
//! the events and the claimed (root, scores hash); then recomputes the scores natively and
//! checks they hash to what was proven.
//! Program hash: sha256 of the serialized verifier preprocessing, which commits to the
//! guest bytecode; it is what a proof verifies against, so it is what the contract registers.
use std::path::Path;
use std::time::Instant;

use jolt_sdk::{JoltVerifierPreprocessing, RV64IMACProof, Serializable};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize)]
struct Result {
    root: String,
    scores_hash: String,
    program_hash: String,
    events: usize,
    prove_seconds: f64,
    verify_ms: u128,
    proof_bytes: u64,
    verifier_preprocessing_bytes: u64,
    trace_note: String,
}

fn events(path: &str) -> Vec<Vec<u8>> {
    let v: Vec<String> = serde_json::from_str(&std::fs::read_to_string(path).expect("read events")).expect("events json: a list of hex strings");
    v.iter().map(|h| hex::decode(h).expect("hex event")).collect()
}

fn sha_file(p: &Path) -> String {
    hex::encode(Sha256::digest(std::fs::read(p).expect("read")))
}

fn prove(events_path: &str, out: &str) {
    let ev = events(events_path);
    std::fs::create_dir_all(out).expect("out dir");
    let target_dir = "/tmp/bookerbob-jolt-guest-targets";
    let mut program = standing_guest::compile_standing(target_dir);
    let shared = standing_guest::preprocess_shared_standing(&mut program).expect("preprocess");
    let prover_pp = standing_guest::preprocess_prover_standing(shared.clone());
    let verifier_setup = prover_pp.generators.to_verifier_setup();
    let verifier_pp = standing_guest::preprocess_verifier_standing(shared, verifier_setup, None);
    verifier_pp.save_to_target_dir(out).expect("save verifier preprocessing");
    let prove_fn = standing_guest::build_prover_standing(program, prover_pp);
    let verify_fn = standing_guest::build_verifier_standing(verifier_pp);

    let t = Instant::now();
    let (output, proof, io) = prove_fn(ev.clone());
    let prove_seconds = t.elapsed().as_secs_f64();
    let proof_path = Path::new(out).join("proof.bin");
    proof.save_to_file(&proof_path).expect("save proof");
    io.save_to_file(Path::new(out).join("io_device.bin")).expect("save io");
    let t = Instant::now();
    assert!(verify_fn(ev.clone(), output, io.panic, proof), "fresh proof does not verify");
    let verify_ms = t.elapsed().as_millis();

    let pp_path = Path::new(out).join("jolt_verifier_preprocessing.dat");
    let r = Result {
        root: hex::encode(output.0),
        scores_hash: hex::encode(output.1),
        program_hash: sha_file(&pp_path),
        events: ev.len(),
        prove_seconds,
        verify_ms,
        proof_bytes: std::fs::metadata(&proof_path).unwrap().len(),
        verifier_preprocessing_bytes: std::fs::metadata(&pp_path).unwrap().len(),
        trace_note: "peak RAM is measured outside, with /usr/bin/time -l".into(),
    };
    std::fs::write(Path::new(out).join("result.json"), serde_json::to_string_pretty(&r).unwrap() + "\n").expect("write result");
    println!("proved {} events in {prove_seconds:.2} s, verified in {verify_ms} ms, proof {} bytes", r.events, r.proof_bytes);
}

fn verify(events_path: &str, out: &str) -> bool {
    let ev = events(events_path);
    let r: Result = serde_json::from_str(&std::fs::read_to_string(Path::new(out).join("result.json")).expect("read result")).expect("parse result");
    let pp_path = Path::new(out).join("jolt_verifier_preprocessing.dat");
    let program_ok = sha_file(&pp_path) == r.program_hash;
    let pp = JoltVerifierPreprocessing::read_from_target_dir(out).expect("read verifier preprocessing");
    let proof = RV64IMACProof::from_file(Path::new(out).join("proof.bin")).expect("read proof");
    let verify_fn = standing_guest::build_verifier_standing(pp);
    let claimed: ([u8; 32], [u8; 32]) = (hex::decode(&r.root).unwrap().try_into().unwrap(), hex::decode(&r.scores_hash).unwrap().try_into().unwrap());
    let t = Instant::now();
    let proof_ok = verify_fn(ev.clone(), claimed, false, proof);
    let ms = t.elapsed().as_millis();
    let decoded: Vec<bookerbob_graph::Event> = ev.iter().map(|b| bookerbob_graph::Event::from_bytes(b).expect("event")).collect();
    let native = bookerbob_graph::compute(&decoded);
    let native_ok = native.root == claimed.0 && native.hash() == claimed.1;
    let check = |ok: bool, what: &str, d: String| println!("{}  {what}  ({d})", if ok { "PASS" } else { "FAIL" });
    check(program_ok, "program hash = sha256 of the committed verifier preprocessing", format!("{}..", &r.program_hash[..16]));
    check(proof_ok, "Jolt proof verifies for these events and the claimed (root, scores hash)", format!("{ms} ms"));
    check(native_ok, "the native computation gives the same root and scores hash", format!("root {}..", &r.root[..16]));
    program_ok && proof_ok && native_ok
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    match a.first().map(String::as_str) {
        Some("prove-standing") if a.len() >= 3 => prove(&a[1], &a[2]),
        Some("verify-standing") if a.len() >= 3 => {
            if !verify(&a[1], &a[2]) {
                std::process::exit(1);
            }
        }
        _ => {
            eprintln!("usage: bookerbob-zk prove-standing|verify-standing <events.json> <out-dir>");
            std::process::exit(2);
        }
    }
}
