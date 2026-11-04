//! Verdict envelope v0. See docs/envelope.md for the field-by-field spec.
use serde::{Deserialize, Serialize};

pub const DOMAIN_TAG: &[u8] = b"bookerbob/verdict/v0\x00";
pub const COMMIT_TAG: &[u8] = b"bookerbob/commit/v0\x00";
pub const NEAR_AI_BIND_TAG: &[u8] = b"bookerbob/near-ai-bind/v0\x00";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attestation {
    /// Model id the verdict was computed with, e.g. `z-ai/glm-5.3-flash`.
    pub model: String,
    /// TCB status as reported by the attestation (`UpToDate`, `OutOfDate`, ...). Recorded,
    /// never hidden; the consumer picks the policy. `fixture` in offline fixtures.
    pub tcb_status: String,
    /// sha256 of the attestation report the issuer checked.
    pub report_hash: String,
}

/// Intel TDX TCB status, ordered: higher is better. The DCAP names (dcap-qvl, Intel PCS).
/// None for anything else, including the offline `fixture` status.
pub fn tcb_rank(status: &str) -> Option<u8> {
    Some(match status {
        "UpToDate" => 4,
        "SWHardeningNeeded" => 3,
        "ConfigurationNeeded" | "ConfigurationAndSWHardeningNeeded" => 2,
        "OutOfDate" | "OutOfDateConfigurationNeeded" => 1,
        "Revoked" => 0,
        _ => return None,
    })
}

/// True when `status` meets `min` (both DCAP names). `fixture` (synthetic, offline and testnet
/// demo) passes only when `allow_fixture`; any unknown status fails.
pub fn tcb_meets(status: &str, min: &str, allow_fixture: bool) -> bool {
    if status == "fixture" {
        return allow_fixture;
    }
    match (tcb_rank(status), tcb_rank(min)) {
        (Some(s), Some(m)) => s >= m && s > 0,
        _ => false,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u8,
    /// Purchase context; the nullifier is per context.
    pub context: String,
    /// Per-context account nullifier (hex, 32 bytes).
    pub nullifier: String,
    /// Commitment to the full derived predicate set (hex, 32 bytes).
    pub commitment: String,
    /// sha256 of the proof set the verdict was computed over (hex, 32 bytes).
    pub proof_hash: String,
    /// Predicates revealed for this purchase. Sorted, unique, from KNOWN_PREDICATES.
    pub predicates: Vec<String>,
    pub tier: String,
    pub attestation: Attestation,
    /// Confirmation: the NEAR account of the agent allowed to act on this verdict.
    pub cnf: String,
    /// Spend cap set by the verdict, token base units.
    #[serde(with = "crate::u128_str")]
    pub max_spend: u128,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SigAlg {
    /// Ed25519 over the 32-byte digest. Checked with `env::ed25519_verify`.
    Ed25519,
    /// ECDSA P-256 over the 32-byte digest (prehash), low-S. Checked with `env::p256_verify`.
    P256,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedVerdict {
    pub envelope: Envelope,
    pub alg: SigAlg,
    /// Hex: 32 bytes for ed25519, 33 bytes compressed SEC1 for p256.
    pub issuer_key: String,
    /// Hex, 64 bytes (ed25519 R||S, or p256 r||s).
    pub signature: String,
}

impl Envelope {
    /// Exact bytes whose sha256 is signed.
    pub fn signing_message(&self) -> Vec<u8> {
        let mut out = DOMAIN_TAG.to_vec();
        out.extend(serde_json::to_vec(self).expect("envelope serializes"));
        out
    }

    pub fn digest(&self) -> [u8; 32] {
        crate::sha256(&self.signing_message())
    }

    /// What the NEAR AI issuer is asked to echo inside its sealed, TEE-signed answer: every
    /// envelope field the model does not compute (context, nullifier, commitment, proof hash,
    /// agent, cap, times). Echoing it binds this envelope to that one chat.
    pub fn near_ai_bind(&self) -> String {
        let core =
            (&self.context, &self.nullifier, &self.commitment, &self.proof_hash, &self.cnf, self.max_spend.to_string(), self.issued_at_ms, self.expires_at_ms);
        let mut m = NEAR_AI_BIND_TAG.to_vec();
        m.extend(serde_json::to_vec(&core).expect("serializes"));
        crate::sha256_hex(&m)
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.v != 0 {
            return Err("unsupported envelope version");
        }
        if self.context.is_empty() || self.context.len() > 64 {
            return Err("bad context");
        }
        if !crate::is_hex32(&self.nullifier) {
            return Err("bad nullifier");
        }
        if !crate::is_hex32(&self.commitment) || !crate::is_hex32(&self.proof_hash) {
            return Err("bad commitment or proof hash");
        }
        if !crate::is_hex32(&self.attestation.report_hash) {
            return Err("bad attestation hash");
        }
        if self.predicates.len() > crate::KNOWN_PREDICATES.len() {
            return Err("too many predicates");
        }
        for (i, p) in self.predicates.iter().enumerate() {
            if !crate::is_known_predicate(p) {
                return Err("unknown predicate");
            }
            if i > 0 && self.predicates[i - 1] >= *p {
                return Err("predicates not sorted and unique");
            }
        }
        if self.cnf.is_empty() || self.cnf.len() > 64 {
            return Err("bad cnf");
        }
        if self.expires_at_ms <= self.issued_at_ms {
            return Err("bad expiry");
        }
        Ok(())
    }
}

impl SignedVerdict {
    /// Registry id of the issuer key, `ed25519:<hex>` or `p256:<hex>`.
    pub fn key_id(&self) -> String {
        key_id(self.alg, &self.issuer_key)
    }
}

pub fn key_id(alg: SigAlg, key_hex: &str) -> String {
    match alg {
        SigAlg::Ed25519 => format!("ed25519:{key_hex}"),
        SigAlg::P256 => format!("p256:{key_hex}"),
    }
}

/// Commitment to the full derived predicate set, so a later opening can prove what was
/// held back. `salt` is 32 random bytes in production; fixed in fixtures.
pub fn commitment(salt: &[u8; 32], all_predicates: &[String]) -> String {
    let mut b = COMMIT_TAG.to_vec();
    b.extend_from_slice(salt);
    b.extend(serde_json::to_vec(all_predicates).expect("serializes"));
    crate::sha256_hex(&b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tcb_order_and_floor() {
        assert!(tcb_meets("UpToDate", "UpToDate", false));
        assert!(!tcb_meets("OutOfDate", "UpToDate", false));
        assert!(tcb_meets("OutOfDate", "OutOfDate", false));
        assert!(tcb_meets("SWHardeningNeeded", "ConfigurationNeeded", false));
        assert!(!tcb_meets("Revoked", "Revoked", false), "revoked never passes");
        assert!(!tcb_meets("uptodate", "UpToDate", false), "exact DCAP names only");
        assert!(!tcb_meets("fixture", "UpToDate", false));
        assert!(tcb_meets("fixture", "UpToDate", true));
        assert!(!tcb_meets("UpToDate", "bogus", false), "an unknown floor fails closed");
    }

    pub(crate) fn sample() -> Envelope {
        Envelope {
            v: 0,
            context: "bookerbob:v0:demo".into(),
            nullifier: "11".repeat(32),
            commitment: "22".repeat(32),
            proof_hash: "33".repeat(32),
            predicates: vec!["airbnb_frequent".into(), "world_id_human".into()],
            tier: "silver".into(),
            attestation: Attestation { model: "m".into(), tcb_status: "fixture".into(), report_hash: "44".repeat(32) },
            cnf: "agent.testnet".into(),
            max_spend: 200_000_000,
            issued_at_ms: 1,
            expires_at_ms: 2,
        }
    }

    #[test]
    fn valid_envelope_passes() {
        assert!(sample().validate().is_ok());
    }

    #[test]
    fn unsorted_predicates_are_rejected() {
        let mut e = sample();
        e.predicates.reverse();
        assert_eq!(e.validate(), Err("predicates not sorted and unique"));
    }

    #[test]
    fn invented_predicate_is_rejected() {
        let mut e = sample();
        e.predicates = vec!["marriott_platinum".into()];
        assert_eq!(e.validate(), Err("unknown predicate"));
    }

    #[test]
    fn digest_changes_with_any_field() {
        let a = sample();
        let mut b = sample();
        b.max_spend += 1;
        assert_ne!(a.digest(), b.digest());
        assert_eq!(a.digest(), sample().digest());
    }

    #[test]
    fn amounts_serialize_as_strings() {
        let j = serde_json::to_string(&sample()).unwrap();
        assert!(j.contains("\"max_spend\":\"200000000\""));
    }
}
