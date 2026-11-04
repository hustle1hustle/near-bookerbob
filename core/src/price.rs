//! Deterministic price and discount stack. Integer math only, basis points, floor on the
//! discount (so rounding never favours the buyer beyond the schedule). Every perk is a
//! discount: a schedule cannot raise the price above `base_price`.
use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

pub const BPS_DENOM: u128 = 10_000;
/// Smallest cohort that unlocks a group price (k-anonymity floor).
pub const K_MIN: u32 = 5;
/// Largest base price (token base units): 10^30, far above any real price and far below
/// u128::MAX / BPS_DENOM, so `base * bps` cannot overflow in a quote (audit finding A7).
pub const MAX_BASE_PRICE: u128 = 1_000_000_000_000_000_000_000_000_000_000;

/// Group unlock: once `k_min` or more verdicts in the same context reveal `predicate`,
/// the merchant adds `bps` on top of its capped stack.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct CohortRule {
    pub predicate: String,
    pub k_min: u32,
    pub bps: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CohortLine {
    pub predicate: String,
    pub k: u32,
    pub bps: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Rule {
    pub predicate: String,
    pub bps: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Schedule {
    /// In token base units (USDC has 6 decimals).
    #[serde(with = "crate::u128_str")]
    pub base_price: u128,
    pub rules: Vec<Rule>,
    pub cap_bps: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cohort: Option<CohortRule>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscountLine {
    pub predicate: String,
    pub bps: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quote {
    #[serde(with = "crate::u128_str")]
    pub base_price: u128,
    /// Lines that matched a revealed predicate, in schedule order, before the cap.
    pub lines: Vec<DiscountLine>,
    /// Group unlock line, present only when the cohort is at or above `k_min`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cohort: Option<CohortLine>,
    /// Sum of line bps capped at `cap_bps`, plus the cohort bps when unlocked (at most 100%).
    pub discount_bps: u16,
    #[serde(with = "crate::u128_str")]
    pub price: u128,
}

impl Schedule {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.base_price == 0 {
            return Err("base price is zero");
        }
        if self.base_price > MAX_BASE_PRICE {
            return Err("base price too large");
        }
        if self.cap_bps as u128 > BPS_DENOM {
            return Err("cap over 100%");
        }
        if self.rules.len() > crate::KNOWN_PREDICATES.len() {
            return Err("too many rules");
        }
        for (i, r) in self.rules.iter().enumerate() {
            if !crate::is_known_predicate(&r.predicate) {
                return Err("unknown predicate in schedule");
            }
            if r.bps as u128 > BPS_DENOM {
                return Err("rule over 100%");
            }
            if self.rules[..i].iter().any(|o| o.predicate == r.predicate) {
                return Err("duplicate predicate in schedule");
            }
        }
        if let Some(c) = &self.cohort {
            if !crate::is_known_predicate(&c.predicate) {
                return Err("unknown predicate in cohort rule");
            }
            if c.k_min < K_MIN {
                return Err("cohort k_min below 5");
            }
            if c.bps as u128 > BPS_DENOM {
                return Err("cohort over 100%");
            }
        }
        Ok(())
    }
}

/// Price for a buyer who revealed `revealed` predicates, with no cohort.
pub fn quote(schedule: &Schedule, revealed: &[String]) -> Quote {
    quote_in_cohort(schedule, revealed, |_| 0)
}

/// Price with the group unlock: `cohort_size(p)` is how many verdicts in this context
/// revealed predicate `p` (the buyer's own included).
pub fn quote_in_cohort(schedule: &Schedule, revealed: &[String], cohort_size: impl Fn(&str) -> u32) -> Quote {
    let lines: Vec<DiscountLine> = schedule
        .rules
        .iter()
        .filter(|r| revealed.iter().any(|p| p == &r.predicate))
        .map(|r| DiscountLine { predicate: r.predicate.clone(), bps: r.bps })
        .collect();
    let sum: u32 = lines.iter().map(|l| l.bps as u32).sum();
    let cohort = schedule.cohort.as_ref().and_then(|c| {
        let k = cohort_size(&c.predicate);
        (revealed.iter().any(|p| p == &c.predicate) && k >= c.k_min).then(|| CohortLine { predicate: c.predicate.clone(), k, bps: c.bps })
    });
    let capped = sum.min(schedule.cap_bps as u32);
    let discount_bps = (capped + cohort.as_ref().map_or(0, |c| c.bps as u32)).min(BPS_DENOM as u32) as u16;
    let discount = schedule.base_price * discount_bps as u128 / BPS_DENOM;
    Quote { base_price: schedule.base_price, lines, cohort, discount_bps, price: schedule.base_price - discount }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sched() -> Schedule {
        // "base $189, -12% Airbnb Frequent, -8% World ID, cap 25%"
        Schedule {
            base_price: 189_000_000,
            rules: vec![
                Rule { predicate: "airbnb_frequent".into(), bps: 1200 },
                Rule { predicate: "world_id_human".into(), bps: 800 },
                Rule { predicate: "claude_spender".into(), bps: 900 },
            ],
            cap_bps: 2500,
            cohort: None,
        }
    }

    #[test]
    fn no_revealed_bits_pays_base() {
        let q = quote(&sched(), &[]);
        assert_eq!(q.price, 189_000_000);
        assert_eq!(q.discount_bps, 0);
    }

    #[test]
    fn stack_applies_each_matching_line() {
        let q = quote(&sched(), &["airbnb_frequent".into(), "world_id_human".into()]);
        assert_eq!(q.discount_bps, 2000);
        assert_eq!(q.price, 151_200_000);
        assert_eq!(q.lines.len(), 2);
    }

    #[test]
    fn stack_is_capped() {
        let all = ["airbnb_frequent", "world_id_human", "claude_spender"].map(String::from);
        let q = quote(&sched(), &all);
        assert_eq!(q.lines.iter().map(|l| l.bps).sum::<u16>(), 2900);
        assert_eq!(q.discount_bps, 2500);
        assert_eq!(q.price, 141_750_000);
    }

    #[test]
    fn a_base_price_that_could_overflow_the_quote_is_refused() {
        let mut s = sched();
        s.base_price = MAX_BASE_PRICE;
        assert!(s.validate().is_ok());
        assert_eq!(quote(&s, &["airbnb_frequent".into()]).discount_bps, 1200);
        s.base_price = u128::MAX / 1000;
        assert_eq!(s.validate(), Err("base price too large"));
    }

    #[test]
    fn discount_rounds_down() {
        let s = Schedule { base_price: 999, rules: vec![Rule { predicate: "uber_regular".into(), bps: 333 }], cap_bps: 10_000, cohort: None };
        // 999 * 333 / 10000 = 33.26 -> 33
        assert_eq!(quote(&s, &["uber_regular".into()]).price, 966);
    }

    #[test]
    fn invalid_schedules_are_rejected() {
        let mut s = sched();
        s.cap_bps = 10_001;
        assert_eq!(s.validate(), Err("cap over 100%"));
        let mut s = sched();
        s.rules.push(Rule { predicate: "marriott_platinum".into(), bps: 100 });
        assert_eq!(s.validate(), Err("unknown predicate in schedule"));
        let mut s = sched();
        s.rules.push(Rule { predicate: "airbnb_frequent".into(), bps: 100 });
        assert_eq!(s.validate(), Err("duplicate predicate in schedule"));
        assert!(sched().validate().is_ok());
        let mut s = sched();
        s.cohort = Some(CohortRule { predicate: "world_id_human".into(), k_min: 4, bps: 500 });
        assert_eq!(s.validate(), Err("cohort k_min below 5"));
    }

    fn cohort_sched() -> Schedule {
        let mut s = sched();
        s.cohort = Some(CohortRule { predicate: "world_id_human".into(), k_min: 5, bps: 500 });
        s
    }

    #[test]
    fn cohort_below_k_min_stays_locked() {
        let q = quote_in_cohort(&cohort_sched(), &["world_id_human".into()], |_| 4);
        assert_eq!(q.cohort, None);
        assert_eq!(q.discount_bps, 800);
    }

    #[test]
    fn group_unlock_opens_at_k6_on_top_of_the_cap() {
        let all = ["airbnb_frequent", "world_id_human", "claude_spender"].map(String::from);
        let q = quote_in_cohort(&cohort_sched(), &all, |p| if p == "world_id_human" { 6 } else { 0 });
        assert_eq!(q.cohort, Some(CohortLine { predicate: "world_id_human".into(), k: 6, bps: 500 }));
        assert_eq!(q.discount_bps, 3000);
        assert_eq!(q.price, 132_300_000);
    }

    #[test]
    fn cohort_needs_the_predicate_revealed() {
        let q = quote_in_cohort(&cohort_sched(), &["airbnb_frequent".into()], |_| 9);
        assert_eq!(q.cohort, None);
    }

    #[test]
    fn schedule_without_cohort_serializes_as_before() {
        let j = serde_json::to_string(&sched()).unwrap();
        assert!(!j.contains("cohort"));
    }
}
