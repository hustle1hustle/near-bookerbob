//! Cohort commitment: the verdicts in one context that revealed one predicate. The contract
//! keeps `root' = sha256(TAG || root || context || predicate || nullifier)` per
//! (context, predicate), starting at 32 zero bytes, alongside the count it already keeps.
//! The cohort guest proves that an answer came from a committed cohort of at least `K_MIN`
//! distinct members.
use alloc::vec::Vec;

pub const COHORT_TAG: &[u8] = b"bookerbob/cohort/v0\x00";
pub const K_MIN: u32 = 5;

pub fn extend(root: &[u8; 32], context: &str, predicate: &str, nullifier: &str) -> [u8; 32] {
    let mut b = Vec::new();
    crate::put_str(&mut b, context);
    crate::put_str(&mut b, predicate);
    crate::put_str(&mut b, nullifier);
    crate::sha256(&[COHORT_TAG, root, &b])
}

pub fn root(context: &str, predicate: &str, nullifiers: &[&str]) -> [u8; 32] {
    nullifiers.iter().fold([0u8; 32], |r, n| extend(&r, context, predicate, n))
}

/// The cohort guest's statement: (root, k) for a cohort of at least K_MIN distinct members.
pub fn check(context: &str, predicate: &str, nullifiers: &[&str]) -> Result<([u8; 32], u32), &'static str> {
    for (i, n) in nullifiers.iter().enumerate() {
        if nullifiers[..i].contains(n) {
            return Err("a member appears twice");
        }
    }
    let k = nullifiers.len() as u32;
    if k < K_MIN {
        return Err("cohort below k_min");
    }
    Ok((root(context, predicate, nullifiers), k))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cohort_of_five_distinct_members_is_proven_and_four_is_not() {
        let n = ["a", "b", "c", "d", "e"];
        let (r, k) = check("ctx", "world_id_human", &n).unwrap();
        assert_eq!((r, k), (root("ctx", "world_id_human", &n), 5));
        assert_eq!(check("ctx", "world_id_human", &n[..4]), Err("cohort below k_min"));
        assert_eq!(check("ctx", "world_id_human", &["a", "b", "c", "d", "a"]), Err("a member appears twice"));
    }

    #[test]
    fn the_root_is_per_context_and_predicate_and_order() {
        let n = ["a", "b", "c", "d", "e"];
        assert_ne!(root("ctx", "p", &n), root("ctx2", "p", &n));
        assert_ne!(root("ctx", "p", &n), root("ctx", "q", &n));
        assert_ne!(root("ctx", "p", &n), root("ctx", "p", &["b", "a", "c", "d", "e"]));
    }
}
