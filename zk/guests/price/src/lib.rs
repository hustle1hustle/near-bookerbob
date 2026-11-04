//! Price-stack guest: price = f(schedule, revealed predicates, cohort size), the exact
//! function the contract runs (bookerbob-zkcore::price). Output: (price, discount_bps,
//! input_hash); a referee receipt can carry the proof's hash next to its price.
#![cfg_attr(feature = "guest", no_std)]
extern crate alloc;
use alloc::string::String;
use alloc::vec::Vec;
use bookerbob_zkcore::price::{input_hash, quote_in_cohort, Schedule};

#[allow(clippy::type_complexity)]
#[jolt::provable(heap_size = 262144, max_trace_length = 1048576)]
fn price(base_price: u128, rules: Vec<(String, u16)>, cap_bps: u16, cohort: Option<(String, u32, u16)>, revealed: Vec<String>, cohort_k: u32) -> (u128, u16, [u8; 32]) {
    let s = Schedule { base_price, rules, cap_bps, cohort };
    let q = quote_in_cohort(&s, &revealed, |_| cohort_k);
    (q.price, q.discount_bps, input_hash(&s, &revealed, cohort_k))
}
