//! The buyer agent's disclosure policy. Deterministic, no model.
//!
//! - Merchants may ask; the agent answers by rule. Raw history and identity are always
//!   declined. A predicate is revealed only if it is proven and the budget allows it.
//! - `plan` picks which proven bits to reveal under a budget of `max_bits`: the lowest
//!   best price across merchants, then the fewest bits, then the first in sorted order.
//! - `per_bit` reports what each revealed bit saved: the best price without that bit minus
//!   the best price with the full set.
use serde::{Deserialize, Serialize};

use crate::price::{quote_in_cohort, Schedule};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Ask {
    /// "send me your booking history", "show the airbnb trips".
    RawHistory { platform: String },
    /// "who are you", email, wallet, name.
    Identity,
    /// "do you have booking_genius?"
    Predicate { predicate: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "answer", rename_all = "snake_case")]
pub enum Answer {
    Declined { reason: String },
    Revealed { predicate: String },
    AlreadyRevealed { predicate: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Policy {
    pub max_bits: usize,
}

pub fn answer(policy: &Policy, derived: &[String], revealed: &[String], ask: &Ask) -> Answer {
    let no = |r: String| Answer::Declined { reason: r };
    match ask {
        Ask::RawHistory { .. } => no("raw history never leaves the enclave".into()),
        Ask::Identity => no("identity is never disclosed".into()),
        Ask::Predicate { predicate } => {
            if revealed.contains(predicate) {
                Answer::AlreadyRevealed { predicate: predicate.clone() }
            } else if !derived.contains(predicate) {
                no(format!("{predicate} is not proven"))
            } else if revealed.len() >= policy.max_bits {
                no(format!("disclosure budget of {} bits is used", policy.max_bits))
            } else {
                Answer::Revealed { predicate: predicate.clone() }
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BitSaving {
    pub predicate: String,
    #[serde(with = "crate::u128_str")]
    pub saved: u128,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub revealed: Vec<String>,
    pub winner: String,
    #[serde(with = "crate::u128_str")]
    pub price: u128,
    pub per_bit: Vec<BitSaving>,
}

/// Best price for revealing `subset`. `others(p)` = verdicts from other buyers in this
/// context that revealed `p`; the buyer adds one for each bit it reveals.
pub fn best_price<'a>(merchants: &'a [(String, Schedule)], subset: &[String], others: &dyn Fn(&str) -> u32) -> Option<(&'a str, u128)> {
    let k = |p: &str| others(p) + subset.iter().any(|s| s == p) as u32;
    merchants.iter().map(|(id, s)| (id.as_str(), quote_in_cohort(s, subset, k).price)).fold(None, |best, (id, p)| match best {
        Some((_, bp)) if bp <= p => best,
        _ => Some((id, p)),
    })
}

pub fn plan(policy: &Policy, derived: &[String], merchants: &[(String, Schedule)], others: &dyn Fn(&str) -> u32) -> Option<Plan> {
    let mut derived: Vec<String> = derived.to_vec();
    derived.sort();
    derived.dedup();
    if derived.len() > 16 {
        return None;
    }
    let mut best: Option<(u128, Vec<String>, String)> = None;
    for mask in 0u32..(1 << derived.len()) {
        if mask.count_ones() as usize > policy.max_bits {
            continue;
        }
        let subset: Vec<String> = derived.iter().enumerate().filter(|(i, _)| mask & (1 << i) != 0).map(|(_, p)| p.clone()).collect();
        let Some((winner, price)) = best_price(merchants, &subset, others) else { continue };
        let better = match &best {
            None => true,
            Some((bp, bs, _)) => price < *bp || (price == *bp && (subset.len() < bs.len() || (subset.len() == bs.len() && subset < *bs))),
        };
        if better {
            best = Some((price, subset, winner.to_string()));
        }
    }
    let (price, revealed, winner) = best?;
    let per_bit = revealed
        .iter()
        .map(|p| {
            let without: Vec<String> = revealed.iter().filter(|q| *q != p).cloned().collect();
            let (_, price_without) = best_price(merchants, &without, others).expect("merchants exist");
            BitSaving { predicate: p.clone(), saved: price_without.saturating_sub(price) }
        })
        .collect();
    Some(Plan { revealed, winner, price, per_bit })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::price::{CohortRule, Rule};

    fn d(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn raw_history_request_is_declined() {
        let a = answer(&Policy { max_bits: 3 }, &d(&["airbnb_frequent"]), &[], &Ask::RawHistory { platform: "airbnb".into() });
        assert_eq!(a, Answer::Declined { reason: "raw history never leaves the enclave".into() });
    }

    #[test]
    fn identity_request_is_declined() {
        assert!(matches!(answer(&Policy { max_bits: 3 }, &[], &[], &Ask::Identity), Answer::Declined { .. }));
    }

    #[test]
    fn unproven_predicate_is_declined() {
        let a = answer(&Policy { max_bits: 3 }, &d(&["airbnb_frequent"]), &[], &Ask::Predicate { predicate: "steam_veteran".into() });
        assert_eq!(a, Answer::Declined { reason: "steam_veteran is not proven".into() });
    }

    #[test]
    fn ask_over_the_budget_is_declined() {
        let derived = d(&["airbnb_frequent", "booking_genius"]);
        let a = answer(&Policy { max_bits: 1 }, &derived, &d(&["airbnb_frequent"]), &Ask::Predicate { predicate: "booking_genius".into() });
        assert_eq!(a, Answer::Declined { reason: "disclosure budget of 1 bits is used".into() });
        let ok = answer(&Policy { max_bits: 2 }, &derived, &d(&["airbnb_frequent"]), &Ask::Predicate { predicate: "booking_genius".into() });
        assert_eq!(ok, Answer::Revealed { predicate: "booking_genius".into() });
    }

    fn merchants() -> Vec<(String, Schedule)> {
        vec![
            (
                "a".into(),
                Schedule {
                    base_price: 100,
                    rules: vec![Rule { predicate: "airbnb_frequent".into(), bps: 1000 }, Rule { predicate: "world_id_human".into(), bps: 1000 }],
                    cap_bps: 2000,
                    cohort: Some(CohortRule { predicate: "world_id_human".into(), k_min: 5, bps: 500 }),
                },
            ),
            ("b".into(), Schedule { base_price: 95, rules: vec![], cap_bps: 0, cohort: None }),
        ]
    }

    #[test]
    fn plan_respects_the_budget_and_prefers_fewer_bits() {
        let derived = d(&["airbnb_frequent", "booking_genius", "world_id_human"]);
        let zero = |_: &str| 0;
        // One bit: best is merchant b at 95 (a with one bit is 90).
        let p1 = plan(&Policy { max_bits: 1 }, &derived, &merchants(), &zero).unwrap();
        assert_eq!((p1.revealed.len(), p1.price), (1, 90));
        // Two bits: a at 80. booking_genius is never revealed: it saves nothing.
        let p2 = plan(&Policy { max_bits: 3 }, &derived, &merchants(), &zero).unwrap();
        assert_eq!(p2.revealed, d(&["airbnb_frequent", "world_id_human"]));
        assert_eq!(p2.price, 80);
    }

    #[test]
    fn cohort_counts_the_buyer_and_per_bit_savings_add_up() {
        let derived = d(&["airbnb_frequent", "world_id_human"]);
        let four = |p: &str| if p == "world_id_human" { 4 } else { 0 };
        let p = plan(&Policy { max_bits: 2 }, &derived, &merchants(), &four).unwrap();
        // 4 others + the buyer = 5: the group price opens, 25% off.
        assert_eq!(p.price, 75);
        assert_eq!(p.per_bit, vec![BitSaving { predicate: "airbnb_frequent".into(), saved: 10 }, BitSaving { predicate: "world_id_human".into(), saved: 15 },]);
        assert_eq!(p.winner, "a");
    }

    #[test]
    fn zero_budget_reveals_nothing() {
        let p = plan(&Policy { max_bits: 0 }, &d(&["airbnb_frequent"]), &merchants(), &|_| 0).unwrap();
        assert!(p.revealed.is_empty());
        assert_eq!((p.winner.as_str(), p.price), ("b", 95));
    }
}
