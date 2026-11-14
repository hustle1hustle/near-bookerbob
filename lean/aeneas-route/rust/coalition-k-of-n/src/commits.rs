//! Template-generated (would be, from the spec's rule 1): the commitment of the committed value,
//! monomorphic, so the translated check calls one opaque function and no serde trait reaches
//! Charon. Body = smith_std::commit, unchanged. TRUSTED: opaque in Lean.
use crate::types::Seat;
use alloc::vec::Vec;

pub fn commit_seats(tag: &str, seats: &Vec<Seat>) -> [u8; 32] {
    crate::smith_std::commit(tag, seats)
}
