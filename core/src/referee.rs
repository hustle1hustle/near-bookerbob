//! Referee: a deterministic claim checker. A model writes the "why" for each discount line
//! as structured claims: each citation names a fact and asserts its field and value. The
//! referee refuses the receipt if a cited fact is missing, the asserted field or value
//! differs from the proof, the fact does not prove the line, or the line was not revealed;
//! if the free text names an unproven status, a platform the claim does not prove, or a
//! number the claim does not assert; if any applied discount line has no claim; and if
//! two facts share an id. The text never earns a discount on its own: only proven,
//! asserted values do.
//! "The agent can lie. The receipt cannot."
use serde::{Deserialize, Serialize};

use crate::price::Quote;
use crate::tier::{predicate_for, ProofSet, RULES};

/// One cited fact and what the claim asserts about it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Citation {
    /// Fact id in the proof set, e.g. `F3`.
    pub fact: String,
    /// The proven field the claim relies on, e.g. `trips_12m`.
    pub field: String,
    /// The value the claim asserts for that field. Must equal the proven value.
    pub value: u64,
}

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

/// Status words no fact in this system can prove. Text that uses one is a claim the
/// receipt would launder, so it is refused.
pub const UNPROVEN_STATUS: &[&str] = &[
    "platinum",
    "diamond",
    "titanium",
    "gold",
    "silver",
    "elite",
    "vip",
    "ambassador",
    "superhost",
    "premier",
    "executive",
    "centurion",
    "marriott",
    "hilton",
    "hyatt",
    "ihg",
    "accor",
    "bonvoy",
    "amex",
    "loyalty",
];

/// Words that name a platform, and the predicate whose facts come from it.
const PLATFORM_WORDS: &[(&str, &str)] = &[
    ("airbnb", "airbnb_frequent"),
    ("booking", "booking_genius"),
    ("genius", "booking_genius"),
    ("anthropic", "claude_spender"),
    ("claude", "claude_spender"),
    ("steam", "steam_veteran"),
    ("uber", "uber_regular"),
    ("world", "world_id_human"),
];

fn words(text: &str) -> Vec<String> {
    text.to_lowercase().split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).map(String::from).collect()
}

/// Numbers that are part of a field name for this line, like the 12 in `trips_12m`.
fn window_numbers(line: &str) -> Vec<u64> {
    RULES.iter().filter(|r| r.3 == line).flat_map(|r| r.1.split(|c: char| !c.is_ascii_digit()).filter_map(|d| d.parse().ok()).collect::<Vec<u64>>()).collect()
}

fn check_text(c: &Claim) -> Option<String> {
    // Homoglyphs and zero-width characters would slip past the word checks.
    if !c.text.chars().all(|ch| ch == ' ' || ch.is_ascii_graphic()) {
        return Some("claim text must be plain ascii".into());
    }
    if c.text.len() > 280 {
        return Some("claim text over 280 characters".into());
    }
    let w = words(&c.text);
    if let Some(bad) = w.iter().find(|x| UNPROVEN_STATUS.contains(&x.as_str())) {
        return Some(format!("claim text names unproven status: {bad}"));
    }
    if let Some((word, _)) = PLATFORM_WORDS.iter().find(|(word, pred)| *pred != c.line && w.iter().any(|x| x == word)) {
        return Some(format!("claim text names {word}, which the {} claim does not prove", c.line));
    }
    let allowed: Vec<u64> = c.citations.iter().map(|x| x.value).chain(window_numbers(&c.line)).collect();
    if let Some(n) = w.iter().filter_map(|x| x.parse::<u64>().ok()).find(|n| !allowed.contains(n)) {
        return Some(format!("claim text states {n}, not an asserted value"));
    }
    None
}

pub fn referee(proofs: &ProofSet, revealed: &[String], quote: &Quote, claims: &[Claim]) -> RefereeOutcome {
    // A citation must name exactly one fact.
    for (i, f) in proofs.facts.iter().enumerate() {
        if proofs.facts[..i].iter().any(|g| g.id == f.id) {
            return refuse(format!("duplicate fact id {} in proof set", f.id));
        }
    }
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
        for cit in &c.citations {
            let Some(fact) = proofs.facts.iter().find(|f| f.id == cit.fact) else {
                return refuse(format!("{} not in proof set", cit.fact));
            };
            if fact.field != cit.field || fact.value != cit.value {
                return refuse(format!("{} asserted {}={}, proven {}={}", cit.fact, cit.field, cit.value, fact.field, fact.value));
            }
            if predicate_for(fact) != Some(c.line.as_str()) {
                return refuse(format!("{} does not prove {}", cit.fact, c.line));
            }
        }
        if let Some(reason) = check_text(c) {
            return refuse(reason);
        }
    }
    for line in &quote.lines {
        if !claims.iter().any(|c| c.line == line.predicate) {
            return refuse(format!("discount line {} has no cited claim", line.predicate));
        }
    }
    if let Some(c) = &quote.cohort {
        if !claims.iter().any(|cl| cl.line == c.predicate) {
            return refuse(format!("cohort line {} has no cited claim", c.predicate));
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
        let s = Schedule { base_price: 100, rules: vec![Rule { predicate: "airbnb_frequent".into(), bps: 1000 }], cap_bps: 2500, cohort: None };
        quote(&s, &["airbnb_frequent".into()])
    }

    fn cite(fact: &str, field: &str, value: u64) -> Citation {
        Citation { fact: fact.into(), field: field.into(), value }
    }

    fn claim(line: &str, text: &str, c: Citation) -> Claim {
        Claim { line: line.into(), text: text.into(), citations: vec![c] }
    }

    fn honest() -> Claim {
        claim("airbnb_frequent", "7 stays in 12 months", cite("F1", "trips_12m", 7))
    }

    fn refused(c: Claim) -> String {
        match referee(&proofs(), &["airbnb_frequent".into()], &q(), &[c]) {
            RefereeOutcome::Refused { reason } => reason,
            r => panic!("expected refusal, got {r:?}"),
        }
    }

    #[test]
    fn cited_claims_get_a_receipt() {
        assert!(referee(&proofs(), &["airbnb_frequent".into()], &q(), &[honest()]).is_receipt());
    }

    #[test]
    fn uncited_fact_refuses_receipt() {
        assert_eq!(refused(claim("airbnb_frequent", "guest is marriott platinum", cite("F9", "trips_12m", 7))), "F9 not in proof set");
    }

    #[test]
    fn fact_that_does_not_prove_the_line_is_refused() {
        assert_eq!(refused(claim("airbnb_frequent", "x", cite("F2", "trips_90d", 3))), "F2 does not prove airbnb_frequent");
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
        assert_eq!(refused(claim("marriott_platinum", "x", cite("F1", "trips_12m", 7))), "marriott_platinum is not a known predicate");
    }

    #[test]
    fn a_claim_without_citations_is_refused() {
        let c = Claim { line: "airbnb_frequent".into(), text: "trust me".into(), citations: vec![] };
        assert_eq!(refused(c), "claim for airbnb_frequent cites no fact");
    }

    #[test]
    fn a_fact_that_proves_a_different_line_is_refused() {
        // F3 really proves claude_spender; citing it for airbnb_frequent must fail.
        let p = ProofSet {
            facts: vec![
                Fact { id: "F1".into(), platform: "airbnb".into(), field: "trips_12m".into(), value: 7, proof_ref: "aa".repeat(32) },
                Fact { id: "F3".into(), platform: "anthropic".into(), field: "monthly_spend_usd".into(), value: 120, proof_ref: "bb".repeat(32) },
            ],
        };
        let c = claim("airbnb_frequent", "spends on claude", cite("F3", "monthly_spend_usd", 120));
        assert_eq!(referee(&p, &["airbnb_frequent".into()], &q(), &[c]), RefereeOutcome::Refused { reason: "F3 does not prove airbnb_frequent".into() });
    }

    #[test]
    fn a_real_fact_with_a_false_status_in_the_text_is_refused() {
        // The review's attack: a real citation, an invented status in the text.
        assert_eq!(refused(claim("airbnb_frequent", "guest is marriott platinum", cite("F1", "trips_12m", 7))), "claim text names unproven status: marriott");
    }

    #[test]
    fn an_inflated_value_is_refused() {
        assert_eq!(refused(claim("airbnb_frequent", "9 stays", cite("F1", "trips_12m", 9))), "F1 asserted trips_12m=9, proven trips_12m=7");
        assert_eq!(refused(claim("airbnb_frequent", "stays", cite("F1", "trips_90d", 7))), "F1 asserted trips_90d=7, proven trips_12m=7");
    }

    #[test]
    fn homoglyph_status_is_refused() {
        assert_eq!(refused(claim("airbnb_frequent", "guest is pl\u{0430}tinum", cite("F1", "trips_12m", 7))), "claim text must be plain ascii");
    }

    #[test]
    fn text_numbers_must_be_asserted() {
        assert_eq!(refused(claim("airbnb_frequent", "40 stays in 12 months", cite("F1", "trips_12m", 7))), "claim text states 40, not an asserted value");
    }

    #[test]
    fn text_naming_another_platform_is_refused() {
        assert_eq!(
            refused(claim("airbnb_frequent", "7 airbnb stays and an uber regular", cite("F1", "trips_12m", 7))),
            "claim text names uber, which the airbnb_frequent claim does not prove"
        );
    }
}
