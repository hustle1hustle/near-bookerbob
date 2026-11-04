//! Sealed referee input: the proof set and claims go to the worker encrypted, so the
//! `input_data` of `request_referee` (public tx args) carries only ciphertext and a commitment.
//!
//! The worker's X25519 key is derived from its signing seed (`REFEREE_SIGNING_SEED`), so the
//! same secret serves both. Sealing: an ephemeral X25519 key, `HKDF-SHA256(shared, salt =
//! epk || worker_pk, info = TAG)` to a 32-byte key, XChaCha20-Poly1305 with a random 24-byte
//! nonce, and `commitment = sha256(plaintext)`, checked by the worker after opening.
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

pub const TAG: &[u8] = b"bookerbob/sealed-referee-input/v0";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SealedInput {
    pub v: u8,
    /// Ephemeral X25519 public key, hex.
    pub epk: String,
    /// 24-byte nonce, hex.
    pub nonce: String,
    /// Ciphertext with its Poly1305 tag, hex.
    pub ct: String,
    /// sha256 of the plaintext input, hex: binds the receipt to what was judged.
    pub commitment: String,
}

fn secret_from_seed(seed: &[u8; 32]) -> StaticSecret {
    let mut h = Sha256::new();
    h.update(b"bookerbob/referee-x25519/v0");
    h.update(seed);
    StaticSecret::from(<[u8; 32]>::from(h.finalize()))
}

/// The worker's X25519 public key, hex: what a buyer seals to.
pub fn public_hex(seed: &[u8; 32]) -> String {
    hex::encode(PublicKey::from(&secret_from_seed(seed)).as_bytes())
}

fn key(shared: &[u8; 32], epk: &[u8; 32], wpk: &[u8; 32]) -> [u8; 32] {
    let mut salt = epk.to_vec();
    salt.extend_from_slice(wpk);
    let mut k = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared).expand(TAG, &mut k).expect("32 bytes");
    k
}

/// Seal `plaintext` to the worker key `worker_pk_hex`. `eph` and `nonce` come from the caller's
/// randomness (fixed in tests).
pub fn seal(worker_pk_hex: &str, plaintext: &[u8], eph: [u8; 32], nonce: [u8; 24]) -> Result<SealedInput, String> {
    let wpk: [u8; 32] = hex::decode(worker_pk_hex).ok().and_then(|b| b.try_into().ok()).ok_or("bad worker key")?;
    let es = StaticSecret::from(eph);
    let epk = PublicKey::from(&es);
    let shared = es.diffie_hellman(&PublicKey::from(wpk));
    let k = key(shared.as_bytes(), epk.as_bytes(), &wpk);
    let ct = XChaCha20Poly1305::new(&k.into()).encrypt(XNonce::from_slice(&nonce), plaintext).map_err(|_| "seal failed")?;
    Ok(SealedInput {
        v: 0,
        epk: hex::encode(epk.as_bytes()),
        nonce: hex::encode(nonce),
        ct: hex::encode(ct),
        commitment: hex::encode(Sha256::digest(plaintext)),
    })
}

/// Open with the worker's seed; the plaintext must hash to the commitment.
pub fn open(s: &SealedInput, seed: &[u8; 32]) -> Result<Vec<u8>, String> {
    if s.v != 0 {
        return Err("unsupported sealed input".into());
    }
    let sk = secret_from_seed(seed);
    let wpk = PublicKey::from(&sk);
    let epk: [u8; 32] = hex::decode(&s.epk).ok().and_then(|b| b.try_into().ok()).ok_or("bad epk")?;
    let nonce: [u8; 24] = hex::decode(&s.nonce).ok().and_then(|b| b.try_into().ok()).ok_or("bad nonce")?;
    let shared = sk.diffie_hellman(&PublicKey::from(epk));
    let k = key(shared.as_bytes(), &epk, wpk.as_bytes());
    let pt = XChaCha20Poly1305::new(&k.into())
        .decrypt(XNonce::from_slice(&nonce), hex::decode(&s.ct).map_err(|_| "bad ct")?.as_slice())
        .map_err(|_| "sealed input does not open with this worker key")?;
    if hex::encode(Sha256::digest(&pt)) != s.commitment {
        return Err("sealed input does not match its commitment".into());
    }
    Ok(pt)
}

#[cfg(test)]
mod tests {
    use super::*;
    const SEED: [u8; 32] = [5u8; 32];

    #[test]
    fn seal_then_open_round_trips() {
        let s = seal(&public_hex(&SEED), b"{\"proofs\":\"secret facts\"}", [9u8; 32], [1u8; 24]).unwrap();
        assert!(!s.ct.contains(&hex::encode("secret")), "no plaintext in the ciphertext");
        assert_eq!(open(&s, &SEED).unwrap(), b"{\"proofs\":\"secret facts\"}");
    }

    #[test]
    fn another_worker_key_cannot_open() {
        let s = seal(&public_hex(&SEED), b"x", [9u8; 32], [1u8; 24]).unwrap();
        assert!(open(&s, &[6u8; 32]).unwrap_err().contains("does not open"));
    }

    #[test]
    fn a_tampered_ciphertext_or_commitment_is_refused() {
        let mut s = seal(&public_hex(&SEED), b"abc", [9u8; 32], [1u8; 24]).unwrap();
        let mut t = s.clone();
        t.ct.replace_range(0..2, if &t.ct[0..2] == "00" { "01" } else { "00" });
        assert!(open(&t, &SEED).is_err());
        s.commitment = "00".repeat(32);
        assert!(open(&s, &SEED).unwrap_err().contains("commitment"));
    }
}
