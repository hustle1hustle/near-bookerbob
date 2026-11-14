//! Standing v2, the program the bazaar's graph program is set to: the graph events in the order
//! the contract applied them, out the hash-chained root they produce and the hash of the v2 scores
//! (standing-v2/: every account ranked by its quality-weighted own seed plus the standing conferred
//! on it along hire edges). The bazaar builds its `in_top` tree from the list that hash covers.
//! Malformed input panics, so no proof exists for it.
#![cfg_attr(feature = "guest", no_std)]
extern crate alloc;
use alloc::vec::Vec;

#[jolt::provable(heap_size = 1048576, stack_size = 65536, max_input_size = 65536, max_output_size = 256, max_trace_length = 16777216)]
fn standing(events: Vec<Vec<u8>>) -> ([u8; 32], [u8; 32]) {
    let ev: Vec<bookerbob_standing_v2::Event> = events.iter().map(|b| bookerbob_standing_v2::Event::from_bytes(b).expect("well-formed event")).collect();
    let s = bookerbob_standing_v2::compute(&ev);
    (s.root, s.hash())
}
