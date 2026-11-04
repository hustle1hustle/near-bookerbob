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

pub use bookerbob_core::referee_result::{DisputeBody, DisputeDecision, ResultBody, WorkerResult, RESULT_TAG};
use bookerbob_core::{sha256_hex, SigAlg, SignedVerdict};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
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
        claims_sha256: claims_hash(&input.claims),
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

pub fn claims_hash(claims: &[Claim]) -> String {
    sha256_hex(&serde_json::to_vec(claims).expect("serializes"))
}

fn ed_ok(key_hex: &str, sig_hex: &str, msg: &[u8]) -> bool {
    let (Ok(k), Ok(s)) = (hex::decode(key_hex), hex::decode(sig_hex)) else { return false };
    let (Ok(k), Ok(s)) = (<[u8; 32]>::try_from(k.as_slice()), <[u8; 64]>::try_from(s.as_slice())) else { return false };
    VerifyingKey::from_bytes(&k).is_ok_and(|vk| vk.verify(msg, &Signature::from_bytes(&s)).is_ok())
}

pub fn verdict_signature_ok(v: &SignedVerdict) -> bool {
    let digest = v.envelope.digest();
    match v.alg {
        SigAlg::Ed25519 => ed_ok(&v.issuer_key, &v.signature, &digest),
        SigAlg::P256 => {
            use p256::ecdsa::signature::hazmat::PrehashVerifier;
            let (Ok(k), Ok(s)) = (hex::decode(&v.issuer_key), hex::decode(&v.signature)) else { return false };
            let (Ok(vk), Ok(sig)) = (p256::ecdsa::VerifyingKey::from_sec1_bytes(&k), p256::ecdsa::Signature::from_slice(&s)) else { return false };
            sig.normalize_s().is_none() && vk.verify_prehash(&digest, &sig).is_ok()
        }
    }
}

/// Input of a dispute: the verdict, the contested referee result, the material it judged,
/// and the keys the bazaar registered.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DisputeInput {
    pub v: u8,
    pub verdict: SignedVerdict,
    pub result: WorkerResult,
    pub schedule: Schedule,
    pub claims: Vec<Claim>,
    pub proofs: ProofSet,
    #[serde(default)]
    pub cohort_k: u32,
    pub issuer_keys: Vec<String>,
    pub referee_keys: Vec<String>,
}

/// Re-check everything independently and sign `upheld` or `overturned`.
pub fn arbitrate(d: &DisputeInput, key: &SigningKey) -> Result<String, String> {
    let r = &d.result.body;
    let mut reasons = Vec::new();
    if !d.issuer_keys.contains(&d.verdict.key_id()) {
        reasons.push("verdict issuer key not registered".to_string());
    }
    if !verdict_signature_ok(&d.verdict) {
        reasons.push("verdict signature invalid".into());
    }
    let digest = hex::encode(d.verdict.envelope.digest());
    if r.verdict_digest != digest || r.nullifier != d.verdict.envelope.nullifier {
        reasons.push("referee result is for another verdict".into());
    }
    if !d.referee_keys.contains(&d.result.worker_key) {
        reasons.push("referee key not registered".into());
    }
    if !ed_ok(&d.result.worker_key, &d.result.signature, &r.signing_message()) {
        reasons.push("referee signature invalid".into());
    }
    if r.claims_sha256 != claims_hash(&d.claims) {
        reasons.push("claims differ from the ones the referee signed".into());
    }
    let revealed = &d.verdict.envelope.predicates;
    let q = quote_in_cohort(&d.schedule, revealed, |_| d.cohort_k);
    if q.price != r.price {
        reasons.push(format!("price {} differs from the code quote {}", r.price, q.price));
    }
    let (outcome, detail) = match referee(&d.proofs, revealed, &q, &d.claims) {
        RefereeOutcome::Receipt { receipt_hash } => ("receipt", receipt_hash),
        RefereeOutcome::Refused { reason } => ("refused", reason),
    };
    if r.outcome != outcome {
        reasons.push(format!("referee said {}, re-run says {outcome}: {detail}", r.outcome));
    }
    reasons.iter_mut().for_each(|x| x.truncate(120));
    reasons.truncate(4);
    let body = DisputeBody {
        v: 0,
        nullifier: d.verdict.envelope.nullifier.clone(),
        verdict_digest: digest,
        referee_result_sha256: sha256_hex(&r.signing_message()),
        decision: if reasons.is_empty() { "upheld" } else { "overturned" }.into(),
        reasons,
    };
    let signature = hex::encode(key.sign(&body.signing_message()).to_bytes());
    let out = serde_json::to_string(&DisputeDecision { body, arbiter_key: hex::encode(key.verifying_key().to_bytes()), signature }).expect("serializes");
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

    fn signed_verdict() -> SignedVerdict {
        use bookerbob_core::{Attestation, Envelope};
        let e = Envelope {
            v: 0,
            context: "c".into(),
            nullifier: "bb".repeat(32),
            commitment: "11".repeat(32),
            proof_hash: "22".repeat(32),
            predicates: vec!["airbnb_frequent".into()],
            tier: "silver".into(),
            attestation: Attestation { model: "m".into(), tcb_status: "fixture".into(), report_hash: "33".repeat(32) },
            cnf: "agent.testnet".into(),
            max_spend: 100_000_000,
            issued_at_ms: 1,
            expires_at_ms: 2,
        };
        let k = SigningKey::from_bytes(&[8u8; 32]);
        let sig = hex::encode(k.sign(&e.digest()).to_bytes());
        SignedVerdict { envelope: e, alg: SigAlg::Ed25519, issuer_key: hex::encode(k.verifying_key().to_bytes()), signature: sig }
    }

    fn dispute(claims_judged: Vec<Claim>, outcome_override: Option<&str>) -> DisputeInput {
        let v = signed_verdict();
        let mut inp = input(claims_judged.clone());
        inp.verdict_digest = hex::encode(v.envelope.digest());
        let mut result: WorkerResult = serde_json::from_str(&run(&inp, &key()).unwrap()).unwrap();
        if let Some(o) = outcome_override {
            // A compromised referee key signs a receipt the claims do not support.
            result.body.outcome = o.into();
            result.signature = hex::encode(key().sign(&result.body.signing_message()).to_bytes());
        }
        DisputeInput {
            v: 0,
            issuer_keys: vec![v.key_id()],
            verdict: v,
            result,
            schedule: inp.schedule,
            claims: claims_judged,
            proofs: inp.proofs,
            cohort_k: 0,
            referee_keys: vec![hex::encode(key().verifying_key().to_bytes())],
        }
    }

    #[test]
    fn honest_receipt_is_upheld() {
        let d = dispute(vec![Claim { line: "airbnb_frequent".into(), text: "x".into(), citations: vec!["F1".into()] }], None);
        let out: DisputeDecision = serde_json::from_str(&arbitrate(&d, &SigningKey::from_bytes(&[9u8; 32])).unwrap()).unwrap();
        assert_eq!(out.body.decision, "upheld");
        assert!(out.body.reasons.is_empty());
    }

    #[test]
    fn receipt_from_a_compromised_referee_is_overturned() {
        let cheat = vec![Claim { line: "airbnb_frequent".into(), text: "marriott platinum".into(), citations: vec!["F9".into()] }];
        let d = dispute(cheat, Some("receipt"));
        let out = arbitrate(&d, &SigningKey::from_bytes(&[9u8; 32])).unwrap();
        assert!(out.len() <= MAX_OUTPUT);
        let out: DisputeDecision = serde_json::from_str(&out).unwrap();
        assert_eq!(out.body.decision, "overturned");
        assert!(out.body.reasons[0].contains("F9 not in proof set"), "{:?}", out.body.reasons);
    }

    #[test]
    fn swapped_claims_are_caught() {
        let mut d = dispute(vec![Claim { line: "airbnb_frequent".into(), text: "x".into(), citations: vec!["F1".into()] }], None);
        d.claims[0].text = "something else".into();
        let out: DisputeDecision = serde_json::from_str(&arbitrate(&d, &SigningKey::from_bytes(&[9u8; 32])).unwrap()).unwrap();
        assert_eq!(out.body.decision, "overturned");
        assert!(out.body.reasons.iter().any(|r| r.contains("claims differ")));
    }

    #[test]
    fn long_refusal_still_fits() {
        let long = "x".repeat(5000);
        let out = run(&input(vec![Claim { line: long, text: "y".into(), citations: vec![] }]), &key()).unwrap();
        assert!(out.len() <= MAX_OUTPUT, "{} bytes", out.len());
    }
}
