//! The deterministic checks BookerBob proves in Jolt, written once. no_std + alloc,
//! sha256 only, plain types. `bookerbob-core` (and through it the contract) delegates to
//! these functions and converts its serde types, so a Jolt guest proves exactly the logic
//! the contract runs.
#![no_std]
extern crate alloc;

pub mod cohort;
pub mod price;
pub mod referee;

pub(crate) fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// Length-prefixed string, for canonical byte encodings.
pub(crate) fn put_str(b: &mut alloc::vec::Vec<u8>, s: &str) {
    b.extend_from_slice(&(s.len() as u32).to_le_bytes());
    b.extend_from_slice(s.as_bytes());
}
