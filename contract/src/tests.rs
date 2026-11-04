use super::*;
use bookerbob_core::{Attestation, Claim, Envelope, ProofSet, Fact, Rule, WorldAttestation, WorldBody};
use bookerbob_referee_worker::{arbitrate, run as run_referee, DisputeInput, WorkerInput};
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;
use near_sdk::PromiseResult;

const NOW_MS: u64 = 1_793_000_000_000; // 2026-10-26
const USDC: &str = "usdc.testnet";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("bazaar.testnet"))
        .predecessor_account_id(acc(predecessor))
        .block_timestamp(NOW_MS * 1_000_000);
    b
}

fn set(predecessor: &str) {
    let mut b = ctx(predecessor);
    b.attached_deposit(RECORD_DEPOSIT);
    testing_env!(b.build());
}

fn set_no_deposit(predecessor: &str) {
    testing_env!(ctx(predecessor).build());
}

fn ed_key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn p256_key() -> p256::ecdsa::SigningKey {
    p256::ecdsa::SigningKey::from_slice(&[9u8; 32]).unwrap()
}

fn envelope(nullifier_byte: u8, agent: &str) -> Envelope {
    Envelope {
        v: 0,
        context: "bookerbob:v0:test".into(),
        nullifier: hex::encode([nullifier_byte; 32]),
        commitment: "22".repeat(32),
        proof_hash: "33".repeat(32),
        predicates: vec!["airbnb_frequent".into(), "world_id_human".into()],
        tier: "silver".into(),
        attestation: Attestation { model: "test".into(), tcb_status: "fixture".into(), report_hash: "44".repeat(32) },
        cnf: agent.into(),
        max_spend: 200_000_000,
        issued_at_ms: NOW_MS - 1000,
        expires_at_ms: NOW_MS + 3_600_000,
    }
}

fn sign_ed(e: Envelope) -> SignedVerdict {
    let digest = e.digest();
    let k = ed_key();
    SignedVerdict {
        envelope: e,
        alg: SigAlg::Ed25519,
        issuer_key: hex::encode(k.verifying_key().to_bytes()),
        signature: hex::encode(k.sign(&digest).to_bytes()),
    }
}

fn sign_p256(e: Envelope) -> SignedVerdict {
    use p256::ecdsa::signature::hazmat::PrehashSigner;
    let digest = e.digest();
    let k = p256_key();
    let sig: p256::ecdsa::Signature = k.sign_prehash(&digest).unwrap();
    let sig = sig.normalize_s().unwrap_or(sig);
    SignedVerdict {
        envelope: e,
        alg: SigAlg::P256,
        issuer_key: hex::encode(k.verifying_key().to_encoded_point(true).as_bytes()),
        signature: hex::encode(sig.to_bytes()),
    }
}

fn schedule() -> Schedule {
    Schedule {
        base_price: 189_000_000,
        rules: vec![
            Rule { predicate: "airbnb_frequent".into(), bps: 1200 },
            Rule { predicate: "world_id_human".into(), bps: 800 },
        ],
        cap_bps: 2500, cohort: None,
    }
}

const WORLD_ACTION: &str = "bookerbob-fixture-action";

fn world_key() -> SigningKey {
    SigningKey::from_bytes(&[4u8; 32])
}

fn world_attestation(agent: &str, person: u8, key: &SigningKey) -> WorldAttestation {
    let body = WorldBody { v: 0, action: WORLD_ACTION.into(), world_nullifier: hex::encode([person; 32]), agent: agent.into(), issued_at_ms: NOW_MS };
    WorldAttestation { verifier_key: hex::encode(key.verifying_key().to_bytes()), signature: hex::encode(key.sign(&body.signing_message()).to_bytes()), body }
}

fn attest(c: &mut Bazaar, agent: &str, person: u8) {
    set(agent);
    c.attest_human(world_attestation(agent, person, &world_key()));
}

fn referee_key() -> SigningKey {
    SigningKey::from_bytes(&[5u8; 32])
}

fn proofs() -> ProofSet {
    let f = |id: &str, platform: &str, field: &str, value: u64| Fact { id: id.into(), platform: platform.into(), field: field.into(), value, proof_ref: "cc".repeat(32) };
    ProofSet { facts: vec![f("F1", "airbnb", "trips_12m", 7), f("F5", "world_id", "verified", 1)] }
}

fn honest_claims() -> Vec<Claim> {
    vec![
        Claim { line: "airbnb_frequent".into(), text: "frequent".into(), citations: vec!["F1".into()] },
        Claim { line: "world_id_human".into(), text: "human".into(), citations: vec!["F5".into()] },
    ]
}

/// Run the real referee worker over `claims` for verdict `e` and merchant m01.
fn referee_result(e: &Envelope, claims: Vec<Claim>, key: &SigningKey) -> WorkerResult {
    let input = WorkerInput {
        v: 0,
        verdict_digest: hex::encode(e.digest()),
        nullifier: e.nullifier.clone(),
        merchant: "m01.bazaar.testnet".into(),
        schedule: schedule(),
        revealed: e.predicates.clone(),
        claims,
        proofs: proofs(),
        cohort_k: 0,
    };
    serde_json::from_str(&run_referee(&input, key).unwrap()).unwrap()
}

/// Submit verdict 1 for agent.testnet and store an honest referee receipt for m01.
fn submit_with_receipt(c: &mut Bazaar, e: Envelope) {
    set(e.cnf.as_str());
    c.submit_verdict(sign_ed(e.clone()));
    assert!(c.submit_referee_result(referee_result(&e, honest_claims(), &referee_key())));
    set(e.cnf.as_str());
}

/// Owner deploys, registers both issuer keys, one merchant registers, agent opens escrow
/// and deposits 200 USDC.
fn setup() -> Bazaar {
    set("owner.testnet");
    let mut c = Bazaar::new(acc("owner.testnet"), acc(USDC));
    let ed = sign_ed(envelope(1, "agent.testnet"));
    let p = sign_p256(envelope(1, "agent.testnet"));
    c.register_issuer(ed.key_id(), "fixture ed25519 issuer".into());
    c.register_issuer(p.key_id(), "fixture p256 issuer".into());
    c.register_referee(hex::encode(referee_key().verifying_key().to_bytes()), "fixture referee".into());
    c.register_world_verifier(hex::encode(world_key().verifying_key().to_bytes()), WORLD_ACTION.into(), "fixture world verifier".into());
    attest(&mut c, "agent.testnet", 200);
    set("m01.bazaar.testnet");
    c.register_merchant(schedule(), "hoodie".into(), None);
    let mut b = ctx("agent.testnet");
    b.attached_deposit(ESCROW_STORAGE_DEPOSIT);
    testing_env!(b.build());
    c.storage_deposit(None);
    set(USDC);
    let _ = c.ft_on_transfer(acc("agent.testnet"), U128(200_000_000), String::new());
    c
}

#[test]
fn ed25519_verdict_is_accepted_and_pending() {
    let mut c = setup();
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
    assert_eq!(c.nullifier_status(hex::encode([1u8; 32])), NullifierStatus::Pending);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"verdict_submitted\"")));
}

#[test]
fn p256_verdict_is_accepted() {
    let mut c = setup();
    set("agent.testnet");
    c.submit_verdict(sign_p256(envelope(2, "agent.testnet")));
    assert_eq!(c.nullifier_status(hex::encode([2u8; 32])), NullifierStatus::Pending);
}

#[test]
fn p256_host_function_matches_known_vector() {
    // Vector from the near-sdk 5.29.1 docs for env::p256_verify (RFC 6979 "sample").
    set("owner.testnet");
    let sig: [u8; 64] = hex::decode("EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF37160834E36AD29A83BF2BC9385E491D6099C8FDF9D1ED67AA7EA5F51F93782857A9").unwrap().try_into().unwrap();
    let pk: [u8; 33] = hex::decode("0360FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6").unwrap().try_into().unwrap();
    assert!(env::p256_verify(&sig, &env::sha256_array(b"sample"), &pk));
    assert!(!env::p256_verify(&sig, &env::sha256_array(b"Sample"), &pk));
}

#[test]
#[should_panic(expected = "unknown enclave key")]
fn unknown_enclave_key_is_rejected() {
    let mut c = setup();
    let mut v = sign_ed(envelope(1, "agent.testnet"));
    let other = SigningKey::from_bytes(&[8u8; 32]);
    v.issuer_key = hex::encode(other.verifying_key().to_bytes());
    v.signature = hex::encode(other.sign(&v.envelope.digest()).to_bytes());
    set("agent.testnet");
    c.submit_verdict(v);
}

#[test]
#[should_panic(expected = "bad signature")]
fn tampered_envelope_is_rejected() {
    let mut c = setup();
    let mut v = sign_ed(envelope(1, "agent.testnet"));
    v.envelope.max_spend = 999_000_000;
    set("agent.testnet");
    c.submit_verdict(v);
}

#[test]
#[should_panic(expected = "bad signature")]
fn high_s_p256_signature_is_rejected() {
    let mut c = setup();
    let mut v = sign_p256(envelope(2, "agent.testnet"));
    // Flip s to n - s: still a valid ECDSA signature, but malleable, so refused.
    let sig = p256::ecdsa::Signature::from_slice(&hex::decode(&v.signature).unwrap()).unwrap();
    let (r, s) = sig.split_scalars();
    let high = p256::ecdsa::Signature::from_scalars(r, -*s).unwrap();
    v.signature = hex::encode(high.to_bytes());
    set("agent.testnet");
    c.submit_verdict(v);
}

#[test]
#[should_panic(expected = "agent mismatch")]
fn verdict_from_another_agent_is_rejected() {
    let mut c = setup();
    set("thief.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
}

#[test]
#[should_panic(expected = "verdict expired")]
fn expired_verdict_is_rejected() {
    let mut c = setup();
    let mut e = envelope(1, "agent.testnet");
    e.issued_at_ms = NOW_MS - 10_000;
    e.expires_at_ms = NOW_MS - 1;
    set("agent.testnet");
    c.submit_verdict(sign_ed(e));
}

#[test]
#[should_panic(expected = "nullifier pending")]
fn second_verdict_on_pending_nullifier_is_rejected() {
    let mut c = setup();
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
}

#[test]
fn quote_is_code_computed() {
    let mut c = setup();
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
    let q = c.quote(acc("m01.bazaar.testnet"), hex::encode([1u8; 32]));
    assert_eq!(q.discount_bps, 2000);
    assert_eq!(q.price, 151_200_000);
}

#[test]
fn settle_burns_nullifier_and_pays_merchant() {
    let mut c = setup();
    let n = hex::encode([1u8; 32]);
    submit_with_receipt(&mut c, envelope(1, "agent.testnet"));
    let _ = c.settle(n.clone(), acc("m01.bazaar.testnet"), "order-1".into(), U128(151_200_000));
    assert_eq!(c.nullifier_status(n.clone()), NullifierStatus::Spent);
    assert_eq!(c.escrow_of(acc("agent.testnet")), Some(U128(48_800_000)));
    assert_eq!(c.spent_count(), 1);
    let logs = get_logs();
    assert!(logs.iter().any(|l| l.contains("\"event\":\"settled\"") && l.contains("\"amount\":\"151200000\"")));
    // The ft_transfer receipt to the USDC contract is scheduled in the same call.
    let receipts = near_sdk::test_utils::get_created_receipts();
    assert!(receipts.iter().any(|r| r.receiver_id.as_str() == USDC));
}

#[test]
#[should_panic(expected = "nullifier spent")]
fn replayed_nullifier_is_rejected() {
    // Same proof (same per-context nullifier), new envelope, another wallet.
    let mut c = setup();
    let n = hex::encode([1u8; 32]);
    submit_with_receipt(&mut c, envelope(1, "agent.testnet"));
    let _ = c.settle(n, acc("m01.bazaar.testnet"), "order-1".into(), U128(151_200_000));
    set("wallet2.testnet");
    c.submit_verdict(sign_ed(envelope(1, "wallet2.testnet")));
}

#[test]
#[should_panic(expected = "nullifier spent")]
fn double_settle_is_rejected() {
    let mut c = setup();
    let n = hex::encode([1u8; 32]);
    submit_with_receipt(&mut c, envelope(1, "agent.testnet"));
    let _ = c.settle(n.clone(), acc("m01.bazaar.testnet"), "order-1".into(), U128(151_200_000));
    let _ = c.settle(n, acc("m01.bazaar.testnet"), "order-2".into(), U128(151_200_000));
}

#[test]
#[should_panic(expected = "over verdict cap")]
fn settle_over_cap_is_rejected() {
    let mut c = setup();
    let mut e = envelope(1, "agent.testnet");
    e.max_spend = 100_000_000; // below the 151.2 USDC price
    submit_with_receipt(&mut c, e);
    let _ = c.settle(hex::encode([1u8; 32]), acc("m01.bazaar.testnet"), "order-1".into(), U128(151_200_000));
}

#[test]
#[should_panic(expected = "amount differs from quote")]
fn settle_with_wrong_amount_is_rejected() {
    let mut c = setup();
    submit_with_receipt(&mut c, envelope(1, "agent.testnet"));
    let _ = c.settle(hex::encode([1u8; 32]), acc("m01.bazaar.testnet"), "order-1".into(), U128(100));
}

#[test]
#[should_panic(expected = "insufficient escrow")]
fn settle_without_enough_escrow_is_rejected() {
    set("owner.testnet");
    let mut c = Bazaar::new(acc("owner.testnet"), acc(USDC));
    let v = sign_ed(envelope(1, "agent.testnet"));
    c.register_issuer(v.key_id(), "x".into());
    c.register_referee(hex::encode(referee_key().verifying_key().to_bytes()), "x".into());
    c.register_world_verifier(hex::encode(world_key().verifying_key().to_bytes()), WORLD_ACTION.into(), "x".into());
    attest(&mut c, "agent.testnet", 200);
    set("m01.bazaar.testnet");
    c.register_merchant(schedule(), "hoodie".into(), None);
    let mut b = ctx("agent.testnet");
    b.attached_deposit(ESCROW_STORAGE_DEPOSIT);
    testing_env!(b.build());
    c.storage_deposit(None);
    submit_with_receipt(&mut c, v.envelope);
    let _ = c.settle(hex::encode([1u8; 32]), acc("m01.bazaar.testnet"), "order-1".into(), U128(151_200_000));
}

#[test]
fn deposit_without_escrow_entry_is_refunded() {
    let mut c = setup();
    set(USDC);
    match c.ft_on_transfer(acc("stranger.testnet"), U128(5), String::new()) {
        PromiseOrValue::Value(v) => assert_eq!(v.0, 5),
        _ => panic!("expected value"),
    }
    assert_eq!(c.escrow_of(acc("stranger.testnet")), None);
}

#[test]
#[should_panic(expected = "only USDC is accepted")]
fn other_tokens_are_rejected() {
    let mut c = setup();
    set("fake-usdc.testnet");
    let _ = c.ft_on_transfer(acc("agent.testnet"), U128(5), String::new());
}

#[test]
fn failed_payout_restores_escrow_and_nullifier() {
    let mut c = setup();
    let n = hex::encode([1u8; 32]);
    submit_with_receipt(&mut c, envelope(1, "agent.testnet"));
    let _ = c.settle(n.clone(), acc("m01.bazaar.testnet"), "order-1".into(), U128(151_200_000));
    testing_env!(
        ctx("bazaar.testnet").build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed],
    );
    assert!(!c.on_settle_transfer(n.clone(), acc("agent.testnet"), U128(151_200_000)));
    assert_eq!(c.nullifier_status(n), NullifierStatus::Pending);
    assert_eq!(c.escrow_of(acc("agent.testnet")), Some(U128(200_000_000)));
}

#[test]
#[should_panic(expected = "owner only")]
fn only_owner_registers_issuers() {
    let mut c = setup();
    set("m01.bazaar.testnet");
    c.register_issuer("ed25519:00".into(), "x".into());
}

#[test]
#[should_panic(expected = "unknown predicate in schedule")]
fn merchant_cannot_price_an_invented_predicate() {
    let mut c = setup();
    let mut s = schedule();
    s.rules.push(Rule { predicate: "marriott_platinum".into(), bps: 500 });
    set("m02.bazaar.testnet");
    c.register_merchant(s, "hoodie".into(), None);
}

#[test]
fn best_quote_picks_lowest_price() {
    let mut c = setup();
    set("m02.bazaar.testnet");
    c.register_merchant(Schedule { base_price: 160_000_000, rules: vec![], cap_bps: 0, cohort: None }, "hoodie".into(), None);
    set("h01.bazaar.testnet");
    c.register_merchant(Schedule { base_price: 90_000_000, rules: vec![], cap_bps: 0, cohort: None }, "hotel-lisbon-2n".into(), None);
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
    let best = c.best_quote(hex::encode([1u8; 32]), Some("hoodie".into())).unwrap();
    assert_eq!(best.merchant, acc("m01.bazaar.testnet"));
    assert_eq!(best.quote.price, 151_200_000);
    let hotel = c.best_quote(hex::encode([1u8; 32]), Some("hotel-lisbon-2n".into())).unwrap();
    assert_eq!(hotel.merchant, acc("h01.bazaar.testnet"));
}

#[test]
#[should_panic(expected = "bad category")]
fn merchant_category_is_validated() {
    let mut c = setup();
    set("m02.bazaar.testnet");
    c.register_merchant(schedule(), "Hoodie Store!".into(), None);
}

#[test]
#[should_panic(expected = "for storage")]
fn verdict_without_storage_deposit_is_rejected() {
    let mut c = setup();
    set_no_deposit("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
}

#[test]
fn unused_storage_deposit_is_refunded() {
    let mut c = setup();
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
    let receipts = near_sdk::test_utils::get_created_receipts();
    let refund = receipts.iter().find(|r| r.receiver_id.as_str() == "agent.testnet").expect("refund receipt");
    let amount = refund.actions.iter().find_map(|a| match a {
        near_sdk::mock::MockAction::Transfer { deposit, .. } => Some(*deposit),
        _ => None,
    });
    let amount = amount.expect("transfer action");
    assert!(amount > NearToken::from_yoctonear(0) && amount < RECORD_DEPOSIT);
}

#[test]
#[should_panic(expected = "no referee receipt for this quote")]
fn settle_without_referee_receipt_is_rejected() {
    let mut c = setup();
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
    let _ = c.settle(hex::encode([1u8; 32]), acc("m01.bazaar.testnet"), "order-1".into(), U128(151_200_000));
}

#[test]
fn uncited_fact_refuses_receipt() {
    let mut c = setup();
    let e = envelope(1, "agent.testnet");
    set("agent.testnet");
    c.submit_verdict(sign_ed(e.clone()));
    let mut cheat = honest_claims();
    cheat.push(Claim { line: "airbnb_frequent".into(), text: "guest is marriott platinum".into(), citations: vec!["F9".into()] });
    assert!(!c.submit_referee_result(referee_result(&e, cheat, &referee_key())));
    assert!(get_logs().iter().any(|l| l.contains("receipt_refused") && l.contains("F9 not in proof set")));
    assert_eq!(c.verdict(e.nullifier).unwrap().receipt, None);
}

#[test]
#[should_panic(expected = "unknown referee key")]
fn unknown_referee_key_is_rejected() {
    let mut c = setup();
    let e = envelope(1, "agent.testnet");
    set("agent.testnet");
    c.submit_verdict(sign_ed(e.clone()));
    c.submit_referee_result(referee_result(&e, honest_claims(), &SigningKey::from_bytes(&[6u8; 32])));
}

#[test]
#[should_panic(expected = "bad referee signature")]
fn tampered_referee_result_is_rejected() {
    let mut c = setup();
    let e = envelope(1, "agent.testnet");
    set("agent.testnet");
    c.submit_verdict(sign_ed(e.clone()));
    let mut r = referee_result(&e, honest_claims(), &referee_key());
    r.body.outcome = "receipt".into();
    r.body.detail = "forged".into();
    c.submit_referee_result(r);
}

#[test]
#[should_panic(expected = "referee result is for another verdict")]
fn referee_result_for_another_verdict_is_rejected() {
    let mut c = setup();
    let e = envelope(1, "agent.testnet");
    set("agent.testnet");
    c.submit_verdict(sign_ed(e.clone()));
    let mut other = e.clone();
    other.max_spend += 1;
    c.submit_referee_result(referee_result(&other, honest_claims(), &referee_key()));
}

#[test]
fn outlayer_callback_accepts_worker_stdout() {
    let mut c = setup();
    let e = envelope(1, "agent.testnet");
    set("agent.testnet");
    c.submit_verdict(sign_ed(e.clone()));
    let stdout = serde_json::to_vec(&referee_result(&e, honest_claims(), &referee_key())).unwrap();
    testing_env!(
        ctx("bazaar.testnet").build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(stdout)],
    );
    assert!(c.on_referee_result());
    assert!(c.verdict(e.nullifier).unwrap().receipt.is_some());
}

fn cohort_schedule() -> Schedule {
    let mut s = schedule();
    s.cohort = Some(bookerbob_core::CohortRule { predicate: "world_id_human".into(), k_min: 5, bps: 500 });
    s
}

/// Five other agents in the same context reveal world_id_human.
fn join_cohort(c: &mut Bazaar, n: u8) {
    for i in 0..n {
        let agent = format!("peer{i}.testnet");
        attest(c, &agent, 210 + i);
        set(&agent);
        c.submit_verdict(sign_ed(envelope(100 + i, &agent)));
    }
}

#[test]
fn cohort_size_counts_verdicts_per_context_and_predicate() {
    let mut c = setup();
    join_cohort(&mut c, 3);
    assert_eq!(c.cohort_size("bookerbob:v0:test".into(), "world_id_human".into()), 3);
    assert_eq!(c.cohort_size("bookerbob:v0:other".into(), "world_id_human".into()), 0);
}

#[test]
fn group_unlock_opens_at_k6() {
    let mut c = setup();
    set("m02.bazaar.testnet");
    c.register_merchant(cohort_schedule(), "hoodie".into(), None);
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
    let n = hex::encode([1u8; 32]);
    let locked = c.quote(acc("m02.bazaar.testnet"), n.clone());
    assert_eq!((locked.cohort.is_none(), locked.discount_bps), (true, 2000));
    join_cohort(&mut c, 5);
    let open = c.quote(acc("m02.bazaar.testnet"), n);
    assert_eq!(open.cohort.as_ref().map(|x| x.k), Some(6));
    assert_eq!(open.discount_bps, 2500);
    assert_eq!(open.price, 141_750_000);
}

#[test]
fn receipt_price_holds_when_the_cohort_grows_later() {
    let mut c = setup();
    set("m01.bazaar.testnet");
    c.register_merchant(cohort_schedule(), "hoodie".into(), None);
    let e = envelope(1, "agent.testnet");
    submit_with_receipt(&mut c, e.clone());
    join_cohort(&mut c, 5);
    // The quote dropped, but the agent pays the receipt price it was refereed at.
    assert!(c.quote(acc("m01.bazaar.testnet"), e.nullifier.clone()).price < 151_200_000);
    set("agent.testnet");
    let _ = c.settle(e.nullifier.clone(), acc("m01.bazaar.testnet"), "order-1".into(), U128(151_200_000));
    assert_eq!(c.nullifier_status(e.nullifier), NullifierStatus::Spent);
}

#[test]
#[should_panic(expected = "one person, one agent")]
fn second_agent_of_the_same_person_is_blocked() {
    let mut c = setup();
    attest(&mut c, "agent2.testnet", 200); // same World nullifier as agent.testnet
}

#[test]
#[should_panic(expected = "world_id_human needs a world attestation")]
fn world_id_predicate_without_attestation_is_rejected() {
    let mut c = setup();
    set("stranger.testnet");
    c.submit_verdict(sign_ed(envelope(1, "stranger.testnet")));
}

#[test]
#[should_panic(expected = "unknown world verifier")]
fn world_attestation_from_unknown_verifier_is_rejected() {
    let mut c = setup();
    set("x.testnet");
    c.attest_human(world_attestation("x.testnet", 9, &SigningKey::from_bytes(&[1u8; 32])));
}

#[test]
#[should_panic(expected = "bad world signature")]
fn tampered_world_attestation_is_rejected() {
    let mut c = setup();
    let mut a = world_attestation("x.testnet", 9, &world_key());
    a.body.agent = "y.testnet".into();
    set("y.testnet");
    c.attest_human(a);
}

#[test]
fn reattesting_the_same_pair_is_idempotent() {
    let mut c = setup();
    attest(&mut c, "agent.testnet", 200);
    assert!(c.is_human(acc("agent.testnet")));
}

fn arbiter_key() -> SigningKey {
    SigningKey::from_bytes(&[11u8; 32])
}

/// A compromised (registered) referee key signs a receipt for the F9 cheat.
fn forged_receipt(e: &Envelope) -> (Vec<Claim>, WorkerResult) {
    let mut cheat = honest_claims();
    cheat.push(Claim { line: "airbnb_frequent".into(), text: "guest is marriott platinum".into(), citations: vec!["F9".into()] });
    let mut r = referee_result(e, cheat.clone(), &referee_key());
    r.body.outcome = "receipt".into();
    r.body.detail = "forged".into();
    r.signature = hex::encode(referee_key().sign(&r.body.signing_message()).to_bytes());
    (cheat, r)
}

fn decide(v: &SignedVerdict, result: &WorkerResult, claims: Vec<Claim>) -> bookerbob_core::DisputeDecision {
    let d = DisputeInput {
        v: 0,
        verdict: v.clone(),
        result: result.clone(),
        schedule: schedule(),
        claims,
        proofs: proofs(),
        cohort_k: 0,
        issuer_keys: vec![v.key_id()],
        referee_keys: vec![hex::encode(referee_key().verifying_key().to_bytes())],
    };
    serde_json::from_str(&arbitrate(&d, &arbiter_key()).unwrap()).unwrap()
}

#[test]
fn compromised_referee_receipt_is_overturned_and_settle_is_blocked() {
    let mut c = setup();
    set("owner.testnet");
    c.register_arbiter(hex::encode(arbiter_key().verifying_key().to_bytes()), "fixture arbiter".into());
    let e = envelope(1, "agent.testnet");
    let v = sign_ed(e.clone());
    set("agent.testnet");
    c.submit_verdict(v.clone());
    let (cheat, forged) = forged_receipt(&e);
    assert!(c.submit_referee_result(forged.clone()), "the contract trusts a registered referee key");
    let decision = decide(&v, &forged, cheat);
    assert_eq!(decision.body.decision, "overturned");
    assert!(c.submit_dispute_decision(decision));
    assert_eq!(c.verdict(e.nullifier.clone()).unwrap().receipt, None);
    assert!(get_logs().iter().any(|l| l.contains("dispute_overturned")));
}

#[test]
fn honest_receipt_is_upheld_and_stays() {
    let mut c = setup();
    set("owner.testnet");
    c.register_arbiter(hex::encode(arbiter_key().verifying_key().to_bytes()), "fixture arbiter".into());
    let e = envelope(1, "agent.testnet");
    let v = sign_ed(e.clone());
    set("agent.testnet");
    c.submit_verdict(v.clone());
    let r = referee_result(&e, honest_claims(), &referee_key());
    c.submit_referee_result(r.clone());
    assert!(!c.submit_dispute_decision(decide(&v, &r, honest_claims())));
    assert!(c.verdict(e.nullifier).unwrap().receipt.is_some());
}

#[test]
#[should_panic(expected = "unknown arbiter key")]
fn decision_from_unknown_arbiter_is_rejected() {
    let mut c = setup();
    let e = envelope(1, "agent.testnet");
    let v = sign_ed(e.clone());
    set("agent.testnet");
    c.submit_verdict(v.clone());
    let (cheat, forged) = forged_receipt(&e);
    c.submit_referee_result(forged.clone());
    c.submit_dispute_decision(decide(&v, &forged, cheat));
}

#[test]
fn withdraw_returns_unspent_escrow() {
    let mut c = setup();
    let mut b = ctx("agent.testnet");
    b.attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(b.build());
    let _ = c.withdraw(U128(50_000_000));
    assert_eq!(c.escrow_of(acc("agent.testnet")), Some(U128(150_000_000)));
    assert!(near_sdk::test_utils::get_created_receipts().iter().any(|r| r.receiver_id.as_str() == USDC));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_needs_a_full_access_key() {
    let mut c = setup();
    set_no_deposit("agent.testnet");
    let _ = c.withdraw(U128(1));
}

#[test]
#[should_panic(expected = "insufficient escrow")]
fn withdraw_more_than_escrow_is_rejected() {
    let mut c = setup();
    let mut b = ctx("agent.testnet");
    b.attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(b.build());
    let _ = c.withdraw(U128(200_000_001));
}

#[test]
fn failed_withdraw_restores_escrow() {
    let mut c = setup();
    let mut b = ctx("agent.testnet");
    b.attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(b.build());
    let _ = c.withdraw(U128(50_000_000));
    testing_env!(
        ctx("bazaar.testnet").build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed],
    );
    assert!(!c.on_withdraw(acc("agent.testnet"), U128(50_000_000)));
    assert_eq!(c.escrow_of(acc("agent.testnet")), Some(U128(200_000_000)));
}
