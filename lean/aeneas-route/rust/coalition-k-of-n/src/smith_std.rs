//! Fixed helpers a smith program may call (part of the template, not written by the model).
use alloc::vec::Vec;
use serde::Serialize;
use sha2::{Digest, Sha256};

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// sha256(tag || postcard(value)): the one commitment form specs use.
pub fn commit<T: Serialize + ?Sized>(tag: &str, value: &T) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(tag.as_bytes());
    let body: Vec<u8> = postcard::to_allocvec(value).unwrap_or_default();
    h.update(&body);
    h.finalize().into()
}
