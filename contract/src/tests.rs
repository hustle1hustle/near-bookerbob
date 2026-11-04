use super::*;
use bookerbob_core::{Attestation, Claim, Envelope, Fact, ProofSet, Rule, WorldAttestation, WorldBody};
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
    b.current_account_id(acc("bazaar.testnet")).predecessor_account_id(acc(predecessor)).block_timestamp(NOW_MS * 1_000_000);
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
        rules: vec![Rule { predicate: "airbnb_frequent".into(), bps: 1200 }, Rule { predicate: "world_id_human".into(), bps: 800 }],
        cap_bps: 2500,
        cohort: None,
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
    let f = |id: &str, platform: &str, field: &str, value: u64| Fact {
        id: id.into(),
        platform: platform.into(),
        field: field.into(),
        value,
        proof_ref: "cc".repeat(32),
    };
    ProofSet { facts: vec![f("F1", "airbnb", "trips_12m", 7), f("F5", "world_id", "verified", 1)] }
}

fn cite(fact: &str, field: &str, value: u64) -> bookerbob_core::Citation {
    bookerbob_core::Citation { fact: fact.into(), field: field.into(), value }
}

fn honest_claims() -> Vec<Claim> {
    vec![
        Claim { line: "airbnb_frequent".into(), text: "frequent".into(), citations: vec![cite("F1", "trips_12m", 7)] },
        Claim { line: "world_id_human".into(), text: "human".into(), citations: vec![cite("F5", "verified", 1)] },
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
/// Owner approves a merchant's current schedule.
fn approve(c: &mut Bazaar, merchant: &str) {
    set_no_deposit("owner.testnet");
    c.approve_merchant(acc(merchant));
}

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
    approve(&mut c, "m01.bazaar.testnet");
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
    let sig: [u8; 64] =
        hex::decode("EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF37160834E36AD29A83BF2BC9385E491D6099C8FDF9D1ED67AA7EA5F51F93782857A9")
            .unwrap()
            .try_into()
            .unwrap();
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
    approve(&mut c, "m01.bazaar.testnet");
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
    c.register_merchant(Schedule { base_price: 90_000_000, rules: vec![], cap_bps: 0, cohort: None }, "hotel-lisbon".into(), None);
    approve(&mut c, "m02.bazaar.testnet");
    approve(&mut c, "h01.bazaar.testnet");
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
    let best = c.best_quote(hex::encode([1u8; 32]), Some("hoodie".into()), None, None, None).unwrap();
    assert_eq!(best.merchant, acc("m01.bazaar.testnet"));
    assert_eq!(best.quote.price, 151_200_000);
    let hotel = c.best_quote(hex::encode([1u8; 32]), Some("hotel-lisbon".into()), None, None, None).unwrap();
    assert_eq!(hotel.merchant, acc("h01.bazaar.testnet"));
}

#[test]
fn unapproved_merchant_is_never_quoted() {
    // A spammer registers a cheaper schedule; until the owner approves it, the board ignores it.
    let mut c = setup();
    set("spam.testnet");
    c.register_merchant(Schedule { base_price: 1, rules: vec![], cap_bps: 0, cohort: None }, "hoodie".into(), None);
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
    let n = hex::encode([1u8; 32]);
    assert_eq!(c.best_quote(n.clone(), Some("hoodie".into()), None, None, None).unwrap().merchant, acc("m01.bazaar.testnet"));
    approve(&mut c, "spam.testnet");
    assert_eq!(c.best_quote(n.clone(), Some("hoodie".into()), None, None, None).unwrap().merchant, acc("spam.testnet"));
    set_no_deposit("owner.testnet");
    c.revoke_merchant(acc("spam.testnet"));
    assert_eq!(c.best_quote(n, Some("hoodie".into()), None, None, None).unwrap().merchant, acc("m01.bazaar.testnet"));
}

#[test]
#[should_panic(expected = "merchant not approved")]
fn changed_schedule_needs_new_approval_before_payment() {
    // Bait and switch: m01 is approved, then re-registers a different schedule.
    let mut c = setup();
    submit_with_receipt(&mut c, envelope(1, "agent.testnet"));
    set("m01.bazaar.testnet");
    c.register_merchant(schedule(), "hoodie".into(), None);
    assert!(!c.merchant(acc("m01.bazaar.testnet")).unwrap().approved);
    set("agent.testnet");
    let _ = c.settle(hex::encode([1u8; 32]), acc("m01.bazaar.testnet"), "order-1".into(), U128(151_200_000));
}

#[test]
#[should_panic(expected = "owner only")]
fn only_owner_approves_merchants() {
    let mut c = setup();
    set_no_deposit("m01.bazaar.testnet");
    c.approve_merchant(acc("m01.bazaar.testnet"));
}

#[test]
fn best_quote_is_paginated_and_capped() {
    let mut c = setup();
    // m01 (151.20 after discounts) is index 0; three cheaper flat merchants follow.
    for (i, price) in [(2, 140_000_000u128), (3, 130_000_000), (4, 120_000_000)] {
        let id = format!("m0{i}.bazaar.testnet");
        set(&id);
        c.register_merchant(Schedule { base_price: price, rules: vec![], cap_bps: 0, cohort: None }, "hoodie".into(), None);
        approve(&mut c, &id);
    }
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
    let n = hex::encode([1u8; 32]);
    let page = |c: &Bazaar, from, limit| c.best_quote(n.clone(), Some("hoodie".into()), Some(from), Some(limit), None).map(|q| q.merchant.to_string());
    assert_eq!(page(&c, 0, 1).as_deref(), Some("m01.bazaar.testnet"));
    assert_eq!(page(&c, 0, 2).as_deref(), Some("m02.bazaar.testnet"));
    assert_eq!(page(&c, 2, 2).as_deref(), Some("m04.bazaar.testnet"));
    assert_eq!(page(&c, 4, 10), None);
    // A huge limit is capped, and still sees all four.
    assert_eq!(page(&c, 0, u32::MAX).as_deref(), Some("m04.bazaar.testnet"));
    assert_eq!(MAX_QUOTE_PAGE, 100);
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
    cheat.push(Claim { line: "airbnb_frequent".into(), text: "guest is marriott platinum".into(), citations: vec![cite("F9", "trips_12m", 7)] });
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
    approve(&mut c, "m01.bazaar.testnet");
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
    cheat.push(Claim { line: "airbnb_frequent".into(), text: "guest is marriott platinum".into(), citations: vec![cite("F9", "trips_12m", 7)] });
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

/// Property tests: generated amounts and sequences against the real contract code.
mod props {
    use super::*;
    use proptest::prelude::*;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    /// Run `f`; Ok if it returned, Err(message) if the contract panicked.
    fn attempt<T>(f: impl FnOnce() -> T) -> Result<T, String> {
        catch_unwind(AssertUnwindSafe(f))
            .map_err(|e| e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default())
    }

    /// Each case on its own thread: near-sdk's mocked storage is thread-local and survives
    /// `testing_env!`, so cases would otherwise share state.
    fn fresh(f: impl FnOnce() -> Result<(), TestCaseError> + Send + 'static) -> Result<(), TestCaseError> {
        std::thread::spawn(f).join().unwrap_or_else(|e| std::panic::resume_unwind(e))
    }

    fn with_one_yocto(predecessor: &str) {
        let mut b = ctx(predecessor);
        b.attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(b.build());
    }

    #[derive(Clone, Debug)]
    enum Op {
        Deposit(u128),
        Withdraw(u128),
    }

    fn op() -> impl Strategy<Value = Op> {
        prop_oneof![(1u128..1_000_000_000).prop_map(Op::Deposit), (0u128..2_000_000_000).prop_map(Op::Withdraw)]
    }

    fn escrow_case(ops: Vec<Op>) -> Result<(), TestCaseError> {
        let mut c = setup();
        let mut model: u128 = 200_000_000;
        for o in ops {
            match o {
                Op::Deposit(a) => {
                    set(USDC);
                    let _ = c.ft_on_transfer(acc("agent.testnet"), U128(a), String::new());
                    model += a;
                }
                Op::Withdraw(a) => {
                    with_one_yocto("agent.testnet");
                    let r = attempt(|| drop(c.withdraw(U128(a))));
                    if a > 0 && a <= model {
                        prop_assert!(r.is_ok(), "withdraw {} of {} failed: {:?}", a, model, r);
                        model -= a;
                    } else {
                        prop_assert!(r.unwrap_err().contains("insufficient escrow"));
                    }
                }
            }
            prop_assert_eq!(c.escrow_of(acc("agent.testnet")), Some(U128(model)));
        }
        Ok(())
    }

    fn nullifier_case(n: u8, settle_first: bool) -> Result<(), TestCaseError> {
        let mut c = setup();
        let null = hex::encode([n; 32]);
        submit_with_receipt(&mut c, envelope(n, "agent.testnet"));
        if settle_first {
            let _ = c.settle(null, acc("m01.bazaar.testnet"), "order-1".into(), U128(151_200_000));
        }
        // Same nullifier, any wallet: the original agent or a second one.
        for agent in ["agent.testnet", "wallet2.testnet"] {
            set(agent);
            let err = attempt(|| c.submit_verdict(sign_ed(envelope(n, agent)))).unwrap_err();
            prop_assert!(err.contains(if settle_first { "nullifier spent" } else { "nullifier pending" }), "{}", err);
        }
        prop_assert_eq!(c.spent_count(), settle_first as u64);
        Ok(())
    }

    fn settle_case(max_spend: u128, delta: i64) -> Result<(), TestCaseError> {
        let mut c = setup();
        let price: u128 = 151_200_000;
        let mut e = envelope(1, "agent.testnet");
        e.max_spend = max_spend;
        submit_with_receipt(&mut c, e);
        let amount = (price as i128 + delta as i128) as u128;
        let r = attempt(|| drop(c.settle(hex::encode([1u8; 32]), acc("m01.bazaar.testnet"), "order-1".into(), U128(amount))));
        if delta == 0 && max_spend >= price {
            prop_assert!(r.is_ok(), "{:?}", r);
            prop_assert_eq!(c.escrow_of(acc("agent.testnet")), Some(U128(200_000_000 - price)));
            prop_assert_eq!(c.nullifier_status(hex::encode([1u8; 32])), NullifierStatus::Spent);
        } else {
            prop_assert!(r.is_err());
            prop_assert_eq!(c.escrow_of(acc("agent.testnet")), Some(U128(200_000_000)));
        }
        Ok(())
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn escrow_balance_is_conserved(ops in prop::collection::vec(op(), 1..20)) {
            fresh(move || escrow_case(ops))?;
        }

        #[test]
        fn a_nullifier_is_accepted_once(n in 2u8..=255, settle_first in any::<bool>()) {
            fresh(move || nullifier_case(n, settle_first))?;
        }

        #[test]
        fn settle_pays_exactly_the_quote_within_the_cap(max_spend in 1u128..400_000_000, delta in -2i64..=2) {
            fresh(move || settle_case(max_spend, delta))?;
        }
    }
}

// ---------- blind bid rounds ----------

const COMMIT_UNTIL: u64 = NOW_MS + 60_000;
const REVEAL_UNTIL: u64 = NOW_MS + 120_000;

fn at(predecessor: &str, ms: u64) {
    let mut b = ctx(predecessor);
    b.block_timestamp(ms * 1_000_000).attached_deposit(RECORD_DEPOSIT);
    testing_env!(b.build());
}

fn sealed(account: &str, s: &Schedule, salt: u8) -> String {
    bookerbob_core::bid_commitment(account, s, &[salt; 32])
}

fn cheap() -> Schedule {
    Schedule { base_price: 189_000_000, rules: vec![Rule { predicate: "airbnb_frequent".into(), bps: 5000 }], cap_bps: 5000, cohort: None }
}

/// setup(), m02 approved, a verdict on chain and an open hoodie round.
fn round_setup() -> Bazaar {
    let mut c = setup();
    set("m02.bazaar.testnet");
    c.register_merchant(Schedule { base_price: 189_000_000, rules: vec![], cap_bps: 0, cohort: None }, "hoodie".into(), None);
    approve(&mut c, "m02.bazaar.testnet");
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
    set_no_deposit("owner.testnet");
    c.open_round("r1".into(), "hoodie".into(), COMMIT_UNTIL, REVEAL_UNTIL);
    c
}

#[test]
fn blind_round_picks_the_lowest_revealed_bid_after_the_deadline() {
    let mut c = round_setup();
    at("m01.bazaar.testnet", NOW_MS);
    c.commit_bid("r1".into(), sealed("m01.bazaar.testnet", &schedule(), 1));
    at("m02.bazaar.testnet", NOW_MS);
    c.commit_bid("r1".into(), sealed("m02.bazaar.testnet", &cheap(), 2));
    // The board shows only hashes until the commit deadline; m02's public schedule is flat.
    assert_eq!(c.best_quote(hex::encode([1u8; 32]), Some("hoodie".into()), None, None, None).unwrap().merchant, acc("m01.bazaar.testnet"));
    at("m01.bazaar.testnet", COMMIT_UNTIL);
    c.reveal_bid("r1".into(), schedule(), hex::encode([1u8; 32]));
    at("m02.bazaar.testnet", COMMIT_UNTIL + 1);
    c.reveal_bid("r1".into(), cheap(), hex::encode([2u8; 32]));
    at("agent.testnet", REVEAL_UNTIL);
    let w = c.round_best_quote("r1".into(), hex::encode([1u8; 32])).unwrap();
    assert_eq!((w.merchant, w.quote.price), (acc("m02.bazaar.testnet"), 94_500_000));
    assert_eq!(c.round("r1".into()).unwrap().revealed.len(), 2);
}

#[test]
#[should_panic(expected = "round still open")]
fn round_winner_is_hidden_until_the_reveal_deadline() {
    let c = round_setup();
    at("agent.testnet", REVEAL_UNTIL - 1);
    let _ = c.round_best_quote("r1".into(), hex::encode([1u8; 32]));
}

#[test]
#[should_panic(expected = "bid does not open its commitment")]
fn reveal_that_differs_from_the_commitment_is_refused() {
    let mut c = round_setup();
    at("m02.bazaar.testnet", NOW_MS);
    c.commit_bid("r1".into(), sealed("m02.bazaar.testnet", &schedule(), 2));
    at("m02.bazaar.testnet", COMMIT_UNTIL);
    // Saw the others, tries a cheaper schedule than it committed to.
    c.reveal_bid("r1".into(), cheap(), hex::encode([2u8; 32]));
}

#[test]
#[should_panic(expected = "commit phase is over")]
fn late_commit_is_refused() {
    let mut c = round_setup();
    at("m02.bazaar.testnet", COMMIT_UNTIL);
    c.commit_bid("r1".into(), sealed("m02.bazaar.testnet", &cheap(), 2));
}

#[test]
#[should_panic(expected = "reveal opens after the commit deadline")]
fn early_reveal_is_refused() {
    let mut c = round_setup();
    at("m02.bazaar.testnet", NOW_MS);
    c.commit_bid("r1".into(), sealed("m02.bazaar.testnet", &cheap(), 2));
    c.reveal_bid("r1".into(), cheap(), hex::encode([2u8; 32]));
}

#[test]
fn unrevealed_bid_is_void() {
    let mut c = round_setup();
    at("m01.bazaar.testnet", NOW_MS);
    c.commit_bid("r1".into(), sealed("m01.bazaar.testnet", &schedule(), 1));
    at("m02.bazaar.testnet", NOW_MS);
    c.commit_bid("r1".into(), sealed("m02.bazaar.testnet", &cheap(), 2));
    at("m01.bazaar.testnet", COMMIT_UNTIL);
    c.reveal_bid("r1".into(), schedule(), hex::encode([1u8; 32]));
    // m02 never reveals; after the deadline it cannot.
    at("m02.bazaar.testnet", REVEAL_UNTIL);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.reveal_bid("r1".into(), cheap(), hex::encode([2u8; 32])))).is_err());
    at("agent.testnet", REVEAL_UNTIL);
    assert_eq!(c.round_best_quote("r1".into(), hex::encode([1u8; 32])).unwrap().merchant, acc("m01.bazaar.testnet"));
}

#[test]
#[should_panic(expected = "merchant not approved")]
fn unapproved_merchant_cannot_bid() {
    let mut c = round_setup();
    at("spam.testnet", NOW_MS);
    c.register_merchant(cheap(), "hoodie".into(), None);
    c.commit_bid("r1".into(), sealed("spam.testnet", &cheap(), 3));
}

#[test]
#[should_panic(expected = "already committed")]
fn one_sealed_bid_per_merchant() {
    let mut c = round_setup();
    at("m02.bazaar.testnet", NOW_MS);
    c.commit_bid("r1".into(), sealed("m02.bazaar.testnet", &cheap(), 2));
    c.commit_bid("r1".into(), sealed("m02.bazaar.testnet", &schedule(), 2));
}

// ---------- NEAR AI verdicts (live capture in fixtures/live/near-ai/) ----------

mod near_ai {
    use super::*;
    use bookerbob_core::near_ai::NearAiProof;

    const CAPTURE: &str = include_str!("../../fixtures/live/near-ai/capture.json");
    const PROOF: &str = include_str!("../../fixtures/live/near-ai/proof.json");
    const REPORT: &[u8] = include_bytes!("../../fixtures/live/near-ai/report.json");

    fn captured() -> (Envelope, NearAiProof) {
        let c: serde_json::Value = serde_json::from_str(CAPTURE).unwrap();
        (serde_json::from_value(c["envelope"].clone()).unwrap(), serde_json::from_str(PROOF).unwrap())
    }

    /// A bazaar with the model attestation registered and the envelope's agent bound to a person.
    fn chain() -> (Bazaar, Envelope, NearAiProof) {
        let (e, p) = captured();
        set("owner.testnet");
        let mut c = Bazaar::new(acc("owner.testnet"), acc(USDC));
        c.register_world_verifier(hex::encode(world_key().verifying_key().to_bytes()), WORLD_ACTION.into(), "fixture".into());
        let att = ModelAttestation {
            model: e.attestation.model.clone(),
            nonce: p.nonce.clone(),
            report_hash: bookerbob_core::sha256_hex(REPORT),
            tcb_status: e.attestation.tcb_status.clone(),
        };
        c.register_model_attestation(p.signing_key.clone(), att);
        attest(&mut c, &e.cnf, 9);
        set(&e.cnf);
        (c, e, p)
    }

    #[test]
    fn verdict_issued_by_near_ai_is_accepted_with_its_proof() {
        let (mut c, e, p) = chain();
        c.submit_near_ai_verdict(e.clone(), p.clone());
        let r = c.verdict(e.nullifier.clone()).unwrap();
        assert_eq!(r.issuer, format!("near-ai:{}", p.signing_key));
        assert_eq!(r.tcb_status, "UpToDate");
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"near_ai_verdict\"") && l.contains(&p.chat_id)));
    }

    #[test]
    #[should_panic(expected = "unregistered model key")]
    fn shared_model_key_without_a_registered_attestation_is_refused() {
        let (e, p) = captured();
        set("owner.testnet");
        let mut c = Bazaar::new(acc("owner.testnet"), acc(USDC));
        set(&e.cnf);
        c.submit_near_ai_verdict(e, p);
    }

    #[test]
    #[should_panic(expected = "answer is about another envelope")]
    fn a_valid_model_signature_for_another_envelope_is_refused() {
        // Every user of the model shares its key: the signature is real, the binding is not ours.
        let (mut c, mut e, p) = chain();
        e.nullifier = "77".repeat(32);
        c.submit_near_ai_verdict(e, p);
    }

    #[test]
    #[should_panic(expected = "envelope tcb_status differs from the attestation")]
    fn a_rewritten_tcb_status_is_refused() {
        let (mut c, mut e, p) = chain();
        e.attestation.tcb_status = "OutOfDate".into();
        c.submit_near_ai_verdict(e, p);
    }

    #[test]
    #[should_panic(expected = "envelope reveals a predicate the model did not attest")]
    fn revealing_a_predicate_the_model_did_not_attest_is_refused() {
        let (mut c, mut e, p) = chain();
        e.predicates = vec!["airbnb_frequent".into(), "claude_spender".into(), "steam_veteran".into(), "world_id_human".into()];
        c.submit_near_ai_verdict(e, p);
    }

    #[test]
    #[should_panic(expected = "bad TEE signature")]
    fn an_edited_response_is_refused() {
        let (mut c, e, mut p) = chain();
        p.response.push(' ');
        c.submit_near_ai_verdict(e, p);
    }

    #[test]
    #[should_panic(expected = "nullifier pending")]
    fn the_same_near_ai_verdict_cannot_be_submitted_twice() {
        let (mut c, e, p) = chain();
        c.submit_near_ai_verdict(e.clone(), p.clone());
        c.submit_near_ai_verdict(e, p);
    }
}

// ---------- storage: the record's growth is prepaid by the agent ----------

/// Contract-owned storage right now, after writing every collection.
fn usage(c: &mut Bazaar) -> u64 {
    c.flush_all();
    env::storage_usage()
}

#[test]
fn verdict_deposit_prepays_the_record_reserve() {
    let mut c = setup();
    // storage_usage restarts with every testing_env!, so measure inside one context.
    set("agent.testnet");
    let before = usage(&mut c);
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
    let added = usage(&mut c) - before;
    let cost = env::storage_byte_cost().as_yoctonear() * (added + RECORD_RESERVE_BYTES) as u128;
    let refund: u128 = near_sdk::test_utils::get_created_receipts()
        .iter()
        .flat_map(|r| r.actions.iter())
        .filter_map(|a| match a {
            near_sdk::mock::MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()),
            _ => None,
        })
        .sum();
    assert_eq!(refund, RECORD_DEPOSIT.as_yoctonear() - cost);
    assert_eq!(c.verdict(hex::encode([1u8; 32])).unwrap().storage_reserve, RECORD_RESERVE_BYTES);
}

#[test]
fn referee_receipt_and_settle_bytes_come_from_the_reserve_not_the_contract() {
    let mut c = setup();
    let n = hex::encode([1u8; 32]);
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
    // One context for all three measurements (storage_usage restarts with testing_env!).
    set("agent.testnet");
    let (u0, r0) = (usage(&mut c), c.verdict(n.clone()).unwrap().storage_reserve);
    assert!(c.submit_referee_result(referee_result(&envelope(1, "agent.testnet"), honest_claims(), &referee_key())));
    let (u1, r1) = (usage(&mut c), c.verdict(n.clone()).unwrap().storage_reserve);
    assert!(u1 > u0, "the receipt adds storage");
    assert_eq!(r0 - r1, u1 - u0, "every receipt byte is drawn from the reserve");
    let _ = c.settle(n.clone(), acc("m01.bazaar.testnet"), "order-1".into(), U128(151_200_000));
    let (u2, r2) = (usage(&mut c), c.verdict(n).unwrap().storage_reserve);
    assert_eq!(r1 - r2, u2 - u1, "every settle byte is drawn from the reserve");
}

#[test]
#[should_panic(expected = "record storage reserve exhausted")]
fn growth_beyond_the_reserve_is_refused() {
    let mut c = setup();
    let n = hex::encode([1u8; 32]);
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
    c.verdicts.get_mut(&n).unwrap().storage_reserve = 10;
    c.submit_referee_result(referee_result(&envelope(1, "agent.testnet"), honest_claims(), &referee_key()));
}

// ---------- sealed reviews (fixtures/semaphore, Semaphore v4 proofs) ----------

mod reviews {
    use super::*;

    const REVIEWS: &str = include_str!("../../fixtures/semaphore/reviews.json");
    const SMALL: &str = include_str!("../../fixtures/semaphore/reviews-small-group.json");
    const GROUP: &str = include_str!("../../fixtures/semaphore/group.json");
    /// Fixture clock (cli/src/fixtures.rs), inside the proofs' round.
    const T: u64 = 1_793_793_600_000;

    fn j(s: &str) -> serde_json::Value {
        serde_json::from_str(s).unwrap()
    }

    fn at(who: &str, ms: u64) {
        let mut b = ctx(who);
        b.block_timestamp(ms * 1_000_000).attached_deposit(RECORD_DEPOSIT);
        testing_env!(b.build());
    }

    /// A settled purchase from `merchant` by `agent`, written directly (the full settle path
    /// is covered above and in make verify).
    fn settled(c: &mut Bazaar, i: usize, agent: &str, merchant: &str) -> String {
        let n = hex::encode([200 + i as u8; 32]);
        let receipt =
            RefereeReceipt { merchant: acc(merchant), price: U128(1), receipt_hash: "00".repeat(32), referee: "00".repeat(32), result_sha256: "00".repeat(32) };
        let r = VerdictRecord {
            agent: acc(agent),
            context: "bookerbob:v0:test".into(),
            predicates: vec![],
            commitment: "22".repeat(32),
            proof_hash: "33".repeat(32),
            tier: "silver".into(),
            tcb_status: "fixture".into(),
            issuer: "fixture".into(),
            max_spend: U128(1),
            expires_at_ms: T + 1,
            spent: true,
            checkout_ref: Some(format!("order-{i}")),
            digest: "44".repeat(32),
            receipt: Some(receipt),
            disputed: false,
            storage_reserve: RECORD_RESERVE_BYTES,
            review_joined: false,
            paid: true,
        };
        c.verdicts.insert(n.clone(), r);
        n
    }

    /// `members` buyers of `merchant` join, in fixture order.
    fn group(members: &[serde_json::Value], merchant: &str) -> Bazaar {
        at("owner.testnet", T);
        let mut c = Bazaar::new(acc("owner.testnet"), acc(USDC));
        for (i, m) in members.iter().enumerate() {
            let agent = format!("buyer{i}.testnet");
            let n = settled(&mut c, i, &agent, merchant);
            at(&agent, T);
            c.join_review_group(n, m.as_str().unwrap().into());
        }
        c
    }

    fn proof(p: &serde_json::Value) -> ReviewProof {
        let pts: Vec<String> = p["points"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().into()).collect();
        ReviewProof {
            depth: p["merkleTreeDepth"].as_u64().unwrap() as u32,
            merkle_root: p["merkleTreeRoot"].as_str().unwrap().into(),
            nullifier: p["nullifier"].as_str().unwrap().into(),
            points: pts.try_into().unwrap(),
        }
    }

    fn rate(c: &mut Bazaar, merchant: &str, entry: &serde_json::Value, relayer: &str) {
        at(relayer, T);
        c.submit_review(acc(merchant), entry["review"]["sealed"].as_str().unwrap().into(), proof(&entry["proof"]));
    }

    fn reveal(c: &mut Bazaar, merchant: &str, round: u64, r: &serde_json::Value, relayer: &str) {
        at(relayer, T + REVIEW_ROUND_MS);
        c.reveal_review(
            acc(merchant),
            round,
            r["rating"].as_u64().unwrap() as u8,
            r["delivered"].as_bool().unwrap(),
            r["reason_hash"].as_str().unwrap().into(),
            r["salt"].as_str().unwrap().into(),
        );
    }

    fn six() -> (Bazaar, serde_json::Value) {
        let g = j(GROUP);
        let c = group(g["members"].as_array().unwrap(), "m01.bookerbob.testnet");
        (c, j(REVIEWS))
    }

    #[test]
    fn the_contract_tree_root_equals_the_semaphore_group_root() {
        let (c, _) = six();
        let g = j(GROUP);
        let roots = g["roots_after_each_insert"].as_array().unwrap();
        assert_eq!(&c.review_group(acc("m01.bookerbob.testnet")).unwrap().tree.root, roots.last().unwrap().as_str().unwrap());
    }

    #[test]
    fn six_buyers_rate_and_the_round_is_released_together_after_it_closes() {
        let (mut c, r) = six();
        for (i, e) in r["proofs"].as_array().unwrap().iter().enumerate() {
            rate(&mut c, "m01.bookerbob.testnet", e, &format!("relayer{i}.testnet"));
        }
        let round = r["round"].as_u64().unwrap();
        assert!(c.reviews(acc("m01.bookerbob.testnet"), round).is_none(), "sealed while the round is open");
        for (i, e) in r["proofs"].as_array().unwrap().iter().enumerate() {
            reveal(&mut c, "m01.bookerbob.testnet", round, &e["review"], &format!("relayer{i}.testnet"));
        }
        at("anyone.testnet", T + 2 * REVIEW_ROUND_MS);
        assert!(c.publish_reviews(acc("m01.bookerbob.testnet"), round));
        let out = c.reviews(acc("m01.bookerbob.testnet"), round).unwrap();
        assert_eq!(out.iter().map(|x| x.rating as u64).sum::<u64>(), 23);
        let s = c.merchant_score(acc("m01.bookerbob.testnet"));
        assert_eq!((s.ratings, s.mean_x100, s.delivered_pct, s.members), (6, 383, 83, 6));
        assert_eq!(s.score_x100, (2300 + 1500) / 11);
        assert!(!get_logs().iter().any(|l| l.contains("review_sealed") && l.contains("rating")), "the sealed event carries no rating");
        // Released in sealed-hash order, not in the order the buyers settled and rated.
        let mut by_hash: Vec<(String, u8)> = r["proofs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (e["review"]["sealed"].as_str().unwrap().to_string(), e["review"]["rating"].as_u64().unwrap() as u8))
            .collect();
        by_hash.sort();
        assert_eq!(out.iter().map(|x| x.rating).collect::<Vec<_>>(), by_hash.iter().map(|x| x.1).collect::<Vec<_>>());
    }

    #[test]
    #[should_panic(expected = "already rated this round")]
    fn a_second_rating_by_the_same_member_is_refused_by_the_nullifier() {
        let (mut c, r) = six();
        rate(&mut c, "m01.bookerbob.testnet", &r["proofs"][0], "relayer0.testnet");
        rate(&mut c, "m01.bookerbob.testnet", &r["double_rating"], "relayer9.testnet");
    }

    #[test]
    #[should_panic(expected = "nullifier and root must be canonical field elements")]
    fn a_second_rating_with_a_zero_padded_nullifier_is_refused() {
        // Audit A5: "0" + nullifier is the same field element, so the proof still verifies;
        // only the canonical form may enter the nullifier set.
        let (mut c, r) = six();
        rate(&mut c, "m01.bookerbob.testnet", &r["proofs"][0], "relayer0.testnet");
        let mut again = r["proofs"][0].clone();
        let n = again["proof"]["nullifier"].as_str().unwrap().to_string();
        again["proof"]["nullifier"] = format!("0{n}").into();
        rate(&mut c, "m01.bookerbob.testnet", &again, "relayer9.testnet");
    }

    #[test]
    #[should_panic(expected = "proof is not for this merchant's group")]
    fn a_valid_proof_from_a_non_member_is_refused() {
        let (mut c, r) = six();
        let e = serde_json::json!({ "review": r["proofs"][0]["review"], "proof": r["non_member"] });
        rate(&mut c, "m01.bookerbob.testnet", &e, "relayer0.testnet");
    }

    #[test]
    #[should_panic(expected = "invalid Semaphore proof")]
    fn changing_the_sealed_rating_under_a_real_proof_is_refused() {
        let (mut c, r) = six();
        let mut e = r["proofs"][3].clone();
        e["review"]["sealed"] = bookerbob_core::sha256_hex(b"another rating").into();
        rate(&mut c, "m01.bookerbob.testnet", &e, "relayer0.testnet");
    }

    #[test]
    #[should_panic(expected = "no sealed rating opens to this")]
    fn a_reveal_with_another_rating_than_sealed_is_refused() {
        let (mut c, r) = six();
        rate(&mut c, "m01.bookerbob.testnet", &r["proofs"][3], "relayer0.testnet");
        let mut rv = r["proofs"][3]["review"].clone();
        rv["rating"] = 5.into();
        reveal(&mut c, "m01.bookerbob.testnet", r["round"].as_u64().unwrap(), &rv, "relayer0.testnet");
    }

    #[test]
    #[should_panic(expected = "round still open")]
    fn a_rating_cannot_be_revealed_while_its_round_is_open() {
        let (mut c, r) = six();
        rate(&mut c, "m01.bookerbob.testnet", &r["proofs"][0], "relayer0.testnet");
        let rv = &r["proofs"][0]["review"];
        at("relayer0.testnet", T);
        c.reveal_review(
            acc("m01.bookerbob.testnet"),
            r["round"].as_u64().unwrap(),
            5,
            true,
            rv["reason_hash"].as_str().unwrap().into(),
            rv["salt"].as_str().unwrap().into(),
        );
    }

    #[test]
    fn a_group_below_k5_stays_sealed() {
        let s = j(SMALL);
        let mut c = group(s["members"].as_array().unwrap(), "m02.bookerbob.testnet");
        for (i, e) in s["proofs"].as_array().unwrap().iter().enumerate() {
            rate(&mut c, "m02.bookerbob.testnet", e, &format!("relayer{i}.testnet"));
        }
        let round = s["round"].as_u64().unwrap();
        // Reveals are refused below k, so the ratings never appear on chain.
        let rv = &s["proofs"][0]["review"];
        at("relayer0.testnet", T + REVIEW_ROUND_MS);
        let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.reveal_review(
                acc("m02.bookerbob.testnet"),
                round,
                rv["rating"].as_u64().unwrap() as u8,
                true,
                rv["reason_hash"].as_str().unwrap().into(),
                rv["salt"].as_str().unwrap().into(),
            )
        }));
        assert!(refused.is_err());
        at("anyone.testnet", T + 2 * REVIEW_ROUND_MS);
        assert!(!c.publish_reviews(acc("m02.bookerbob.testnet"), round));
        assert!(c.reviews(acc("m02.bookerbob.testnet"), s["round"].as_u64().unwrap()).is_none());
        assert_eq!(c.merchant_score(acc("m02.bookerbob.testnet")).ratings, 0);
    }

    #[test]
    #[should_panic(expected = "reveal window still open")]
    fn a_round_cannot_be_released_before_the_reveal_window_closes() {
        let (mut c, r) = six();
        rate(&mut c, "m01.bookerbob.testnet", &r["proofs"][0], "relayer0.testnet");
        at("anyone.testnet", T + REVIEW_ROUND_MS);
        c.publish_reviews(acc("m01.bookerbob.testnet"), r["round"].as_u64().unwrap());
    }

    #[test]
    #[should_panic(expected = "this purchase already joined")]
    fn one_purchase_joins_once() {
        at("owner.testnet", T);
        let mut c = Bazaar::new(acc("owner.testnet"), acc(USDC));
        let n = settled(&mut c, 0, "buyer0.testnet", "m01.bookerbob.testnet");
        let g = j(GROUP);
        at("buyer0.testnet", T);
        c.join_review_group(n.clone(), g["members"][0].as_str().unwrap().into());
        c.join_review_group(n, g["members"][1].as_str().unwrap().into());
    }

    #[test]
    #[should_panic(expected = "only a settled purchase joins a review group")]
    fn an_unsettled_verdict_cannot_join() {
        at("owner.testnet", T);
        let mut c = Bazaar::new(acc("owner.testnet"), acc(USDC));
        let n = settled(&mut c, 0, "buyer0.testnet", "m01.bookerbob.testnet");
        c.verdicts.get_mut(&n).unwrap().spent = false;
        at("buyer0.testnet", T);
        c.join_review_group(n, j(GROUP)["members"][0].as_str().unwrap().into());
    }
}

#[test]
fn equal_price_goes_to_the_better_reviewed_merchant_and_min_score_filters() {
    let mut c = setup();
    // m02 has the same schedule as m01 and registered second, so a plain tie goes to m01.
    set("m02.bazaar.testnet");
    c.register_merchant(schedule(), "hoodie".into(), None);
    approve(&mut c, "m02.bazaar.testnet");
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
    let n = hex::encode([1u8; 32]);
    let best = |c: &Bazaar, min| c.best_quote(n.clone(), Some("hoodie".into()), None, None, min).map(|q| q.merchant.to_string());
    assert_eq!(best(&c, None).as_deref(), Some("m01.bazaar.testnet"));
    // Released ratings: m02 has six 5s, m01 six 2s.
    c.review_totals.insert(acc("m02.bazaar.testnet"), (6, 30, 6));
    c.review_totals.insert(acc("m01.bazaar.testnet"), (6, 12, 6));
    assert_eq!(best(&c, None).as_deref(), Some("m02.bazaar.testnet"));
    assert_eq!(c.merchant_score(acc("m02.bazaar.testnet")).score_x100, (3000 + 1500) / 11);
    // A buyer that wants at least 3.00 drops m01 (2.45); m02 (4.09) stays.
    assert_eq!(best(&c, Some(300)).as_deref(), Some("m02.bazaar.testnet"));
    assert_eq!(best(&c, Some(500)), None);
}

#[test]
fn a_merchant_without_released_ratings_scores_neutral() {
    let c = setup();
    let s = c.merchant_score(acc("m01.bazaar.testnet"));
    assert_eq!((s.ratings, s.score_x100), (0, 300));
}

// ---------- conserved delegation along hire edges ----------

#[test]
fn a_spawned_sub_agent_ring_gains_at_most_one_seed_and_outsiders_nothing() {
    let mut c = setup();
    // m01 has 6 released ratings: seed 6 units.
    c.review_totals.insert(acc("m01.bazaar.testnet"), (6, 24, 6));
    let hire = |c: &mut Bazaar, who: &str, sub: &str| {
        set(who);
        c.hire(acc(sub));
    };
    hire(&mut c, "m01.bazaar.testnet", "sub1.testnet");
    // The sub-agent spawns a ring of 8 accounts that all hire each other and back.
    for i in 1..=8 {
        for j in 1..=8 {
            if i != j && (j == i % 8 + 1 || j == (i + 2) % 8 + 1) {
                hire(&mut c, &format!("sub{i}.testnet"), &format!("sub{j}.testnet"));
            }
        }
    }
    hire(&mut c, "sub8.testnet", "m01.bazaar.testnet");
    // An unseeded ring next to it.
    hire(&mut c, "x1.testnet", "x2.testnet");
    hire(&mut c, "x2.testnet", "x1.testnet");
    let (seed, got) = c.standing_from(acc("m01.bazaar.testnet"));
    let total: u128 = got.iter().map(|(_, v)| v.0).sum();
    assert_eq!(seed.0, 6 * SEED_PER_RATING);
    assert!(total <= seed.0, "w/(1-w) = 1 seed for w = 1/2: {total} > {}", seed.0);
    assert!(got.iter().all(|(a, _)| !a.as_str().starts_with('x')), "no standing for accounts no seed reaches");
}

#[test]
fn a_merchant_without_released_ratings_confers_nothing() {
    let mut c = setup();
    set("m01.bazaar.testnet");
    c.hire(acc("sub1.testnet"));
    let (seed, got) = c.standing_from(acc("m01.bazaar.testnet"));
    assert_eq!((seed.0, got.len()), (0, 0));
}

#[test]
#[should_panic(expected = "hire limit reached")]
fn hiring_is_capped_per_agent() {
    let mut c = setup();
    set("m01.bazaar.testnet");
    for i in 0..=MAX_HIRES {
        c.hire(acc(&format!("s{i}.testnet")));
    }
}

#[test]
fn a_purchase_joins_the_review_group_only_after_the_payout_succeeded() {
    // Audit A2: spent is set before the USDC transfer; a failed transfer rolls it back.
    let mut c = setup();
    let n = hex::encode([1u8; 32]);
    submit_with_receipt(&mut c, envelope(1, "agent.testnet"));
    let _ = c.settle(n.clone(), acc("m01.bazaar.testnet"), "order-1".into(), U128(151_200_000));
    set("agent.testnet");
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.join_review_group(n.clone(), "1".into())));
    assert!(early.is_err(), "joined before the payout was confirmed");
    testing_env!(
        ctx("bazaar.testnet").build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(vec![])],
    );
    assert!(c.on_settle_transfer(n.clone(), acc("agent.testnet"), U128(151_200_000)));
    assert!(c.verdict(n.clone()).unwrap().paid);
    set("agent.testnet");
    c.join_review_group(n, "1".into());
}

#[test]
fn a_second_storage_deposit_is_refunded_in_full() {
    // Audit A8: the escrow entry exists after setup(); a repeat deposit must not be kept.
    let mut c = setup();
    let mut b = ctx("agent.testnet");
    b.attached_deposit(ESCROW_STORAGE_DEPOSIT);
    testing_env!(b.build());
    c.storage_deposit(None);
    let refunded: u128 = near_sdk::test_utils::get_created_receipts()
        .iter()
        .flat_map(|r| r.actions.iter())
        .filter_map(|a| match a {
            near_sdk::mock::MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()),
            _ => None,
        })
        .sum();
    assert_eq!(refunded, ESCROW_STORAGE_DEPOSIT.as_yoctonear());
}
