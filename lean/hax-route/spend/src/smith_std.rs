//! Fixed helpers a smith program may call (part of the template, not written by the model).
//! gap-hax: under `hax_compilation` (set by hax/charon only), `commit` keeps its name and call
//! shape but drops the `Serialize` bound, so extraction does not pull serde into Lean. It is
//! declared opaque at extraction, i.e. Lean sees an uninterpreted function of (tag, value),
//! exactly what the Spec's `CommitFn` already assumes. The Jolt build uses the real body below.
use alloc::vec::Vec;
#[cfg(not(hax_compilation))]
use serde::Serialize;
#[cfg(not(hax_compilation))]
use sha2::{Digest, Sha256};

#[cfg(not(hax_compilation))]
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// sha256(tag || postcard(value)): the one commitment form specs use.
#[cfg(not(hax_compilation))]
pub fn commit<T: Serialize + ?Sized>(tag: &str, value: &T) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(tag.as_bytes());
    let body: Vec<u8> = postcard::to_allocvec(value).unwrap_or_default();
    h.update(&body);
    h.finalize().into()
}

#[cfg(hax_compilation)]
pub fn commit<T: ?Sized>(_tag: &str, _value: &T) -> [u8; 32] {
    let _: Vec<u8> = Vec::new();
    [0u8; 32] // body never extracted: `--opaque <crate>::smith_std::commit`
}
