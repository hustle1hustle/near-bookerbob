//! Signed referee result, produced by the OutLayer worker and checked by the contract.
use serde::{Deserialize, Serialize};

pub const RESULT_TAG: &[u8] = b"bookerbob/referee/v0\x00";

/// Signed body. Field order is the signing order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResultBody {
    pub v: u8,
    pub verdict_digest: String,
    pub nullifier: String,
    pub merchant: String,
    #[serde(with = "crate::u128_str")]
    pub price: u128,
    /// `receipt` or `refused`.
    pub outcome: String,
    /// Receipt hash, or the refusal reason.
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkerResult {
    pub body: ResultBody,
    /// Hex ed25519 public key of the worker.
    pub worker_key: String,
    /// Hex ed25519 signature over `RESULT_TAG || json(body)`.
    pub signature: String,
}

impl ResultBody {
    pub fn signing_message(&self) -> Vec<u8> {
        let mut m = RESULT_TAG.to_vec();
        m.extend(serde_json::to_vec(self).expect("serializes"));
        m
    }
}
