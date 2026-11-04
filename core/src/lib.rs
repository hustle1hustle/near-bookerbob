//! bookerbob-core: everything that must be deterministic and shared by the contract and
//! the off-chain tools. No randomness, no clock, no network, no floating point.

pub mod envelope;
pub mod price;
pub mod referee;
pub mod tier;
pub mod u128_str;

pub use envelope::{Attestation, Envelope, SignedVerdict, SigAlg};
pub use price::{quote, DiscountLine, Quote, Rule, Schedule};
pub use referee::{referee, Citation, Claim, RefereeOutcome};
pub use tier::{derive, Derived, Fact, ProofSet, Tier, TierResult};

/// Coarse predicates a verdict may reveal. Anything else is rejected, so a merchant or a
/// model cannot invent a property. Each one is derived by code in [`tier`].
pub const KNOWN_PREDICATES: &[&str] = &[
    "airbnb_frequent",
    "booking_genius",
    "claude_spender",
    "steam_veteran",
    "uber_regular",
    "world_id_human",
];

pub fn is_known_predicate(p: &str) -> bool {
    KNOWN_PREDICATES.contains(&p)
}

/// sha256 as lowercase hex. Used for proof hashes and commitments off-chain; the contract
/// uses the `env::sha256` host function for the same digest.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).into()
}

pub(crate) fn is_hex32(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
