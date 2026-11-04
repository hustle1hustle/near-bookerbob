//! The standing graph, shared bit for bit by `bookerbob-core`, the `bazaar` contract and
//! the Jolt guest that proves it (`zk/`). no_std + alloc, sha256 only.
//!
//! - Events: `Hire { agent, sub }` (an agent hired a sub-agent) and `Seed { merchant,
//!   ratings, sum }` (a merchant's released review totals, cumulative; the last one wins).
//! - Root: a hash chain, `root' = sha256(TAG || root || event bytes)`, starting at 32 zero
//!   bytes. The contract extends it on every hire and every review release, so the root it
//!   holds commits to the whole graph in order.
//! - Standing: from each merchant's seed (`ratings x 10^6` micro-units), conserved
//!   transport along hire edges with damping w = 1/2, following a design rule in REP
//!   Labs' draft "(an unpublished REP draft)": a whole delegation chain gets
//!   at most w/(1-w) of the seed.
#![no_std]
extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use sha2::{Digest, Sha256};

pub const GRAPH_TAG: &[u8] = b"bookerbob/graph/v0\x00";
pub const SCORES_TAG: &[u8] = b"bookerbob/graph-scores/v0\x00";
pub const SEED_PER_RATING: u128 = 1_000_000;
pub const MAX_HOPS: usize = 24;
pub const MAX_VISITS: usize = 4096;
pub const PRIOR_WEIGHT: u64 = 5;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Hire { agent: String, sub: String },
    Seed { merchant: String, ratings: u64, sum: u64 },
}

impl Event {
    /// Canonical bytes: a kind byte, then length-prefixed fields.
    pub fn bytes(&self) -> Vec<u8> {
        let mut b = Vec::new();
        let s = |b: &mut Vec<u8>, x: &str| {
            b.extend_from_slice(&(x.len() as u32).to_le_bytes());
            b.extend_from_slice(x.as_bytes());
        };
        match self {
            Event::Hire { agent, sub } => {
                b.push(1);
                s(&mut b, agent);
                s(&mut b, sub);
            }
            Event::Seed { merchant, ratings, sum } => {
                b.push(2);
                s(&mut b, merchant);
                b.extend_from_slice(&ratings.to_le_bytes());
                b.extend_from_slice(&sum.to_le_bytes());
            }
        }
        b
    }
}

pub fn extend_root(root: &[u8; 32], e: &Event) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(GRAPH_TAG);
    h.update(root);
    h.update(e.bytes());
    h.finalize().into()
}

pub fn root_of(events: &[Event]) -> [u8; 32] {
    events.iter().fold([0u8; 32], |r, e| extend_root(&r, e))
}

/// Damping as num / den, 0 <= w < 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Damping {
    pub num: u128,
    pub den: u128,
}

pub const W_HALF: Damping = Damping { num: 1, den: 2 };

pub fn bound(seed: u128, w: Damping) -> u128 {
    seed * w.num / (w.den - w.num)
}

/// Standing each account receives from `root`'s seed (see the crate docs).
pub fn conferred<F, I>(root: &str, seed: u128, w: Damping, hires: F) -> BTreeMap<String, u128>
where
    F: Fn(&str) -> I,
    I: IntoIterator<Item = String>,
{
    assert!(w.num < w.den, "damping must be below 1");
    let mut got: BTreeMap<String, u128> = BTreeMap::new();
    let mut frontier: BTreeMap<String, u128> = BTreeMap::new();
    frontier.insert(root.to_string(), seed);
    let mut visits = 0usize;
    'hops: for _ in 0..MAX_HOPS {
        let mut next: BTreeMap<String, u128> = BTreeMap::new();
        for (node, mass) in &frontier {
            visits += 1;
            if visits > MAX_VISITS {
                break 'hops;
            }
            let kids: Vec<String> = hires(node).into_iter().collect();
            if kids.is_empty() || *mass == 0 {
                continue;
            }
            let share = mass * w.num / w.den / kids.len() as u128;
            if share == 0 {
                continue;
            }
            for k in kids {
                *next.entry(k.clone()).or_default() += share;
                *got.entry(k).or_default() += share;
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    got
}

/// What the graph computes: the root it was given, each merchant's score, and every
/// account's standing (micro-units), all in sorted order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scores {
    pub root: [u8; 32],
    /// (merchant, ratings, score x 100), score = (sum*100 + 5*300) / (ratings + 5).
    pub merchants: Vec<(String, u64, u64)>,
    /// (account, standing micro-units) from all merchants' seeds.
    pub standing: Vec<(String, u128)>,
}

impl Scores {
    /// Canonical bytes, hashed into the signed score update.
    pub fn bytes(&self) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&self.root);
        b.extend_from_slice(&(self.merchants.len() as u32).to_le_bytes());
        for (m, n, s) in &self.merchants {
            b.extend_from_slice(&(m.len() as u32).to_le_bytes());
            b.extend_from_slice(m.as_bytes());
            b.extend_from_slice(&n.to_le_bytes());
            b.extend_from_slice(&s.to_le_bytes());
        }
        b.extend_from_slice(&(self.standing.len() as u32).to_le_bytes());
        for (a, v) in &self.standing {
            b.extend_from_slice(&(a.len() as u32).to_le_bytes());
            b.extend_from_slice(a.as_bytes());
            b.extend_from_slice(&v.to_le_bytes());
        }
        b
    }

    pub fn hash(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(SCORES_TAG);
        h.update(self.bytes());
        h.finalize().into()
    }
}

/// The whole computation the guest proves.
pub fn compute(events: &[Event]) -> Scores {
    let mut hires: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut seeds: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    for e in events {
        match e {
            Event::Hire { agent, sub } => {
                let v = hires.entry(agent.clone()).or_default();
                if !v.contains(sub) {
                    v.push(sub.clone());
                }
            }
            Event::Seed { merchant, ratings, sum } => {
                seeds.insert(merchant.clone(), (*ratings, *sum));
            }
        }
    }
    let mut standing: BTreeMap<String, u128> = BTreeMap::new();
    let mut merchants = Vec::new();
    for (m, (n, sum)) in &seeds {
        merchants.push((m.clone(), *n, (sum * 100 + PRIOR_WEIGHT * 300) / (n + PRIOR_WEIGHT)));
        let got = conferred(m, *n as u128 * SEED_PER_RATING, W_HALF, |a: &str| hires.get(a).cloned().unwrap_or_default());
        for (a, v) in got {
            *standing.entry(a).or_default() += v;
        }
    }
    Scores { root: root_of(events), merchants, standing: standing.into_iter().collect() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn hire(a: &str, b: &str) -> Event {
        Event::Hire { agent: a.into(), sub: b.into() }
    }

    #[test]
    fn the_root_commits_to_every_event_in_order() {
        let a = vec![hire("m", "s1"), Event::Seed { merchant: "m".into(), ratings: 6, sum: 23 }];
        let mut b = a.clone();
        b.swap(0, 1);
        assert_ne!(root_of(&a), root_of(&b));
        assert_ne!(root_of(&a), root_of(&a[..1]));
        assert_eq!(root_of(&[]), [0u8; 32]);
    }

    #[test]
    fn scores_and_standing_follow_the_rule() {
        let ev = vec![Event::Seed { merchant: "m".into(), ratings: 6, sum: 23 }, hire("m", "s1"), hire("s1", "s2"), hire("s2", "s1")];
        let s = compute(&ev);
        assert_eq!(s.merchants, vec![("m".to_string(), 6, (2300 + 1500) / 11)]);
        let total: u128 = s.standing.iter().map(|x| x.1).sum();
        assert!(total <= bound(6 * SEED_PER_RATING, W_HALF));
        assert_eq!(s.root, root_of(&ev));
    }

    #[test]
    fn the_latest_seed_wins_and_the_hash_changes_with_any_score() {
        let ev = vec![Event::Seed { merchant: "m".into(), ratings: 1, sum: 5 }, Event::Seed { merchant: "m".into(), ratings: 6, sum: 23 }];
        let s = compute(&ev);
        assert_eq!(s.merchants[0].1, 6);
        let mut t = s.clone();
        t.merchants[0].2 += 1;
        assert_ne!(s.hash(), t.hash());
    }
}
