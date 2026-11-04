//! BookerBob Jolt host: prove and verify the four guests.
//!
//!   cargo run --release -- prove  <guest> <input.json> <out-dir>
//!   cargo run --release -- verify <guest> <input.json> <out-dir>
//!
//! guests: standing, price, referee, cohort. Inputs are written by
//! `bookerbob zk-inputs fixtures` from the contract's own data (fixtures/zk/).
//! prove: compiles the guest, preprocesses, proves, verifies, writes the verifier
//! preprocessing, the proof and `result.json` (output, program hash, prove time, sizes).
//! verify: loads only the committed files (no guest compile), checks the proof against the
//! input and the claimed output, and checks the output against a native run of the same
//! shared code. Program hash = sha256 of the serialized verifier preprocessing (it commits
//! to the guest bytecode, and it is what a proof is verified against).
use std::path::Path;
use std::time::Instant;

use jolt_sdk::{JoltVerifierPreprocessing, RV64IMACProof, Serializable};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize)]
struct RunResult {
    guest: String,
    output: Value,
    program_hash: String,
    prove_seconds: f64,
    verify_ms: u128,
    proof_bytes: u64,
    verifier_preprocessing_bytes: u64,
    note: String,
}

fn load<T: DeserializeOwned>(p: &str) -> T {
    serde_json::from_str(&std::fs::read_to_string(p).unwrap_or_else(|e| panic!("read {p}: {e}"))).unwrap_or_else(|e| panic!("parse {p}: {e}"))
}

fn sha_file(p: &Path) -> String {
    hex::encode(Sha256::digest(std::fs::read(p).expect("read")))
}

fn write_result(out: &str, guest: &str, output: Value, prove_seconds: f64, verify_ms: u128) {
    let pp = Path::new(out).join("jolt_verifier_preprocessing.dat");
    let r = RunResult {
        guest: guest.into(),
        output,
        program_hash: sha_file(&pp),
        prove_seconds,
        verify_ms,
        proof_bytes: std::fs::metadata(Path::new(out).join("proof.bin")).unwrap().len(),
        verifier_preprocessing_bytes: std::fs::metadata(&pp).unwrap().len(),
        note: "peak RAM is measured outside, with /usr/bin/time -l (scripts/zk-prove.sh)".into(),
    };
    std::fs::write(Path::new(out).join("result.json"), serde_json::to_string_pretty(&r).unwrap() + "\n").expect("write result");
    println!("{guest}: proved in {prove_seconds:.2} s, verified in {verify_ms} ms, proof {} bytes", r.proof_bytes);
}

fn report(guest: &str, out: &str, proof_ok: bool, native_ok: bool, ms: u128) -> bool {
    let r: RunResult = load(&Path::new(out).join("result.json").to_string_lossy());
    let program_ok = sha_file(&Path::new(out).join("jolt_verifier_preprocessing.dat")) == r.program_hash;
    let line = |ok: bool, what: String| println!("{}  {what}", if ok { "PASS" } else { "FAIL" });
    line(program_ok, format!("{guest}: program hash is sha256 of the committed verifier preprocessing ({}..)", &r.program_hash[..16]));
    line(proof_ok, format!("{guest}: Jolt proof verifies for this input and the claimed output ({ms} ms)"));
    line(native_ok, format!("{guest}: the native run of the same shared code gives the same output"));
    program_ok && proof_ok && native_ok
}

/// prove_X / verify_X for one guest: `$m` guest crate, `$f` function name, the argument
/// list read from the input JSON, the output type, and a native recomputation.
macro_rules! guest {
    ($prove:ident, $verify:ident, $m:ident, $name:literal, $f:ident, ($($arg:ident: $ty:ty),*), $out:ty, $native:expr) => {
        fn $prove(input: &str, out: &str) {
            let v: Value = load(input);
            $(let $arg: $ty = serde_json::from_value(v[stringify!($arg)].clone()).expect(stringify!($arg));)*
            std::fs::create_dir_all(out).expect("out dir");
            let target_dir = "/tmp/bookerbob-jolt-guest-targets";
            let mut program = paste_fn!($m, compile, $f)(target_dir);
            let shared = paste_fn!($m, preprocess_shared, $f)(&mut program).expect("preprocess");
            let prover_pp = paste_fn!($m, preprocess_prover, $f)(shared.clone());
            let setup = prover_pp.generators.to_verifier_setup();
            let verifier_pp = paste_fn!($m, preprocess_verifier, $f)(shared, setup, None);
            verifier_pp.save_to_target_dir(out).expect("save verifier preprocessing");
            let prove_fn = paste_fn!($m, build_prover, $f)(program, prover_pp);
            let verify_fn = paste_fn!($m, build_verifier, $f)(verifier_pp);
            let t = Instant::now();
            let (output, proof, io) = prove_fn($($arg.clone()),*);
            let prove_seconds = t.elapsed().as_secs_f64();
            proof.save_to_file(Path::new(out).join("proof.bin")).expect("save proof");
            io.save_to_file(Path::new(out).join("io_device.bin")).expect("save io");
            let t = Instant::now();
            assert!(verify_fn($($arg.clone(),)* output.clone(), io.panic, proof), "fresh proof does not verify");
            write_result(out, $name, serde_json::to_value(&output).unwrap(), prove_seconds, t.elapsed().as_millis());
        }

        fn $verify(input: &str, out: &str) -> bool {
            let v: Value = load(input);
            $(let $arg: $ty = serde_json::from_value(v[stringify!($arg)].clone()).expect(stringify!($arg));)*
            let r: RunResult = load(&Path::new(out).join("result.json").to_string_lossy());
            let claimed: $out = serde_json::from_value(r.output.clone()).expect("output");
            let pp = JoltVerifierPreprocessing::read_from_target_dir(out).expect("read verifier preprocessing");
            let proof = RV64IMACProof::from_file(Path::new(out).join("proof.bin")).expect("read proof");
            let verify_fn = paste_fn!($m, build_verifier, $f)(pp);
            let t = Instant::now();
            let proof_ok = verify_fn($($arg.clone(),)* claimed.clone(), false, proof);
            let ms = t.elapsed().as_millis();
            let native: $out = ($native)($($arg),*);
            report($name, out, proof_ok, native == claimed, ms)
        }
    };
}

/// `paste_fn!(m, prefix, f)` -> `m::prefix_f`, spelled out per guest below.
macro_rules! paste_fn {
    (standing_guest, compile, standing) => { standing_guest::compile_standing };
    (standing_guest, preprocess_shared, standing) => { standing_guest::preprocess_shared_standing };
    (standing_guest, preprocess_prover, standing) => { standing_guest::preprocess_prover_standing };
    (standing_guest, preprocess_verifier, standing) => { standing_guest::preprocess_verifier_standing };
    (standing_guest, build_prover, standing) => { standing_guest::build_prover_standing };
    (standing_guest, build_verifier, standing) => { standing_guest::build_verifier_standing };
    (price_guest, compile, price) => { price_guest::compile_price };
    (price_guest, preprocess_shared, price) => { price_guest::preprocess_shared_price };
    (price_guest, preprocess_prover, price) => { price_guest::preprocess_prover_price };
    (price_guest, preprocess_verifier, price) => { price_guest::preprocess_verifier_price };
    (price_guest, build_prover, price) => { price_guest::build_prover_price };
    (price_guest, build_verifier, price) => { price_guest::build_verifier_price };
    (referee_guest, compile, referee) => { referee_guest::compile_referee };
    (referee_guest, preprocess_shared, referee) => { referee_guest::preprocess_shared_referee };
    (referee_guest, preprocess_prover, referee) => { referee_guest::preprocess_prover_referee };
    (referee_guest, preprocess_verifier, referee) => { referee_guest::preprocess_verifier_referee };
    (referee_guest, build_prover, referee) => { referee_guest::build_prover_referee };
    (referee_guest, build_verifier, referee) => { referee_guest::build_verifier_referee };
    (cohort_guest, compile, cohort) => { cohort_guest::compile_cohort };
    (cohort_guest, preprocess_shared, cohort) => { cohort_guest::preprocess_shared_cohort };
    (cohort_guest, preprocess_prover, cohort) => { cohort_guest::preprocess_prover_cohort };
    (cohort_guest, preprocess_verifier, cohort) => { cohort_guest::preprocess_verifier_cohort };
    (cohort_guest, build_prover, cohort) => { cohort_guest::build_prover_cohort };
    (cohort_guest, build_verifier, cohort) => { cohort_guest::build_verifier_cohort };
}

type Rules = Vec<(String, u16)>;
type CohortRule = Option<(String, u32, u16)>;
type Facts = Vec<(String, String, String, u64)>;
type Claims = Vec<(String, String, Vec<(String, String, u64)>)>;

guest!(prove_standing, verify_standing, standing_guest, "standing", standing, (events: Vec<Vec<u8>>), ([u8; 32], [u8; 32]), |events: Vec<Vec<u8>>| {
    let ev: Vec<bookerbob_graph::Event> = events.iter().map(|b| bookerbob_graph::Event::from_bytes(b).expect("event")).collect();
    let s = bookerbob_graph::compute(&ev);
    (s.root, s.hash())
});

guest!(prove_price, verify_price, price_guest, "price", price, (base_price: u128, rules: Rules, cap_bps: u16, cohort: CohortRule, revealed: Vec<String>, cohort_k: u32), (u128, u16, [u8; 32]),
    |base_price, rules, cap_bps, cohort, revealed: Vec<String>, cohort_k| {
        let s = bookerbob_zkcore::price::Schedule { base_price, rules, cap_bps, cohort };
        let q = bookerbob_zkcore::price::quote_in_cohort(&s, &revealed, |_| cohort_k);
        (q.price, q.discount_bps, bookerbob_zkcore::price::input_hash(&s, &revealed, cohort_k))
    });

guest!(prove_referee, verify_referee, referee_guest, "referee", referee, (facts: Facts, revealed: Vec<String>, lines: Vec<String>, cohort_line: Option<String>, claims: Claims), (bool, [u8; 32]),
    |facts: Facts, revealed: Vec<String>, lines: Vec<String>, cohort_line: Option<String>, claims: Claims| {
        use bookerbob_zkcore::referee::{check, input_hash, Citation, Claim, Fact};
        let f: Vec<Fact> = facts.into_iter().map(|(id, platform, field, value)| Fact { id, platform, field, value }).collect();
        let c: Vec<Claim> = claims.into_iter().map(|(line, text, x)| Claim { line, text, citations: x.into_iter().map(|(fact, field, value)| Citation { fact, field, value }).collect() }).collect();
        (check(&f, &revealed, &lines, cohort_line.as_deref(), &c).is_ok(), input_hash(&f, &revealed, &lines, cohort_line.as_deref(), &c))
    });

guest!(prove_cohort, verify_cohort, cohort_guest, "cohort", cohort, (context: String, predicate: String, nullifiers: Vec<String>), ([u8; 32], u32),
    |context: String, predicate: String, nullifiers: Vec<String>| {
        let r: Vec<&str> = nullifiers.iter().map(String::as_str).collect();
        bookerbob_zkcore::cohort::check(&context, &predicate, &r).expect("cohort")
    });

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let (cmd, guest, input, out) = match a.as_slice() {
        [c, g, i, o] => (c.as_str(), g.as_str(), i.as_str(), o.as_str()),
        _ => {
            eprintln!("usage: bookerbob-zk prove|verify standing|price|referee|cohort <input.json> <out-dir>");
            std::process::exit(2);
        }
    };
    let ok = match (cmd, guest) {
        ("prove", "standing") => { prove_standing(input, out); true }
        ("prove", "price") => { prove_price(input, out); true }
        ("prove", "referee") => { prove_referee(input, out); true }
        ("prove", "cohort") => { prove_cohort(input, out); true }
        ("verify", "standing") => verify_standing(input, out),
        ("verify", "price") => verify_price(input, out),
        ("verify", "referee") => verify_referee(input, out),
        ("verify", "cohort") => verify_cohort(input, out),
        _ => {
            eprintln!("unknown command or guest");
            std::process::exit(2);
        }
    };
    std::process::exit(if ok { 0 } else { 1 });
}
