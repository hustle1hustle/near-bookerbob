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
