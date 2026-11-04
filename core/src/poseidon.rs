//! Poseidon(2) over the BN254 scalar field, circomlib parameters, without arkworks.
//!
//! The light-poseidon crate compiles in the round constants for every width from 2 to 13
//! (about 1.4 MB of contract wasm, over NEAR's transaction size limit); Semaphore only needs
//! width 3. This is the same permutation (domain tag 0, 4 full, 57 partial, 4 full rounds,
//! x^5 S-box, MDS mix) over 4 x 64-bit limbs in Montgomery form. The constants are in
//! `poseidon_params.rs`. Tests: the circomlib vectors and every Semaphore group root.
use crate::poseidon_params::{ARK, INV, MDS, R, R2};

pub type Fe = [u64; 4];

const WIDTH: usize = 3;
const FULL: usize = 8;
const PARTIAL: usize = 57;

fn geq(a: &Fe, b: &Fe) -> bool {
    for i in (0..4).rev() {
        if a[i] != b[i] {
            return a[i] > b[i];
        }
    }
    true
}

fn sub(a: &Fe, b: &Fe) -> Fe {
    let mut out = [0u64; 4];
    let mut borrow = 0u64;
    for i in 0..4 {
        let (d1, b1) = a[i].overflowing_sub(b[i]);
        let (d2, b2) = d1.overflowing_sub(borrow);
        out[i] = d2;
        borrow = (b1 | b2) as u64;
    }
    out
}

fn add(a: &Fe, b: &Fe) -> Fe {
    let mut out = [0u64; 4];
    let mut carry = 0u128;
    for i in 0..4 {
        let s = a[i] as u128 + b[i] as u128 + carry;
        out[i] = s as u64;
        carry = s >> 64;
    }
    // r < 2^254, so a + b < 2^255 never overflows 256 bits.
    if geq(&out, &R) {
        sub(&out, &R)
    } else {
        out
    }
}

/// Montgomery product a * b * 2^-256 mod r (CIOS). Indexed loops mirror the textbook form.
#[allow(clippy::needless_range_loop)]
fn mul(a: &Fe, b: &Fe) -> Fe {
    let mut t = [0u64; 6];
    for i in 0..4 {
        let mut c: u128 = 0;
        for j in 0..4 {
            let x = t[j] as u128 + a[j] as u128 * b[i] as u128 + c;
            t[j] = x as u64;
            c = x >> 64;
        }
        let x = t[4] as u128 + c;
        t[4] = x as u64;
        t[5] = (x >> 64) as u64;
        let m = t[0].wrapping_mul(INV);
        let x = t[0] as u128 + m as u128 * R[0] as u128;
        let mut c = x >> 64;
        for j in 1..4 {
            let x = t[j] as u128 + m as u128 * R[j] as u128 + c;
            t[j - 1] = x as u64;
            c = x >> 64;
        }
        let x = t[4] as u128 + c;
        t[3] = x as u64;
        t[4] = t[5] + (x >> 64) as u64;
    }
    let out = [t[0], t[1], t[2], t[3]];
    if t[4] != 0 || geq(&out, &R) {
        sub(&out, &R)
    } else {
        out
    }
}

/// Canonical little-endian limbs below r, or None.
pub fn from_le_bytes(le: &[u8; 32]) -> Option<Fe> {
    let mut v = [0u64; 4];
    for (i, limb) in v.iter_mut().enumerate() {
        *limb = u64::from_le_bytes(le[i * 8..i * 8 + 8].try_into().unwrap());
    }
    (!geq(&v, &R)).then_some(v)
}

/// Decimal string of a canonical value.
pub fn to_decimal(v: &Fe) -> String {
    let mut n = *v;
    if n == [0; 4] {
        return "0".into();
    }
    let mut digits = Vec::new();
    while n != [0; 4] {
        let mut rem: u128 = 0;
        for i in (0..4).rev() {
            let cur = (rem << 64) | n[i] as u128;
            n[i] = (cur / 10) as u64;
            rem = cur % 10;
        }
        digits.push(b'0' + rem as u8);
    }
    digits.reverse();
    String::from_utf8(digits).expect("ascii digits")
}

fn sbox(x: &Fe) -> Fe {
    let x2 = mul(x, x);
    let x4 = mul(&x2, &x2);
    mul(&x4, x)
}

/// Poseidon(a, b) on canonical inputs, canonical output.
pub fn hash2(a: &Fe, b: &Fe) -> Fe {
    let mut s = [[0u64; 4], mul(a, &R2), mul(b, &R2)];
    for round in 0..FULL + PARTIAL {
        for (i, x) in s.iter_mut().enumerate() {
            *x = add(x, &ARK[round * WIDTH + i]);
        }
        if !(FULL / 2..FULL / 2 + PARTIAL).contains(&round) {
            for x in s.iter_mut() {
                *x = sbox(x);
            }
        } else {
            s[0] = sbox(&s[0]);
        }
        let mut next = [[0u64; 4]; WIDTH];
        for (i, row) in MDS.iter().enumerate() {
            for (j, m) in row.iter().enumerate() {
                next[i] = add(&next[i], &mul(&s[j], m));
            }
        }
        s = next;
    }
    // Out of Montgomery form: multiply by 1.
    mul(&s[0], &[1, 0, 0, 0])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn montgomery_one_round_trips() {
        use crate::poseidon_params::ONE;
        let x: Fe = [12345, 0, 0, 0];
        let m = mul(&x, &R2);
        assert_eq!(mul(&m, &[1, 0, 0, 0]), x);
        assert_eq!(mul(&ONE, &[1, 0, 0, 0]), [1, 0, 0, 0]);
    }

    #[test]
    fn decimal_and_bounds() {
        assert_eq!(to_decimal(&[0, 0, 0, 0]), "0");
        assert_eq!(to_decimal(&[123, 0, 0, 0]), "123");
        assert_eq!(to_decimal(&[0, 1, 0, 0]), "18446744073709551616");
        let mut r = [0u8; 32];
        for (i, limb) in R.iter().enumerate() {
            r[i * 8..i * 8 + 8].copy_from_slice(&limb.to_le_bytes());
        }
        assert!(from_le_bytes(&r).is_none(), "r itself is not canonical");
    }
}
