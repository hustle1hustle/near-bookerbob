//! The price stack: base price, per-predicate discounts capped, a group unlock on top.
//! Integer math, basis points, floor on the discount.
use alloc::string::String;
use alloc::vec::Vec;

pub const BPS_DENOM: u128 = 10_000;
pub const PRICE_TAG: &[u8] = b"bookerbob/price/v0\x00";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Schedule {
    pub base_price: u128,
    /// (predicate, bps), in schedule order.
    pub rules: Vec<(String, u16)>,
    pub cap_bps: u16,
    /// (predicate, k_min, bps).
    pub cohort: Option<(String, u32, u16)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Quote {
    /// (predicate, bps) of every rule the buyer's revealed predicates match.
    pub lines: Vec<(String, u16)>,
    /// (predicate, k, bps) when the group price is open.
    pub cohort: Option<(String, u32, u16)>,
    pub discount_bps: u16,
    pub price: u128,
}

/// `k(p)` = verdicts in this context that revealed `p` (the buyer's included).
pub fn quote_in_cohort(s: &Schedule, revealed: &[String], k: impl Fn(&str) -> u32) -> Quote {
    let lines: Vec<(String, u16)> = s.rules.iter().filter(|(p, _)| revealed.iter().any(|r| r == p)).cloned().collect();
    let sum: u32 = lines.iter().map(|(_, b)| *b as u32).sum();
    let cohort = s.cohort.as_ref().and_then(|(p, k_min, bps)| {
        let n = k(p);
        (revealed.iter().any(|r| r == p) && n >= *k_min).then(|| (p.clone(), n, *bps))
    });
    let capped = sum.min(s.cap_bps as u32);
    let discount_bps = (capped + cohort.as_ref().map_or(0, |c| c.2 as u32)).min(BPS_DENOM as u32) as u16;
    let price = s.base_price - s.base_price * discount_bps as u128 / BPS_DENOM;
    Quote { lines, cohort, discount_bps, price }
}

/// Canonical bytes of a quote's inputs (schedule, revealed predicates, cohort size for the
/// schedule's cohort predicate). Their hash binds a proven price to what it priced.
pub fn input_bytes(s: &Schedule, revealed: &[String], cohort_k: u32) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(&s.base_price.to_le_bytes());
    b.extend_from_slice(&(s.rules.len() as u32).to_le_bytes());
    for (p, bps) in &s.rules {
        crate::put_str(&mut b, p);
        b.extend_from_slice(&bps.to_le_bytes());
    }
    b.extend_from_slice(&s.cap_bps.to_le_bytes());
    match &s.cohort {
        None => b.push(0),
        Some((p, k_min, bps)) => {
            b.push(1);
            crate::put_str(&mut b, p);
            b.extend_from_slice(&k_min.to_le_bytes());
            b.extend_from_slice(&bps.to_le_bytes());
        }
    }
    b.extend_from_slice(&(revealed.len() as u32).to_le_bytes());
    for r in revealed {
        crate::put_str(&mut b, r);
    }
    b.extend_from_slice(&cohort_k.to_le_bytes());
    b
}

pub fn input_hash(s: &Schedule, revealed: &[String], cohort_k: u32) -> [u8; 32] {
    crate::sha256(&[PRICE_TAG, &input_bytes(s, revealed, cohort_k)])
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::ToString;
    use alloc::vec;

    fn s() -> Schedule {
        Schedule {
            base_price: 189_000_000,
            rules: vec![("airbnb_frequent".into(), 1200), ("world_id_human".into(), 800), ("claude_spender".into(), 900)],
            cap_bps: 2500,
            cohort: Some(("world_id_human".into(), 5, 500)),
        }
    }

    #[test]
    fn the_stack_is_capped_then_the_group_price_adds_on_top() {
        let all = ["airbnb_frequent", "world_id_human", "claude_spender"].map(|x| x.to_string());
        assert_eq!(quote_in_cohort(&s(), &all, |_| 1).discount_bps, 2500);
        let q = quote_in_cohort(&s(), &all, |_| 6);
        assert_eq!((q.discount_bps, q.price, q.cohort.map(|c| c.1)), (3000, 132_300_000, Some(6)));
    }

    #[test]
    fn the_input_hash_binds_every_input() {
        let r = ["airbnb_frequent".to_string()];
        let h = input_hash(&s(), &r, 6);
        assert_ne!(h, input_hash(&s(), &r, 5));
        let mut t = s();
        t.cap_bps = 2499;
        assert_ne!(h, input_hash(&t, &r, 6));
        assert_ne!(h, input_hash(&s(), &[], 6));
    }
}
