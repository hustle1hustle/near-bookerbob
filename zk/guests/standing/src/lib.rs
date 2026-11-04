//! Verifiable PageRank for agents: the Jolt guest proves the BookerBob standing graph.
//! Input: the graph events as their canonical bytes (hire edges, released review seeds),
//! in the order the contract applied them. Output: the hash-chained root they produce
//! (must equal the contract's `graph_root`) and the hash of the scores and standing
//! computed with conserved transport, w = 1/2 (bookerbob-graph, the same code the contract
//! runs). Malformed input panics, so no proof exists for it.
#![cfg_attr(feature = "guest", no_std)]
extern crate alloc;
use alloc::vec::Vec;

#[jolt::provable(heap_size = 1048576, max_trace_length = 16777216)]
fn standing(events: Vec<Vec<u8>>) -> ([u8; 32], [u8; 32]) {
    let ev: Vec<bookerbob_graph::Event> = events.iter().map(|b| bookerbob_graph::Event::from_bytes(b).expect("well-formed event")).collect();
    let s = bookerbob_graph::compute(&ev);
    (s.root, s.hash())
}
