//! Referee guest: the deterministic claim check (bookerbob-zkcore::referee), proven, as a
//! second path beside the TEE worker. Output: (receipt?, input_hash). A refused input still
//! proves, with `false`, so a refusal is as verifiable as a receipt.
#![cfg_attr(feature = "guest", no_std)]
extern crate alloc;
use alloc::string::String;
use alloc::vec::Vec;
use bookerbob_zkcore::referee::{check, input_hash, Citation, Claim, Fact};

#[allow(clippy::type_complexity)]
#[jolt::provable(heap_size = 524288, max_trace_length = 4194304)]
fn referee(facts: Vec<(String, String, String, u64)>, revealed: Vec<String>, lines: Vec<String>, cohort_line: Option<String>, claims: Vec<(String, String, Vec<(String, String, u64)>)>) -> (bool, [u8; 32]) {
    let facts: Vec<Fact> = facts.into_iter().map(|(id, platform, field, value)| Fact { id, platform, field, value }).collect();
    let claims: Vec<Claim> = claims
        .into_iter()
        .map(|(line, text, cits)| Claim { line, text, citations: cits.into_iter().map(|(fact, field, value)| Citation { fact, field, value }).collect() })
        .collect();
    let ok = check(&facts, &revealed, &lines, cohort_line.as_deref(), &claims).is_ok();
    (ok, input_hash(&facts, &revealed, &lines, cohort_line.as_deref(), &claims))
}
