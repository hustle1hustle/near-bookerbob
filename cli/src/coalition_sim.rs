//! `bookerbob coalition-sim`: coalitions with proven standing and bonds against single agents,
//! and a sybil coalition that tries to join. Pre-registered in docs/coalition-prereg.md.
//!
//!   bookerbob coalition-sim --out <result.json>     run the pre-registered seeds, write the result
//!   bookerbob coalition-sim --check <result.json>   re-run, compare byte for byte, apply the pass rule
//!   bookerbob coalition-sim --seed <n>              one seed, a summary on stdout, nothing written
//!
//! The coalition arm uses the code the chain runs: `bookerbob_graph::compute` over the event
//! log, `bookerbob_core::standing::graph` for the tree and its proofs, and admission is the
//! bazaar's `in_top` view rule, `proof.n == n && standing::in_top(root, GRAPH_CONTEXT, proof, pct)`.
//! Deterministic from the seed (a sha256 counter), no network, no keys.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::ExitCode;

use bookerbob_core::standing::{self, TopProof, GRAPH_CONTEXT};
use bookerbob_graph::{compute, root_of, Event};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

// ---------- frozen parameters (docs/coalition-prereg.md, "Parameters") ----------

/// (category, base price in micro-dUSDC).
pub const CATS: [(&str, u64); 3] = [("hotel", 120_000_000), ("transfer", 30_000_000), ("tour", 50_000_000)];
pub const HONEST_PER_CAT: usize = 12;
pub const UNRELIABLE_PER_CAT: usize = 4;
pub const SYBILS_PER_CAT: usize = 2;
/// Legs one agent can take per epoch.
pub const CAPACITY: u32 = 10;
pub const JOBS_PER_EPOCH: usize = 40;
pub const EPOCHS: usize = 8;
/// Admission: in the top `TOP_PCT`% of the standing tree, every epoch.
pub const TOP_PCT: u8 = 67;
/// Bond per member, in basis points of its leg price.
pub const BOND_BPS: u64 = 5_000;
/// Cost of holding the bond for one job, in basis points of the bond; added to the leg price.
pub const CARRY_BPS: u64 = 400;
/// Reliability in permille (probability a leg taken is delivered).
pub const RELIABLE_PERMILLE: (u64, u64) = (930, 990);
pub const UNRELIABLE_PERMILLE: (u64, u64) = (500, 800);
/// Honest price = base x U(850, 1250) / 1000; a sybil undercuts at 750 / 1000.
pub const PRICE_PERMILLE: (u64, u64) = (850, 1_250);
pub const SYBIL_PRICE_PERMILLE: u64 = 750;
/// Buyer budget = sum of bases x U(1050, 1400) / 1000.
pub const BUDGET_PERMILLE: (u64, u64) = (1_050, 1_400);
/// Every honest agent enters with this many prior legs, each reviewed (5 or 1 stars) by a draw
/// from its own reliability: the released reviews it already holds. Sybils enter with none.
pub const HISTORY_LEGS: u32 = 4;
pub const STARS_DELIVERED: u64 = 5;
pub const STARS_NO_SHOW: u64 = 1;
pub const SEEDS: std::ops::RangeInclusive<u64> = 1..=20;
pub const PASS_MIN_SEEDS: usize = 18;
pub const PREREG: &str = "docs/coalition-prereg.md";
/// Everything after this line in the pre-registration (the anchor tx) is outside the hash.
pub const PREREG_MARKER: &str = "<!-- anchored above this line -->";

// ---------- exploratory, beyond the pre-registration (added after the registered run) ----------

pub const EXPLORATORY: &str = "exploratory, beyond the pre-registration";
/// The run with closer reliability bands: unreliable agents deliver 80% to 90% of legs.
pub const CLOSE_UNRELIABLE_PERMILLE: (u64, u64) = (800, 900);
/// The files whose sha256 the result records (the anchor covers the pre-registration only).
pub const CODE_FILES: [&str; 2] = ["cli/src/coalition_sim.rs", "Cargo.lock"];

const BUYERS: &str = "buyers";
const ESCROW: &str = "bond-escrow";
const ARMS: [&str; 3] = ["singles", "singles_clean", "coalitions"];

// ---------- deterministic randomness ----------

fn h(parts: &[&[u8]]) -> [u8; 32] {
    let mut s = Sha256::new();
    s.update(b"bookerbob/coalition-sim/v1\x00");
    for p in parts {
        s.update((p.len() as u32).to_le_bytes());
        s.update(p);
    }
    s.finalize().into()
}

struct Rng {
    key: [u8; 32],
    ctr: u64,
}

impl Rng {
    fn new(seed: u64, label: &str) -> Self {
        Rng { key: h(&[&seed.to_le_bytes(), label.as_bytes()]), ctr: 0 }
    }
    fn next(&mut self) -> u64 {
        let d = h(&[&self.key, &self.ctr.to_le_bytes()]);
        self.ctr += 1;
        u64::from_le_bytes(d[..8].try_into().unwrap())
    }
    /// Uniform in lo..=hi (modulo bias below 2^-50 for these ranges).
    fn between(&mut self, (lo, hi): (u64, u64)) -> u64 {
        lo + self.next() % (hi - lo + 1)
    }
}

/// Whether `agent` delivers its `slot`-th leg of `epoch`. The same draw in every arm (common
/// random numbers), so the arms differ only in who gets the leg.
fn delivers(seed: u64, a: &Agent, epoch: usize, slot: u32) -> bool {
    let d = h(&[&seed.to_le_bytes(), b"deliver", a.id.as_bytes(), &(epoch as u64).to_le_bytes(), &slot.to_le_bytes()]);
    (u64::from_le_bytes(d[..8].try_into().unwrap()) % 1000) < a.rel
}

// ---------- population and jobs ----------

#[derive(Clone, Debug)]
pub struct Agent {
    pub id: String,
    pub cat: usize,
    pub price: u64,
    pub rel: u64,
    pub sybil: bool,
    pub unreliable: bool,
}

pub fn population(seed: u64) -> Vec<Agent> {
    population_with(seed, UNRELIABLE_PERMILLE)
}

/// The population with another reliability band for the unreliable agents (same draws otherwise).
pub fn population_with(seed: u64, unreliable_band: (u64, u64)) -> Vec<Agent> {
    let mut r = Rng::new(seed, "population");
    let mut out = Vec::new();
    for (c, (name, base)) in CATS.iter().enumerate() {
        // Which honest agents are unreliable: a seeded shuffle.
        let mut idx: Vec<usize> = (0..HONEST_PER_CAT).collect();
        for i in (1..idx.len()).rev() {
            let j = (r.next() % (i as u64 + 1)) as usize;
            idx.swap(i, j);
        }
        let bad: BTreeSet<usize> = idx[..UNRELIABLE_PER_CAT].iter().copied().collect();
        for i in 0..HONEST_PER_CAT {
            let unreliable = bad.contains(&i);
            let price = base * r.between(PRICE_PERMILLE) / 1000;
            let rel = r.between(if unreliable { unreliable_band } else { RELIABLE_PERMILLE });
            out.push(Agent { id: format!("{name}{:02}.sim.testnet", i + 1), cat: c, price, rel, sybil: false, unreliable });
        }
        for j in 0..SYBILS_PER_CAT {
            out.push(Agent {
                id: format!("sybil-{name}{}.sim.testnet", j + 1),
                cat: c,
                price: base * SYBIL_PRICE_PERMILLE / 1000,
                rel: 0,
                sybil: true,
                unreliable: true,
            });
        }
    }
    out
}

/// Each job's budget, the same in every arm.
pub fn jobs(seed: u64, epoch: usize) -> Vec<u64> {
    let mut r = Rng::new(seed, &format!("jobs/{epoch}"));
    let total: u64 = CATS.iter().map(|c| c.1).sum();
    (0..JOBS_PER_EPOCH).map(|_| total * r.between(BUDGET_PERMILLE) / 1000).collect()
}

fn cheapest(agents: &[Agent], ok: impl Fn(usize) -> bool, used: &[u32], cat: usize) -> Option<usize> {
    (0..agents.len())
        .filter(|&i| agents[i].cat == cat && used[i] < CAPACITY && ok(i))
        .min_by(|&a, &b| (agents[a].price, &agents[a].id).cmp(&(agents[b].price, &agents[b].id)))
}

fn coalition_price(p: u64) -> u64 {
    p + p * BOND_BPS / 10_000 * CARRY_BPS / 10_000
}

fn bond(p: u64) -> u64 {
    p * BOND_BPS / 10_000
}

// ---------- metrics ----------

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub jobs: u64,
    /// Jobs no bundle could be formed for (no agent with capacity, or over budget).
    pub unserved: u64,
    pub filled: u64,
    pub failed_bundles: u64,
    pub no_show_legs: u64,
    /// Sum of what buyers paid for filled bundles.
    pub paid_filled: u64,
    /// Paid for delivered legs of failed bundles.
    pub paid_failed: u64,
    /// Bonds slashed to buyers.
    pub slashed: u64,
    pub legs_to_sybils: u64,
    pub admitted: u64,
    pub unreliable_admitted: u64,
    pub sybil_attempts: u64,
    pub sybil_admissions: u64,
    pub sybil_standing_max: u64,
}

impl Stats {
    fn add(&mut self, o: &Stats) {
        self.jobs += o.jobs;
        self.unserved += o.unserved;
        self.filled += o.filled;
        self.failed_bundles += o.failed_bundles;
        self.no_show_legs += o.no_show_legs;
        self.paid_filled += o.paid_filled;
        self.paid_failed += o.paid_failed;
        self.slashed += o.slashed;
        self.legs_to_sybils += o.legs_to_sybils;
        self.admitted += o.admitted;
        self.unreliable_admitted += o.unreliable_admitted;
        self.sybil_attempts += o.sybil_attempts;
        self.sybil_admissions += o.sybil_admissions;
        self.sybil_standing_max = self.sybil_standing_max.max(o.sybil_standing_max);
    }
    pub fn fill_rate(&self) -> f64 {
        self.filled as f64 / self.jobs.max(1) as f64
    }
    /// No-show legs per 100 bundles formed.
    pub fn failed_legs_per_100(&self) -> f64 {
        100.0 * self.no_show_legs as f64 / (self.jobs - self.unserved).max(1) as f64
    }
    /// Mean price per filled bundle, dUSDC.
    pub fn price_per_filled(&self) -> f64 {
        self.paid_filled as f64 / self.filled.max(1) as f64 / 1e6
    }
    /// Buyer loss from failed bundles net of slashed bonds, dUSDC per 100 jobs posted.
    pub fn loss_per_100(&self) -> f64 {
        (self.paid_failed as f64 - self.slashed as f64) / 1e6 * 100.0 / self.jobs.max(1) as f64
    }
    fn json(&self) -> Value {
        json!({
            "jobs": self.jobs, "unserved": self.unserved, "filled": self.filled, "failed_bundles": self.failed_bundles,
            "no_show_legs": self.no_show_legs, "paid_filled": self.paid_filled, "paid_failed": self.paid_failed, "slashed": self.slashed,
            "legs_to_sybils": self.legs_to_sybils, "admitted": self.admitted, "unreliable_admitted": self.unreliable_admitted,
            "sybil_attempts": self.sybil_attempts, "sybil_admissions": self.sybil_admissions, "sybil_standing_max": self.sybil_standing_max,
        })
    }
}

// ---------- money ----------

/// Every transfer in the coalition arm; conservation is a unit test.
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

// ---------- the arms ----------

/// Each leg bought separately from the cheapest agent with capacity; no bond, no standing check.
/// The buyer pays for each delivered leg; a no-show fails the bundle.
pub fn singles(seed: u64, agents: &[Agent], with_sybils: bool) -> Vec<Stats> {
    let mut out = Vec::new();
    for e in 0..EPOCHS {
        let mut s = Stats::default();
        let mut used = vec![0u32; agents.len()];
        for budget in jobs(seed, e) {
            s.jobs += 1;
            let legs: Option<Vec<usize>> = (0..CATS.len()).map(|c| cheapest(agents, |i| with_sybils || !agents[i].sybil, &used, c)).collect();
            let Some(legs) = legs.filter(|l| l.iter().map(|&i| agents[i].price).sum::<u64>() <= budget) else {
                s.unserved += 1;
                continue;
            };
            let (mut paid, mut all) = (0u64, true);
            for &i in &legs {
                used[i] += 1;
                s.legs_to_sybils += agents[i].sybil as u64;
                if delivers(seed, &agents[i], e, used[i] - 1) {
                    paid += agents[i].price;
                } else {
                    all = false;
                    s.no_show_legs += 1;
                }
            }
            if all {
                s.filled += 1;
                s.paid_filled += paid;
            } else {
                s.failed_bundles += 1;
                s.paid_failed += paid;
            }
        }
        out.push(s);
    }
    out
}

/// The bazaar's `in_top` view rule, word for word: `proof.n == n && standing::in_top(...)`.
pub fn admit(root: &[u8; 32], n: u32, p: &TopProof, pct: u8) -> bool {
    p.n == n && standing::in_top(root, GRAPH_CONTEXT, p, pct)
}

/// An honest agent's prior reviews: (ratings, sum of stars) over `HISTORY_LEGS` drawn legs.
pub fn history(seed: u64, a: &Agent) -> (u64, u64) {
    let delivered = (0..HISTORY_LEGS).filter(|&k| delivers(seed, a, HISTORY_EPOCH, k)).count() as u64;
    (HISTORY_LEGS as u64, delivered * STARS_DELIVERED + (HISTORY_LEGS as u64 - delivered) * STARS_NO_SHOW)
}

/// The epoch index the prior legs are drawn under (never a simulated epoch).
const HISTORY_EPOCH: usize = usize::MAX;

/// The graph the coalition arm starts from: each honest agent's prior reviews as its seed, and
/// the sybils' fabricated hire edges (every sybil hires every other sybil). No seed for any sybil.
pub fn initial_events(seed: u64, agents: &[Agent]) -> Vec<Event> {
    let mut ev: Vec<Event> = agents
        .iter()
        .filter(|a| !a.sybil)
        .map(|a| {
            let (ratings, sum) = history(seed, a);
            Event::Seed { merchant: a.id.clone(), ratings, sum }
        })
        .collect();
    for a in agents.iter().filter(|a| a.sybil) {
        for b in agents.iter().filter(|b| b.sybil && b.id != a.id) {
            ev.push(Event::Hire { agent: a.id.clone(), sub: b.id.clone() });
        }
    }
    ev
}

/// What a sybil can present, since it has no leaf: (1) the top proof with its own name,
/// (2) the bottom proof with its own name and rank 1, (3) a proof from a forged graph that gives
/// every sybil a 50-review seed (valid against the forged root, which differs from the real one).
pub fn forgeries(events: &[Event], proofs: &[TopProof], agents: &[Agent]) -> (Vec<(String, TopProof)>, [u8; 32]) {
    let mut out = Vec::new();
    let top = proofs.iter().find(|p| p.rank == 1).cloned();
    let bottom = proofs.iter().max_by_key(|p| p.rank).cloned();
    let mut forged = events.to_vec();
    for a in agents.iter().filter(|a| a.sybil) {
        forged.push(Event::Seed { merchant: a.id.clone(), ratings: 50, sum: 250 });
    }
    let fs = compute(&forged);
    let (forged_tree, forged_proofs) = standing::graph(&fs.root, &fs.merchants);
    for a in agents.iter().filter(|a| a.sybil) {
        if let Some(mut p) = top.clone() {
            p.merchant = a.id.clone();
            out.push((a.id.clone(), p));
        }
        if let Some(mut p) = bottom.clone() {
            p.merchant = a.id.clone();
            p.rank = 1;
            out.push((a.id.clone(), p));
        }
        let p = forged_proofs.iter().find(|p| p.merchant == a.id).expect("forged leaf").clone();
        debug_assert!(admit(&forged_tree, forged_proofs.len() as u32, &p, 100), "valid in the forged tree");
        out.push((a.id.clone(), p));
    }
    (out, forged_tree)
}

/// One epoch's admission: (tree root, n, admitted per agent, the proof each admitted agent showed).
pub struct Admission {
    pub root: [u8; 32],
    pub n: u32,
    pub pct: u8,
    pub admitted: Vec<bool>,
    pub proofs: Vec<TopProof>,
}

pub fn admission(events: &[Event], agents: &[Agent]) -> (Admission, bookerbob_graph::Scores) {
    let scores = compute(events);
    let (root, proofs) = standing::graph(&scores.root, &scores.merchants);
    let n = proofs.len() as u32;
    let pct = TOP_PCT;
    let admitted = agents.iter().map(|a| proofs.iter().find(|p| p.merchant == a.id).is_some_and(|p| admit(&root, n, p, pct))).collect();
    (Admission { root, n, pct, admitted, proofs }, scores)
}

/// Coalitions: a bundle needs one admitted member per category; each posts a bond; a no-show is
/// slashed to the buyer. After each epoch the lead (the hotel member) hires the others of every
/// filled bundle, each leg's buyer review is released (5 stars delivered, 1 star no-show), and
/// standing is recomputed with `compute`.
#[cfg(test)]
pub fn coalitions(seed: u64, agents: &[Agent], ledger: &mut Ledger) -> (Vec<Stats>, Vec<Event>) {
    let r = standing_arm(seed, agents, ledger, true, false);
    (r.stats, r.events)
}

/// Exploratory probes on one epoch state of the coalition arm.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Probe {
    /// The rank 1 merchant hires a sybil: the sybil's standing from `compute`, and whether it is admitted.
    pub hired_sybil_standing: u64,
    pub hired_sybil_admitted: bool,
    /// A sybil holds one attested 5-star seed (one proven, paying buyer): its rank of n, and admission.
    pub one_seed_rank: u32,
    pub one_seed_n: u32,
    pub one_seed_admitted: bool,
}

pub fn probe(events: &[Event], agents: &[Agent], top: &TopProof) -> Probe {
    let sybil = &agents.iter().find(|a| a.sybil).expect("a sybil").id;
    let mut hired = events.to_vec();
    hired.push(Event::Hire { agent: top.merchant.clone(), sub: sybil.clone() });
    let hs = compute(&hired);
    let (ht, hp) = standing::graph(&hs.root, &hs.merchants);
    let hired_sybil_admitted = hp.iter().find(|p| &p.merchant == sybil).is_some_and(|p| admit(&ht, hp.len() as u32, p, TOP_PCT));
    let hired_sybil_standing = hs.standing.iter().find(|(a, _)| a == sybil).map_or(0, |x| x.1 as u64);
    let mut seeded = events.to_vec();
    seeded.push(Event::Seed { merchant: sybil.clone(), ratings: 1, sum: STARS_DELIVERED });
    let ss = compute(&seeded);
    let (st, sp) = standing::graph(&ss.root, &ss.merchants);
    let p = sp.iter().find(|p| &p.merchant == sybil).expect("seeded sybil has a leaf");
    Probe { hired_sybil_standing, hired_sybil_admitted, one_seed_rank: p.rank, one_seed_n: p.n, one_seed_admitted: admit(&st, sp.len() as u32, p, TOP_PCT) }
}

pub struct ArmRun {
    pub stats: Vec<Stats>,
    pub events: Vec<Event>,
    /// The event log length at the start of each epoch (the state admission ran on).
    #[cfg_attr(not(test), allow(dead_code))]
    pub epoch_starts: Vec<usize>,
    pub probes: Vec<Probe>,
}

/// The coalition arm (`bonded`), or `singles_filtered` (`!bonded`): the same admission rule over
/// the same public reviews, with no bond, no carry and no hire edges.
pub fn standing_arm(seed: u64, agents: &[Agent], ledger: &mut Ledger, bonded: bool, probes: bool) -> ArmRun {
    let mut epoch_starts = Vec::new();
    let mut probe_out = Vec::new();
    let mut events = initial_events(seed, agents);
    let mut ratings: BTreeMap<String, (u64, u64)> = agents.iter().filter(|a| !a.sybil).map(|a| (a.id.clone(), history(seed, a))).collect();
    let mut edges: BTreeSet<(String, String)> = BTreeSet::new();
    let mut out = Vec::new();
    for e in 0..EPOCHS {
        let mut s = Stats::default();
        epoch_starts.push(events.len());
        let (adm, scores) = admission(&events, agents);
        if probes {
            probe_out.push(probe(&events, agents, adm.proofs.iter().find(|p| p.rank == 1).expect("a rank 1 merchant")));
        }
        s.admitted = adm.admitted.iter().filter(|x| **x).count() as u64;
        s.unreliable_admitted = agents.iter().zip(&adm.admitted).filter(|(a, x)| **x && a.unreliable).count() as u64;
        // The sybil coalition tries to join.
        let (forged, forged_root) = forgeries(&events, &adm.proofs, agents);
        assert_ne!(forged_root, adm.root, "a forged graph has another tree root");
        for (_, p) in &forged {
            s.sybil_attempts += 1;
            s.sybil_admissions += admit(&adm.root, adm.n, p, adm.pct) as u64;
        }
        let st: BTreeMap<&str, u128> = scores.standing.iter().map(|(a, v)| (a.as_str(), *v)).collect();
        s.sybil_standing_max = agents.iter().filter(|a| a.sybil).map(|a| st.get(a.id.as_str()).copied().unwrap_or(0) as u64).max().unwrap_or(0);

        let mut used = vec![0u32; agents.len()];
        let mut reviews: BTreeMap<String, (u64, u64)> = BTreeMap::new();
        let mut new_edges = Vec::new();
        for budget in jobs(seed, e) {
            s.jobs += 1;
            let legs: Option<Vec<usize>> = (0..CATS.len()).map(|c| cheapest(agents, |i| adm.admitted[i], &used, c)).collect();
            let leg_price = |p: u64| if bonded { coalition_price(p) } else { p };
            let Some(legs) = legs.filter(|l| l.iter().map(|&i| leg_price(agents[i].price)).sum::<u64>() <= budget) else {
                s.unserved += 1;
                continue;
            };
            let (mut paid, mut total, mut all) = (0u64, 0u64, true);
            for &i in &legs {
                let a = &agents[i];
                let (p, b) = (leg_price(a.price), if bonded { bond(a.price) } else { 0 });
                total += p;
                used[i] += 1;
                s.legs_to_sybils += a.sybil as u64;
                ledger.mv(&a.id, ESCROW, b);
                let r = reviews.entry(a.id.clone()).or_default();
                r.0 += 1;
                if delivers(seed, a, e, used[i] - 1) {
                    ledger.mv(BUYERS, &a.id, p);
                    ledger.mv(ESCROW, &a.id, b);
                    paid += p;
                    r.1 += STARS_DELIVERED;
                } else {
                    ledger.mv(ESCROW, BUYERS, b);
                    s.slashed += b;
                    debug_assert!(bonded || b == 0);
                    s.no_show_legs += 1;
                    all = false;
                    r.1 += STARS_NO_SHOW;
                }
            }
            if all {
                s.filled += 1;
                s.paid_filled += total;
                if bonded {
                    let lead = &agents[legs[0]].id;
                    for &i in &legs[1..] {
                        new_edges.push((lead.clone(), agents[i].id.clone()));
                    }
                }
            } else {
                s.failed_bundles += 1;
                s.paid_failed += paid;
            }
        }
        // Epoch close: new hire edges, then each reviewed merchant's cumulative seed.
        for ed in new_edges {
            if edges.insert(ed.clone()) {
                events.push(Event::Hire { agent: ed.0, sub: ed.1 });
            }
        }
        for (m, (n, sum)) in reviews {
            let r = ratings.get_mut(&m).expect("only admitted honest agents take legs");
            r.0 += n;
            r.1 += sum;
            events.push(Event::Seed { merchant: m, ratings: r.0, sum: r.1 });
        }
        out.push(s);
    }
    ArmRun { stats: out, events, epoch_starts, probes: probe_out }
}

// ---------- the run ----------

pub struct SeedRun {
    pub seed: u64,
    pub arms: [Vec<Stats>; 3],
    pub graph_root: [u8; 32],
    pub ledger_sum: i128,
    /// Exploratory: `singles_filtered` under the registered bands.
    pub filtered: Vec<Stats>,
    /// Exploratory: singles, singles_clean, coalitions, singles_filtered under the close bands.
    pub close: [Vec<Stats>; 4],
    pub probes: Vec<Probe>,
}

pub fn run_seed(seed: u64) -> SeedRun {
    let agents = population(seed);
    let mut ledger = Ledger::default();
    let c = standing_arm(seed, &agents, &mut ledger, true, true);
    let filtered = standing_arm(seed, &agents, &mut Ledger::default(), false, false).stats;
    let near = population_with(seed, CLOSE_UNRELIABLE_PERMILLE);
    let close = [
        singles(seed, &near, true),
        singles(seed, &near, false),
        standing_arm(seed, &near, &mut Ledger::default(), true, false).stats,
        standing_arm(seed, &near, &mut Ledger::default(), false, false).stats,
    ];
    SeedRun {
        seed,
        arms: [singles(seed, &agents, true), singles(seed, &agents, false), c.stats],
        graph_root: root_of(&c.events),
        ledger_sum: ledger.sum(),
        filtered,
        close,
        probes: c.probes,
    }
}

fn total(v: &[Stats]) -> Stats {
    let mut t = Stats::default();
    for s in v {
        t.add(s);
    }
    t
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

/// The pre-registered pass rule over per-seed totals (docs/coalition-prereg.md, "Pass rule").
pub struct Verdict {
    pub fill_wins: usize,
    pub failed_leg_wins: usize,
    pub loss_wins: usize,
    pub sybil_admissions: u64,
    pub sybil_standing_max: u64,
}

impl Verdict {
    pub fn pass(&self) -> bool {
        self.fill_wins >= PASS_MIN_SEEDS
            && self.failed_leg_wins >= PASS_MIN_SEEDS
            && self.loss_wins >= PASS_MIN_SEEDS
            && self.sybil_admissions == 0
            && self.sybil_standing_max == 0
    }
}

pub fn verdict(runs: &[SeedRun]) -> Verdict {
    let mut v = Verdict { fill_wins: 0, failed_leg_wins: 0, loss_wins: 0, sybil_admissions: 0, sybil_standing_max: 0 };
    for r in runs {
        let (clean, coal) = (total(&r.arms[1]), total(&r.arms[2]));
        v.fill_wins += (coal.fill_rate() > clean.fill_rate()) as usize;
        v.failed_leg_wins += (coal.failed_legs_per_100() < clean.failed_legs_per_100()) as usize;
        v.loss_wins += (coal.loss_per_100() < clean.loss_per_100()) as usize;
        v.sybil_admissions += coal.sybil_admissions;
        v.sybil_standing_max = v.sybil_standing_max.max(coal.sybil_standing_max);
    }
    v
}

fn prereg_sha256(repo: &Path) -> Option<String> {
    let body = std::fs::read_to_string(repo.join(PREREG)).ok()?;
    let anchored = body.split(PREREG_MARKER).next().unwrap_or(&body);
    Some(hex::encode(Sha256::digest(anchored.as_bytes())))
}

pub fn result_json(runs: &[SeedRun], prereg: Option<String>) -> Value {
    let v = verdict(runs);
    let metric = |s: &Stats| json!({ "fill_rate": r4(s.fill_rate()), "failed_legs_per_100": r4(s.failed_legs_per_100()), "price_per_filled": r4(s.price_per_filled()), "loss_per_100": r4(s.loss_per_100()) });
    let mut per_epoch = serde_json::Map::new();
    let mut overall = serde_json::Map::new();
    for (k, arm) in ARMS.iter().enumerate() {
        let arm_runs: Vec<&[Stats]> = runs.iter().map(|r| r.arms[k].as_slice()).collect();
        per_epoch.insert(arm.to_string(), epoch_rows(&arm_runs));
        overall.insert(arm.to_string(), overall_of(&arm_runs));
    }
    let seeds: Vec<Value> = runs
        .iter()
        .map(|r| {
            let mut arms = serde_json::Map::new();
            for (k, arm) in ARMS.iter().enumerate() {
                let t = total(&r.arms[k]);
                arms.insert(
                    arm.to_string(),
                    json!({ "total": t.json(), "metrics": metric(&t), "epochs": r.arms[k].iter().map(Stats::json).collect::<Vec<_>>() }),
                );
            }
            json!({ "seed": r.seed, "graph_root": hex::encode(r.graph_root), "ledger_sum": r.ledger_sum.to_string(), "arms": arms })
        })
        .collect();
    json!({
        "what": "coalitions with proven standing and bonds against single agents; a sybil coalition tries to join (docs/coalition-prereg.md)",
        "prereg": PREREG,
        "prereg_sha256": prereg,
        "params": params(),
        "pass_rule": {
            "comparator": "singles_clean",
            "min_seeds": PASS_MIN_SEEDS,
            "fill_wins": v.fill_wins, "failed_leg_wins": v.failed_leg_wins, "loss_wins": v.loss_wins,
            "sybil_admissions": v.sybil_admissions, "sybil_standing_max": v.sybil_standing_max,
            "pass": v.pass(),
        },
        "overall": overall,
        "per_epoch": per_epoch,
        "seeds": seeds,
        "exploratory": exploratory(runs),
    })
}

fn epoch_rows(arm_runs: &[&[Stats]]) -> Value {
    let mut rows = Vec::new();
    for e in 0..EPOCHS {
        let ss: Vec<&Stats> = arm_runs.iter().map(|r| &r[e]).collect();
        rows.push(json!({
            "epoch": e,
            "fill_rate": spread(&ss.iter().map(|s| s.fill_rate()).collect::<Vec<_>>()),
            "failed_legs_per_100": spread(&ss.iter().map(|s| s.failed_legs_per_100()).collect::<Vec<_>>()),
            "price_per_filled": spread(&ss.iter().filter(|s| s.filled > 0).map(|s| s.price_per_filled()).collect::<Vec<_>>()),
            "loss_per_100": spread(&ss.iter().map(|s| s.loss_per_100()).collect::<Vec<_>>()),
            "unserved": spread(&ss.iter().map(|s| s.unserved as f64).collect::<Vec<_>>()),
            "admitted": spread(&ss.iter().map(|s| s.admitted as f64).collect::<Vec<_>>()),
            "unreliable_admitted": spread(&ss.iter().map(|s| s.unreliable_admitted as f64).collect::<Vec<_>>()),
        }));
    }
    Value::Array(rows)
}

fn overall_of(arm_runs: &[&[Stats]]) -> Value {
    let ts: Vec<Stats> = arm_runs.iter().map(|r| total(r)).collect();
    json!({
        "fill_rate": spread(&ts.iter().map(|s| s.fill_rate()).collect::<Vec<_>>()),
        "failed_legs_per_100": spread(&ts.iter().map(|s| s.failed_legs_per_100()).collect::<Vec<_>>()),
        "price_per_filled": spread(&ts.iter().map(|s| s.price_per_filled()).collect::<Vec<_>>()),
        "loss_per_100": spread(&ts.iter().map(|s| s.loss_per_100()).collect::<Vec<_>>()),
        "unserved_per_100": spread(&ts.iter().map(|s| 100.0 * s.unserved as f64 / s.jobs as f64).collect::<Vec<_>>()),
    })
}

/// Seeds where `a` beats `b`: (more fills, fewer failed legs, lower net loss).
fn wins(a: &[Stats], b: &[Stats]) -> (usize, usize, usize) {
    (
        a.iter().zip(b).filter(|(x, y)| x.fill_rate() > y.fill_rate()).count(),
        a.iter().zip(b).filter(|(x, y)| x.failed_legs_per_100() < y.failed_legs_per_100()).count(),
        a.iter().zip(b).filter(|(x, y)| x.loss_per_100() < y.loss_per_100()).count(),
    )
}

fn wins_json(a: &[Stats], b: &[Stats]) -> Value {
    let (f, l, n) = wins(a, b);
    json!({ "fill_wins": f, "failed_leg_wins": l, "loss_wins": n, "seeds": a.len() })
}

/// What lies beyond the pre-registration: it does not enter the pass rule.
fn exploratory(runs: &[SeedRun]) -> Value {
    let tot = |f: &dyn Fn(&SeedRun) -> &[Stats]| -> Vec<Stats> { runs.iter().map(|r| total(f(r))).collect() };
    let (coal, clean, filt) = (tot(&|r| &r.arms[2]), tot(&|r| &r.arms[1]), tot(&|r| &r.filtered));
    let per100 = |ts: &[Stats], f: &dyn Fn(&Stats) -> u64| ts.iter().map(|s| f(s) as f64 / 1e6 * 100.0 / s.jobs as f64).sum::<f64>() / ts.len() as f64;
    let paid_failed = per100(&coal, &|s| s.paid_failed);
    let slashed = per100(&coal, &|s| s.slashed);
    let clean_loss = clean.iter().map(|s| s.loss_per_100()).sum::<f64>() / clean.len() as f64;
    let gap = clean_loss - (paid_failed - slashed);
    let close_names = ["singles", "singles_clean", "coalitions", "singles_filtered"];
    let mut close_overall = serde_json::Map::new();
    for (k, arm) in close_names.iter().enumerate() {
        let arm_runs: Vec<&[Stats]> = runs.iter().map(|r| r.close[k].as_slice()).collect();
        close_overall.insert(arm.to_string(), overall_of(&arm_runs));
    }
    let close_t: Vec<Vec<Stats>> = (0..4).map(|k| runs.iter().map(|r| total(&r.close[k])).collect()).collect();
    let probes: Vec<&Probe> = runs.iter().flat_map(|r| r.probes.iter()).collect();
    let filt_runs: Vec<&[Stats]> = runs.iter().map(|r| r.filtered.as_slice()).collect();
    json!({
        "label": EXPLORATORY,
        "singles_filtered": {
            "what": "each leg to the cheapest agent that passes the same in_top rule over the same public reviews; no bond, no carry, no hire edges",
            "overall": overall_of(&filt_runs),
            "per_epoch": epoch_rows(&filt_runs),
            "coalitions_vs_singles_filtered": wins_json(&coal, &filt),
            "singles_filtered_vs_singles_clean": wins_json(&filt, &clean),
        },
        "loss_decomposition": {
            "what": "means over seeds, dUSDC per 100 jobs posted",
            "coalitions_paid_for_failed_bundles": r4(paid_failed),
            "coalitions_slashed_to_buyers": r4(slashed),
            "singles_clean_loss": r4(clean_loss),
            "gap_to_singles_clean": r4(gap),
            "slashed_share_of_gap": r4(slashed / gap),
        },
        "close_bands": {
            "unreliable_permille": [CLOSE_UNRELIABLE_PERMILLE.0, CLOSE_UNRELIABLE_PERMILLE.1],
            "overall": close_overall,
            "coalitions_vs_singles_clean": wins_json(&close_t[2], &close_t[1]),
            "singles_filtered_vs_singles_clean": wins_json(&close_t[3], &close_t[1]),
            "coalitions_vs_singles_filtered": wins_json(&close_t[2], &close_t[3]),
        },
        "attacks": {
            "epoch_states": probes.len(),
            "honest_hires_sybil": {
                "what": "the rank 1 merchant hires a sybil; the sybil still has no seed, so no leaf",
                "states_with_sybil_standing": probes.iter().filter(|p| p.hired_sybil_standing > 0).count(),
                "max_sybil_standing": probes.iter().map(|p| p.hired_sybil_standing).max().unwrap_or(0),
                "admitted": probes.iter().filter(|p| p.hired_sybil_admitted).count(),
            },
            "sybil_with_one_attested_seed": {
                "what": "a sybil holds one released 5-star review from a proven, paying buyer",
                "admitted": probes.iter().filter(|p| p.one_seed_admitted).count(),
                "best_rank": probes.iter().map(|p| p.one_seed_rank).min().unwrap_or(0),
                "worst_rank": probes.iter().map(|p| p.one_seed_rank).max().unwrap_or(0),
                "n": probes.first().map_or(0, |p| p.one_seed_n),
            },
        },
        "seeds": runs.iter().map(|r| json!({
            "seed": r.seed,
            "singles_filtered": { "total": total(&r.filtered).json(), "epochs": r.filtered.iter().map(Stats::json).collect::<Vec<_>>() },
            "close_bands": close_names.iter().enumerate().map(|(k, a)| (a.to_string(), total(&r.close[k]).json())).collect::<serde_json::Map<_, _>>(),
        })).collect::<Vec<_>>(),
    })
}

fn code_sha256(repo: &Path) -> Value {
    let mut m = serde_json::Map::new();
    for f in CODE_FILES {
        m.insert(f.to_string(), std::fs::read(repo.join(f)).map(|b| Value::String(hex::encode(Sha256::digest(&b)))).unwrap_or(Value::Null));
    }
    json!({ "note": "the anchor tx covers the pre-registration text; the code was not anchored; these hashes record the code that wrote this file", "files": m })
}

pub fn params() -> Value {
    json!({
        "categories": CATS.iter().map(|(n, b)| json!({ "name": n, "base": b })).collect::<Vec<_>>(),
        "honest_per_category": HONEST_PER_CAT, "unreliable_per_category": UNRELIABLE_PER_CAT, "sybils_per_category": SYBILS_PER_CAT,
        "capacity": CAPACITY, "jobs_per_epoch": JOBS_PER_EPOCH, "epochs": EPOCHS, "top_pct": TOP_PCT, "history_legs": HISTORY_LEGS,
        "bond_bps": BOND_BPS, "carry_bps": CARRY_BPS,
        "reliable_permille": [RELIABLE_PERMILLE.0, RELIABLE_PERMILLE.1], "unreliable_permille": [UNRELIABLE_PERMILLE.0, UNRELIABLE_PERMILLE.1],
        "price_permille": [PRICE_PERMILLE.0, PRICE_PERMILLE.1], "sybil_price_permille": SYBIL_PRICE_PERMILLE,
        "budget_permille": [BUDGET_PERMILLE.0, BUDGET_PERMILLE.1],
        "stars_delivered": STARS_DELIVERED, "stars_no_show": STARS_NO_SHOW,
        "seeds": [*SEEDS.start(), *SEEDS.end()], "money_unit": "micro-dUSDC",
    })
}

fn summary(v: &Value) -> String {
    let o = &v["overall"];
    let g = |arm: &str, m: &str| o[arm][m]["mean"].as_f64().unwrap_or(f64::NAN);
    let p = &v["pass_rule"];
    format!(
        "fill {:.3} vs {:.3} singles ({:.3} with sybils), failed legs/100 {:.2} vs {:.2}, loss/100 jobs {:.1} vs {:.1} dUSDC, price/filled {:.2} vs {:.2} dUSDC; wins {}/{}/{} of {} seeds; sybil admissions {}",
        g("coalitions", "fill_rate"),
        g("singles_clean", "fill_rate"),
        g("singles", "fill_rate"),
        g("coalitions", "failed_legs_per_100"),
        g("singles_clean", "failed_legs_per_100"),
        g("coalitions", "loss_per_100"),
        g("singles_clean", "loss_per_100"),
        g("coalitions", "price_per_filled"),
        g("singles_clean", "price_per_filled"),
        p["fill_wins"],
        p["failed_leg_wins"],
        p["loss_wins"],
        v["seeds"].as_array().map_or(0, |a| a.len()),
        p["sybil_admissions"],
    )
}

/// One line on the exploratory arms; printed with NOTE, never gated.
fn explore_line(v: &Value) -> String {
    let x = &v["exploratory"];
    let m = |o: &Value, arm: &str, k: &str| o[arm][k]["mean"].as_f64().unwrap_or(f64::NAN);
    let f = &x["singles_filtered"];
    let c = &x["close_bands"];
    format!(
        "NOTE  coalition, {}: singles_filtered fills {:.3} against {:.3} for coalitions (coalitions fill more in {} of 20 seeds), so the fill gain is the standing filter; slashed bonds return {:.0}% of the net-loss gap; with unreliable agents at 80% to 90%, coalitions fill {:.3} against {:.3} for singles (wins {}/{}/{})",
        EXPLORATORY,
        f["overall"]["fill_rate"]["mean"].as_f64().unwrap_or(f64::NAN),
        m(&v["overall"], "coalitions", "fill_rate"),
        f["coalitions_vs_singles_filtered"]["fill_wins"],
        100.0 * x["loss_decomposition"]["slashed_share_of_gap"].as_f64().unwrap_or(f64::NAN),
        m(&c["overall"], "coalitions", "fill_rate"),
        m(&c["overall"], "singles_clean", "fill_rate"),
        c["coalitions_vs_singles_clean"]["fill_wins"],
        c["coalitions_vs_singles_clean"]["failed_leg_wins"],
        c["coalitions_vs_singles_clean"]["loss_wins"],
    )
}

pub fn run(args: &[String]) -> ExitCode {
    let opt = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let repo = Path::new(".");
    if let Some(s) = opt("--seed") {
        let Ok(seed) = s.parse::<u64>() else { return ExitCode::from(2) };
        if SEEDS.contains(&seed) && std::env::var("COALITION_UNLOCK").as_deref() != Ok("1") {
            eprintln!("seed {seed} is a pre-registered seed; use --out (or COALITION_UNLOCK=1)");
            return ExitCode::from(2);
        }
        let v = result_json(&[run_seed(seed)], prereg_sha256(repo));
        println!("seed {seed}: {}", summary(&v));
        for arm in ARMS {
            for row in v["per_epoch"][arm].as_array().unwrap() {
                println!(
                    "  {arm:13} e{} fill {:.3} failed/100 {:6.2} price {:7.2} loss/100 {:8.2} unserved {:4.1} admitted {:4.1} unreliable {:3.1}",
                    row["epoch"],
                    row["fill_rate"]["mean"].as_f64().unwrap(),
                    row["failed_legs_per_100"]["mean"].as_f64().unwrap(),
                    row["price_per_filled"]["mean"].as_f64().unwrap_or(0.0),
                    row["loss_per_100"]["mean"].as_f64().unwrap(),
                    row["unserved"]["mean"].as_f64().unwrap(),
                    row["admitted"]["mean"].as_f64().unwrap(),
                    row["unreliable_admitted"]["mean"].as_f64().unwrap()
                );
            }
        }
        return ExitCode::SUCCESS;
    }
    let t0 = std::time::Instant::now();
    let runs: Vec<SeedRun> = SEEDS.map(run_seed).collect();
    let mut v = result_json(&runs, prereg_sha256(repo));
    v["code_sha256"] = code_sha256(repo);
    let body = serde_json::to_string_pretty(&v).expect("json") + "\n";
    let pass = v["pass_rule"]["pass"].as_bool() == Some(true);
    if let Some(out) = opt("--out") {
        if let Some(d) = Path::new(&out).parent() {
            std::fs::create_dir_all(d).expect("mkdir");
        }
        std::fs::write(&out, &body).expect("write result");
        println!("wrote {out} in {:.1} s", t0.elapsed().as_secs_f64());
        println!("{}  coalition: {}", if pass { "PASS" } else { "FAIL" }, summary(&v));
        println!("{}", explore_line(&v));
        return ExitCode::SUCCESS;
    }
    if let Some(p) = opt("--check") {
        let committed = std::fs::read_to_string(&p).unwrap_or_default();
        if committed != body {
            println!("FAIL  coalition: a re-run differs from {p} (run `make coalition`)");
            return ExitCode::FAILURE;
        }
        println!("{}  coalition: {} (re-run equals {p}, {:.1} s)", if pass { "PASS" } else { "FAIL" }, summary(&v), t0.elapsed().as_secs_f64());
        println!("{}", explore_line(&v));
        return if pass { ExitCode::SUCCESS } else { ExitCode::FAILURE };
    }
    eprintln!("usage: bookerbob coalition-sim --out <json> | --check <json> | --seed <n>");
    ExitCode::from(2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bookerbob_bazaar::Bazaar;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{env, testing_env, AccountId};

    const T: u64 = 999;

    #[test]
    fn sybils_get_no_standing_no_leaf_and_no_admission() {
        let agents = population(T);
        let mut l = Ledger::default();
        let (stats, events) = coalitions(T, &agents, &mut l);
        let s = compute(&events);
        for a in agents.iter().filter(|a| a.sybil) {
            assert!(s.standing.iter().all(|(x, v)| x != &a.id || *v == 0), "sybil {} has standing", a.id);
            assert!(s.merchants.iter().all(|(m, _, _)| m != &a.id), "sybil {} has a leaf", a.id);
        }
        assert!(stats.iter().all(|e| e.sybil_attempts > 0 && e.sybil_admissions == 0 && e.legs_to_sybils == 0 && e.sybil_standing_max == 0));
    }

    #[test]
    fn slashing_conserves_money_and_the_escrow_ends_empty() {
        let agents = population(T);
        let mut l = Ledger::default();
        let (stats, _) = coalitions(T, &agents, &mut l);
        assert_eq!(l.sum(), 0);
        assert_eq!(l.0.get(ESCROW).copied().unwrap_or(0), 0);
        let t = total(&stats);
        assert!(t.slashed > 0, "some bond was slashed");
        // What buyers net = slashed bonds received - paid for every delivered leg.
        assert_eq!(l.0[BUYERS], t.slashed as i128 - (t.paid_filled + t.paid_failed) as i128);
    }

    #[test]
    fn the_run_is_deterministic_and_seeds_differ() {
        let a = result_json(&[run_seed(T)], None);
        let b = result_json(&[run_seed(T)], None);
        assert_eq!(serde_json::to_string(&a).unwrap(), serde_json::to_string(&b).unwrap());
        assert_ne!(run_seed(T).graph_root, run_seed(T + 1).graph_root);
    }

    #[test]
    fn a_forged_edge_or_a_changed_weight_changes_the_root_and_the_proof_fails() {
        let agents = population(T);
        let mut l = Ledger::default();
        let (_, events) = coalitions(T, &agents, &mut l);
        let real = compute(&events);
        let (tree, proofs) = standing::graph(&real.root, &real.merchants);
        let n = proofs.len() as u32;
        // A forged hire edge.
        let mut e1 = events.clone();
        e1.push(Event::Hire { agent: agents[0].id.clone(), sub: "sybil-hotel1.sim.testnet".into() });
        assert_ne!(root_of(&e1), real.root);
        // A changed weight: one merchant's latest seed gets more ratings.
        let mut e2 = events.clone();
        let k = e2.iter().rposition(|e| matches!(e, Event::Seed { .. })).unwrap();
        if let Event::Seed { ratings, sum, .. } = &mut e2[k] {
            *ratings += 10;
            *sum += 50;
        }
        assert_ne!(root_of(&e2), real.root);
        for forged in [e1, e2] {
            let f = compute(&forged);
            let (ft, fp) = standing::graph(&f.root, &f.merchants);
            assert_ne!(ft, tree);
            // Every proof from the forged tree fails against the real root, at any pct.
            assert!(fp.iter().all(|p| !admit(&tree, n, p, 100)));
        }
        let (forged, _) = forgeries(&events, &proofs, &agents);
        assert!(forged.iter().all(|(_, p)| !admit(&tree, n, p, 100)));
    }

    /// The bazaar's own `in_top` view, given the same tree root, n and pct, agrees with the
    /// sim's admission for every agent and every forged proof, in every epoch state of the 20
    /// registered seeds at pct 67. The view reads the tree root from storage, written here
    /// directly: the update path (`submit_graph_scores`, `apply_graph_update` and its
    /// scores-hash check) is not exercised by this test.
    #[test]
    fn admission_equals_the_bazaar_in_top_view_in_every_registered_epoch_state() {
        let acc = |s: &str| -> AccountId { s.parse().unwrap() };
        testing_env!(VMContextBuilder::new().current_account_id(acc("bazaar.sim.testnet")).predecessor_account_id(acc("owner.sim.testnet")).build());
        let c = Bazaar::new(acc("owner.sim.testnet"), acc("usdc.sim.testnet"));
        let (mut states, mut decisions) = (0, 0);
        for seed in SEEDS {
            let agents = population(seed);
            let run = standing_arm(seed, &agents, &mut Ledger::default(), true, false);
            for (e, &len) in run.epoch_starts.iter().enumerate() {
                let events = &run.events[..len];
                let (adm, scores) = admission(events, &agents);
                assert_eq!(adm.admitted.iter().filter(|x| **x).count() as u64, run.stats[e].admitted);
                let stored = (hex::encode(adm.root), adm.n, hex::encode(scores.hash()), hex::encode(scores.root));
                env::storage_write(b"proven_standing", &serde_json::to_vec(&stored).unwrap());
                for (a, ok) in agents.iter().zip(&adm.admitted) {
                    match adm.proofs.iter().find(|p| p.merchant == a.id) {
                        Some(p) => assert_eq!(c.in_top(p.clone(), TOP_PCT), *ok, "seed {seed} epoch {e} {}", a.id),
                        None => assert!(!ok && a.sybil),
                    }
                    decisions += 1;
                }
                for (_, p) in forgeries(events, &adm.proofs, &agents).0 {
                    assert!(!c.in_top(p.clone(), TOP_PCT) && !admit(&adm.root, adm.n, &p, TOP_PCT));
                    decisions += 1;
                }
                states += 1;
            }
        }
        assert_eq!(states, 160);
        assert!(decisions > 160 * 36);
    }

    #[test]
    fn a_hired_sybil_gets_standing_but_no_leaf_and_a_one_review_sybil_ranks_below_the_cut() {
        let agents = population(T);
        let run = standing_arm(T, &agents, &mut Ledger::default(), true, true);
        assert!(run.probes.iter().all(|p| p.hired_sybil_standing > 0 && !p.hired_sybil_admitted));
        assert!(run.probes.iter().all(|p| !p.one_seed_admitted && p.one_seed_rank > 25));
    }

    #[test]
    fn singles_filtered_moves_no_bond_and_logs_no_hire() {
        let agents = population(T);
        let mut l = Ledger::default();
        let run = standing_arm(T, &agents, &mut l, false, false);
        assert_eq!(total(&run.stats).slashed, 0);
        assert!(run.events.iter().filter(|e| matches!(e, Event::Hire { .. })).all(|e| matches!(e, Event::Hire { agent, .. } if agent.starts_with("sybil-"))));
        assert_eq!(l.0.get(ESCROW).copied().unwrap_or(0), 0);
    }
}
