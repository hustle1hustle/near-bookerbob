//! Dialect types for coalition-k-of-n. Same fields as the generated types.rs, with the spec's
//! `string` carried as `Vec<u8>`. On the postcard wire a `String` and a `Vec<u8>` are the same
//! bytes (varint length, then the raw bytes), so encoding, commitments and every valid input are
//! unchanged. The one difference: decoding no longer refuses non-UTF-8 bytes (see README).
#![allow(unused_imports)]
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seat {
    pub leg: u32,
    pub member: Vec<u8>,
    pub price: u128,
    pub delivered: Option<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Public {
    pub coalition: Vec<u8>,
    pub job: u64,
    pub seats_root: [u8; 32],
    pub k_min: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Private {
    pub seats: Vec<Seat>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Output {
    pub delivered: u32,
    pub seats: u32,
}
