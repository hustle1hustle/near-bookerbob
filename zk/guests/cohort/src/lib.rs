//! Cohort-matching guest: the answer came from a committed cohort of at least k_min = 5
//! distinct members (bookerbob-zkcore::cohort). Output: (root, k); the root must equal the
//! contract's `cohort_root(context, predicate)`. Below k_min or with a repeated member the
//! guest panics, so no proof exists.
#![cfg_attr(feature = "guest", no_std)]
extern crate alloc;
use alloc::string::String;
use alloc::vec::Vec;

#[jolt::provable(heap_size = 262144, max_trace_length = 1048576)]
fn cohort(context: String, predicate: String, nullifiers: Vec<String>) -> ([u8; 32], u32) {
    let refs: Vec<&str> = nullifiers.iter().map(String::as_str).collect();
    bookerbob_zkcore::cohort::check(&context, &predicate, &refs).expect("a committed cohort of at least k_min")
}
