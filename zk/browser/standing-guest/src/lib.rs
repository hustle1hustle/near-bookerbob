//! The standing guest again, at this folder's Jolt pin, so a browser can verify its proof.
//! Same body as zk/guests/standing (the program registered on chain at the 997c1543e pin): the
//! graph events in the order the contract applied them in, out the hash-chained root they
//! produce and the hash of the standing computed by bookerbob-graph (a bounded, damped fan-out
//! from attested seeds, w = 1/2). Malformed input panics, so no proof exists for it.
#![cfg_attr(feature = "guest", no_std)]
extern crate alloc;
use alloc::vec::Vec;

#[jolt::provable(heap_size = 1048576, stack_size = 65536, max_input_size = 65536, max_output_size = 256, max_trace_length = 16777216)]
fn standing(events: Vec<Vec<u8>>) -> ([u8; 32], [u8; 32]) {
    let ev: Vec<bookerbob_graph::Event> = events.iter().map(|b| bookerbob_graph::Event::from_bytes(b).expect("well-formed event")).collect();
    let s = bookerbob_graph::compute(&ev);
    (s.root, s.hash())
}
