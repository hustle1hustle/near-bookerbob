//! Semaphore v4 pieces the bazaar needs, matching the JS packages bit for bit:
//! Poseidon(2) with circomlib parameters, the LeanIMT group tree, and the message and
//! scope hashing (`keccak256(x as 32 bytes) >> 8`). Field elements travel as decimal
//! strings, as Semaphore writes them. The Groth16 check itself is in the contract, on the
//! alt_bn128 host functions. See docs/semaphore.md.
use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use borsh::{BorshDeserialize, BorshSerialize};
use light_poseidon::{Poseidon, PoseidonHasher};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

/// Decimal string to a 32-byte little-endian integer. None if not a decimal below 2^256.
pub fn dec_to_le32(s: &str) -> Option<[u8; 32]> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut limbs = [0u64; 4];
    for d in s.bytes() {
        let mut carry = (d - b'0') as u128;
        for l in limbs.iter_mut() {
            let v = (*l as u128) * 10 + carry;
            *l = v as u64;
            carry = v >> 64;
        }
        if carry != 0 {
            return None;
        }
    }
    let mut out = [0u8; 32];
    for (i, l) in limbs.iter().enumerate() {
        out[i * 8..i * 8 + 8].copy_from_slice(&l.to_le_bytes());
    }
    Some(out)
}

fn fr(s: &str) -> Option<Fr> {
    let le = dec_to_le32(s)?;
    let f = Fr::from_le_bytes_mod_order(&le);
    // Reject values at or above the field modulus instead of reducing them.
    (f.into_bigint().to_bytes_le() == le.to_vec()).then_some(f)
}

/// True for the one canonical decimal form of a field element: no leading zeros, below the
/// modulus. A nullifier or root compared as a string must be canonical, or "0123" and "123"
/// would be the same field element under two different strings.
pub fn is_canonical_field(s: &str) -> bool {
    fr(s).is_some_and(|f| dec(f) == s)
}

fn dec(f: Fr) -> String {
    f.into_bigint().to_string()
}

/// Poseidon(2), circomlib parameters (Semaphore's commitments and tree nodes).
pub fn poseidon2(a: &str, b: &str) -> Option<String> {
    let mut h = Poseidon::<Fr>::new_circom(2).ok()?;
    h.hash(&[fr(a)?, fr(b)?]).ok().map(dec)
}

/// Semaphore's off-circuit hash: keccak256 of the 32-byte big-endian value, shifted right
/// by 8 bits so it fits the SNARK field.
pub fn semaphore_hash(x32_be: &[u8; 32]) -> String {
    let mut h: [u8; 32] = Keccak256::digest(x32_be).into();
    // >> 8 on a big-endian 256-bit number: drop the last byte, shift in a zero byte.
    h.copy_within(0..31, 1);
    h[0] = 0;
    h.reverse();
    Fr::from_le_bytes_mod_order(&h).into_bigint().to_string()
}

/// The sealed rating, hex: sha256(json([rating, delivered, reason_hash, salt])). Posted
/// during the round; the rating itself is revealed only after the round closes.
pub fn review_seal(rating: u8, delivered: bool, reason_hash: &str, salt: &str) -> String {
    crate::sha256_hex(&serde_json::to_vec(&(rating, delivered, reason_hash, salt)).expect("serializes"))
}

/// The Semaphore message for a sealed rating (hex, 32 bytes): Semaphore's hash of it.
pub fn review_message(sealed_hex: &str) -> Option<String> {
    let b: [u8; 32] = hex::decode(sealed_hex).ok()?.try_into().ok()?;
    Some(semaphore_hash(&b))
}

/// The review scope: one rating per member per merchant per round.
pub fn review_scope(merchant: &str, round: u64) -> String {
    semaphore_hash(&crate::sha256(format!("bookerbob/review/v0|{merchant}|{round}").as_bytes()))
}

/// LeanIMT (zk-kit), the tree Semaphore v4 groups use: a node is Poseidon(left, right);
/// a lone left child is carried up unhashed. Keeps only the side nodes, so an insert is
/// at most `depth` hashes.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct LeanImt {
    pub size: u64,
    pub depth: u32,
    pub side_nodes: Vec<String>,
    pub root: String,
}

impl LeanImt {
    pub fn insert(&mut self, leaf: &str) -> Result<String, &'static str> {
        fr(leaf).ok_or("leaf is not a field element")?;
        let index = self.size;
        let mut depth = self.depth;
        if (1u64 << depth) < index + 1 {
            depth += 1;
        }
        self.depth = depth;
        if self.side_nodes.len() < depth as usize + 1 {
            self.side_nodes.resize(depth as usize + 1, "0".into());
        }
        let mut node = leaf.to_string();
        for level in 0..depth {
            if (index >> level) & 1 == 1 {
                node = poseidon2(&self.side_nodes[level as usize], &node).ok_or("poseidon")?;
            } else {
                self.side_nodes[level as usize] = node.clone();
            }
        }
        self.size = index + 1;
        self.side_nodes[depth as usize] = node.clone();
        self.root = node.clone();
        Ok(node)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTORS: &str = include_str!("../../fixtures/semaphore/poseidon-vectors.json");
    const GROUP: &str = include_str!("../../fixtures/semaphore/group.json");
    const REVIEWS: &str = include_str!("../../fixtures/semaphore/reviews.json");

    #[test]
    fn poseidon_matches_circomlib_vectors() {
        let v: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        for c in v.as_array().unwrap() {
            let i = c["inputs"].as_array().unwrap();
            assert_eq!(poseidon2(i[0].as_str().unwrap(), i[1].as_str().unwrap()).unwrap(), c["output"].as_str().unwrap());
        }
    }

    #[test]
    fn lean_imt_roots_match_the_semaphore_group_after_every_insert() {
        let g: serde_json::Value = serde_json::from_str(GROUP).unwrap();
        let mut t = LeanImt::default();
        for (m, r) in g["members"].as_array().unwrap().iter().zip(g["roots_after_each_insert"].as_array().unwrap()) {
            assert_eq!(t.insert(m.as_str().unwrap()).unwrap(), r.as_str().unwrap());
        }
        assert_eq!(t.depth, 3);
    }

    #[test]
    fn sealed_message_and_scope_hashing_match_the_proofs() {
        let r: serde_json::Value = serde_json::from_str(REVIEWS).unwrap();
        let scope = review_scope(r["merchant"].as_str().unwrap(), r["round"].as_u64().unwrap());
        for p in r["proofs"].as_array().unwrap() {
            let (rv, pf) = (&p["review"], &p["proof"]);
            // The JS proof carries the preimages; the circuit saw their Semaphore hashes.
            let sealed = review_seal(
                rv["rating"].as_u64().unwrap() as u8,
                rv["delivered"].as_bool().unwrap(),
                rv["reason_hash"].as_str().unwrap(),
                rv["salt"].as_str().unwrap(),
            );
            assert_eq!(sealed, rv["sealed"].as_str().unwrap());
            let pre: [u8; 32] = hex::decode(&sealed).unwrap().try_into().unwrap();
            let mut m = dec_to_le32(pf["message"].as_str().unwrap()).unwrap();
            m.reverse();
            assert_eq!(m, pre);
            assert_eq!(review_message(&sealed).unwrap(), semaphore_hash(&pre));
            let mut sc = dec_to_le32(pf["scope"].as_str().unwrap()).unwrap();
            sc.reverse();
            assert_eq!(semaphore_hash(&sc), scope);
        }
    }

    #[test]
    fn only_the_canonical_decimal_is_canonical() {
        assert!(is_canonical_field("123"));
        assert!(is_canonical_field("0"));
        assert!(!is_canonical_field("0123"));
        assert!(!is_canonical_field("00"));
        assert!(!is_canonical_field("21888242871839275222246405745257275088548364400416034343698204186575808495617"));
    }

    #[test]
    fn values_at_or_above_the_field_are_refused() {
        let r = "21888242871839275222246405745257275088548364400416034343698204186575808495617";
        assert!(poseidon2(r, "1").is_none());
        assert!(dec_to_le32("12a").is_none());
        assert!(dec_to_le32(&"9".repeat(80)).is_none());
    }
}
