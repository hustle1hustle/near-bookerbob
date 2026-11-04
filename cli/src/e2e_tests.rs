//! The judge-facing check suites, run in process on the committed fixtures: each one
//! must pass exactly as `make verify` runs it.
use std::path::{Path, PathBuf};
use std::process::ExitCode;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn ok(code: ExitCode) -> bool {
    code == ExitCode::SUCCESS
}

#[test]
fn the_26_chain_checks_pass_and_match_the_public_receipts() {
    let r = root();
    assert!(ok(crate::verify::run_with_receipts(&r.join("fixtures"), Some((&r.join("agents/receipts.json"), true)))));
}

#[test]
fn the_board_matches_the_contract_and_both_blind_rounds() {
    let r = root();
    assert!(ok(crate::swarm::run(&r.join("agents/merchants.json"), &r.join("fixtures/verdict-ed25519.json"), &r.join("agents/board.json"), true)));
}

#[test]
fn all_50_referee_evals_get_their_expected_outcome() {
    let r = root();
    assert!(ok(crate::evals::run(
        &r.join("fixtures/referee-evals.json"),
        &r.join("fixtures/proofs.json"),
        &r.join("fixtures/verdict-ed25519.json"),
        &r.join("agents/merchants.json")
    )));
}

#[test]
fn sealed_reviews_pass_end_to_end_and_match_the_page_data() {
    let r = root();
    assert!(ok(crate::reviews::run(&r.join("fixtures"), Some(&r.join("agents/reviews.json")), true)));
}

#[test]
fn the_near_ai_verdict_passes_all_offline_and_contract_checks() {
    let r = root();
    assert!(ok(crate::near_ai::run(&r.join("fixtures/live/near-ai"), &r.join("fixtures/proofs.json"))));
}

#[test]
fn fixtures_are_exactly_what_the_generator_produces() {
    for (name, body) in crate::fixtures::all() {
        assert_eq!(std::fs::read_to_string(root().join("fixtures").join(name)).unwrap(), body, "{name}");
    }
}

#[test]
fn evidence_measures_every_purchase_path_method() {
    let (rows, _) = crate::evidence::collect();
    assert!(rows.len() >= 15);
    assert!(rows.iter().any(|r| r.method.starts_with("submit_verdict") && r.storage_bytes > 0));
}

#[test]
fn one_scenario_chains_every_feature_on_one_chain() {
    assert!(ok(crate::scenario::run(&root().join("fixtures"))));
}

#[test]
fn the_jolt_guest_inputs_match_the_contract() {
    assert!(ok(crate::zk_inputs::run(&root().join("fixtures"), true)));
}
