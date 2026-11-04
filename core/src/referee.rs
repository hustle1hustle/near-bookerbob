//! Referee: a deterministic fact-citation checker. A model writes the "why" for each
//! discount line and must cite facts by id. The referee refuses the receipt if any cited
//! fact is missing from the proof set, does not prove the line, or the line was not
//! revealed, and if any applied discount line has no cited claim.
//! "The agent can lie. The receipt cannot."
use serde::{Deserialize, Serialize};

use crate::price::Quote;
use crate::tier::{predicate_for, ProofSet};

/// A fact id cited by a claim, e.g. `F3`.
pub type Citation = String;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claim {
    /// The discount line (predicate) this claim justifies.
    pub line: String,
    pub text: String,
    pub citations: Vec<Citation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum RefereeOutcome {
    Receipt { receipt_hash: String },
    Refused { reason: String },
}

impl RefereeOutcome {
    pub fn is_receipt(&self) -> bool {
        matches!(self, RefereeOutcome::Receipt { .. })
    }
}

fn refuse(reason: String) -> RefereeOutcome {
    RefereeOutcome::Refused { reason }
}

pub fn referee(proofs: &ProofSet, revealed: &[String], quote: &Quote, claims: &[Claim]) -> RefereeOutcome {
    for c in claims {
        if !crate::is_known_predicate(&c.line) {
            return refuse(format!("{} is not a known predicate", c.line));
        }
        if !revealed.iter().any(|p| p == &c.line) {
            return refuse(format!("{} not revealed", c.line));
        }
        if c.citations.is_empty() {
            return refuse(format!("claim for {} cites no fact", c.line));
        }
        for id in &c.citations {
            let Some(fact) = proofs.facts.iter().find(|f| &f.id == id) else {
                return refuse(format!("{id} not in proof set"));
            };
            if predicate_for(fact) != Some(c.line.as_str()) {
                return refuse(format!("{id} does not prove {}", c.line));
            }
        }
    }
    for line in &quote.lines {
        if !claims.iter().any(|c| c.line == line.predicate) {
            return refuse(format!("discount line {} has no cited claim", line.predicate));
        }
    }
    let body = serde_json::to_vec(&(quote, claims)).expect("serializes");
    RefereeOutcome::Receipt { receipt_hash: crate::sha256_hex(&body) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::price::{quote, Rule, Schedule};
    use crate::tier::Fact;

    fn proofs() -> ProofSet {
        ProofSet {
            facts: vec![
                Fact { id: "F1".into(), platform: "airbnb".into(), field: "trips_12m".into(), value: 7, proof_ref: "aa".repeat(32) },
                Fact { id: "F2".into(), platform: "uber".into(), field: "trips_90d".into(), value: 3, proof_ref: "bb".repeat(32) },
            ],
        }
    }

    fn q() -> Quote {
        let s = Schedule { base_price: 100, rules: vec![Rule { predicate: "airbnb_frequent".into(), bps: 1000 }], cap_bps: 2500 };
        quote(&s, &["airbnb_frequent".into()])
    }

    fn honest() -> Claim {
        Claim { line: "airbnb_frequent".into(), text: "7 stays in 12 months".into(), citations: vec!["F1".into()] }
    }

    #[test]
    fn cited_claims_get_a_receipt() {
        assert!(referee(&proofs(), &["airbnb_frequent".into()], &q(), &[honest()]).is_receipt());
    }

    #[test]
    fn uncited_fact_refuses_receipt() {
        let cheat = Claim { line: "airbnb_frequent".into(), text: "guest is marriott platinum".into(), citations: vec!["F9".into()] };
        assert_eq!(
            referee(&proofs(), &["airbnb_frequent".into()], &q(), &[cheat]),
            RefereeOutcome::Refused { reason: "F9 not in proof set".into() }
        );
    }

    #[test]
    fn fact_that_does_not_prove_the_line_is_refused() {
        let c = Claim { line: "airbnb_frequent".into(), text: "x".into(), citations: vec!["F2".into()] };
        let r = referee(&proofs(), &["airbnb_frequent".into()], &q(), &[c]);
        assert_eq!(r, RefereeOutcome::Refused { reason: "F2 does not prove airbnb_frequent".into() });
    }

    #[test]
    fn discount_line_without_claim_is_refused() {
        let r = referee(&proofs(), &["airbnb_frequent".into()], &q(), &[]);
        assert_eq!(r, RefereeOutcome::Refused { reason: "discount line airbnb_frequent has no cited claim".into() });
    }

    #[test]
    fn claim_on_unrevealed_line_is_refused() {
        let r = referee(&proofs(), &[], &q(), &[honest()]);
        assert_eq!(r, RefereeOutcome::Refused { reason: "airbnb_frequent not revealed".into() });
    }

    #[test]
    fn invented_status_is_refused() {
        let c = Claim { line: "marriott_platinum".into(), text: "x".into(), citations: vec!["F1".into()] };
        let r = referee(&proofs(), &["airbnb_frequent".into()], &q(), &[c]);
        assert_eq!(r, RefereeOutcome::Refused { reason: "marriott_platinum is not a known predicate".into() });
    }
}
