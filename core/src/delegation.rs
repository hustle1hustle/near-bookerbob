//! Conserved delegation of standing along hire edges (buyer -> merchant agent -> the
//! sub-agents it hires). Following a design rule in REP's unpublished draft "(title withheld)
//! for a World of Agents: Costly Signals, Conserved Delegation, and the Cost of Attack"
//! (2026, arXiv preprint in preparation): when standing is split among children with
//! damping `w`, one attested fact confers at most `w / (1 - w)` units of seed mass on the
//! whole delegation chain, whatever its fanout or depth (for w = 1/2, at most 1 unit).
//!
//! Here: a root starts with `seed` (micro-units). At each hop a node passes on `w` of what
//! it received, split evenly among the accounts it hired, rounding down; it never passes
//! on what it already holds. Mass that comes back around a ring is passed on again, damped
//! again. Integer floors only lose mass, so the total conferred below the root is at most
//! `seed * w / (1 - w)`.
// One implementation, shared with the contract and the Jolt guest (`graph/`).
pub use bookerbob_graph::{bound, conferred, Damping, MAX_HOPS, MAX_VISITS, W_HALF};

#[cfg(test)]
mod tests {
    use super::*;

    fn graph<'a>(edges: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Vec<String> + 'a {
        move |n: &str| edges.iter().filter(|(a, _)| *a == n).map(|(_, b)| b.to_string()).collect()
    }

    #[test]
    fn a_chain_halves_at_every_hop() {
        let g = graph(&[("m", "a"), ("a", "b"), ("b", "c")]);
        let c = conferred("m", 1_000_000, W_HALF, g);
        assert_eq!((c["a"], c["b"], c["c"]), (500_000, 250_000, 125_000));
    }

    #[test]
    fn fanout_splits_the_same_mass() {
        let g = graph(&[("m", "a"), ("m", "b"), ("m", "c"), ("m", "d")]);
        let c = conferred("m", 1_000_000, W_HALF, g);
        assert_eq!(c.values().sum::<u128>(), 500_000);
    }

    #[test]
    fn a_spawned_ring_gains_at_most_one_seed_unit() {
        // The merchant hires s1; s1..s4 hire each other in a ring and back.
        let g = graph(&[("m", "s1"), ("s1", "s2"), ("s2", "s3"), ("s3", "s4"), ("s4", "s1"), ("s2", "s4"), ("s3", "m")]);
        let c = conferred("m", 1_000_000, W_HALF, g);
        let total: u128 = c.values().sum();
        assert!(total <= bound(1_000_000, W_HALF), "{total}");
        assert!(total > 900_000, "the ring does collect most of the bound: {total}");
    }

    #[test]
    fn accounts_without_a_seeded_parent_get_nothing() {
        let g = graph(&[("x", "y"), ("y", "x")]);
        assert!(conferred("m", 1_000_000, W_HALF, g).is_empty());
    }
}
