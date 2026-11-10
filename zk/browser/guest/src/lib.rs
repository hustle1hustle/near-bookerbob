//! "decide": the buyer's agent followed the buyer's rules. Every input is public.
//!
//! Given the budget, the predicates the buyer revealed, the cohort size, the offers (merchant,
//! public base price, discount schedule) and a claimed (merchant, price), it reprices every
//! offer with `bookerbob_zkcore::price::quote_in_cohort`, the function the bazaar contract
//! calls, and holds only when:
//!   1. the claimed merchant is in the list, exactly once,
//!   2. the claimed price is the code price of that offer,
//!   3. that price fits the budget,
//!   4. no offer is cheaper.
//! Output: the merchant and its price. It says nothing about whether the offers are honest.
#![cfg_attr(feature = "guest", no_std)]
extern crate alloc;
use alloc::string::String;
use alloc::vec::Vec;
use bookerbob_zkcore::price::{quote_in_cohort, Schedule};

/// (merchant, base price, rules as (predicate, bps), cap bps, cohort as (predicate, k_min, bps)).
pub type Offer = (String, u128, Vec<(String, u16)>, u16, Option<(String, u32, u16)>);

/// The contract's bound on a base price (core/src/price.rs MAX_BASE_PRICE), so base * bps
/// cannot overflow.
pub const MAX_BASE_PRICE: u128 = 1_000_000_000_000_000_000_000_000_000_000;

#[jolt::provable(heap_size = 65536, stack_size = 16384, max_input_size = 4096, max_output_size = 256, max_trace_length = 65536)]
fn decide(budget: u128, revealed: Vec<String>, cohort_k: u32, offers: Vec<Offer>, choice: String, price: u128) -> (String, u128) {
    let mut chosen: Option<u128> = None;
    let mut cheapest = u128::MAX;
    for (merchant, base_price, rules, cap_bps, cohort) in offers {
        assert!(base_price <= MAX_BASE_PRICE);
        let quote = quote_in_cohort(&Schedule { base_price, rules, cap_bps, cohort }, &revealed, |_| cohort_k);
        if merchant == choice {
            assert!(chosen.is_none());
            chosen = Some(quote.price);
        }
        cheapest = cheapest.min(quote.price);
    }
    let code_price = chosen.expect("the chosen merchant is not in the list");
    assert!(code_price == price);
    assert!(code_price <= budget);
    assert!(code_price == cheapest);
    (choice, code_price)
}
