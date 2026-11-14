//! The smith template's body-lib (`zk/smith/template/body-lib.rs.tmpl`) without the spec hash:
//! exact postcard decoding, `body::check`, encoded output.
#![no_std]
#![forbid(unsafe_code)]
extern crate alloc;
use alloc::vec::Vec;

pub mod body;
pub mod commits;
pub mod smith_std;
pub mod types;

fn exact<'a, T: serde::Deserialize<'a>>(bytes: &'a [u8], what: &'static str) -> Result<T, &'static str> {
    match postcard::take_from_bytes::<T>(bytes) {
        Ok((v, rest)) if rest.is_empty() => Ok(v),
        _ => Err(what),
    }
}

/// decode, check, encode: `Ok(output bytes)` or the refusal string.
pub fn run(public: &[u8], private: &[u8]) -> Result<Vec<u8>, &'static str> {
    let p: types::Public = exact(public, "public input does not decode")?;
    let s: types::Private = exact(private, "private input does not decode")?;
    let out = body::check(&p, &s)?;
    postcard::to_allocvec(&out).map_err(|_| "output does not encode")
}
