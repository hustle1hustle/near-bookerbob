//! Deterministic tier. Code maps proven fields to coarse predicates; a model cannot raise
//! a tier or add a predicate, because nothing here reads model output.
use serde::{Deserialize, Serialize};

/// One proven field from a zkTLS presentation. `proof_ref` is the hash of the presentation
/// it came from. In fixtures these are synthetic.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fact {
    pub id: String,
    pub platform: String,
    pub field: String,
    pub value: u64,
    pub proof_ref: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProofSet {
    pub facts: Vec<Fact>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    None,
    Silver,
    Gold,
}

impl Tier {
    pub fn as_str(&self) -> &'static str {
        match self {
            Tier::None => "none",
            Tier::Silver => "silver",
            Tier::Gold => "gold",
        }
    }
}

/// A derived predicate and the fact that proves it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Derived {
    pub predicate: String,
    pub fact_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TierResult {
    pub tier: Tier,
    /// Sorted by predicate, one entry per predicate.
    pub derived: Vec<Derived>,
}

impl TierResult {
    pub fn predicates(&self) -> Vec<String> {
        self.derived.iter().map(|d| d.predicate.clone()).collect()
    }
}

/// (platform, field, minimum value, predicate). The whole rule table, in `bookerbob-zkcore`.
pub use bookerbob_zkcore::referee::RULES;

/// Which predicate, if any, a single fact proves.
pub fn predicate_for(fact: &Fact) -> Option<&'static str> {
    bookerbob_zkcore::referee::predicate_for(&fact.platform, &fact.field, fact.value)
}

pub fn tier_for_count(n: usize) -> Tier {
    match n {
        0 => Tier::None,
        1 | 2 => Tier::Silver,
        _ => Tier::Gold,
    }
}

/// Derive predicates and tier from a proof set. The first fact (by id order in the set)
/// that proves a predicate is the one cited.
pub fn derive(set: &ProofSet) -> TierResult {
    let mut derived: Vec<Derived> = Vec::new();
    for fact in &set.facts {
        if let Some(pred) = predicate_for(fact) {
            if !derived.iter().any(|d| d.predicate == pred) {
                derived.push(Derived { predicate: pred.to_string(), fact_id: fact.id.clone() });
            }
        }
    }
    derived.sort_by(|a, b| a.predicate.cmp(&b.predicate));
    TierResult { tier: tier_for_count(derived.len()), derived }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fact(id: &str, platform: &str, field: &str, value: u64) -> Fact {
        Fact { id: id.into(), platform: platform.into(), field: field.into(), value, proof_ref: "00".repeat(32) }
    }

    #[test]
    fn below_threshold_fact_proves_nothing() {
        let set = ProofSet { facts: vec![fact("F1", "airbnb", "trips_12m", 2)] };
        let r = derive(&set);
        assert_eq!(r.tier, Tier::None);
        assert!(r.derived.is_empty());
    }

    #[test]
    fn three_predicates_make_gold_and_are_sorted() {
        let set = ProofSet {
            facts: vec![fact("F1", "uber", "trips_90d", 14), fact("F2", "airbnb", "trips_12m", 7), fact("F3", "anthropic", "monthly_spend_usd", 100)],
        };
        let r = derive(&set);
        assert_eq!(r.tier, Tier::Gold);
        assert_eq!(r.predicates(), vec!["airbnb_frequent", "claude_spender", "uber_regular"]);
        assert_eq!(r.derived[0].fact_id, "F2");
    }

    #[test]
    fn unknown_field_is_ignored() {
        let set = ProofSet { facts: vec![fact("F1", "marriott", "status", 99)] };
        assert!(derive(&set).derived.is_empty());
    }
}
