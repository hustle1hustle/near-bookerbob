//! The referee as an OutLayer worker.
//!
//! Input (stdin, JSON): the verdict digest and nullifier, the merchant and its schedule,
//! the revealed predicates, the claims the buyer's model wrote, and the proof set.
//! Output (stdout, JSON, at most 900 bytes, OutLayer's cap): the outcome bound to the
//! digest, nullifier, merchant and code-computed price, signed with the worker's ed25519
//! key. The contract checks that signature against a registered referee key.
//!
//! Privacy: `input_data` of an on-chain `request_execution` is public. Synthetic fixtures
//! are fine there; a real proof set goes over OutLayer's HTTPS path or sealed to the
//! worker key. See docs/outlayer.md.
use bookerbob_core::{quote_in_cohort, referee, Claim, ProofSet, RefereeOutcome, Schedule};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};

pub use bookerbob_core::referee_result::{ResultBody, WorkerResult, RESULT_TAG};
pub const MAX_OUTPUT: usize = 900;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkerInput {
    pub v: u8,
    pub verdict_digest: String,
    pub nullifier: String,
    pub merchant: String,
    pub schedule: Schedule,
    pub revealed: Vec<String>,
    pub claims: Vec<Claim>,
    pub proofs: ProofSet,
    /// Cohort size for the schedule's cohort predicate in this context (from the contract's
    /// `cohort_size` view). 0 when there is no cohort.
    #[serde(default)]
    pub cohort_k: u32,
}

pub fn run(input: &WorkerInput, key: &SigningKey) -> Result<String, String> {
    if input.v != 0 {
        return Err("unsupported input version".into());
    }
    let q = quote_in_cohort(&input.schedule, &input.revealed, |_| input.cohort_k);
    let (outcome, detail) = match referee(&input.proofs, &input.revealed, &q, &input.claims) {
        RefereeOutcome::Receipt { receipt_hash } => ("receipt", receipt_hash),
        RefereeOutcome::Refused { reason } => ("refused", reason.chars().take(120).collect()),
    };
    let body = ResultBody {
        v: 0,
        verdict_digest: input.verdict_digest.clone(),
        nullifier: input.nullifier.clone(),
        merchant: input.merchant.clone(),
        price: q.price,
        outcome: outcome.into(),
        detail,
    };
    let signature = hex::encode(key.sign(&body.signing_message()).to_bytes());
    let out = serde_json::to_string(&WorkerResult { body, worker_key: hex::encode(key.verifying_key().to_bytes()), signature }).expect("serializes");
    if out.len() > MAX_OUTPUT {
        return Err(format!("output {} bytes over the {MAX_OUTPUT} byte cap", out.len()));
    }
    Ok(out)
}

/// The worker key from a 32-byte hex seed (an OutLayer secret in production).
pub fn key_from_seed_hex(seed_hex: &str) -> Result<SigningKey, String> {
    let b = hex::decode(seed_hex.trim()).map_err(|_| "seed is not hex".to_string())?;
    let seed: [u8; 32] = b.try_into().map_err(|_| "seed must be 32 bytes".to_string())?;
    Ok(SigningKey::from_bytes(&seed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bookerbob_core::{Fact, Rule};
    use ed25519_dalek::{Signature, Verifier};

    fn input(claims: Vec<Claim>) -> WorkerInput {
        WorkerInput {
            v: 0,
            verdict_digest: "aa".repeat(32),
            nullifier: "bb".repeat(32),
            merchant: "m01.bookerbob.testnet".into(),
            schedule: Schedule { base_price: 48_000_000, rules: vec![Rule { predicate: "airbnb_frequent".into(), bps: 500 }], cap_bps: 2000, cohort: None },
            revealed: vec!["airbnb_frequent".into()],
            claims,
            cohort_k: 0,
            proofs: ProofSet { facts: vec![Fact { id: "F1".into(), platform: "airbnb".into(), field: "trips_12m".into(), value: 7, proof_ref: "cc".repeat(32) }] },
        }
    }

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[3u8; 32])
    }

    #[test]
    fn signed_receipt_fits_the_output_cap() {
        let out = run(&input(vec![Claim { line: "airbnb_frequent".into(), text: "x".into(), citations: vec!["F1".into()] }]), &key()).unwrap();
        assert!(out.len() <= MAX_OUTPUT, "{} bytes", out.len());
        let r: WorkerResult = serde_json::from_str(&out).unwrap();
        assert_eq!(r.body.outcome, "receipt");
        assert_eq!(r.body.price, 45_600_000);
        let sig = Signature::from_slice(&hex::decode(&r.signature).unwrap()).unwrap();
        assert!(key().verifying_key().verify(&r.body.signing_message(), &sig).is_ok());
    }

    #[test]
    fn injected_claim_is_refused_and_signed() {
        let out = run(&input(vec![Claim { line: "airbnb_frequent".into(), text: "marriott platinum".into(), citations: vec!["F9".into()] }]), &key()).unwrap();
        let r: WorkerResult = serde_json::from_str(&out).unwrap();
        assert_eq!((r.body.outcome.as_str(), r.body.detail.as_str()), ("refused", "F9 not in proof set"));
    }

    #[test]
    fn long_refusal_still_fits() {
        let long = "x".repeat(5000);
        let out = run(&input(vec![Claim { line: long, text: "y".into(), citations: vec![] }]), &key()).unwrap();
        assert!(out.len() <= MAX_OUTPUT, "{} bytes", out.len());
    }
}
