#![cfg_attr(feature = "guest", no_std)]
#![no_main]

// The binary Jolt builds and proves (named after the package, as the host expects); the
// provable function lives in the library.
#[allow(unused_imports)]
use cohort_guest::*;
