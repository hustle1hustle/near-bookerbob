//! Native side of the browser standing proofs.
//!   standing-host build <zk-input.json> <out-dir>      v1, the guest of zk/guests/standing at this pin
//!   standing-host build-v2 <zk-input.json> <out-dir>   v2 (standing-v2/), the bazaar's graph program; also
//!                                                      writes scores.json for submit_graph_scores
//! Reads a standing input the on-chain guest was proved on (fixtures/zk/standing-testnet-3-input.json:
//! events as byte arrays and the expected root and scores hash), writes statement.json, compiles
//! and preprocesses the guest at this folder's pin, proves, verifies, refuses changed statements,
//! and writes verifier.bin, proof.bin and native.json for agents/standing.html.
use decide_public::Standing;
use jolt_sdk::RV64IMACProof;
use serde_json::{json, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Instant;

fn guest_target() -> String {
    format!("{}/../target/guests", env!("CARGO_MANIFEST_DIR"))
}

fn statement(input: &str) -> Standing {
    let v: Value = serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
    let events: Vec<String> = v["events"].as_array().unwrap().iter().map(|e| hex::encode(e.as_array().unwrap().iter().map(|b| b.as_u64().unwrap() as u8).collect::<Vec<u8>>())).collect();
    Standing {
        note: "The live testnet standing graph: 10 events (6 hire edges, 4 seeds from paid sealed reviews), the log bookerbob.testnet's proven standing tree was built from; the same events zk/out/standing-live proves with the program registered on chain.".into(),
        events,
        root: v["expected"]["root"].as_str().unwrap().into(),
        scores_hash: v["expected"]["scores_hash"].as_str().unwrap().into(),
    }
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    match (a.first().map(String::as_str), a.len()) {
        (Some("build"), 3) => build_v1(&a[1], &a[2]),
        (Some("build-v2"), 3) => build_v2(&a[1], &a[2]),
        (Some("build-v3"), 3) => build_v3(&a[1], &a[2]),
        _ => {
            eprintln!("usage: standing-host build|build-v2|build-v3 <zk-input.json> <out-dir>");
            std::process::exit(2);
        }
    }
}

/// The v2 scores list for the submission (the bazaar's `submit_graph_scores` arguments), and
/// the program hash: sha256 of the verifier preprocessing the page and the check load.
fn write_scores(st: &Standing, out: &str, verifier_bytes: &[u8], compute: fn(&[bookerbob_graph::Event]) -> bookerbob_graph::Scores) {
    use sha2::{Digest, Sha256};
    let ev: Vec<bookerbob_graph::Event> = st.event_bytes().unwrap().iter().map(|b| bookerbob_graph::Event::from_bytes(b).unwrap()).collect();
    let s = compute(&ev);
    let scores = json!({
        "program_hash": hex::encode(Sha256::digest(verifier_bytes)),
        "root": hex::encode(s.root),
        "scores_hash": hex::encode(s.hash()),
        "merchants": s.merchants.iter().map(|(m, n, x)| json!([m, n, x])).collect::<Vec<_>>(),
        "standing": s.standing.iter().map(|(m, v)| json!([m, v.to_string()])).collect::<Vec<_>>(),
    });
    std::fs::write(format!("{out}/scores.json"), serde_json::to_string_pretty(&scores).unwrap() + "\n").unwrap();
}

macro_rules! build_fn {
    ($name:ident, $g:ident, $compute:path, $note:expr, $v2:expr) => {
        fn $name(input: &str, out: &str) {
            let mut st = statement(input);
            st.note = $note.into();
            let compute = $compute;
    std::fs::create_dir_all(out).unwrap();
    // The shared code gives the claimed output for these events.
    let ev: Vec<bookerbob_graph::Event> = st.event_bytes().unwrap().iter().map(|b| bookerbob_graph::Event::from_bytes(b).unwrap()).collect();
    let s = compute(&ev);
    if $v2 {
        // The input's expected hash is v1's; the v2 claim is what v2 computes over the same events.
        st.scores_hash = hex::encode(s.hash());
    }
    assert_eq!((s.root, s.hash()), st.claim().unwrap(), "the committed input's expected output is not what the shared code computes");
    std::fs::write(format!("{out}/statement.json"), serde_json::to_string_pretty(&st).unwrap() + "\n").unwrap();

    let t = Instant::now();
    let mut program = $g::compile_standing(&guest_target());
    let shared = $g::preprocess_shared_standing(&mut program).unwrap();
    let prover_pp = $g::preprocess_prover_standing(shared.clone());
    let verifier_pp = $g::verifier_preprocessing_from_prover_standing(&prover_pp);
    let preprocess_s = t.elapsed().as_secs_f64();
    let config = bincode::config::standard();
    let verifier_bytes = bincode::serde::encode_to_vec(&verifier_pp, config).unwrap();
    std::fs::write(format!("{out}/verifier.bin"), &verifier_bytes).unwrap();
    if $v2 {
        write_scores(&st, out, &verifier_bytes, compute);
    }
    // The guest ELF the preprocessing was made from, served next to it and pinned by sha256.
    std::fs::write(format!("{out}/guest.elf"), program.get_elf_contents().unwrap()).unwrap();

    let prove = $g::build_prover_standing(program, prover_pp);
    let verify = $g::build_verifier_standing(verifier_pp);
    let t = Instant::now();
    let (output, proof, io) = prove(st.event_bytes().unwrap());
    let prove_s = t.elapsed().as_secs_f64();
    assert!(!io.panic, "the guest panicked");
    assert_eq!(output, st.claim().unwrap());
    assert_eq!(io.inputs, st.inputs().unwrap(), "statement bytes differ from the guest's inputs");
    assert!(decide_public::same_output(&io.outputs, &st.outputs().unwrap()), "statement bytes differ from the guest's outputs");
    let proof_bytes = bincode::serde::encode_to_vec(&proof, config).unwrap();
    std::fs::write(format!("{out}/proof.bin"), &proof_bytes).unwrap();

    let check = |q: &Standing| -> bool {
        let (proof, _): (RV64IMACProof, usize) = bincode::serde::decode_from_slice(&proof_bytes, config).unwrap();
        let (Ok(ev), Ok(claim)) = (q.event_bytes(), q.claim()) else { return false };
        catch_unwind(AssertUnwindSafe(|| verify(ev, claim, false, proof).is_ok())).unwrap_or(false)
    };
    let t = Instant::now();
    assert!(check(&st), "the native verifier refused the honest proof");
    let verify_ms = t.elapsed().as_secs_f64() * 1000.0;
    let mut forged = st.clone();
    forged.events.push(hex::encode(bookerbob_graph::Event::Hire { agent: "m09.bookerbob.testnet".into(), sub: "m01.bookerbob.testnet".into() }.bytes()));
    assert!(!check(&forged), "a forged edge was ACCEPTED");
    let mut claim = st.clone();
    claim.root = format!("{}{}", if claim.root.starts_with('0') { '1' } else { '0' }, &claim.root[1..]);
    assert!(!check(&claim), "a changed root was ACCEPTED");
    let native = json!({ "prove_s": prove_s, "preprocess_s": preprocess_s, "verify_ms": verify_ms, "proof_bytes": proof_bytes.len(), "verifier_bin_bytes": verifier_bytes.len(), "events": st.events.len() });
    std::fs::write(format!("{out}/native.json"), serde_json::to_string_pretty(&native).unwrap() + "\n").unwrap();
    println!("{native}");
        }
    };
}

build_fn!(build_v1, guest, bookerbob_graph::compute, "The live testnet standing graph: 10 events (6 hire edges, 4 seeds from paid sealed reviews), the log bookerbob.testnet's proven standing tree was built from; the same events zk/out/standing-live proves with the program registered on chain.", false);
build_fn!(build_v2, guest_v2, bookerbob_standing_v2::compute, "The live testnet standing graph under standing v2 (every account ranked by its quality-weighted own seed plus the standing conferred on it); this program is the bazaar's graph program.", true);
build_fn!(build_v3, guest_v3, bookerbob_standing_v2::compute_v3, "The live testnet standing graph under standing v3 (accounts with their own reviews ranked by quality per rating; an unreviewed account enters only through the hire-edge fan-out, capped at 3.5 stars); this program is the bazaar's graph program.", true);
