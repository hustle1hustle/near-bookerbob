//! `bookerbob coalition-sim --v2`: the coalition simulation with admission by standing v2,
//! pre-registered separately in docs/coalition-prereg-v2.md.
//!
//!   bookerbob coalition-sim --v2 --out <result-v2.json>    run the registered seeds, write the result
//!   bookerbob coalition-sim --v2 --check <result-v2.json>  re-run, compare, apply the v2 pass rule
//!   bookerbob coalition-sim --v2 --seed <n>                one seed, a summary on stdout
//!
//! This file sits beside `coalition_sim.rs` and leaves it byte for byte as it was: the registered
//! v1 result records that file's sha256. It reuses v1's population, jobs, history, singles arm and
//! admission rule (`proof.n == n && standing::in_top(root, GRAPH_CONTEXT, proof, 67)`), and adds:
//!
//! - newcomers: 3 per category with no reviews of their own; after each epoch a delivering lead
//!   gives each newcomer one trial job, and a delivered trial is logged as the lead's hire edge;
//! - one hired sybil (`sybil-hired`), outside the ring, hired once by an honest lead after the
//!   first epoch with a filled bundle; it never delivers;
//! - two coalition arms over the same market: admission by `bookerbob_graph::compute` (v1) and by
//!   `bookerbob_standing_v2::compute` (v2), the tree from `bookerbob_core::standing::graph`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::ExitCode;

use crate::coalition_sim::{self as v1, admit, history, jobs, population, Agent, CAPACITY, CATS, EPOCHS, SEEDS, STARS_DELIVERED, STARS_NO_SHOW, TOP_PCT};
use bookerbob_core::standing::{self, TopProof};
use bookerbob_graph::{root_of, Event, Scores};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

// ---------- frozen parameters (docs/coalition-prereg-v2.md, "Parameters") ----------

/// Newcomers per category; the first `NEWCOMERS_RELIABLE` are drawn from the reliable band.
pub const NEWCOMERS_PER_CAT: usize = 3;
pub const NEWCOMERS_RELIABLE: usize = 2;
/// The hired sybil's category (index into CATS) and the sybil price.
pub const HIRED_SYBIL_CAT: usize = 0;
pub const HIRED_SYBIL: &str = "sybil-hired.sim.testnet";
/// A trial job's delivery slot: never a buyer leg slot (those are below CAPACITY).
const TRIAL_SLOT: u32 = 1_000_000;
pub const PASS_MIN_SEEDS: usize = 18;
/// Failed legs per 100 bundles formed: v2's mean over the seeds may exceed v1's by at most this.
pub const FAILED_LEG_TOLERANCE: f64 = 1.0;
/// Fill rate: v2's mean over the seeds may fall below v1's by at most this.
pub const FILL_TOLERANCE: f64 = 0.01;
pub const PREREG: &str = "docs/coalition-prereg-v2.md";
pub const CODE_FILES: [&str; 4] = ["cli/src/coalition_sim_v2.rs", "cli/src/coalition_sim.rs", "standing-v2/src/lib.rs", "Cargo.lock"];

const BUYERS: &str = "buyers";
const ESCROW: &str = "bond-escrow";
pub const ARMS: [&str; 4] = ["singles_clean", "coalitions_v1", "coalitions_v2", "coalitions_v2_at_v1_count"];

/// One registered run: v2 (docs/coalition-prereg-v2.md) or v3 (docs/coalition-prereg-v3.md).
/// Same market, same mechanics; the rule under test and the file names differ.
pub struct Mode {
    pub tag: &'static str,
    pub prereg: &'static str,
    pub arms: [&'static str; 4],
    pub rules: [(Rule, Cut); 3],
    /// What each coalition arm is (recorded in `params.coalition_arms`).
    pub desc: [&'static str; 3],
    /// The fourth arm's name in the one-line summary.
    pub secondary: &'static str,
    /// The registered seeds (first, last).
    pub seeds: (u64, u64),
}

pub const V2: Mode = Mode {
    tag: "v2",
    prereg: PREREG,
    arms: ARMS,
    rules: [(Rule::V1, Cut::Pct(TOP_PCT)), (Rule::V2, Cut::Pct(TOP_PCT)), (Rule::V2, Cut::AtMost(V1_ADMITTED))],
    desc: ["v1, in_top at pct 67", "v2, in_top at pct 67", "v2, in_top at the largest pct that admits at most 25"],
    secondary: "v2 holding v1's admitted count",
    seeds: (1, 20),
};
pub const V3: Mode = Mode {
    tag: "v3",
    prereg: "docs/coalition-prereg-v3.md",
    arms: ["singles_clean", "coalitions_v1", "coalitions_v3", "coalitions_v3_at_v1_count"],
    rules: [(Rule::V1, Cut::Pct(TOP_PCT)), (Rule::V3, Cut::Pct(TOP_PCT)), (Rule::V3, Cut::AtMost(V1_ADMITTED))],
    desc: ["v1, in_top at pct 67", "v3, in_top at pct 67", "v3, in_top at the largest pct that admits at most 25"],
    secondary: "v3 holding v1's admitted count",
    seeds: (1, 20),
};
/// v4 (docs/coalition-prereg-v4.md): v3's ranking cut at v1's admitted count, on fresh seeds.
pub const V4: Mode = Mode {
    tag: "v4",
    prereg: "docs/coalition-prereg-v4.md",
    arms: ["singles_clean", "coalitions_v1", "coalitions_v4", "coalitions_v3_pct67"],
    rules: [(Rule::V1, Cut::Pct(TOP_PCT)), (Rule::V3, Cut::AtMost(V1_ADMITTED)), (Rule::V3, Cut::Pct(TOP_PCT))],
    desc: ["v1, in_top at pct 67", "v3 ranking, in_top at the largest pct that admits at most 25 (v1's admitted count)", "v3, in_top at pct 67"],
    secondary: "v3 at pct 67",
    seeds: (21, 40),
};

// ---------- the same draws as v1 ----------

fn h(parts: &[&[u8]]) -> [u8; 32] {
    // v1's hash domain, so honest agents' histories and deliveries equal the registered run's.
    let mut s = Sha256::new();
    s.update(b"bookerbob/coalition-sim/v1\x00");
    for p in parts {
        s.update((p.len() as u32).to_le_bytes());
        s.update(p);
    }
    s.finalize().into()
}

fn delivers(seed: u64, a: &Agent, epoch: usize, slot: u32) -> bool {
    let d = h(&[&seed.to_le_bytes(), b"deliver", a.id.as_bytes(), &(epoch as u64).to_le_bytes(), &slot.to_le_bytes()]);
    (u64::from_le_bytes(d[..8].try_into().unwrap()) % 1000) < a.rel
}

fn draw(seed: u64, label: &str, k: u64, (lo, hi): (u64, u64)) -> u64 {
    let d = h(&[&seed.to_le_bytes(), b"v2", label.as_bytes(), &k.to_le_bytes()]);
    lo + u64::from_le_bytes(d[..8].try_into().unwrap()) % (hi - lo + 1)
}

// ---------- population ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Honest,
    Newcomer,
    Ring,
    Hired,
}

/// v1's population (36 honest, 6 ring sybils), then 9 newcomers, then the hired sybil.
pub fn population_v2(seed: u64) -> (Vec<Agent>, Vec<Kind>) {
    let mut agents = population(seed);
    let mut kinds: Vec<Kind> = agents.iter().map(|a| if a.sybil { Kind::Ring } else { Kind::Honest }).collect();
    for (c, (name, base)) in CATS.iter().enumerate() {
        for j in 0..NEWCOMERS_PER_CAT {
            let id = format!("new-{name}{}.sim.testnet", j + 1);
            let unreliable = j >= NEWCOMERS_RELIABLE;
            let price = base * draw(seed, &id, 0, v1::PRICE_PERMILLE) / 1000;
            let rel = draw(seed, &id, 1, if unreliable { v1::UNRELIABLE_PERMILLE } else { v1::RELIABLE_PERMILLE });
            agents.push(Agent { id, cat: c, price, rel, sybil: false, unreliable });
            kinds.push(Kind::Newcomer);
        }
    }
    let base = CATS[HIRED_SYBIL_CAT].1;
    agents.push(Agent { id: HIRED_SYBIL.into(), cat: HIRED_SYBIL_CAT, price: base * v1::SYBIL_PRICE_PERMILLE / 1000, rel: 0, sybil: true, unreliable: true });
    kinds.push(Kind::Hired);
    (agents, kinds)
}

/// Honest agents' prior reviews as seeds (v1's), and the ring's fabricated edges (every ring
/// sybil hires every other). Newcomers and the hired sybil start with nothing.
pub fn initial_events(seed: u64, agents: &[Agent], kinds: &[Kind]) -> Vec<Event> {
    let mut ev: Vec<Event> = agents
        .iter()
        .zip(kinds)
        .filter(|(_, k)| **k == Kind::Honest)
        .map(|(a, _)| {
            let (ratings, sum) = history(seed, a);
            Event::Seed { merchant: a.id.clone(), ratings, sum }
        })
        .collect();
    let ring: Vec<&Agent> = agents.iter().zip(kinds).filter(|(_, k)| **k == Kind::Ring).map(|(a, _)| a).collect();
    for a in &ring {
        for b in ring.iter().filter(|b| b.id != a.id) {
            ev.push(Event::Hire { agent: a.id.clone(), sub: b.id.clone() });
        }
    }
    ev
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rule {
    V1,
    V2,
    V3,
}

pub fn scores(rule: Rule, events: &[Event]) -> Scores {
    match rule {
        Rule::V1 => bookerbob_graph::compute(events),
        Rule::V2 => bookerbob_standing_v2::compute(events),
        Rule::V3 => bookerbob_standing_v2::compute_v3(events),
    }
}

pub struct Admission {
    pub root: [u8; 32],
    pub n: u32,
    pub pct: u8,
    pub admitted: Vec<bool>,
    pub proofs: Vec<TopProof>,
    pub scores: Scores,
}

/// The admission cut: `in_top` at a fixed pct (v1's 67), or at the largest pct whose cut admits
/// at most `k` leaves (the coalition sets the pct per job; this holds the admitted count at v1's).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cut {
    Pct(u8),
    AtMost(u32),
}

/// The largest pct with rank cut `floor((pct * n + 99) / 100) <= k` (the `in_top` rule).
pub fn pct_for(n: u32, k: u32) -> u8 {
    (0..=100u8).rev().find(|&p| (p as u64 * n as u64 + 99) / 100 <= k as u64).unwrap_or(0)
}

pub fn admission(rule: Rule, cut: Cut, events: &[Event], agents: &[Agent]) -> Admission {
    let scores = scores(rule, events);
    let (root, proofs) = standing::graph(&scores.root, &scores.merchants);
    let n = proofs.len() as u32;
    let pct = match cut {
        Cut::Pct(p) => p,
        Cut::AtMost(k) => pct_for(n, k),
    };
    let admitted = agents.iter().map(|a| proofs.iter().find(|p| p.merchant == a.id).is_some_and(|p| admit(&root, n, p, pct))).collect();
    Admission { root, n, pct, admitted, proofs, scores }
}

/// A ring sybil with no leaf presents v1's three forgeries, the third built with the arm's rule.
fn forgeries(rule: Rule, events: &[Event], proofs: &[TopProof], ring: &[&Agent]) -> Vec<TopProof> {
    let mut out = Vec::new();
    let top = proofs.iter().find(|p| p.rank == 1).cloned();
    let bottom = proofs.iter().max_by_key(|p| p.rank).cloned();
    let mut forged = events.to_vec();
    for a in ring {
        forged.push(Event::Seed { merchant: a.id.clone(), ratings: 50, sum: 250 });
    }
    let fs = scores(rule, &forged);
    let (_, fp) = standing::graph(&fs.root, &fs.merchants);
    for a in ring {
        if let Some(mut p) = top.clone() {
            p.merchant = a.id.clone();
            out.push(p);
        }
        if let Some(mut p) = bottom.clone() {
            p.merchant = a.id.clone();
            p.rank = 1;
            out.push(p);
        }
        out.push(fp.iter().find(|p| p.merchant == a.id).expect("forged leaf").clone());
    }
    out
}

// ---------- metrics ----------

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub jobs: u64,
    pub unserved: u64,
    pub filled: u64,
    pub failed_bundles: u64,
    pub no_show_legs: u64,
    pub paid_filled: u64,
    pub paid_failed: u64,
    pub slashed: u64,
    pub admitted: u64,
    pub unreliable_admitted: u64,
    /// Newcomer-epochs admitted, all and reliable only.
    pub newcomers_admitted: u64,
    pub reliable_newcomers_admitted: u64,
    pub newcomer_legs: u64,
    pub newcomer_delivered_legs: u64,
    /// Trial jobs given to newcomers, delivered trials (each a hire edge, deduplicated in the graph).
    pub trials: u64,
    pub trials_delivered: u64,
    /// Ring sybils: forged proofs tried and admitted, ring members with a leaf, max v1 standing.
    pub ring_attempts: u64,
    pub ring_admissions: u64,
    pub ring_leaves: u64,
    pub ring_standing_max: u64,
    /// The hired sybil: epochs with a leaf, epochs admitted, legs, its v2 leaf score (max).
    pub hired_leaf: u64,
    pub hired_admitted: u64,
    pub hired_legs: u64,
    pub hired_score_max: u64,
    pub legs_to_sybils: u64,
    /// Legs taken by unreliable honest agents and unreliable newcomers (sybils excluded).
    pub unreliable_legs: u64,
}

macro_rules! fields {
    ($m:ident) => {
        $m!(jobs, unserved, filled, failed_bundles, no_show_legs, paid_filled, paid_failed, slashed, admitted, unreliable_admitted, newcomers_admitted, reliable_newcomers_admitted, newcomer_legs, newcomer_delivered_legs, trials, trials_delivered, ring_attempts, ring_admissions, ring_leaves, hired_leaf, hired_admitted, hired_legs, legs_to_sybils, unreliable_legs)
    };
}

impl Stats {
    fn add(&mut self, o: &Stats) {
        macro_rules! sum { ($($f:ident),*) => { $( self.$f += o.$f; )* } }
        fields!(sum);
        self.ring_standing_max = self.ring_standing_max.max(o.ring_standing_max);
        self.hired_score_max = self.hired_score_max.max(o.hired_score_max);
    }
    fn json(&self) -> Value {
        let mut m = serde_json::Map::new();
        macro_rules! put { ($($f:ident),*) => { $( m.insert(stringify!($f).into(), json!(self.$f)); )* } }
        fields!(put);
        m.insert("ring_standing_max".into(), json!(self.ring_standing_max));
        m.insert("hired_score_max".into(), json!(self.hired_score_max));
        Value::Object(m)
    }
    fn from_v1(s: &v1::Stats) -> Stats {
        Stats {
            jobs: s.jobs,
            unserved: s.unserved,
            filled: s.filled,
            failed_bundles: s.failed_bundles,
            no_show_legs: s.no_show_legs,
            paid_filled: s.paid_filled,
            paid_failed: s.paid_failed,
            slashed: s.slashed,
            legs_to_sybils: s.legs_to_sybils,
            ..Default::default()
        }
    }
    pub fn fill_rate(&self) -> f64 {
        self.filled as f64 / self.jobs.max(1) as f64
    }
    pub fn failed_legs_per_100(&self) -> f64 {
        100.0 * self.no_show_legs as f64 / (self.jobs - self.unserved).max(1) as f64
    }
    pub fn price_per_filled(&self) -> f64 {
        self.paid_filled as f64 / self.filled.max(1) as f64 / 1e6
    }
    pub fn loss_per_100(&self) -> f64 {
        (self.paid_failed as f64 - self.slashed as f64) / 1e6 * 100.0 / self.jobs.max(1) as f64
    }
}

pub fn total(v: &[Stats]) -> Stats {
    let mut t = Stats::default();
    for s in v {
        t.add(s);
    }
    t
}

// ---------- money ----------

/// Every transfer in a coalition arm; the sum is 0 (a unit test and `ledger_sum` in the result).
#[derive(Default, Debug)]
pub struct Ledger(pub BTreeMap<String, i128>);

impl Ledger {
    fn mv(&mut self, from: &str, to: &str, amt: u64) {
        *self.0.entry(from.to_string()).or_default() -= amt as i128;
        *self.0.entry(to.to_string()).or_default() += amt as i128;
    }
    pub fn sum(&self) -> i128 {
        self.0.values().sum()
    }
}

// ---------- the coalition arm ----------

pub struct ArmRun {
    pub stats: Vec<Stats>,
    pub events: Vec<Event>,
    /// Newcomers ever admitted (ids).
    pub newcomers_ever: BTreeSet<String>,
}

pub fn coalition_arm(seed: u64, agents: &[Agent], kinds: &[Kind], rule: Rule, cut: Cut, ledger: &mut Ledger) -> ArmRun {
    let mut events = initial_events(seed, agents, kinds);
    let mut ratings: BTreeMap<String, (u64, u64)> = agents.iter().zip(kinds).filter(|(_, k)| **k == Kind::Honest).map(|(a, _)| (a.id.clone(), history(seed, a))).collect();
    let mut edges: BTreeSet<(String, String)> = BTreeSet::new();
    let ring: Vec<&Agent> = agents.iter().zip(kinds).filter(|(_, k)| **k == Kind::Ring).map(|(a, _)| a).collect();
    let newcomers: Vec<usize> = (0..agents.len()).filter(|&i| kinds[i] == Kind::Newcomer).collect();
    let hired_ix = kinds.iter().position(|k| *k == Kind::Hired).expect("hired sybil");
    let mut sybil_hired = false;
    let mut newcomers_ever = BTreeSet::new();
    let mut out = Vec::new();
    for e in 0..EPOCHS {
        let mut s = Stats::default();
        let adm = admission(rule, cut, &events, agents);
        let leaf: BTreeMap<&str, u64> = adm.scores.merchants.iter().map(|(m, _, x)| (m.as_str(), *x)).collect();
        let standing: BTreeMap<&str, u128> = adm.scores.standing.iter().map(|(a, v)| (a.as_str(), *v)).collect();
        for (i, a) in agents.iter().enumerate() {
            if !adm.admitted[i] {
                continue;
            }
            s.admitted += 1;
            s.unreliable_admitted += (a.unreliable && kinds[i] != Kind::Ring && kinds[i] != Kind::Hired) as u64;
            if kinds[i] == Kind::Newcomer {
                s.newcomers_admitted += 1;
                s.reliable_newcomers_admitted += !a.unreliable as u64;
                newcomers_ever.insert(a.id.clone());
            }
        }
        // The ring: a member with no leaf presents forgeries; a member with a leaf presents it.
        let mut no_leaf = Vec::new();
        for (i, a) in agents.iter().enumerate().filter(|(i, _)| kinds[*i] == Kind::Ring) {
            if leaf.contains_key(a.id.as_str()) {
                s.ring_leaves += 1;
                s.ring_attempts += 1;
                s.ring_admissions += adm.admitted[i] as u64;
            } else {
                no_leaf.push(a);
            }
        }
        let _ = &ring;
        for p in forgeries(rule, &events, &adm.proofs, &no_leaf) {
            s.ring_attempts += 1;
            s.ring_admissions += admit(&adm.root, adm.n, &p, adm.pct) as u64;
        }
        s.ring_standing_max = ring.iter().map(|a| standing.get(a.id.as_str()).copied().unwrap_or(0) as u64).max().unwrap_or(0);
        s.hired_leaf = leaf.contains_key(HIRED_SYBIL) as u64;
        s.hired_admitted = adm.admitted[hired_ix] as u64;
        s.hired_score_max = leaf.get(HIRED_SYBIL).copied().unwrap_or(0);

        let mut used = vec![0u32; agents.len()];
        let mut reviews: BTreeMap<String, (u64, u64)> = BTreeMap::new();
        let mut new_edges: Vec<(String, String)> = Vec::new();
        let mut leads: Vec<usize> = Vec::new();
        for budget in jobs(seed, e) {
            s.jobs += 1;
            let legs: Option<Vec<usize>> = (0..CATS.len())
                .map(|c| (0..agents.len()).filter(|&i| agents[i].cat == c && used[i] < CAPACITY && adm.admitted[i]).min_by(|&a, &b| (agents[a].price, &agents[a].id).cmp(&(agents[b].price, &agents[b].id))))
                .collect();
            let Some(legs) = legs.filter(|l| l.iter().map(|&i| price(agents[i].price)).sum::<u64>() <= budget) else {
                s.unserved += 1;
                continue;
            };
            let (mut paid, mut sum, mut all) = (0u64, 0u64, true);
            for &i in &legs {
                let a = &agents[i];
                let (p, b) = (price(a.price), bond(a.price));
                sum += p;
                used[i] += 1;
                s.legs_to_sybils += a.sybil as u64;
                s.hired_legs += (kinds[i] == Kind::Hired) as u64;
                s.newcomer_legs += (kinds[i] == Kind::Newcomer) as u64;
                s.unreliable_legs += (a.unreliable && !a.sybil) as u64;
                ledger.mv(&a.id, ESCROW, b);
                let r = reviews.entry(a.id.clone()).or_default();
                r.0 += 1;
                if delivers(seed, a, e, used[i] - 1) {
                    ledger.mv(BUYERS, &a.id, p);
                    ledger.mv(ESCROW, &a.id, b);
                    paid += p;
                    r.1 += STARS_DELIVERED;
                    s.newcomer_delivered_legs += (kinds[i] == Kind::Newcomer) as u64;
                } else {
                    ledger.mv(ESCROW, BUYERS, b);
                    s.slashed += b;
                    s.no_show_legs += 1;
                    all = false;
                    r.1 += STARS_NO_SHOW;
                }
            }
            if all {
                s.filled += 1;
                s.paid_filled += sum;
                let lead = legs[0];
                for &i in &legs[1..] {
                    new_edges.push((agents[lead].id.clone(), agents[i].id.clone()));
                }
                if !leads.contains(&lead) {
                    leads.push(lead);
                }
            } else {
                s.failed_bundles += 1;
                s.paid_failed += paid;
            }
        }
        // Epoch close. The hired sybil: the first delivering lead of the first epoch with one.
        if !sybil_hired {
            if let Some(&lead) = leads.first() {
                new_edges.push((agents[lead].id.clone(), HIRED_SYBIL.into()));
                sybil_hired = true;
            }
        }
        // Newcomer trials: newcomer j gets one trial job from delivering lead (j + e) mod L; a
        // delivered trial is logged as the lead's hire edge.
        if !leads.is_empty() {
            for (j, &ni) in newcomers.iter().enumerate() {
                let lead = leads[(j + e) % leads.len()];
                if lead == ni {
                    continue;
                }
                s.trials += 1;
                if delivers(seed, &agents[ni], e, TRIAL_SLOT) {
                    s.trials_delivered += 1;
                    new_edges.push((agents[lead].id.clone(), agents[ni].id.clone()));
                }
            }
        }
        for ed in new_edges {
            if edges.insert(ed.clone()) {
                events.push(Event::Hire { agent: ed.0, sub: ed.1 });
            }
        }
        for (m, (n, sum)) in reviews {
            let r = ratings.entry(m.clone()).or_insert((0, 0));
            r.0 += n;
            r.1 += sum;
            events.push(Event::Seed { merchant: m, ratings: r.0, sum: r.1 });
        }
        out.push(s);
    }
    ArmRun { stats: out, events, newcomers_ever }
}

fn price(p: u64) -> u64 {
    p + p * v1::BOND_BPS / 10_000 * v1::CARRY_BPS / 10_000
}

fn bond(p: u64) -> u64 {
    p * v1::BOND_BPS / 10_000
}

// ---------- the run ----------

pub struct SeedRun {
    pub seed: u64,
    /// singles_clean, then the coalition arms in `ARMS[1..]` order.
    pub arms: [Vec<Stats>; 4],
    /// Per coalition arm (`ARMS[1..]`): newcomers ever admitted, reliable ones, graph root, ledger sum.
    pub newcomers_ever: [usize; 3],
    pub reliable_newcomers_ever: [usize; 3],
    pub roots: [[u8; 32]; 3],
    pub ledger_sums: [i128; 3],
}

/// v1 admits 25 of 36 at pct 67 in every registered epoch state (docs/coalitions.md).
pub const V1_ADMITTED: u32 = 25;

pub fn run_seed(m: &Mode, seed: u64) -> SeedRun {
    let (agents, kinds) = population_v2(seed);
    let clean: Vec<Stats> = v1::singles(seed, &agents, false).iter().map(Stats::from_v1).collect();
    let reliable = |set: &BTreeSet<String>| set.iter().filter(|id| agents.iter().any(|a| &a.id == *id && !a.unreliable)).count();
    let mut r = SeedRun { seed, arms: [clean, vec![], vec![], vec![]], newcomers_ever: [0; 3], reliable_newcomers_ever: [0; 3], roots: [[0; 32]; 3], ledger_sums: [0; 3] };
    for (k, (rule, cut)) in m.rules.iter().enumerate() {
        let mut l = Ledger::default();
        let a = coalition_arm(seed, &agents, &kinds, *rule, *cut, &mut l);
        r.newcomers_ever[k] = a.newcomers_ever.len();
        r.reliable_newcomers_ever[k] = reliable(&a.newcomers_ever);
        r.roots[k] = root_of(&a.events);
        r.ledger_sums[k] = l.sum();
        r.arms[k + 1] = a.stats;
    }
    r
}

fn r4(x: f64) -> f64 {
    (x * 10_000.0).round() / 10_000.0
}

fn spread(xs: &[f64]) -> Value {
    let n = xs.len() as f64;
    let mean = xs.iter().sum::<f64>() / n;
    let sd = (xs.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / (n - 1.0).max(1.0)).sqrt();
    let min = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    json!({ "mean": r4(mean), "sd": r4(sd), "min": r4(min), "max": r4(max) })
}

fn mean(xs: impl Iterator<Item = f64>) -> f64 {
    let v: Vec<f64> = xs.collect();
    v.iter().sum::<f64>() / v.len().max(1) as f64
}

/// The v2 pass rule (docs/coalition-prereg-v2.md, "Pass rule").
#[derive(Debug)]
pub struct Verdict {
    pub newcomer_wins: usize,
    pub failed_v1: f64,
    pub failed_v2: f64,
    pub fill_v1: f64,
    pub fill_v2: f64,
    pub ring_admissions: u64,
    pub ring_leaves: u64,
    pub ring_standing_max: u64,
}

impl Verdict {
    pub fn pass(&self) -> bool {
        self.newcomer_wins >= PASS_MIN_SEEDS
            && r4(self.failed_v2) <= r4(self.failed_v1 + FAILED_LEG_TOLERANCE)
            && r4(self.fill_v2) >= r4(self.fill_v1 - FILL_TOLERANCE)
            && self.ring_admissions == 0
            && self.ring_leaves == 0
            && self.ring_standing_max == 0
    }
}

pub fn verdict(runs: &[SeedRun]) -> Verdict {
    let t = |r: &SeedRun, k: usize| total(&r.arms[k]);
    let mut v = Verdict {
        newcomer_wins: runs.iter().filter(|r| r.reliable_newcomers_ever[1] > r.reliable_newcomers_ever[0]).count(),
        failed_v1: mean(runs.iter().map(|r| t(r, 1).failed_legs_per_100())),
        failed_v2: mean(runs.iter().map(|r| t(r, 2).failed_legs_per_100())),
        fill_v1: mean(runs.iter().map(|r| t(r, 1).fill_rate())),
        fill_v2: mean(runs.iter().map(|r| t(r, 2).fill_rate())),
        ring_admissions: 0,
        ring_leaves: 0,
        ring_standing_max: 0,
    };
    for r in runs {
        for k in 1..ARMS.len() {
            let x = t(r, k);
            v.ring_admissions += x.ring_admissions;
            v.ring_leaves += x.ring_leaves;
            v.ring_standing_max = v.ring_standing_max.max(x.ring_standing_max);
        }
    }
    v
}

fn prereg_sha256(m: &Mode, repo: &Path) -> Option<String> {
    let body = std::fs::read_to_string(repo.join(m.prereg)).ok()?;
    let anchored = body.split(v1::PREREG_MARKER).next().unwrap_or(&body);
    Some(hex::encode(Sha256::digest(anchored.as_bytes())))
}

fn overall_of(ts: &[Stats]) -> Value {
    json!({
        "fill_rate": spread(&ts.iter().map(|s| s.fill_rate()).collect::<Vec<_>>()),
        "failed_legs_per_100": spread(&ts.iter().map(|s| s.failed_legs_per_100()).collect::<Vec<_>>()),
        "price_per_filled": spread(&ts.iter().map(|s| s.price_per_filled()).collect::<Vec<_>>()),
        "loss_per_100": spread(&ts.iter().map(|s| s.loss_per_100()).collect::<Vec<_>>()),
        "unserved_per_100": spread(&ts.iter().map(|s| 100.0 * s.unserved as f64 / s.jobs as f64).collect::<Vec<_>>()),
    })
}

fn epoch_rows(arm_runs: &[&[Stats]]) -> Value {
    Value::Array(
        (0..EPOCHS)
            .map(|e| {
                let ss: Vec<&Stats> = arm_runs.iter().map(|r| &r[e]).collect();
                let f = |g: &dyn Fn(&Stats) -> f64| spread(&ss.iter().map(|s| g(s)).collect::<Vec<_>>());
                json!({
                    "epoch": e,
                    "fill_rate": f(&|s| s.fill_rate()),
                    "failed_legs_per_100": f(&|s| s.failed_legs_per_100()),
                    "admitted": f(&|s| s.admitted as f64),
                    "unreliable_admitted": f(&|s| s.unreliable_admitted as f64),
                    "newcomers_admitted": f(&|s| s.newcomers_admitted as f64),
                    "hired_admitted": f(&|s| s.hired_admitted as f64),
                })
            })
            .collect(),
    )
}

pub fn result_json(m: &Mode, runs: &[SeedRun], prereg: Option<String>) -> Value {
    let v = verdict(runs);
    let metric = |s: &Stats| json!({ "fill_rate": r4(s.fill_rate()), "failed_legs_per_100": r4(s.failed_legs_per_100()), "price_per_filled": r4(s.price_per_filled()), "loss_per_100": r4(s.loss_per_100()) });
    let mut overall = serde_json::Map::new();
    let mut per_epoch = serde_json::Map::new();
    for (k, arm) in m.arms.iter().enumerate() {
        overall.insert(arm.to_string(), overall_of(&runs.iter().map(|r| total(&r.arms[k])).collect::<Vec<_>>()));
        per_epoch.insert(arm.to_string(), epoch_rows(&runs.iter().map(|r| r.arms[k].as_slice()).collect::<Vec<_>>()));
    }
    let seeds: Vec<Value> = runs
        .iter()
        .map(|r| {
            let mut arms = serde_json::Map::new();
            for (k, arm) in m.arms.iter().enumerate() {
                let t = total(&r.arms[k]);
                arms.insert(arm.to_string(), json!({ "total": t.json(), "metrics": metric(&t), "epochs": r.arms[k].iter().map(Stats::json).collect::<Vec<_>>() }));
            }
            let per = |f: &dyn Fn(usize) -> Value| -> Value { m.arms[1..].iter().enumerate().map(|(k, arm)| (arm.to_string(), f(k))).collect::<serde_json::Map<_, _>>().into() };
            json!({
                "seed": r.seed,
                "newcomers_ever": per(&|k| json!(r.newcomers_ever[k])),
                "reliable_newcomers_ever": per(&|k| json!(r.reliable_newcomers_ever[k])),
                "graph_root": per(&|k| json!(hex::encode(r.roots[k]))),
                "ledger_sum": per(&|k| json!(r.ledger_sums[k].to_string())),
                "arms": arms,
            })
        })
        .collect();
    let tot: Vec<Vec<Stats>> = (0..m.arms.len()).map(|k| runs.iter().map(|r| total(&r.arms[k])).collect()).collect();
    let per = |f: &dyn Fn(usize) -> Value| -> Value { m.arms[1..].iter().enumerate().map(|(k, arm)| (arm.to_string(), f(k))).collect::<serde_json::Map<_, _>>().into() };
    let sum = |k: usize, f: &dyn Fn(&Stats) -> u64| json!(tot[k + 1].iter().map(f).sum::<u64>());
    let mut pass_rule = serde_json::Map::new();
    for (k, x) in [
        ("arms".to_string(), json!(format!("{} against coalitions_v1", m.arms[2]))),
        ("min_seeds".into(), json!(PASS_MIN_SEEDS)),
        ("reliable_newcomer_wins".into(), json!(v.newcomer_wins)),
        ("failed_legs_per_100_v1".into(), json!(r4(v.failed_v1))),
        (format!("failed_legs_per_100_{}", m.tag), json!(r4(v.failed_v2))),
        ("fill_rate_v1".into(), json!(r4(v.fill_v1))),
        (format!("fill_rate_{}", m.tag), json!(r4(v.fill_v2))),
        ("ring_admissions".into(), json!(v.ring_admissions)),
        ("ring_leaves".into(), json!(v.ring_leaves)),
        ("ring_standing_max".into(), json!(v.ring_standing_max)),
        ("pass".into(), json!(v.pass())),
    ] {
        pass_rule.insert(k, x);
    }
    let mut out = json!({
        "what": format!("coalition simulation, admission by standing {} against v1 over the same market with newcomers and a hired sybil ({})", m.tag, m.prereg),
        "prereg": m.prereg,
        "prereg_sha256": prereg,
        "params": {
            "v1_params": v1::params(),
            "newcomers_per_category": NEWCOMERS_PER_CAT, "newcomers_reliable_per_category": NEWCOMERS_RELIABLE,
            "hired_sybil": HIRED_SYBIL, "hired_sybil_category": CATS[HIRED_SYBIL_CAT].0,
            "coalition_arms": ([(m.arms[1], m.desc[0]), (m.arms[2], m.desc[1]), (m.arms[3], m.desc[2])].into_iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<serde_json::Map<_, _>>()),
            "failed_leg_tolerance": FAILED_LEG_TOLERANCE, "fill_tolerance": FILL_TOLERANCE,
        },
        "pass_rule": pass_rule,
        "newcomers": {
            "reliable_ever_admitted_mean": per(&|k| json!(r4(mean(runs.iter().map(|r| r.reliable_newcomers_ever[k] as f64))))),
            "unreliable_ever_admitted_mean": per(&|k| json!(r4(mean(runs.iter().map(|r| (r.newcomers_ever[k] - r.reliable_newcomers_ever[k]) as f64))))),
            "seeds_with_more_reliable_newcomers_than_v1": per(&|k| json!(runs.iter().filter(|r| r.reliable_newcomers_ever[k] > r.reliable_newcomers_ever[0]).count())),
            "legs": per(&|k| sum(k, &|s| s.newcomer_legs)),
            "delivered_legs": per(&|k| sum(k, &|s| s.newcomer_delivered_legs)),
        },
        "hired_sybil": {
            "epoch_states": runs.len() * EPOCHS,
            "with_leaf": per(&|k| sum(k, &|s| s.hired_leaf)),
            "admitted": per(&|k| sum(k, &|s| s.hired_admitted)),
            "legs": per(&|k| sum(k, &|s| s.hired_legs)),
            "seeds_admitted_at_least_once": per(&|k| json!(tot[k + 1].iter().filter(|s| s.hired_admitted > 0).count())),
            "score_max": per(&|k| json!(tot[k + 1].iter().map(|s| s.hired_score_max).max().unwrap_or(0))),
        },
        "legs_to_unreliable_agents": per(&|k| sum(k, &|s| s.unreliable_legs)),
        "legs_total": per(&|k| json!(tot[k + 1].iter().map(|s| 3 * (s.jobs - s.unserved)).sum::<u64>())),
        "secondary": {
            "what": format!("{} against coalitions_v1, reported, outside the pass rule", m.arms[3]),
            "fill_rate": [r4(mean(tot[1].iter().map(|s| s.fill_rate()))), r4(mean(tot[3].iter().map(|s| s.fill_rate())))],
            "failed_legs_per_100": [r4(mean(tot[1].iter().map(|s| s.failed_legs_per_100()))), r4(mean(tot[3].iter().map(|s| s.failed_legs_per_100())))],
        },
        "overall": overall,
        "per_epoch": per_epoch,
        "seeds": seeds,
    });
    if m.seeds != (*SEEDS.start(), *SEEDS.end()) {
        out["params"]["seeds_run"] = json!([m.seeds.0, m.seeds.1]);
    }
    out
}

fn code_sha256(repo: &Path) -> Value {
    let mut m = serde_json::Map::new();
    for f in CODE_FILES {
        m.insert(f.to_string(), std::fs::read(repo.join(f)).map(|b| Value::String(hex::encode(Sha256::digest(&b)))).unwrap_or(Value::Null));
    }
    json!({ "note": "the anchor tx covers the pre-registration text; the code was not anchored; these hashes record the code that wrote this file; --check compares everything else byte for byte and reports these", "files": m })
}

pub fn summary(m: &Mode, v: &Value) -> String {
    let o = &v["overall"];
    let g = |arm: &str, m: &str| o[arm][m]["mean"].as_f64().unwrap_or(f64::NAN);
    let p = &v["pass_rule"];
    let nc = &v["newcomers"];
    let hs = &v["hired_sybil"];
    format!(
        "reliable newcomers ever admitted {:.2} {t} vs {:.2} v1 (more in {} of {} seeds), newcomer delivered legs {} vs {}; fill {:.3} {t} vs {:.3} v1 ({:.3} singles), failed legs/100 {:.2} vs {:.2} ({:.2} singles), loss/100 jobs {:.1} vs {:.1}; ring admissions {}, ring leaves {}; hired sybil admitted in {} of {} epoch states under {t} ({} under v1), {} legs; {s2}: fill {:.3}, failed legs/100 {:.2}, reliable newcomers {:.2}",
        nc["reliable_ever_admitted_mean"][m.arms[2]].as_f64().unwrap_or(f64::NAN),
        nc["reliable_ever_admitted_mean"]["coalitions_v1"].as_f64().unwrap_or(f64::NAN),
        p["reliable_newcomer_wins"],
        v["seeds"].as_array().map_or(0, |a| a.len()),
        nc["delivered_legs"][m.arms[2]],
        nc["delivered_legs"]["coalitions_v1"],
        g(m.arms[2], "fill_rate"),
        g("coalitions_v1", "fill_rate"),
        g("singles_clean", "fill_rate"),
        g(m.arms[2], "failed_legs_per_100"),
        g("coalitions_v1", "failed_legs_per_100"),
        g("singles_clean", "failed_legs_per_100"),
        g(m.arms[2], "loss_per_100"),
        g("coalitions_v1", "loss_per_100"),
        p["ring_admissions"],
        p["ring_leaves"],
        hs["admitted"][m.arms[2]],
        hs["epoch_states"],
        hs["admitted"]["coalitions_v1"],
        hs["legs"][m.arms[2]],
        g(m.arms[3], "fill_rate"),
        g(m.arms[3], "failed_legs_per_100"),
        nc["reliable_ever_admitted_mean"][m.arms[3]].as_f64().unwrap_or(f64::NAN),
        t = m.tag,
        s2 = m.secondary,
    )
}

pub fn run(args: &[String]) -> ExitCode {
    let m = if args.iter().any(|a| a == "--v4") { &V4 } else if args.iter().any(|a| a == "--v3") { &V3 } else { &V2 };
    let opt = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let repo = Path::new(".");
    if let Some(s) = opt("--seed") {
        let Ok(seed) = s.parse::<u64>() else { return ExitCode::from(2) };
        if (m.seeds.0..=m.seeds.1).contains(&seed) && std::env::var("COALITION_UNLOCK").as_deref() != Ok("1") {
            eprintln!("seed {seed} is a pre-registered seed; use --out (or COALITION_UNLOCK=1)");
            return ExitCode::from(2);
        }
        let v = result_json(m, &[run_seed(m, seed)], prereg_sha256(m, repo));
        println!("seed {seed}: {}", summary(m, &v));
        println!("  legs to unreliable agents {} of {}; hired sybil {}", v["legs_to_unreliable_agents"], v["legs_total"], v["hired_sybil"]);
        for arm in m.arms {
            for row in v["per_epoch"][arm].as_array().unwrap() {
                let m = |k: &str| row[k]["mean"].as_f64().unwrap_or(0.0);
                println!(
                    "  {arm:13} e{} fill {:.3} failed/100 {:6.2} admitted {:4.1} unreliable {:3.1} newcomers {:3.1} hired-sybil {:.0}",
                    row["epoch"],
                    m("fill_rate"),
                    m("failed_legs_per_100"),
                    m("admitted"),
                    m("unreliable_admitted"),
                    m("newcomers_admitted"),
                    m("hired_admitted")
                );
            }
        }
        return ExitCode::SUCCESS;
    }
    let t0 = std::time::Instant::now();
    let runs: Vec<SeedRun> = (m.seeds.0..=m.seeds.1).map(|s| run_seed(m, s)).collect();
    let mut v = result_json(m, &runs, prereg_sha256(m, repo));
    let pass = v["pass_rule"]["pass"].as_bool() == Some(true);
    let code = code_sha256(repo);
    if let Some(out) = opt("--out") {
        v["code_sha256"] = code;
        std::fs::write(&out, serde_json::to_string_pretty(&v).expect("json") + "\n").expect("write result");
        println!("wrote {out} in {:.1} s", t0.elapsed().as_secs_f64());
        println!("{}  coalition {}: {}", if pass { "PASS" } else { "FAIL" }, m.tag, summary(m, &v));
        return ExitCode::SUCCESS;
    }
    if let Some(p) = opt("--check") {
        let committed: Value = std::fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
        let mut rest = committed.clone();
        let recorded = rest.as_object_mut().and_then(|o| o.remove("code_sha256")).unwrap_or(Value::Null);
        if serde_json::to_string_pretty(&rest).ok() != serde_json::to_string_pretty(&v).ok() {
            println!("FAIL  coalition {}: a re-run differs from {p} (run `make coalition-{}`)", m.tag, m.tag);
            return ExitCode::FAILURE;
        }
        if recorded["files"] != code["files"] {
            println!("NOTE  coalition {}: the code hashes differ from the ones {p} records; the numbers re-run equal", m.tag);
        }
        println!("{}  coalition {}: {} (re-run equals {p}, {:.1} s)", if pass { "PASS" } else { "FAIL" }, m.tag, summary(m, &v), t0.elapsed().as_secs_f64());
        return if pass { ExitCode::SUCCESS } else { ExitCode::FAILURE };
    }
    eprintln!("usage: bookerbob coalition-sim --v2|--v3 --out <json> | --check <json> | --seed <n>");
    ExitCode::from(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: u64 = 999;

    fn ix(agents: &[Agent], id: &str) -> usize {
        agents.iter().position(|a| a.id == id).unwrap()
    }

    /// A newcomer with no reviews, hired by a delivering lead with a real seed, gets a leaf and
    /// is admitted under v2; under v1 it has no leaf and is refused.
    #[test]
    fn a_hired_newcomer_is_admitted_under_v2_and_refused_under_v1() {
        let (agents, kinds) = population_v2(T);
        let mut ev = initial_events(T, &agents, &kinds);
        let lead = "hotel01.sim.testnet";
        let new = "new-transfer1.sim.testnet";
        // The lead has a long delivered record (a busy, reliable lead), then hires the newcomer.
        ev.push(Event::Seed { merchant: lead.into(), ratings: 40, sum: 200 });
        ev.push(Event::Hire { agent: lead.into(), sub: new.into() });
        let (a1, a2) = (admission(Rule::V1, Cut::Pct(TOP_PCT), &ev, &agents), admission(Rule::V2, Cut::Pct(TOP_PCT), &ev, &agents));
        let i = ix(&agents, new);
        assert!(a1.proofs.iter().all(|p| p.merchant != new) && !a1.admitted[i]);
        assert!(a2.proofs.iter().any(|p| p.merchant == new) && a2.admitted[i]);
    }

    /// The ring: fabricated hire edges, no seed upstream. No leaf, 0 standing and every forgery
    /// refused under both rules, in every epoch of a whole run.
    #[test]
    fn a_sybil_ring_is_refused_under_both_rules() {
        let (agents, kinds) = population_v2(T);
        for rule in [Rule::V1, Rule::V2, Rule::V3] {
            let run = coalition_arm(T, &agents, &kinds, rule, Cut::Pct(TOP_PCT), &mut Ledger::default());
            for s in &run.stats {
                assert!(s.ring_attempts > 0);
                assert_eq!((s.ring_admissions, s.ring_leaves, s.ring_standing_max), (0, 0, 0), "{rule:?}");
            }
            let sc = scores(rule, &run.events);
            for (a, _) in agents.iter().zip(&kinds).filter(|(_, k)| **k == Kind::Ring) {
                assert!(sc.merchants.iter().all(|(m, _, _)| m != &a.id), "{rule:?} {}", a.id);
            }
        }
    }

    /// The hired-once sybil: under v1 it never has a leaf. Under v2 one honest hire gives it a
    /// leaf (conferred standing) while it has no reviews of its own; whether that leaf clears the
    /// cut depends on the hirer. Hired by a lead with 40 five-star ratings, it is admitted.
    #[test]
    fn a_sybil_hired_once_gets_a_v2_leaf_and_no_v1_leaf() {
        let (agents, kinds) = population_v2(T);
        let i = ix(&agents, HIRED_SYBIL);
        let mut ev = initial_events(T, &agents, &kinds);
        ev.push(Event::Hire { agent: "hotel01.sim.testnet".into(), sub: HIRED_SYBIL.into() });
        let a1 = admission(Rule::V1, Cut::Pct(TOP_PCT), &ev, &agents);
        assert!(!a1.admitted[i] && a1.proofs.iter().all(|p| p.merchant != HIRED_SYBIL));
        let a2 = admission(Rule::V2, Cut::Pct(TOP_PCT), &ev, &agents);
        assert!(a2.proofs.iter().any(|p| p.merchant == HIRED_SYBIL));
        let mut big = initial_events(T, &agents, &kinds);
        big.push(Event::Seed { merchant: "hotel01.sim.testnet".into(), ratings: 40, sum: 200 });
        big.push(Event::Hire { agent: "hotel01.sim.testnet".into(), sub: HIRED_SYBIL.into() });
        assert!(admission(Rule::V2, Cut::Pct(TOP_PCT), &big, &agents).admitted[i]);
        // In a run it is hired once and its no-shows are slashed: money is conserved either way.
        let mut l = Ledger::default();
        let run = coalition_arm(T, &agents, &kinds, Rule::V2, Cut::Pct(TOP_PCT), &mut l);
        assert_eq!(l.sum(), 0);
        let hires = run.events.iter().filter(|e| matches!(e, Event::Hire { sub, .. } if sub == HIRED_SYBIL)).count();
        assert_eq!(hires, 1);
        // The result in this seed: admitted for one epoch, 10 legs, all no-shows; after its own
        // 1-star reviews are released it has no leaf, whatever its hirer confers.
        let t = total(&run.stats);
        assert_eq!((t.hired_admitted, t.hired_legs), (1, 10));
        assert!(scores(Rule::V2, &run.events).merchants.iter().all(|(m, _, _)| m != HIRED_SYBIL));
    }

    /// v4's cut: for every tree size from 25 to 100 some pct admits exactly 25 leaves.
    #[test]
    fn the_count_cut_admits_exactly_25() {
        for n in 25..=100u32 {
            let p = pct_for(n, V1_ADMITTED);
            assert_eq!((p as u64 * n as u64 + 99) / 100, V1_ADMITTED as u64, "n {n} pct {p}");
        }
    }

    #[test]
    fn the_v2_run_is_deterministic_and_seeds_differ() {
        let a = serde_json::to_string(&result_json(&V2, &[run_seed(&V2, T)], None)).unwrap();
        let b = serde_json::to_string(&result_json(&V2, &[run_seed(&V2, T)], None)).unwrap();
        assert_eq!(a, b);
        assert_ne!(run_seed(&V2, T).roots, run_seed(&V2, T - 1).roots);
    }

    /// The honest agents and their histories are v1's: same ids, prices, reliabilities, seeds.
    #[test]
    fn the_honest_market_equals_v1() {
        let (agents, _) = population_v2(T);
        let p1 = population(T);
        for (a, b) in agents.iter().zip(&p1) {
            assert_eq!((&a.id, a.price, a.rel), (&b.id, b.price, b.rel));
        }
        assert_eq!(agents.len(), p1.len() + CATS.len() * NEWCOMERS_PER_CAT + 1);
    }
}
