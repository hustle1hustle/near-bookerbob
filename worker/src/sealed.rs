//! Sealed referee input: the proof set and claims go to the worker encrypted, so the
//! `input_data` of `request_referee` (public tx args) carries only ciphertext and a commitment.
//!
//! The worker's X25519 key is derived from its signing seed (`REFEREE_SIGNING_SEED`), so the
//! same secret serves both. Sealing: an ephemeral X25519 key, `HKDF-SHA256(shared, salt =
//! epk || worker_pk, info = TAG)` to a 32-byte key, XChaCha20-Poly1305 with a random 24-byte
//! nonce, and `commitment = sha256(plaintext)`, checked by the worker after opening.
//!
//! v1 (post-quantum hybrid, X-Wing style): the worker key is also an ML-KEM-768 encapsulation
//! key (FIPS 203, RustCrypto `ml-kem`), derived from the same seed. The sealer encapsulates to
//! it and both shared secrets go into HKDF (`ikm = ss_mlkem || ss_x25519`), with the KEM
//! ciphertext's hash, the ephemeral key and the worker's X25519 key in the salt. Breaking v1
//! needs breaking both X25519 and ML-KEM-768. A v1 worker key is written `pq1:<x25519><mlkem>`
//! in hex. v0 inputs still open.
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use ml_kem::{Decapsulate, DecapsulationKey768, EncapsulationKey768, KeyExport, Seed, B32};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

pub const TAG: &[u8] = b"bookerbob/sealed-referee-input/v0";
pub const TAG_V1: &[u8] = b"bookerbob/sealed-referee-input/v1-xwing";
/// A v1 (hybrid) worker key: `pq1:` then the X25519 key and the ML-KEM-768 encapsulation key, hex.
pub const PQ1: &str = "pq1:";
const X25519_LEN: usize = 32;

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
    /// v1: the ML-KEM-768 ciphertext, hex.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kem_ct: Option<String>,
}

fn mlkem_from_seed(seed: &[u8; 32]) -> DecapsulationKey768 {
    let mut h = sha2::Sha512::new();
    h.update(b"bookerbob/referee-mlkem768/v1");
    h.update(seed);
    let d: [u8; 64] = h.finalize().into();
    DecapsulationKey768::from_seed(Seed::from(d))
}

/// The worker's v1 (hybrid) public key: `pq1:` + X25519 + ML-KEM-768, hex.
pub fn public_hex_v1(seed: &[u8; 32]) -> String {
    let ek = mlkem_from_seed(seed).encapsulation_key().to_bytes();
    format!("{PQ1}{}{}", public_hex(seed), hex::encode(ek.as_slice()))
}

fn key_v1(ss_kem: &[u8], ss_x: &[u8; 32], kem_ct: &[u8], epk: &[u8; 32], wpk: &[u8; 32]) -> [u8; 32] {
    let mut salt = Sha256::digest(kem_ct).to_vec();
    salt.extend_from_slice(epk);
    salt.extend_from_slice(wpk);
    let mut ikm = ss_kem.to_vec();
    ikm.extend_from_slice(ss_x);
    let mut k = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), &ikm).expand(TAG_V1, &mut k).expect("32 bytes");
    k
}

/// Seal to a v1 worker key. `eph`, `m` (the KEM randomness) and `nonce` come from the caller.
pub fn seal_v1(worker_pq_hex: &str, plaintext: &[u8], eph: [u8; 32], m: [u8; 32], nonce: [u8; 24]) -> Result<SealedInput, String> {
    let raw = hex::decode(worker_pq_hex.strip_prefix(PQ1).ok_or("not a pq1 worker key")?).map_err(|_| "bad worker key")?;
    if raw.len() <= X25519_LEN {
        return Err("bad worker key".into());
    }
    let wpk: [u8; 32] = raw[..X25519_LEN].try_into().expect("32");
    let ek_bytes = ml_kem::Key::<EncapsulationKey768>::try_from(&raw[X25519_LEN..]).map_err(|_| "bad ML-KEM key length")?;
    let ek = EncapsulationKey768::new(&ek_bytes).map_err(|_| "bad ML-KEM key")?;
    let (kem_ct, ss_kem) = ek.encapsulate_deterministic(&B32::from(m));
    let es = StaticSecret::from(eph);
    let epk = PublicKey::from(&es);
    let shared = es.diffie_hellman(&PublicKey::from(wpk));
    let k = key_v1(ss_kem.as_slice(), shared.as_bytes(), kem_ct.as_slice(), epk.as_bytes(), &wpk);
    let ct = XChaCha20Poly1305::new(&k.into()).encrypt(XNonce::from_slice(&nonce), plaintext).map_err(|_| "seal failed")?;
    Ok(SealedInput {
        v: 1,
        epk: hex::encode(epk.as_bytes()),
        nonce: hex::encode(nonce),
        ct: hex::encode(ct),
        commitment: hex::encode(Sha256::digest(plaintext)),
        kem_ct: Some(hex::encode(kem_ct.as_slice())),
    })
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
        kem_ct: None,
    })
}

/// Open with the worker's seed; the plaintext must hash to the commitment. v0 and v1.
pub fn open(s: &SealedInput, seed: &[u8; 32]) -> Result<Vec<u8>, String> {
    let sk = secret_from_seed(seed);
    let wpk = PublicKey::from(&sk);
    let epk: [u8; 32] = hex::decode(&s.epk).ok().and_then(|b| b.try_into().ok()).ok_or("bad epk")?;
    let nonce: [u8; 24] = hex::decode(&s.nonce).ok().and_then(|b| b.try_into().ok()).ok_or("bad nonce")?;
    let shared = sk.diffie_hellman(&PublicKey::from(epk));
    let k = match (s.v, &s.kem_ct) {
        (0, None) => key(shared.as_bytes(), &epk, wpk.as_bytes()),
        (1, Some(kc)) => {
            let raw = hex::decode(kc).map_err(|_| "bad kem_ct")?;
            let c = ml_kem::Ciphertext::<ml_kem::MlKem768>::try_from(raw.as_slice()).map_err(|_| "bad kem_ct length")?;
            let ss = mlkem_from_seed(seed).decapsulate(&c);
            key_v1(ss.as_slice(), shared.as_bytes(), &raw, &epk, wpk.as_bytes())
        }
        _ => return Err("unsupported sealed input".into()),
    };
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
    fn a_hybrid_v1_input_round_trips_and_carries_an_ml_kem_ciphertext() {
        let pk = public_hex_v1(&SEED);
        assert!(pk.starts_with(PQ1) && pk.len() == PQ1.len() + 2 * (32 + 1184), "X25519 + ML-KEM-768 encapsulation key");
        let s = seal_v1(&pk, b"{\"proofs\":\"secret facts\"}", [9u8; 32], [3u8; 32], [1u8; 24]).unwrap();
        assert_eq!((s.v, s.kem_ct.as_ref().map(|k| k.len())), (1, Some(2 * 1088)));
        assert_eq!(open(&s, &SEED).unwrap(), b"{\"proofs\":\"secret facts\"}");
        assert!(open(&s, &[6u8; 32]).is_err(), "another worker cannot open");
    }

    #[test]
    fn v1_needs_both_secrets_a_swapped_kem_ciphertext_or_a_v0_downgrade_fails() {
        let pk = public_hex_v1(&SEED);
        let a = seal_v1(&pk, b"abc", [9u8; 32], [3u8; 32], [1u8; 24]).unwrap();
        let b = seal_v1(&pk, b"abc", [9u8; 32], [4u8; 32], [1u8; 24]).unwrap();
        // Same X25519 exchange, another ML-KEM encapsulation: the key differs, so it cannot open.
        let mut mixed = a.clone();
        mixed.kem_ct = b.kem_ct.clone();
        assert!(open(&mixed, &SEED).is_err());
        let mut down = a.clone();
        down.v = 0;
        down.kem_ct = None;
        assert!(open(&down, &SEED).is_err(), "stripping the KEM part does not give a v0 that opens");
        let mut odd = a;
        odd.kem_ct = None;
        assert!(open(&odd, &SEED).unwrap_err().contains("unsupported"));
    }

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
