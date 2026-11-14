//! Standing v2: who ranks in the bazaar's `in_top` tree.
//!
//! v1 (`bookerbob_graph::compute`) ranks only merchants with released reviews, by their review
//! average shrunk toward 3 stars; the standing conferred along hire edges is proven alongside and
//! takes no part in the ranking. v2 keeps the same events, the same root and the same fan-out,
//! and changes only the list the tree is built from:
//!
//! - every account with an own seed or conferred standing gets a leaf;
//! - a seed counts only for the quality above neutral: ratings x one seed x max(shrunk average -
//!   3 stars, 0) / 2 stars, the analogue of EigenTrust's max(satisfied - unsatisfied, 0), with a
//!   no-show's 1-star review pulling the average down; a merchant at or under 3 stars has no own
//!   mass and confers none;
//! - an account whose own released reviews average 3 stars or under gets no leaf, whatever its
//!   hirers confer: its buyers' verdict outweighs anyone vouching for it;
//! - its score is that own mass plus everything other seeds conferred on it along hire edges
//!   (w = 1/2 per hop, at most one weighted seed's worth per seed in total), in units of 1/100 of
//!   a seed; mass a seed sends back to its own merchant around a ring does not count for it;
//! - an account that only hires, or is only hired by accounts with no seed upstream, has 0 and no
//!   leaf: a ring of fresh accounts hiring each other never enters the tree.
//!
//! The bazaar builds its tree from whatever list the proven scores hash covers
//! (`apply_graph_update`), so v2 needs a new Jolt program hash and no contract change.
#![no_std]
extern crate alloc;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;
pub use bookerbob_graph::{Event, Scores, PRIOR_WEIGHT, SEED_PER_RATING, W_HALF};

/// A leaf score's unit: 1/100 of one rating's seed.
pub const UNIT: u128 = SEED_PER_RATING / 100;

/// A seed's mass in v2: ratings x one seed x max(shrunk average - 3 stars, 0) / 2 stars.
pub fn weighted_seed(ratings: u64, shrunk_x100: u64) -> u128 {
    (ratings as u128) * SEED_PER_RATING * (shrunk_x100.saturating_sub(300) as u128) / 200
}

/// The v2 scores: v1's root and standing (unchanged, so the hash still covers them), and the
/// ranked list built from the events again. One change to the fan-out for ranking: mass that a
/// seed sends around a ring and back to its own merchant is not counted for that merchant, so
/// hiring a ring cannot raise the hirer's own rank.
pub fn compute(events: &[Event]) -> Scores {
    let v1 = bookerbob_graph::compute(events);
    let mut hires: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for e in events {
        if let Event::Hire { agent, sub } = e {
            let v = hires.entry(agent.clone()).or_default();
            if !v.contains(sub) {
                v.push(sub.clone());
            }
        }
    }
    let mut total: BTreeMap<String, (u64, u128)> = BTreeMap::new();
    for (m, n, shrunk_x100) in &v1.merchants {
        // Quality above neutral (3 stars = 300), out of the 2 stars above it: at most one seed per rating.
        let weighted = weighted_seed(*n, *shrunk_x100);
        total.entry(m.clone()).or_insert((0, 0)).0 = *n;
        total.get_mut(m).expect("inserted").1 += weighted;
        let got = bookerbob_graph::conferred(m, weighted, W_HALF, |a: &str| hires.get(a).cloned().unwrap_or_default());
        for (a, v) in got {
            if a != *m {
                total.entry(a).or_insert((0, 0)).1 += v;
            }
        }
    }
    // An account with its own released reviews at or under 3 stars gets no leaf, whatever its
    // hirers confer: its buyers' verdict outweighs anyone vouching for it (a hired no-show).
    for (m, _, shrunk_x100) in &v1.merchants {
        if *shrunk_x100 <= 300 {
            total.remove(m);
        }
    }
    let merchants: Vec<(String, u64, u64)> = total
        .into_iter()
        .filter(|(_, (_, t))| *t / UNIT > 0)
        .map(|(a, (n, t))| (a, n, u64::try_from(t / UNIT).unwrap_or(u64::MAX)))
        .collect();
    Scores { root: v1.root, merchants, standing: v1.standing }
}

/// v3's cap for an account with no reviews of its own: 3.5 stars (x100). A newcomer vouched for
/// along hire edges ranks at most like a 3.5-star merchant, so it gets in only at the margin.
pub const V3_ENTRY_CAP: u64 = 350;

/// Standing v3. Accounts with their own released reviews rank by quality per rating, exactly v1's
/// score (the review average shrunk toward 3 stars), so volume buys no rank. An account with no
/// reviews of its own enters only through the fan-out: 300 + 25 per weighted seed conferred on it
/// by other seeds (v2's weighting: only quality above 3 stars confers), capped at
/// `V3_ENTRY_CAP`. A ring with no seed upstream has no leaf. Same events and root as v1 and v2.
pub fn compute_v3(events: &[Event]) -> Scores {
    let v1 = bookerbob_graph::compute(events);
    let v2 = compute(events);
    let reviewed: BTreeMap<String, (u64, u64)> = v1.merchants.iter().map(|(m, n, s)| (m.clone(), (*n, *s))).collect();
    let mut merchants: Vec<(String, u64, u64)> = v1.merchants.clone();
    // v2's leaves for unreviewed accounts are exactly their conferred standing (they have no own mass).
    for (a, _, units) in &v2.merchants {
        if reviewed.contains_key(a) {
            continue;
        }
        let seeds_x100 = u128::from(*units); // units are 1/100 of a seed
        let lift = u64::try_from(seeds_x100 * 25 / 100).unwrap_or(u64::MAX);
        merchants.push((a.clone(), 0, (300 + lift).min(V3_ENTRY_CAP)));
    }
    merchants.sort();
    Scores { root: v1.root, merchants, standing: v1.standing }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::ToString;

    fn hire(a: &str, b: &str) -> Event {
        Event::Hire { agent: a.into(), sub: b.into() }
    }
    fn seed(m: &str, n: u64, sum: u64) -> Event {
        Event::Seed { merchant: m.into(), ratings: n, sum }
    }
    fn score(s: &Scores, a: &str) -> Option<u64> {
        s.merchants.iter().find(|(m, _, _)| m == a).map(|x| x.2)
    }

    #[test]
    fn self_returned_mass_does_not_count() {
        let s = compute(&[seed("m", 5, 25), hire("m", "a"), hire("a", "m")]);
        assert_eq!(score(&s, "m"), Some((weighted_seed(5, 400) / UNIT) as u64));
    }

    #[test]
    fn same_root_and_fan_out_as_v1() {
        let ev = [seed("m", 6, 30), hire("m", "a"), hire("a", "b")];
        let (v1, v2) = (bookerbob_graph::compute(&ev), compute(&ev));
        assert_eq!(v1.root, v2.root);
        assert_eq!(v1.standing, v2.standing);
    }

    #[test]
    fn a_hired_newcomer_gets_a_leaf_through_its_hirer() {
        let s = compute(&[seed("m", 6, 30), hire("m", "new")]);
        // m: 6 ratings, 5 stars each: shrunk (3000 + 1500) / 11 = 409; own 6 x (409 - 300) / 200 seeds.
        let own = weighted_seed(6, 409);
        assert_eq!(score(&s, "m"), Some((own / UNIT) as u64));
        // new: half of m's weighted seed.
        assert_eq!(score(&s, "new"), Some((own / 2 / UNIT) as u64));
    }

    #[test]
    fn a_ring_with_no_seed_upstream_has_no_leaf() {
        let s = compute(&[seed("m", 6, 30), hire("s1", "s2"), hire("s2", "s3"), hire("s3", "s1")]);
        for a in ["s1", "s2", "s3"] {
            assert_eq!(score(&s, a), None, "{a}");
        }
        assert_eq!(s.merchants.len(), 1);
    }

    #[test]
    fn hiring_a_ring_confers_at_most_one_seed_in_total() {
        let s = compute(&[seed("m", 4, 20), hire("m", "s1"), hire("s1", "s2"), hire("s2", "s3"), hire("s3", "s1")]);
        let ring: u64 = ["s1", "s2", "s3"].iter().filter_map(|a| score(&s, a)).sum();
        assert!(u128::from(ring) * UNIT <= weighted_seed(4, 388), "{ring}");
        assert!(ring > 0);
    }

    #[test]
    fn worse_reviews_rank_lower_at_the_same_count() {
        let s = compute(&[seed("good", 10, 50), seed("fair", 10, 38), seed("poor", 10, 15)]);
        assert!(score(&s, "good").unwrap() > score(&s, "fair").unwrap());
        assert_eq!(score(&s, "poor"), None, "under 3 stars: no own mass");
    }

    /// Cost of attack, on the live numbers. A review round releases only at 5 members and 5
    /// raters, each a buyer who proved its context and paid (the k-gate), so the cheapest seed is
    /// 5 paid purchases. The live m01 (12 ratings, 53 stars, shrunk 400) scores 600. A sybil with
    /// one round of 5 five-star reviews scores 250 and stays below, with the ring it hires; it
    /// crosses only at 10 five-star reviews (two released rounds, 10 real purchases from proven
    /// buyers), at 665. That is the price, stated in docs/coalitions.md.
    #[test]
    fn a_sybil_with_the_minimum_paid_reviews_stays_below_a_real_merchant() {
        let base = [seed("m01", 12, 53), hire("syb", "r1"), hire("r1", "r2"), hire("r2", "syb")];
        let at = |n: u64| {
            let mut ev = base.to_vec();
            ev.push(seed("syb", n, 5 * n));
            compute(&ev)
        };
        let s = at(5);
        let real = score(&s, "m01").unwrap();
        assert_eq!(real, 600);
        assert_eq!(score(&s, "syb"), Some(250), "the ring sends mass back to syb; v2 does not count it for syb");
        for a in ["syb", "r1", "r2"] {
            assert!(score(&s, a).unwrap_or(0) < real, "{a} {:?}", score(&s, a));
        }
        let first = (5..=20).find(|n| score(&at(*n), "syb").unwrap() > real).unwrap();
        assert_eq!(first, 10);
        assert_eq!(score(&at(10), "syb"), Some(665));
    }

    /// A merchant at 3 stars or under has no own mass and confers nothing: busy but unreliable
    /// agents (no-shows rated 1 star) do not climb by volume.
    #[test]
    fn volume_without_quality_ranks_nothing() {
        // 30 ratings averaging 3 stars, against 6 five-star ratings.
        let s = compute(&[seed("busy", 30, 90), seed("good", 6, 30), hire("busy", "friend")]);
        assert_eq!(score(&s, "busy"), None);
        assert_eq!(score(&s, "friend"), None);
        assert!(score(&s, "good").unwrap() > 0);
    }

    /// A hired agent with its own poor reviews: its hirer's standing does not carry it in.
    #[test]
    fn a_hired_no_show_with_poor_reviews_has_no_leaf() {
        let s = compute(&[seed("lead", 20, 100), hire("lead", "noshow"), seed("noshow", 5, 5), hire("lead", "fresh")]);
        assert_eq!(score(&s, "noshow"), None);
        assert!(score(&s, "fresh").unwrap() > 0, "a hired newcomer with no reviews still gets a leaf");
    }

    fn score3(s: &Scores, a: &str) -> Option<u64> {
        s.merchants.iter().find(|(m, _, _)| m == a).map(|x| x.2)
    }

    #[test]
    fn v3_reviewed_accounts_rank_by_quality_per_rating() {
        let s = compute_v3(&[seed("busy", 40, 152), seed("good", 4, 20)]);
        // busy: 3.8 average over 40; good: 5.0 over 4, shrunk (2000 + 1500) / 9 = 388.
        assert!(score3(&s, "good").unwrap() > 0);
        assert_eq!(score3(&s, "busy"), Some((15200 + 1500) / 45));
        assert!(score3(&s, "good").unwrap() > score3(&s, "busy").unwrap(), "volume buys no rank");
    }

    #[test]
    fn v3_a_vouched_newcomer_enters_capped_and_a_ring_does_not() {
        let s = compute_v3(&[seed("lead", 20, 100), hire("lead", "new"), hire("s1", "s2"), hire("s2", "s1")]);
        assert_eq!(score3(&s, "new"), Some(V3_ENTRY_CAP));
        assert_eq!(score3(&s, "s1"), None);
        assert!(score3(&s, "lead").unwrap() > V3_ENTRY_CAP);
    }

    #[test]
    fn v3_a_hired_account_with_its_own_reviews_keeps_its_review_score() {
        let s = compute_v3(&[seed("lead", 20, 100), hire("lead", "noshow"), seed("noshow", 5, 5)]);
        assert_eq!(score3(&s, "noshow"), Some((500 + 1500) / 10));
    }
}
