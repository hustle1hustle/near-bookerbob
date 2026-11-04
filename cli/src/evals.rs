//! Referee evals: authored cases (honest bids and cheats) with expected verdicts.
use std::path::Path;
use std::process::ExitCode;

use bookerbob_core::{quote, referee, Claim, ProofSet, RefereeOutcome, SignedVerdict};
use serde::Deserialize;

use crate::swarm::SwarmMerchant;

#[derive(Deserialize)]
struct Case {
    name: String,
    merchant: String,
    claims: Vec<Claim>,
    expect: String,
    reason: Option<String>,
}

fn load<T: serde::de::DeserializeOwned>(p: &Path) -> T {
    serde_json::from_str(&std::fs::read_to_string(p).unwrap_or_else(|e| panic!("read {}: {e}", p.display())))
        .unwrap_or_else(|e| panic!("parse {}: {e}", p.display()))
}

pub fn run(evals: &Path, proofs: &Path, verdict: &Path, merchants: &Path) -> ExitCode {
    let cases: Vec<Case> = load(evals);
    let proofs: ProofSet = load(proofs);
    let verdict: SignedVerdict = load(verdict);
    let merchants: Vec<SwarmMerchant> = load(merchants);
    let revealed = &verdict.envelope.predicates;
    let mut failed = 0;
    for (i, c) in cases.iter().enumerate() {
        let m = merchants.iter().find(|m| m.account == c.merchant).expect("merchant in config");
        let q = quote(&m.schedule, revealed);
        let got = referee(&proofs, revealed, &q, &c.claims);
        let ok = match (&got, c.expect.as_str()) {
            (RefereeOutcome::Receipt { .. }, "receipt") => true,
            (RefereeOutcome::Refused { reason }, "refused") => Some(reason) == c.reason.as_ref(),
            _ => false,
        };
        let shown = match &got {
            RefereeOutcome::Receipt { .. } => "receipt".to_string(),
            RefereeOutcome::Refused { reason } => format!("refused: {reason}"),
        };
        println!("{}  eval {:02}  {}  ({shown})", if ok { "PASS" } else { "FAIL" }, i + 1, c.name);
        if !ok {
            failed += 1;
        }
    }
    let refusals = cases.iter().filter(|c| c.expect == "refused").count();
    if failed == 0 {
        println!("PASS  referee evals {}/{} ({} cheats refused, {} honest receipts)", cases.len(), cases.len(), refusals, cases.len() - refusals);
        ExitCode::SUCCESS
    } else {
        println!("FAIL  referee evals: {failed} of {} wrong", cases.len());
        ExitCode::FAILURE
    }
}
