//! smith-host: the checker and prover for smith programs (docs/smith.md).
//!
//!   smith-host check <id> <vectors.json>        every vector traced in the guest (Jolt's emulator, not proved)
//!   smith-host prove <id> <vector.json> <out>   compile, preprocess, prove, verify, refuse changed statements
//!
//! Run from the fixed build root (/tmp/bookerbob-smith) by scripts/smith.mjs: `jolt build -p` runs
//! in the current workspace, and the guest ELF carries source paths.
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Instant;

use jolt_sdk::{RV64IMACProof, UntrustedAdvice};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const GUEST_TARGET: &str = "/tmp/bookerbob-smith/target/guests";

type Commit = ([u8; 32], [u8; 32], Vec<u8>);

struct Program {
    id: &'static str,
    /// Trace the guest: (output bytes, panic, cycles).
    trace: fn(Vec<u8>, Vec<u8>) -> (Vec<u8>, bool, usize),
    prove: fn(Vec<u8>, Vec<u8>, &str) -> Value,
    /// Compile and preprocess only: (program hash, ELF sha256).
    hash: fn() -> (String, String),
}

macro_rules! program {
    ($m:ident, $id:literal) => {
        Program {
            id: $id,
            trace: |public, private| {
                let s = $m::analyze_smith(public, UntrustedAdvice::new(private));
                let cycles = s.trace_len();
                (s.io_device.outputs.clone(), s.io_device.panic, cycles)
            },
            hash: || {
                let config = bincode::config::standard();
                let mut program = $m::compile_smith(GUEST_TARGET);
                let shared = $m::preprocess_shared_smith(&mut program).unwrap();
                let prover_pp = $m::preprocess_prover_smith(shared);
                let verifier_pp = $m::verifier_preprocessing_from_prover_smith(&prover_pp);
                let verifier_bytes = bincode::serde::encode_to_vec(&verifier_pp, config).unwrap();
                (hex::encode(Sha256::digest(&verifier_bytes)), hex::encode(Sha256::digest(program.get_elf_contents().unwrap())))
            },
            prove: |public, private, out| {
                let config = bincode::config::standard();
                let t = Instant::now();
                let mut program = $m::compile_smith(GUEST_TARGET);
                let shared = $m::preprocess_shared_smith(&mut program).unwrap();
                let prover_pp = $m::preprocess_prover_smith(shared);
                let verifier_pp = $m::verifier_preprocessing_from_prover_smith(&prover_pp);
                let preprocess_s = t.elapsed().as_secs_f64();
                let elf = program.get_elf_contents().unwrap();
                let verifier_bytes = bincode::serde::encode_to_vec(&verifier_pp, config).unwrap();
                std::fs::create_dir_all(out).unwrap();
                std::fs::write(format!("{out}/guest.elf"), &elf).unwrap();
                std::fs::write(format!("{out}/verifier.bin"), &verifier_bytes).unwrap();
                let prove = $m::build_prover_smith(program, prover_pp);
                let verify = $m::build_verifier_smith(verifier_pp);
                let t = Instant::now();
                let (output, proof, io) = prove(public.clone(), UntrustedAdvice::new(private.clone()));
                let prove_s = t.elapsed().as_secs_f64();
                assert!(!io.panic, "the guest refused this vector, so there is nothing to prove");
                let proof_bytes = bincode::serde::encode_to_vec(&proof, config).unwrap();
                std::fs::write(format!("{out}/proof.bin"), &proof_bytes).unwrap();
                let check = |public: Vec<u8>, output: Commit| -> (bool, f64) {
                    let (proof, _): (RV64IMACProof, usize) = bincode::serde::decode_from_slice(&proof_bytes, config).unwrap();
                    let t = Instant::now();
                    let ok = catch_unwind(AssertUnwindSafe(|| verify(public, output, false, proof).is_ok())).unwrap_or(false);
                    (ok, t.elapsed().as_secs_f64() * 1000.0)
                };
                let (ok, verify_ms) = check(public.clone(), output.clone());
                assert!(ok, "the native verifier refused the honest proof");
                let mut refused = vec![];
                let mut tampered = |label: &str, p: Vec<u8>, o: Commit| {
                    let (ok, _) = check(p, o);
                    assert!(!ok, "a changed statement was ACCEPTED: {label}");
                    refused.push(label.to_string());
                };
                let mut o = output.clone();
                if let Some(b) = o.2.first_mut() { *b ^= 1 } else { o.2.push(0) }
                tampered("output: first byte changed", public.clone(), o);
                let mut o = output.clone();
                o.1[0] ^= 1;
                tampered("private commitment: one bit changed", public.clone(), o);
                let mut o = output.clone();
                o.0[31] ^= 1;
                tampered("spec hash: one bit changed", public.clone(), o);
                let mut p = public.clone();
                if let Some(b) = p.last_mut() { *b ^= 1 } else { p.push(0) }
                tampered("public input: last byte changed", p, output.clone());
                json!({
                    "program_hash": hex::encode(Sha256::digest(&verifier_bytes)),
                    "elf_sha256": hex::encode(Sha256::digest(&elf)),
                    "spec_hash": hex::encode(output.0),
                    "private_commitment": hex::encode(output.1),
                    "output_hex": hex::encode(&output.2),
                    "io_inputs_hex": hex::encode(&io.inputs),
                    "io_outputs_hex": hex::encode(&io.outputs),
                    "preprocess_s": preprocess_s, "prove_s": prove_s, "verify_ms": verify_ms,
                    "proof_bytes": proof_bytes.len(), "verifier_bytes": verifier_bytes.len(), "elf_bytes": elf.len(),
                    "refused": refused,
                    "threads": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
                })
            },
        }
    };
}

include!("programs.rs");


fn hexarg(v: &Value, k: &str) -> Vec<u8> {
    hex::decode(v[k].as_str().unwrap_or_else(|| panic!("{k} missing"))).unwrap_or_else(|_| panic!("{k} is not hex"))
}

fn find(id: &str) -> Program {
    programs().into_iter().find(|p| p.id == id).unwrap_or_else(|| {
        eprintln!("no program {id}");
        std::process::exit(2)
    })
}

/// Each vector traced in the guest (Jolt's RISC-V emulator): its output bytes, panic flag and
/// cycles. The model's code is never called natively here: scripts/smith.mjs runs the same
/// vectors in the wasm build of the body crate and compares.
fn cmd_check(id: &str, vectors: &str) -> bool {
    let p = find(id);
    let vs: Value = serde_json::from_slice(&std::fs::read(vectors).unwrap()).unwrap();
    let mut rows = vec![];
    for v in vs.as_array().unwrap() {
        let (public, private) = (hexarg(v, "public_hex"), hexarg(v, "private_hex"));
        let (guest_out, panic, cycles) = (p.trace)(public, private);
        rows.push(json!({ "label": v["label"], "guest_panic": panic, "guest_outputs": hex::encode(&guest_out), "cycles": cycles }));
    }
    println!("{}", json!({ "id": id, "rows": rows }));
    true
}

fn cmd_prove(id: &str, vector: &str, out: &str) {
    let p = find(id);
    let v: Value = serde_json::from_slice(&std::fs::read(vector).unwrap()).unwrap();
    let r = (p.prove)(hexarg(&v, "public_hex"), hexarg(&v, "private_hex"), out);
    std::fs::write(format!("{out}/native.json"), serde_json::to_string_pretty(&r).unwrap() + "\n").unwrap();
    println!("{r}");
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let ok = match a.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["check", id, vectors] => cmd_check(id, vectors),
        ["hash", id] => {
            let (program_hash, elf) = (find(id).hash)();
            println!("{}", json!({ "id": id, "program_hash": program_hash, "elf_sha256": elf }));
            true
        }
        ["prove", id, vector, out] => {
            cmd_prove(id, vector, out);
            true
        }
        _ => {
            eprintln!("usage: smith-host check <id> <vectors.json> | prove <id> <vector.json> <out-dir> | hash <id>");
            std::process::exit(2)
        }
    };
    std::process::exit(if ok { 0 } else { 1 });
}
