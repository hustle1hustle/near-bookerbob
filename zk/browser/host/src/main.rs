//! Native side of the browser prover.
//!   decide-host public <repo-root> <public.json>   the statement, from agents/board.json and agents/merchants.json
//!   decide-host build <public.json> <out-dir>      compile and preprocess the guest, prove, verify, refuse a changed
//!                                                  claim; writes guest.elf, prover.bin, verifier.bin,
//!                                                  sample-proof.bin and native.json
//!   decide-host verify <out-dir> <public.json>     verify sample-proof.bin against a statement; exit 1 when refused
use decide_public::{Cohort, Offer, Public, Rule};
use jolt_sdk::RV64IMACProof;
use serde_json::{json, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Instant;

const CATEGORY: &str = "hotel-lisbon";
/// The buyer's ask on the board: "3 nights Lisbon under 500" (agents/choose.mjs), in base units.
const BUDGET: u128 = 500_000_000;

fn guest_target() -> String {
    format!("{}/../target/guests", env!("CARGO_MANIFEST_DIR"))
}

fn mode() -> &'static str {
    if cfg!(feature = "zk") { "zk" } else { "transparent" }
}

fn read_json(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// The statement for the board's hotel round: offers in board order, each with the full
/// schedule its merchant registered, the buyer's revealed predicates and cohort size, and the
/// board's winner as the claim.
fn public_from_board(root: &str) -> Public {
    let board = read_json(&format!("{root}/agents/board.json"));
    let merchants = read_json(&format!("{root}/agents/merchants.json"));
    let cat = board["categories"].as_array().unwrap().iter().find(|c| c["category"] == CATEGORY).expect("category on the board");
    let s = |v: &Value| v.as_str().expect("string").to_string();
    let revealed: Vec<String> = board["disclosures"]
        .as_array()
        .and_then(|d| d.iter().find(|d| d["category"] == CATEGORY))
        .unwrap_or(&board["disclosure"])["plan"]
        .as_array()
        .expect("disclosure plan")
        .iter()
        .map(s)
        .collect();
    let offers = cat["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            let m = merchants.as_array().unwrap().iter().find(|m| m["account"] == row["merchant"]).expect("merchant of a board row");
            let sch = &m["schedule"];
            Offer {
                merchant: s(&row["merchant"]),
                base_price: s(&sch["base_price"]),
                rules: sch["rules"].as_array().unwrap().iter().map(|r| Rule { predicate: s(&r["predicate"]), bps: r["bps"].as_u64().unwrap() as u16 }).collect(),
                cap_bps: sch["cap_bps"].as_u64().unwrap() as u16,
                cohort: sch.get("cohort").filter(|c| !c.is_null()).map(|c| Cohort { predicate: s(&c["predicate"]), k_min: c["k_min"].as_u64().unwrap() as u32, bps: c["bps"].as_u64().unwrap() as u16 }),
            }
        })
        .collect();
    let winner = cat["rows"].as_array().unwrap().iter().find(|r| r["merchant"] == cat["winner"]).expect("winner row");
    Public {
        note: "public inputs of the decide proof: agents/board.json hotel-lisbon round, schedules from agents/merchants.json. amounts are dUSDC base units (6 decimals); dUSDC is a testnet demo token.".into(),
        budget: BUDGET.to_string(),
        revealed,
        cohort_k: board["buyer"]["cohort_k"].as_u64().expect("cohort_k") as u32,
        offers,
        choice: s(&cat["winner"]),
        price: s(&winner["price"]),
    }
}

fn run_guest(p: &Public) -> (String, u128) {
    guest::decide(p.budget().unwrap(), p.revealed.clone(), p.cohort_k, p.guest_offers().unwrap(), p.choice.clone(), p.price().unwrap())
}

fn cmd_public(root: &str, out: &str) {
    let p = public_from_board(root);
    let (merchant, price) = run_guest(&p);
    std::fs::write(out, serde_json::to_string_pretty(&p).unwrap() + "\n").unwrap();
    println!("public: {} offers, choice {merchant} at {price}, budget {}, inputs {} bytes", p.offers.len(), p.budget, p.inputs().unwrap().len());
}

fn changed(p: &Public, f: impl FnOnce(&mut Public)) -> Public {
    let mut q = p.clone();
    f(&mut q);
    q
}

fn bump(s: &str, by: i128) -> String {
    (s.parse::<i128>().unwrap() + by).to_string()
}

fn cmd_build(public: &str, out: &str) {
    let p = Public::from_json(&std::fs::read(public).unwrap()).unwrap();
    std::fs::create_dir_all(out).unwrap();
    let t = Instant::now();
    let mut program = guest::compile_decide(&guest_target());
    let shared = guest::preprocess_shared_decide(&mut program).unwrap();
    let prover_pp = guest::preprocess_prover_decide(shared.clone());
    let verifier_pp = guest::verifier_preprocessing_from_prover_decide(&prover_pp);
    let preprocess_s = t.elapsed().as_secs_f64();

    let args = |q: &Public| (q.budget().unwrap(), q.revealed.clone(), q.cohort_k, q.guest_offers().unwrap(), q.choice.clone(), q.price().unwrap());
    let a = args(&p);
    let cycles = guest::analyze_decide(a.0, a.1, a.2, a.3, a.4, a.5).trace.len();

    let config = bincode::config::standard();
    let elf = program.get_elf_contents().unwrap();
    let prover_bytes = bincode::serde::encode_to_vec(&prover_pp, config).unwrap();
    let verifier_bytes = bincode::serde::encode_to_vec(&verifier_pp, config).unwrap();
    std::fs::write(format!("{out}/guest.elf"), &elf).unwrap();
    std::fs::write(format!("{out}/prover.bin"), &prover_bytes).unwrap();
    std::fs::write(format!("{out}/verifier.bin"), &verifier_bytes).unwrap();

    let prove = guest::build_prover_decide(program, prover_pp);
    let verify = guest::build_verifier_decide(verifier_pp);
    let a = args(&p);
    let t = Instant::now();
    let (output, proof, io) = prove(a.0, a.1, a.2, a.3, a.4, a.5);
    let prove_s = t.elapsed().as_secs_f64();
    assert!(!io.panic, "the guest refused the statement");
    assert_eq!(output, (p.choice.clone(), p.price().unwrap()));
    assert_eq!(io.inputs, p.inputs().unwrap(), "public.json bytes differ from the guest's inputs");
    assert!(decide_public::same_output(&io.outputs, &p.outputs().unwrap()), "public.json bytes differ from the guest's outputs");
    let proof_bytes = bincode::serde::encode_to_vec(&proof, config).unwrap();
    std::fs::write(format!("{out}/sample-proof.bin"), &proof_bytes).unwrap();

    let check = |q: &Public| -> (bool, f64) {
        let (proof, _): (RV64IMACProof, usize) = bincode::serde::decode_from_slice(&proof_bytes, config).unwrap();
        let a = args(q);
        let out = (q.choice.clone(), q.price().unwrap());
        let t = Instant::now();
        let ok = catch_unwind(AssertUnwindSafe(|| verify(a.0, a.1, a.2, a.3, a.4, a.5, out, false, proof).is_ok())).unwrap_or(false);
        (ok, t.elapsed().as_secs_f64() * 1000.0)
    };
    let (ok, verify_ms) = check(&p);
    assert!(ok, "the native verifier refused the honest proof");
    let tampers: Vec<(&str, Public)> = vec![
        ("price + 1", changed(&p, |q| q.price = bump(&q.price, 1))),
        ("price - 1", changed(&p, |q| q.price = bump(&q.price, -1))),
        ("budget + 1", changed(&p, |q| q.budget = bump(&q.budget, 1))),
        ("budget - 1", changed(&p, |q| q.budget = bump(&q.budget, -1))),
        ("another merchant", changed(&p, |q| q.choice = q.offers[1].merchant.clone())),
        ("one base price + 1", changed(&p, |q| q.offers[0].base_price = bump(&q.offers[0].base_price, 1))),
    ];
    let mut refused = Vec::new();
    for (label, q) in &tampers {
        let (ok, _) = check(q);
        assert!(!ok, "a changed statement was ACCEPTED: {label}");
        println!("refused  {label}");
        refused.push(*label);
    }
    let native = json!({
        "mode": mode(), "cycles": cycles, "preprocess_s": preprocess_s, "prove_s": prove_s, "verify_ms": verify_ms,
        "proof_bytes": proof_bytes.len(), "guest_elf_bytes": elf.len(), "prover_bin_bytes": prover_bytes.len(),
        "verifier_bin_bytes": verifier_bytes.len(), "input_bytes": p.inputs().unwrap().len(), "refused": refused,
        "threads": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
    });
    std::fs::write(format!("{out}/native.json"), serde_json::to_string_pretty(&native).unwrap() + "\n").unwrap();
    println!("{native}");
}

fn cmd_verify(dir: &str, public: &str) {
    let p = Public::from_json(&std::fs::read(public).unwrap()).unwrap();
    let config = bincode::config::standard();
    let mut program = guest::compile_decide(&guest_target());
    let shared = guest::preprocess_shared_decide(&mut program).unwrap();
    let verifier_pp = guest::verifier_preprocessing_from_prover_decide(&guest::preprocess_prover_decide(shared));
    let bytes = std::fs::read(format!("{dir}/sample-proof.bin")).unwrap();
    let Ok((proof, _)) = bincode::serde::decode_from_slice::<RV64IMACProof, _>(&bytes, config) else {
        println!("valid=false (not a proof)");
        std::process::exit(1);
    };
    let verify = guest::build_verifier_decide(verifier_pp);
    let out = (p.choice.clone(), p.price().unwrap());
    let t = Instant::now();
    let ok = catch_unwind(AssertUnwindSafe(|| verify(p.budget().unwrap(), p.revealed.clone(), p.cohort_k, p.guest_offers().unwrap(), p.choice.clone(), p.price().unwrap(), out, false, proof).is_ok())).unwrap_or(false);
    println!("mode={} verify_ms={:.1} valid={ok}", mode(), t.elapsed().as_secs_f64() * 1000.0);
    std::process::exit(if ok { 0 } else { 1 });
}

pub fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    match (a.first().map(String::as_str), a.len()) {
        (Some("public"), 3) => cmd_public(&a[1], &a[2]),
        (Some("build"), 3) => cmd_build(&a[1], &a[2]),
        (Some("verify"), 3) => cmd_verify(&a[1], &a[2]),
        _ => {
            eprintln!("usage: decide-host public <repo-root> <public.json> | build <public.json> <out-dir> | verify <out-dir> <public.json>");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bookerbob_zkcore::price::{quote_in_cohort, Schedule};

    fn root() -> String {
        format!("{}/../../..", env!("CARGO_MANIFEST_DIR"))
    }

    /// Every hotel row on the board: the price this guest's rule gives equals the board's.
    #[test]
    fn guest_prices_equal_the_board_for_all_hotel_rows() {
        let p = public_from_board(&root());
        let board = read_json(&format!("{}/agents/board.json", root()));
        let cat = board["categories"].as_array().unwrap().iter().find(|c| c["category"] == CATEGORY).unwrap();
        let rows = cat["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 8);
        for (row, (merchant, base_price, rules, cap_bps, cohort)) in rows.iter().zip(p.guest_offers().unwrap()) {
            assert_eq!(row["merchant"], merchant.as_str());
            assert_eq!(row["base_price"], base_price.to_string().as_str());
            let q = quote_in_cohort(&Schedule { base_price, rules, cap_bps, cohort }, &p.revealed, |_| p.cohort_k);
            assert_eq!(row["price"], q.price.to_string().as_str(), "{merchant}");
            assert_eq!(row["discount_bps"], q.discount_bps);
        }
    }

    #[test]
    fn the_board_winner_holds() {
        let p = public_from_board(&root());
        assert_eq!(run_guest(&p), ("h05.bookerbob.testnet".to_string(), 408_000_000));
        assert_eq!(p.offers[0].base_price, "510000000");
    }

    fn refused(f: impl FnOnce(&mut Public)) {
        let p = changed(&public_from_board(&root()), f);
        assert!(catch_unwind(AssertUnwindSafe(|| run_guest(&p))).is_err());
    }

    #[test]
    fn the_guest_refuses_a_false_claim() {
        refused(|q| q.price = bump(&q.price, 1));
        refused(|q| q.price = bump(&q.price, -1));
        refused(|q| q.budget = "407999999".into());
        refused(|q| q.choice = "nobody.testnet".into());
        // A dearer offer at its true code price that still fits the budget.
        refused(|q| {
            q.choice = "h08.bookerbob.testnet".into();
            q.price = "488370000".into();
        });
        // The same merchant listed twice.
        refused(|q| q.offers.push(q.offers[0].clone()));
    }
}
