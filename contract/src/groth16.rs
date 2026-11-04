//! Groth16 (BN254) verification of a Semaphore v4 proof with NEAR's alt_bn128 host
//! functions. The verification keys are Semaphore's (V4 ceremony), committed in
//! `fixtures/semaphore/verification-key.json` and compiled in, so the owner cannot swap
//! them. Encoding for the host functions: little-endian 32-byte limbs; an Fq2 element is
//! (real, imaginary), which is snarkjs' `[c0, c1]` order.
use bookerbob_core::semaphore::dec_to_le32;
use near_sdk::env;
use serde::Deserialize;

const VK_JSON: &str = include_str!("../../fixtures/semaphore/verification-key.json");
/// BN254 base field modulus (for negating a G1 point), little-endian.
const FQ_MODULUS_DEC: &str = "21888242871839275222246405745257275088696311157297823662689037894645226208583";

#[derive(Deserialize)]
struct DepthKey {
    vk_delta_2: [[String; 2]; 3],
    #[serde(rename = "IC")]
    ic: Vec<[String; 3]>,
}

#[derive(Deserialize)]
struct Vk {
    vk_alpha_1: [String; 3],
    vk_beta_2: [[String; 2]; 3],
    vk_gamma_2: [[String; 2]; 3],
    by_depth: std::collections::BTreeMap<String, DepthKey>,
}

fn le(s: &str) -> Option<[u8; 32]> {
    dec_to_le32(s)
}

fn g1(x: &str, y: &str) -> Option<Vec<u8>> {
    let mut v = le(x)?.to_vec();
    v.extend(le(y)?);
    Some(v)
}

/// snarkjs G2 `[[x_c0, x_c1], [y_c0, y_c1]]` to NEAR's (x.re, x.im, y.re, y.im).
fn g2(p: &[[String; 2]]) -> Option<Vec<u8>> {
    let mut v = Vec::with_capacity(128);
    for c in [&p[0][0], &p[0][1], &p[1][0], &p[1][1]] {
        v.extend(le(c)?);
    }
    Some(v)
}

/// p - y, little-endian (y < p).
fn neg_fq(y: &[u8; 32]) -> [u8; 32] {
    if y.iter().all(|b| *b == 0) {
        return *y;
    }
    let p = le(FQ_MODULUS_DEC).expect("modulus");
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in 0..32 {
        let d = p[i] as i16 - y[i] as i16 - borrow;
        borrow = (d < 0) as i16;
        out[i] = (d + 256 * borrow) as u8;
    }
    out
}

/// A Semaphore proof: 8 packed points (Solidity order) and its tree depth.
pub struct SemaphoreProof<'a> {
    pub depth: u32,
    pub points: &'a [String; 8],
}

/// Verify against the public signals `[merkleRoot, nullifier, message, scope]` (decimal).
/// Err for malformed input; Ok(false) for a proof that does not verify.
pub fn verify(proof: &SemaphoreProof, public: [&str; 4]) -> Result<bool, &'static str> {
    let vk: Vk = serde_json::from_str(VK_JSON).map_err(|_| "verification key")?;
    let dk = vk.by_depth.get(&proof.depth.to_string()).ok_or("no verification key for this tree depth")?;
    if dk.ic.len() != 5 {
        return Err("verification key shape");
    }
    // vk_x = IC0 + sum(IC_i * s_i), one multiexp (IC0 with scalar 1).
    let mut me = Vec::with_capacity(5 * 96);
    let one = {
        let mut o = [0u8; 32];
        o[0] = 1;
        o
    };
    me.extend(g1(&dk.ic[0][0], &dk.ic[0][1]).ok_or("ic")?);
    me.extend(one);
    for (i, s) in public.iter().enumerate() {
        me.extend(g1(&dk.ic[i + 1][0], &dk.ic[i + 1][1]).ok_or("ic")?);
        me.extend(le(s).ok_or("public signal is not a decimal")?);
    }
    let vk_x = env::alt_bn128_g1_multiexp(&me);
    let p = proof.points;
    // A, negated: e(-A, B) e(alpha, beta) e(vk_x, gamma) e(C, delta) == 1.
    let ay = neg_fq(&le(&p[1]).ok_or("proof point")?);
    let mut pairs = Vec::with_capacity(4 * 192);
    pairs.extend(le(&p[0]).ok_or("proof point")?);
    pairs.extend(ay);
    pairs.extend(g2(&[[p[3].clone(), p[2].clone()], [p[5].clone(), p[4].clone()]]).ok_or("proof point")?);
    pairs.extend(g1(&vk.vk_alpha_1[0], &vk.vk_alpha_1[1]).ok_or("alpha")?);
    pairs.extend(g2(&vk.vk_beta_2).ok_or("beta")?);
    pairs.extend(vk_x);
    pairs.extend(g2(&vk.vk_gamma_2).ok_or("gamma")?);
    pairs.extend(g1(&p[6], &p[7]).ok_or("proof point")?);
    pairs.extend(g2(&dk.vk_delta_2).ok_or("delta")?);
    Ok(env::alt_bn128_pairing_check(&pairs))
}

#[cfg(test)]
mod tests {
    use super::*;

    const REVIEWS: &str = include_str!("../../fixtures/semaphore/reviews.json");

    fn check(p: &serde_json::Value) -> Result<bool, &'static str> {
        let pts: Vec<String> = p["points"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let pts: [String; 8] = pts.try_into().unwrap();
        let mut m = dec_to_le32(p["message"].as_str().unwrap()).unwrap();
        m.reverse();
        let mut s = dec_to_le32(p["scope"].as_str().unwrap()).unwrap();
        s.reverse();
        let (mh, sh) = (bookerbob_core::semaphore::semaphore_hash(&m), bookerbob_core::semaphore::semaphore_hash(&s));
        verify(
            &SemaphoreProof { depth: p["merkleTreeDepth"].as_u64().unwrap() as u32, points: &pts },
            [p["merkleTreeRoot"].as_str().unwrap(), p["nullifier"].as_str().unwrap(), &mh, &sh],
        )
    }

    #[test]
    fn semaphore_proofs_verify_on_the_alt_bn128_host_functions() {
        near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
        let r: serde_json::Value = serde_json::from_str(REVIEWS).unwrap();
        for p in r["proofs"].as_array().unwrap() {
            assert_eq!(check(&p["proof"]), Ok(true));
        }
        // Host gas for 6 checks in one context, mostly alt_bn128 (see docs/evidence.md).
        println!("groth16 host gas per proof: {:.2} Tgas", near_sdk::env::used_gas().as_gas() as f64 / 6e12);
        assert_eq!(check(&r["non_member"]), Ok(true), "valid, just for another group");
    }

    #[test]
    fn a_changed_public_signal_fails_the_pairing() {
        near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
        let r: serde_json::Value = serde_json::from_str(REVIEWS).unwrap();
        let mut p = r["proofs"][0]["proof"].clone();
        p["nullifier"] = serde_json::Value::String("12345".into());
        assert_eq!(check(&p), Ok(false));
    }
}
