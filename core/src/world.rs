//! World ID attestation: an off-chain verifier (REP's rep-world-verify service, which calls
//! World ID 4.0 `POST /api/v4/verify/{rp_id}`) signs that a World ID holder bound one agent
//! for one action. The contract checks the signature and keeps one agent per World
//! nullifier: one person, one agent. There is no World ID verifier on NEAR itself.
use serde::{Deserialize, Serialize};

pub const WORLD_TAG: &[u8] = b"bookerbob/world/v0\x00";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorldBody {
    pub v: u8,
    /// World ID action. Fixtures use a placeholder; the real action is created by the team.
    pub action: String,
    /// World ID nullifier for this action (hex, 32 bytes). Same person, same nullifier.
    pub world_nullifier: String,
    /// NEAR account of the agent being bound.
    pub agent: String,
    pub issued_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorldAttestation {
    pub body: WorldBody,
    /// Hex ed25519 key of the verifier service.
    pub verifier_key: String,
    /// Hex ed25519 signature over `WORLD_TAG || json(body)`.
    pub signature: String,
}

impl WorldBody {
    pub fn signing_message(&self) -> Vec<u8> {
        let mut m = WORLD_TAG.to_vec();
        m.extend(serde_json::to_vec(self).expect("serializes"));
        m
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.v != 0 {
            return Err("unsupported world attestation");
        }
        if self.action.is_empty() || self.action.len() > 64 {
            return Err("bad world action");
        }
        if !crate::is_hex32(&self.world_nullifier) {
            return Err("bad world nullifier");
        }
        if self.agent.is_empty() || self.agent.len() > 64 {
            return Err("bad agent");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body() -> WorldBody {
        WorldBody { v: 0, action: "bookerbob-fixture-action".into(), world_nullifier: "ab".repeat(32), agent: "agent.testnet".into(), issued_at_ms: 1 }
    }

    #[test]
    fn a_well_formed_attestation_body_validates() {
        assert_eq!(body().validate(), Ok(()));
    }

    #[test]
    fn malformed_attestation_bodies_are_refused() {
        let mut b = body();
        b.v = 1;
        assert_eq!(b.validate(), Err("unsupported world attestation"));
        let mut b = body();
        b.action = String::new();
        assert_eq!(b.validate(), Err("bad world action"));
        let mut b = body();
        b.action = "a".repeat(65);
        assert_eq!(b.validate(), Err("bad world action"));
        let mut b = body();
        b.world_nullifier = "zz".into();
        assert_eq!(b.validate(), Err("bad world nullifier"));
        let mut b = body();
        b.agent = String::new();
        assert_eq!(b.validate(), Err("bad agent"));
    }

    #[test]
    fn the_signed_message_is_tagged_and_binds_the_agent() {
        let m = body().signing_message();
        assert!(m.starts_with(WORLD_TAG));
        let mut other = body();
        other.agent = "wallet2.testnet".into();
        assert_ne!(m, other.signing_message());
    }
}
