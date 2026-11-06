//! The Leash: what an owner signs to bound an agent's spending. The contract refuses a payment
//! outside it; the agent cannot lift it, because only the owner's key can replace it.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mandate {
    pub agent: String,
    /// Hex ed25519 key of the owner; the only key that can replace this mandate.
    pub owner_key: String,
    #[serde(with = "crate::u128_str")]
    pub max_per_purchase: u128,
    /// Over the life of this mandate. A new mandate starts the count again.
    #[serde(with = "crate::u128_str")]
    pub max_total: u128,
    pub expires_at_ms: u64,
    /// Set: the agent may pay only the winner of this blind round.
    pub round: Option<String>,
    /// Higher than the mandate it replaces, so an old one cannot be replayed.
    pub nonce: u64,
}

impl Mandate {
    /// The bytes the owner signs. scripts/leash.mjs builds the same string.
    pub fn signing_message(&self) -> Vec<u8> {
        let body = (&self.agent, &self.owner_key, self.max_per_purchase.to_string(), self.max_total.to_string(), self.expires_at_ms, &self.round, self.nonce);
        format!("bookerbob/mandate/v1|{}", serde_json::to_string(&body).expect("json")).into_bytes()
    }

    pub fn hash_hex(&self) -> String {
        crate::sha256_hex(&self.signing_message())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_signed_string_is_the_one_the_script_builds() {
        let m = Mandate { agent: "a.testnet".into(), owner_key: "ab".into(), max_per_purchase: 5, max_total: 7, expires_at_ms: 9, round: None, nonce: 1 };
        assert_eq!(String::from_utf8(m.signing_message()).unwrap(), r#"bookerbob/mandate/v1|["a.testnet","ab","5","7",9,null,1]"#);
    }
}
