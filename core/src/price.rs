//! Deterministic price and discount stack. Integer math only, basis points, floor on the
//! discount (so rounding never favours the buyer beyond the schedule). Every perk is a
//! discount: a schedule cannot raise the price above `base_price`.
use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

pub const BPS_DENOM: u128 = 10_000;

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
    /// Sum of line bps, capped at `cap_bps`.
    pub discount_bps: u16,
    #[serde(with = "crate::u128_str")]
    pub price: u128,
}

impl Schedule {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.base_price == 0 {
            return Err("base price is zero");
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
        Ok(())
    }
}

/// Price for a buyer who revealed `revealed` predicates.
pub fn quote(schedule: &Schedule, revealed: &[String]) -> Quote {
    let lines: Vec<DiscountLine> = schedule
        .rules
        .iter()
        .filter(|r| revealed.iter().any(|p| p == &r.predicate))
        .map(|r| DiscountLine { predicate: r.predicate.clone(), bps: r.bps })
        .collect();
    let sum: u32 = lines.iter().map(|l| l.bps as u32).sum();
    let discount_bps = sum.min(schedule.cap_bps as u32) as u16;
    let discount = schedule.base_price * discount_bps as u128 / BPS_DENOM;
    Quote {
        base_price: schedule.base_price,
        lines,
        discount_bps,
        price: schedule.base_price - discount,
    }
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
    fn discount_rounds_down() {
        let s = Schedule { base_price: 999, rules: vec![Rule { predicate: "uber_regular".into(), bps: 333 }], cap_bps: 10_000 };
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
    }
}
