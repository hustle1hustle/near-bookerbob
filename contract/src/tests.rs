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
        disclosure: None,
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
        salt: None,
        v: 0,
        verdict_digest: hex::encode(e.digest()),
        nullifier: e.nullifier.clone(),
        merchant: "m01.bazaar.testnet".into(),
        schedule: schedule(),
        revealed: e.predicates.clone(),
        claims,
        proofs: proofs(),
        cohort_k: 0,
        sealed_verdict: None,
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
    // The liability record: what the payment relied on, hashed, queryable per nullifier.
    let rec = c.verdict(n.clone()).unwrap();
    let rh = rec.receipt.as_ref().unwrap().receipt_hash.clone();
    let want = hex::encode(bookerbob_core::sha256(&serde_json::to_vec(&(&rec.digest, &rh, "m01.bazaar.testnet", "151200000", "usdc", "0")).unwrap()));
    assert_eq!(c.liability(n.clone()), Some(want.clone()));
    assert!(logs.iter().any(|l| l.contains(&want)));
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
    assert!(!c.on_settle_transfer(n.clone(), acc("agent.testnet"), U128(151_200_000), None));
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
        salt: None,
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
fn an_overturned_receipt_after_settle_refunds_the_buyer_from_the_merchant_bond() {
    let mut c = setup();
    set("owner.testnet");
    c.register_arbiter(hex::encode(arbiter_key().verifying_key().to_bytes()), "fixture arbiter".into());
    // m01 bonds 500 USDC (ft_transfer_call with msg "bond").
    set(USDC);
    assert!(matches!(c.ft_on_transfer(acc("m01.bazaar.testnet"), U128(500_000_000), "bond".into()), PromiseOrValue::Value(U128(0))));
    assert_eq!(c.merchant_bond(acc("m01.bazaar.testnet"), "usdc".into()), U128(500_000_000));
    let e = envelope(1, "agent.testnet");
    let v = sign_ed(e.clone());
    set("agent.testnet");
    c.submit_verdict(v.clone());
    let (cheat, forged) = forged_receipt(&e);
    assert!(c.submit_referee_result(forged.clone()));
    let price = c.verdict(e.nullifier.clone()).unwrap().receipt.unwrap().price.0;
    set("agent.testnet");
    let _ = c.settle(e.nullifier.clone(), acc("m01.bazaar.testnet"), "o-1".into(), U128(price));
    assert_eq!(c.escrow_of(acc("agent.testnet")), Some(U128(200_000_000 - price)));
    payout_lands(&mut c, &e.nullifier, price);
    assert!(c.submit_dispute_decision(decide(&v, &forged, cheat)));
    assert!(c.verdict(e.nullifier.clone()).unwrap().disputed);
    assert_eq!(c.escrow_of(acc("agent.testnet")), Some(U128(200_000_000)), "the price is back in the buyer's escrow");
    assert_eq!(c.merchant_bond(acc("m01.bazaar.testnet"), "usdc".into()), U128(500_000_000 - price));
    assert!(get_logs().iter().any(|l| l.contains("dispute_overturned_after_settle") && l.contains(&format!("\"refund\":\"{price}\""))));
}

/// A settled purchase with a bond behind it and one signed overturning decision, at `bps` off.
fn disputed_purchase(bps: u16) -> (Bazaar, SignedVerdict, (Vec<Claim>, WorkerResult), u128) {
    let mut c = setup();
    set("owner.testnet");
    c.register_arbiter(hex::encode(arbiter_key().verifying_key().to_bytes()), "fixture arbiter".into());
    set(USDC);
    let _ = c.ft_on_transfer(acc("m01.bazaar.testnet"), U128(500_000_000), "bond".into());
    let e = envelope(1, "agent.testnet");
    let v = sign_ed(e.clone());
    set("agent.testnet");
    c.submit_verdict(v.clone());
    let (cheat, forged) = forged_receipt(&e);
    assert!(c.submit_referee_result(forged.clone()));
    let m = acc("m01.bazaar.testnet");
    near_sdk::env::storage_write(format!("rc|{}", e.nullifier).as_bytes(), &[&bps.to_le_bytes()[..], m.as_bytes()].concat());
    let receipt = c.verdict(e.nullifier.clone()).unwrap().receipt.unwrap().price.0;
    let paid = receipt - receipt * bps as u128 / 10_000;
    set("agent.testnet");
    let _ = c.settle(e.nullifier.clone(), m, "o-1".into(), U128(paid));
    payout_lands(&mut c, &e.nullifier, paid);
    (c, v, (cheat, forged), paid)
}

fn payout_lands(c: &mut Bazaar, n: &str, amount: u128) {
    testing_env!(
        ctx("bazaar.testnet").build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(vec![])]
    );
    assert!(c.on_settle_transfer(n.to_string(), acc("agent.testnet"), U128(amount), None));
}

#[test]
#[should_panic(expected = "payment not confirmed yet")]
fn no_dispute_refund_before_the_payout_lands() {
    let mut c = setup();
    set("owner.testnet");
    c.register_arbiter(hex::encode(arbiter_key().verifying_key().to_bytes()), "fixture arbiter".into());
    let e = envelope(1, "agent.testnet");
    let v = sign_ed(e.clone());
    set("agent.testnet");
    c.submit_verdict(v.clone());
    let (cheat, forged) = forged_receipt(&e);
    assert!(c.submit_referee_result(forged.clone()));
    let price = c.verdict(e.nullifier.clone()).unwrap().receipt.unwrap().price.0;
    set("agent.testnet");
    let _ = c.settle(e.nullifier.clone(), acc("m01.bazaar.testnet"), "o-1".into(), U128(price));
    c.submit_dispute_decision(decide(&v, &forged, cheat));
}

#[test]
#[should_panic(expected = "already refunded for this dispute")]
fn a_signed_decision_refunds_once() {
    let (mut c, v, (cheat, forged), _) = disputed_purchase(0);
    assert!(c.submit_dispute_decision(decide(&v, &forged, cheat.clone())));
    c.submit_dispute_decision(decide(&v, &forged, cheat));
}

/// The public replay: an overturned receipt sent again, settled, the old decision sent again.
#[test]
#[should_panic(expected = "this referee result was overturned")]
fn an_overturned_result_cannot_be_brought_back() {
    let mut c = setup();
    set("owner.testnet");
    c.register_arbiter(hex::encode(arbiter_key().verifying_key().to_bytes()), "fixture arbiter".into());
    let e = envelope(1, "agent.testnet");
    let v = sign_ed(e.clone());
    set("agent.testnet");
    c.submit_verdict(v.clone());
    let (cheat, forged) = forged_receipt(&e);
    assert!(c.submit_referee_result(forged.clone()));
    assert!(c.submit_dispute_decision(decide(&v, &forged, cheat)));
    c.submit_referee_result(forged);
}

#[test]
fn an_honest_result_still_lands_after_an_overturned_one() {
    let mut c = setup();
    set("owner.testnet");
    c.register_arbiter(hex::encode(arbiter_key().verifying_key().to_bytes()), "fixture arbiter".into());
    let e = envelope(1, "agent.testnet");
    let v = sign_ed(e.clone());
    set("agent.testnet");
    c.submit_verdict(v.clone());
    let (cheat, forged) = forged_receipt(&e);
    assert!(c.submit_referee_result(forged.clone()));
    let reserve_with_receipt = c.verdicts.get(&e.nullifier).unwrap().storage_reserve;
    assert!(c.submit_dispute_decision(decide(&v, &forged, cheat)));
    assert!(c.verdicts.get(&e.nullifier).unwrap().storage_reserve > reserve_with_receipt, "the receipt's bytes are back");
    assert!(c.submit_referee_result(referee_result(&e, honest_claims(), &referee_key())));
}

#[test]
fn a_failed_payout_clears_what_was_paid() {
    let mut c = setup();
    let e = envelope(1, "agent.testnet");
    submit_with_receipt(&mut c, e.clone());
    let m = acc("m01.bazaar.testnet");
    near_sdk::env::storage_write(format!("rc|{}", e.nullifier).as_bytes(), &[&500u16.to_le_bytes()[..], m.as_bytes()].concat());
    let _ = c.settle(e.nullifier.clone(), m, "o-1".into(), U128(143_640_000));
    let n = e.nullifier;
    assert!(near_sdk::env::storage_has_key(format!("pp|{n}").as_bytes()));
    testing_env!(
        ctx("bazaar.testnet").build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    assert!(!c.on_settle_transfer(n.clone(), acc("agent.testnet"), U128(143_640_000), None));
    assert!(!near_sdk::env::storage_has_key(format!("pp|{n}").as_bytes()));
}

#[test]
fn a_dispute_refunds_what_was_paid_not_the_receipt() {
    let (mut c, v, (cheat, forged), paid) = disputed_purchase(2000);
    assert!(c.submit_dispute_decision(decide(&v, &forged, cheat)));
    assert_eq!(c.escrow_of(acc("agent.testnet")), Some(U128(200_000_000)), "whole, and not ahead");
    assert_eq!(c.merchant_bond(acc("m01.bazaar.testnet"), "usdc".into()), U128(500_000_000 - paid));
}

#[test]
fn a_bond_from_an_unapproved_account_is_returned() {
    let mut c = setup();
    set(USDC);
    assert!(matches!(c.ft_on_transfer(acc("stranger.testnet"), U128(7), "bond".into()), PromiseOrValue::Value(U128(7))));
    assert_eq!(c.merchant_bond(acc("stranger.testnet"), "usdc".into()), U128(0));
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
    assert!(!c.on_withdraw(acc("agent.testnet"), U128(50_000_000), None));
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
        c.set_evaluator_key(hex::encode(evaluator().verifying_key().to_bytes()));
        attest(&mut c, &e.cnf, 9);
        set(&e.cnf);
        let mut p = p;
        p.evaluator_sig = countersign(&e, &p.request_sha256);
        (c, e, p)
    }

    fn evaluator() -> SigningKey {
        SigningKey::from_bytes(&[8u8; 32])
    }

    fn countersign(e: &Envelope, request_sha256: &str) -> String {
        hex::encode(evaluator().sign(&bookerbob_core::near_ai::evaluator_message("bazaar.testnet", e, request_sha256)).to_bytes())
    }

    /// `make forge-poc`: a real TEE signature on an answer about a typed fact. The binding alone
    /// passes, so the evaluator's signature is what stands between that answer and a record.
    #[test]
    #[should_panic(expected = "evaluator signature")]
    fn a_signed_answer_about_a_prompt_the_evaluator_did_not_build_is_refused() {
        let (mut c, e, mut p) = chain();
        p.evaluator_sig = String::new();
        assert!(bookerbob_core::near_ai::check_binding(&e, &p).is_ok());
        c.submit_near_ai_verdict(e, p);
    }

    #[test]
    #[should_panic(expected = "bad evaluator signature")]
    fn an_evaluator_signature_does_not_move_to_another_request() {
        let (mut c, e, mut p) = chain();
        p.evaluator_sig = countersign(&e, &"ab".repeat(32));
        c.submit_near_ai_verdict(e, p);
    }

    #[test]
    #[should_panic(expected = "bad evaluator signature")]
    fn an_evaluator_signature_does_not_move_to_another_envelope() {
        let (mut c, e, mut p) = chain();
        let mut other = e.clone();
        other.max_spend += 1;
        p.evaluator_sig = countersign(&other, &p.request_sha256);
        c.submit_near_ai_verdict(e, p);
    }

    #[test]
    #[should_panic(expected = "bad evaluator signature")]
    fn an_evaluator_signature_does_not_move_to_another_bazaar() {
        let (mut c, e, mut p) = chain();
        let msg = bookerbob_core::near_ai::evaluator_message("market.testnet", &e, &p.request_sha256);
        p.evaluator_sig = hex::encode(evaluator().sign(&msg).to_bytes());
        c.submit_near_ai_verdict(e, p);
    }

    #[test]
    #[should_panic(expected = "no evaluator key anchored")]
    fn with_no_evaluator_key_the_model_path_is_closed() {
        let (e, p) = captured();
        set("owner.testnet");
        let mut c = Bazaar::new(acc("owner.testnet"), acc(USDC));
        let att = ModelAttestation {
            model: e.attestation.model.clone(),
            nonce: p.nonce.clone(),
            report_hash: bookerbob_core::sha256_hex(REPORT),
            tcb_status: e.attestation.tcb_status.clone(),
        };
        c.register_model_attestation(p.signing_key.clone(), att);
        set(&e.cnf);
        c.submit_near_ai_verdict(e, p);
    }

    #[test]
    fn the_evaluator_key_is_an_anchor() {
        let (mut c, _, _) = chain();
        set("owner.testnet");
        c.set_anchor_delay(60_000);
        c.set_evaluator_key("cd".repeat(32));
        assert_ne!(c.evaluator_key(), Some("cd".repeat(32)));
        testing_env!(ctx("anyone.testnet").block_timestamp((NOW_MS + 60_001) * 1_000_000).build());
        c.execute_anchor(1);
        assert_eq!(c.evaluator_key(), Some("cd".repeat(32)));
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
    const RETURNING: &str = include_str!("../../fixtures/semaphore/returning.json");
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
        // Each buyer is World-bound to a person of its own (review k counts persons).
        if !c.humans.contains_key(&acc(agent)) {
            c.humans.insert(acc(agent), format!("person-{agent}"));
        }
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

    /// Buy Twice: an unspent verdict of a fresh account, with a receipt at 40.00 from `merchant`.
    fn returning_buyer(c: &mut Bazaar, i: usize, merchant: &str) -> (String, String) {
        let agent = format!("fresh{i}.testnet");
        let n = hex::encode([220 + i as u8; 32]);
        let tmp = settled(c, 40 + i, &agent, merchant);
        let mut r = c.verdicts.get(&tmp).unwrap().clone();
        r.spent = false;
        r.paid = false;
        r.checkout_ref = None;
        c.verdicts.insert(n.clone(), r);
        (agent, n)
    }

    fn claim(c: &mut Bazaar, agent: &str, n: &str, entry: &serde_json::Value) {
        at(agent, T);
        near_sdk::env::storage_write(b"rb|m01.bookerbob.testnet", &500u16.to_le_bytes());
        c.claim_returning(acc("m01.bookerbob.testnet"), n.to_string(), proof(entry));
    }

    /// The transfer of a settled purchase confirms.
    fn confirm(c: &mut Bazaar, agent: &str, n: &str) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(acc("bazaar.testnet"))
                .predecessor_account_id(acc("bazaar.testnet"))
                .block_timestamp(T * 1_000_000)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Successful(vec![])],
        );
        assert!(c.on_settle_transfer(n.to_string(), acc(agent), U128(1), Some(true)));
    }

    #[test]
    fn the_rate_counts_paid_repeat_purchases_and_stays_dark_below_k() {
        let (mut c, _) = six();
        let f = j(RETURNING);
        let m = acc("m01.bookerbob.testnet");
        let epoch = T / RETURNING_EPOCH_MS;
        assert_eq!(f["epoch"].as_u64(), Some(epoch));
        for i in 0..5 {
            let (agent, n) = returning_buyer(&mut c, i, m.as_str());
            claim(&mut c, &agent, &n, &f["claims"][i]["proof"]);
            assert!(c.returning_rate(m.clone(), epoch).is_none(), "a claim alone counts for nothing");
            confirm(&mut c, &agent, &n);
            assert_eq!(c.returning_rate(m.clone(), epoch).is_some(), i == 4, "dark below k");
        }
        assert_eq!(c.returning_rate(m, epoch), Some((5, 6)));
    }

    #[test]
    fn a_purchase_with_no_claim_does_not_count_as_a_repeat() {
        let (mut c, _) = six();
        let m = acc("m01.bookerbob.testnet");
        let (agent, n) = returning_buyer(&mut c, 0, m.as_str());
        confirm(&mut c, &agent, &n);
        assert_eq!(near_sdk::env::storage_read(format!("rn|{m}|{}", T / RETURNING_EPOCH_MS).as_bytes()), None);
    }

    #[test]
    #[should_panic(expected = "this verdict already claimed")]
    fn a_verdict_claims_once_whoever_holds_the_second_membership() {
        let (mut c, _) = six();
        let f = j(RETURNING);
        let (a, n) = returning_buyer(&mut c, 0, "m01.bookerbob.testnet");
        claim(&mut c, &a, &n, &f["claims"][0]["proof"]);
        claim(&mut c, &a, &n, &f["claims"][1]["proof"]);
    }

    #[test]
    #[should_panic(expected = "group under k")]
    fn a_claim_is_refused_below_k_people() {
        let g = j(GROUP);
        let few: Vec<_> = g["members"].as_array().unwrap()[..4].to_vec();
        let mut c = group(&few, "m01.bookerbob.testnet");
        let f = j(RETURNING);
        let (a, n) = returning_buyer(&mut c, 0, "m01.bookerbob.testnet");
        claim(&mut c, &a, &n, &f["claims"][0]["proof"]);
    }

    #[test]
    #[should_panic(expected = "merchant offers no returning discount")]
    fn a_claim_says_nothing_for_nothing() {
        let (mut c, _) = six();
        let f = j(RETURNING);
        let (a, n) = returning_buyer(&mut c, 0, "m01.bookerbob.testnet");
        at(&a, T);
        c.claim_returning(acc("m01.bookerbob.testnet"), n, proof(&f["claims"][0]["proof"]));
    }

    #[test]
    fn a_claim_keeps_its_discount_when_the_merchant_moves_it() {
        let (mut c, _) = six();
        let f = j(RETURNING);
        let m = acc("m01.bookerbob.testnet");
        let (a, n) = returning_buyer(&mut c, 0, m.as_str());
        claim(&mut c, &a, &n, &f["claims"][0]["proof"]);
        near_sdk::env::storage_write(b"rb|m01.bookerbob.testnet", &0u16.to_le_bytes());
        assert_eq!(returning_bps_for(&n, &m), 500);
        assert_eq!(returning_bps_for(&n, &acc("m02.bookerbob.testnet")), 0);
    }

    #[test]
    #[should_panic(expected = "already claimed this epoch")]
    fn one_member_claims_once_per_epoch() {
        let (mut c, _) = six();
        let f = j(RETURNING);
        let (a, n) = returning_buyer(&mut c, 0, "m01.bookerbob.testnet");
        claim(&mut c, &a, &n, &f["claims"][0]["proof"]);
        let (a, n) = returning_buyer(&mut c, 6, "m01.bookerbob.testnet");
        claim(&mut c, &a, &n, &f["again"]["proof"]);
    }

    #[test]
    #[should_panic(expected = "invalid Semaphore proof")]
    fn a_claim_proof_does_not_move_to_another_verdict() {
        let (mut c, _) = six();
        let f = j(RETURNING);
        let (a, n) = returning_buyer(&mut c, 1, "m01.bookerbob.testnet");
        claim(&mut c, &a, &n, &f["claims"][0]["proof"]);
    }

    #[test]
    #[should_panic(expected = "agent mismatch")]
    fn only_the_verdicts_agent_can_claim() {
        let (mut c, _) = six();
        let f = j(RETURNING);
        let (_, n) = returning_buyer(&mut c, 0, "m01.bookerbob.testnet");
        claim(&mut c, "stranger.testnet", &n, &f["claims"][0]["proof"]);
    }

    #[test]
    #[should_panic(expected = "merchant has no review group")]
    fn a_claim_needs_a_group_at_that_merchant() {
        let (mut c, _) = six();
        let f = j(RETURNING);
        let (a, n) = returning_buyer(&mut c, 0, "m01.bookerbob.testnet");
        at(&a, T);
        near_sdk::env::storage_write(b"rb|m02.bookerbob.testnet", &500u16.to_le_bytes());
        c.claim_returning(acc("m02.bookerbob.testnet"), n, proof(&f["claims"][0]["proof"]));
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
        assert!(
            get_logs().iter().any(|l| l.contains("reviews_published") && l.contains(r#""ratings":6"#) && l.contains(r#""k_d":5"#)),
            "the release logs its size"
        );
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
    fn a_round_under_k_d_distinct_raters_stays_sealed_in_a_group_over_k() {
        // Six members, two ratings: the group passes k, the round does not. A merchant that
        // knows its two sales this round could tell whose rating is whose; nothing opens.
        let (mut c, r) = six();
        let ps = r["proofs"].as_array().unwrap();
        for (i, e) in ps.iter().take(2).enumerate() {
            rate(&mut c, "m01.bookerbob.testnet", e, &format!("relayer{i}.testnet"));
        }
        let round = r["round"].as_u64().unwrap();
        assert!(c.review_persons(acc("m01.bookerbob.testnet")) >= bookerbob_core::K_MIN as u64);
        let rv = &ps[0]["review"];
        at("relayer0.testnet", T + REVIEW_ROUND_MS);
        let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.reveal_review(
                acc("m01.bookerbob.testnet"),
                round,
                rv["rating"].as_u64().unwrap() as u8,
                rv["delivered"].as_bool().unwrap(),
                rv["reason_hash"].as_str().unwrap().into(),
                rv["salt"].as_str().unwrap().into(),
            )
        }));
        assert!(refused.is_err(), "a reveal in a two-rater round is refused");
        at("anyone.testnet", T + 2 * REVIEW_ROUND_MS);
        assert!(!c.publish_reviews(acc("m01.bookerbob.testnet"), round));
        assert!(c.reviews(acc("m01.bookerbob.testnet"), round).is_none());
        assert_eq!(c.merchant_score(acc("m01.bookerbob.testnet")).ratings, 0);
    }

    #[test]
    fn a_release_needs_k_d_revealed_ratings_and_logs_its_size() {
        // Five sealed, three revealed: a release of three is held, and the event says so.
        let (mut c, r) = six();
        let ps = r["proofs"].as_array().unwrap();
        for (i, e) in ps.iter().take(5).enumerate() {
            rate(&mut c, "m01.bookerbob.testnet", e, &format!("relayer{i}.testnet"));
        }
        let round = r["round"].as_u64().unwrap();
        for (i, e) in ps.iter().take(3).enumerate() {
            reveal(&mut c, "m01.bookerbob.testnet", round, &e["review"], &format!("relayer{i}.testnet"));
        }
        at("anyone.testnet", T + 2 * REVIEW_ROUND_MS);
        assert!(!c.publish_reviews(acc("m01.bookerbob.testnet"), round));
        let held = get_logs().into_iter().find(|l| l.contains("reviews_held")).expect("a reviews_held event");
        assert!(held.contains(r#""ratings":3"#) && held.contains(r#""sealed":5"#) && held.contains(r#""k_d":5"#), "{held}");
        assert!(c.reviews(acc("m01.bookerbob.testnet"), round).is_none());
        assert_eq!(c.merchant_score(acc("m01.bookerbob.testnet")).ratings, 0);
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
    assert!(c.on_settle_transfer(n.clone(), acc("agent.testnet"), U128(151_200_000), None));
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

// ---------- proven graph scores (Jolt guest, signed by a worker that verified the proof) ----------

mod graph_scores {
    use super::*;

    const PROGRAM: &str = "ab00000000000000000000000000000000000000000000000000000000000001";

    /// m01 hires a ring; the off-chain computation over the same events.
    fn chain() -> (Bazaar, bookerbob_graph::Scores) {
        let mut c = setup();
        set("owner.testnet");
        c.set_graph_program(PROGRAM.into());
        let mut events = vec![];
        for (a, b) in [("m01.bazaar.testnet", "s1.testnet"), ("s1.testnet", "s2.testnet"), ("s2.testnet", "s1.testnet")] {
            set(a);
            c.hire(acc(b));
            events.push(bookerbob_graph::Event::Hire { agent: a.into(), sub: b.into() });
        }
        let s = bookerbob_graph::compute(&events);
        assert_eq!(hex::encode(s.root), c.graph_root().0, "the contract's root is the guest's root");
        let mut b = ctx("bonder.testnet");
        b.attached_deposit(WORKER_BOND);
        testing_env!(b.build());
        c.bond_worker(worker());
        (c, s)
    }

    fn worker() -> String {
        hex::encode(referee_key().verifying_key().to_bytes())
    }

    const PROOF: &str = "9f00000000000000000000000000000000000000000000000000000000000009";

    fn at_ms(who: &str, ms: u64, deposit: NearToken) {
        let mut b = ctx(who);
        b.block_timestamp(ms * 1_000_000).attached_deposit(deposit);
        testing_env!(b.build());
    }

    fn arbiter_key() -> SigningKey {
        SigningKey::from_bytes(&[23u8; 32])
    }

    fn resolution(c: &Bazaar, valid: bool) -> (String, String) {
        let p = c.pending_graph_update().unwrap();
        let mut msg = GRAPH_CHALLENGE_TAG.to_vec();
        msg.extend(serde_json::to_vec(&(&p.root, &p.scores_hash, &p.proof_sha256, valid)).unwrap());
        (hex::encode(arbiter_key().verifying_key().to_bytes()), hex::encode(arbiter_key().sign(&bookerbob_core::sha256(&msg)).to_bytes()))
    }

    fn sign(program: &str, s: &bookerbob_graph::Scores) -> String {
        let mut msg = GRAPH_UPDATE_TAG.to_vec();
        msg.extend(hex::decode(program).unwrap());
        msg.extend(s.root);
        msg.extend(s.hash());
        let digest = bookerbob_core::sha256(&msg);
        hex::encode(referee_key().sign(&digest).to_bytes())
    }

    fn submit(c: &mut Bazaar, program: &str, s: &bookerbob_graph::Scores, sig: String) {
        set("relayer.testnet");
        let merchants = s.merchants.iter().map(|(m, n, x)| (acc(m), *n, *x)).collect();
        let standing = s.standing.iter().map(|(a, v)| (acc(a), U128(*v))).collect();
        c.submit_graph_scores(program.into(), hex::encode(s.root), merchants, standing, worker(), sig, PROOF.into());
    }

    fn with_seed(mut s: bookerbob_graph::Scores) -> bookerbob_graph::Scores {
        // A merchant score in the update (seeds come from review releases; none here).
        s.merchants.push(("m01.bazaar.testnet".into(), 6, 345));
        s
    }

    #[test]
    fn a_signed_update_waits_out_the_window_then_applies() {
        let (mut c, s) = chain();
        let s = with_seed(s);
        let sig = sign(PROGRAM, &s);
        submit(&mut c, PROGRAM, &s, sig);
        assert_eq!(c.standing_root(), None, "pending, not applied");
        assert_eq!(c.pending_graph_update().unwrap().proof_sha256, PROOF);
        at_ms("anyone.testnet", NOW_MS + REVIEW_ROUND_MS, NearToken::from_yoctonear(0));
        c.finalize_graph_scores();
        let (root, n, scores_hash, graph_root) = c.standing_root().unwrap();
        assert_eq!((n, scores_hash, graph_root.clone()), (1, hex::encode(s.hash()), hex::encode(s.root)), "a root over the proven list, no scores");
        let (tree, proofs) = bookerbob_core::standing::graph(&s.root, &s.merchants);
        assert_eq!(root, hex::encode(tree));
        assert!(c.in_top(proofs[0].clone(), 100));
        assert!(c.pending_graph_update().is_none());
    }

    #[test]
    #[should_panic(expected = "the score list differs from the proven scores hash")]
    fn a_list_swapped_after_proving_cannot_reach_the_root() {
        let (mut c, s) = chain();
        let s = with_seed(s);
        let sig = sign(PROGRAM, &s);
        submit(&mut c, PROGRAM, &s, sig);
        // Tamper with the stored list after the signed, proven hash was recorded.
        let mut p = crate::pending_graph().unwrap();
        p.merchants[0].2 = 999;
        crate::set_pending_graph(Some(&p));
        at_ms("anyone.testnet", NOW_MS + REVIEW_ROUND_MS, NearToken::from_yoctonear(0));
        c.finalize_graph_scores();
    }

    #[test]
    #[should_panic(expected = "challenge window still open")]
    fn finalize_inside_the_window_is_refused() {
        let (mut c, s) = chain();
        let s = with_seed(s);
        let sig = sign(PROGRAM, &s);
        submit(&mut c, PROGRAM, &s, sig);
        c.finalize_graph_scores();
    }

    #[test]
    #[should_panic(expected = "worker key has no bond")]
    fn an_unbonded_worker_cannot_post() {
        let (mut c, s) = chain();
        at_ms("bonder.testnet", NOW_MS, NearToken::from_yoctonear(0));
        let _ = c.unbond_worker(worker());
        let sig = sign(PROGRAM, &s);
        submit(&mut c, PROGRAM, &s, sig);
    }

    fn challenged() -> Bazaar {
        let (mut c, s) = chain();
        set_no_deposit("owner.testnet");
        c.register_arbiter(hex::encode(arbiter_key().verifying_key().to_bytes()), "graph arbiter".into());
        let s = with_seed(s);
        let sig = sign(PROGRAM, &s);
        submit(&mut c, PROGRAM, &s, sig);
        at_ms("challenger.testnet", NOW_MS + 1000, CHALLENGE_BOND);
        c.challenge_graph_scores();
        c
    }

    #[test]
    #[should_panic(expected = "challenged: waits for the arbiter")]
    fn a_challenged_update_cannot_be_finalized() {
        let mut c = challenged();
        at_ms("anyone.testnet", NOW_MS + REVIEW_ROUND_MS, NearToken::from_yoctonear(0));
        c.finalize_graph_scores();
    }

    #[test]
    fn a_false_update_is_dropped_and_the_worker_bond_goes_to_the_challenger() {
        let mut c = challenged();
        let (k, sig) = resolution(&c, false);
        set_no_deposit("anyone.testnet");
        assert!(!c.resolve_graph_challenge(PROOF.into(), false, k, sig, None));
        assert_eq!(c.standing_root(), None);
        assert!(c.worker_bond(worker()).is_none(), "slashed");
        let r = near_sdk::test_utils::get_created_receipts();
        assert!(r.iter().any(|x| x.receiver_id.as_str() == "challenger.testnet"));
        assert!(get_logs().iter().any(|l| l.contains("graph_update_rejected")));
    }

    #[test]
    fn a_valid_update_applies_and_the_challenger_bond_goes_to_the_bonder() {
        let mut c = challenged();
        let (k, sig) = resolution(&c, true);
        set_no_deposit("anyone.testnet");
        assert!(c.resolve_graph_challenge(PROOF.into(), true, k, sig, None));
        assert_eq!(c.standing_root().map(|x| x.1), Some(1));
        assert!(near_sdk::test_utils::get_created_receipts().iter().any(|x| x.receiver_id.as_str() == "bonder.testnet"));
    }

    #[test]
    #[should_panic(expected = "bad arbiter signature")]
    fn a_resolution_with_the_other_verdict_is_refused() {
        let mut c = challenged();
        let (k, sig) = resolution(&c, true);
        set_no_deposit("anyone.testnet");
        c.resolve_graph_challenge(PROOF.into(), false, k, sig, None);
    }

    #[test]
    #[should_panic(expected = "challenge window is over")]
    fn a_late_challenge_is_refused() {
        let (mut c, s) = chain();
        let s = with_seed(s);
        let sig = sign(PROGRAM, &s);
        submit(&mut c, PROGRAM, &s, sig);
        at_ms("challenger.testnet", NOW_MS + REVIEW_ROUND_MS, CHALLENGE_BOND);
        c.challenge_graph_scores();
    }

    #[test]
    #[should_panic(expected = "a graph update is already pending")]
    fn one_pending_update_at_a_time() {
        let (mut c, s) = chain();
        let s = with_seed(s);
        let sig = sign(PROGRAM, &s);
        submit(&mut c, PROGRAM, &s, sig.clone());
        submit(&mut c, PROGRAM, &s, sig);
    }

    #[test]
    #[should_panic(expected = "bad worker signature")]
    fn a_tampered_score_is_refused() {
        let (mut c, s) = chain();
        let s = with_seed(s);
        let sig = sign(PROGRAM, &s);
        let mut t = s.clone();
        t.merchants[0].2 = 500;
        submit(&mut c, PROGRAM, &t, sig);
    }

    #[test]
    #[should_panic(expected = "stale graph root")]
    fn an_update_for_a_stale_root_is_refused() {
        let (mut c, s) = chain();
        let s = with_seed(s);
        let sig = sign(PROGRAM, &s);
        set("s2.testnet");
        c.hire(acc("s3.testnet"));
        submit(&mut c, PROGRAM, &s, sig);
    }

    #[test]
    #[should_panic(expected = "not the registered graph program")]
    fn an_update_from_another_program_is_refused() {
        let (mut c, s) = chain();
        let other = "cd00000000000000000000000000000000000000000000000000000000000002";
        let sig = sign(other, &s);
        submit(&mut c, other, &s, sig);
    }

    #[test]
    #[should_panic(expected = "unknown worker key")]
    fn an_update_signed_by_an_unregistered_worker_is_refused() {
        let (mut c, s) = chain();
        set("relayer.testnet");
        c.submit_graph_scores(PROGRAM.into(), hex::encode(s.root), vec![], vec![], "11".repeat(32), "22".repeat(64), PROOF.into());
    }
}

#[test]
fn the_cohort_root_commits_to_the_counted_nullifiers_in_order() {
    // What the cohort guest proves k >= 5 against (bookerbob-zkcore::cohort).
    let mut c = setup();
    let mut nulls = vec![];
    for i in 1..=5u8 {
        let agent = format!("peer{i}.testnet");
        attest(&mut c, &agent, 100 + i);
        set(&agent);
        let e = envelope(i, &agent);
        nulls.push(e.nullifier.clone());
        c.submit_verdict(sign_ed(e));
    }
    let (root, k) = c.cohort_root("bookerbob:v0:test".into(), "world_id_human".into());
    let refs: Vec<&str> = nulls.iter().map(String::as_str).collect();
    assert_eq!(k, 5);
    assert_eq!(root, hex::encode(bookerbob_zkcore::cohort::root("bookerbob:v0:test", "world_id_human", &refs)));
    assert!(bookerbob_zkcore::cohort::check("bookerbob:v0:test", "world_id_human", &refs).is_ok());
}

/// Testnet demo mode: the free-mint demo token beside USDC, its own escrow, never on mainnet.
mod demo {
    use super::*;
    const DUSDC: &str = "dusdc.bazaar.testnet";

    fn demo_setup() -> Bazaar {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.set_demo_token(acc(DUSDC));
        // The agent's escrow entry exists (USDC); a second deposit opens the demo entry.
        let mut b = ctx("agent.testnet");
        b.attached_deposit(ESCROW_STORAGE_DEPOSIT);
        testing_env!(b.build());
        c.storage_deposit(None);
        set(DUSDC);
        assert_eq!(refund(c.ft_on_transfer(acc("agent.testnet"), U128(200_000_000), String::new())), 0);
        c
    }

    fn refund(r: PromiseOrValue<U128>) -> u128 {
        match r {
            PromiseOrValue::Value(v) => v.0,
            PromiseOrValue::Promise(_) => u128::MAX,
        }
    }

    #[test]
    #[should_panic(expected = "only USDC is accepted")]
    fn demo_token_is_refused_before_it_is_set() {
        let mut c = setup();
        set(DUSDC);
        let _ = c.ft_on_transfer(acc("agent.testnet"), U128(5), String::new());
    }

    #[test]
    #[should_panic(expected = "demo token is testnet only")]
    fn set_demo_token_is_refused_on_mainnet() {
        set("owner.near");
        let mut b = ctx("owner.near");
        b.current_account_id(acc("bazaar.near"));
        testing_env!(b.build());
        let mut c = Bazaar::new(acc("owner.near"), acc(USDC));
        c.set_demo_token(acc(DUSDC));
    }

    #[test]
    #[should_panic(expected = "only USDC is accepted")]
    fn a_stored_demo_token_is_still_refused_on_mainnet() {
        // A testnet bazaar's state under a mainnet account id (the second check): refused.
        let mut c = demo_setup();
        let mut b = ctx(DUSDC);
        b.current_account_id(acc("bazaar.near"));
        testing_env!(b.build());
        assert_eq!(c.demo_token(), None);
        let _ = c.ft_on_transfer(acc("agent.testnet"), U128(5), String::new());
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn only_owner_sets_the_demo_token() {
        let mut c = setup();
        set_no_deposit("agent.testnet");
        c.set_demo_token(acc(DUSDC));
    }

    #[test]
    #[should_panic(expected = "demo token must be a .testnet account other than USDC")]
    fn usdc_cannot_be_the_demo_token() {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.set_demo_token(acc(USDC));
    }

    #[test]
    fn demo_deposit_credits_demo_escrow_only() {
        let c = demo_setup();
        assert_eq!(c.demo_escrow_of(acc("agent.testnet")), Some(U128(200_000_000)));
        assert_eq!(c.escrow_of(acc("agent.testnet")), Some(U128(200_000_000)), "USDC escrow unchanged");
        assert!(get_logs().iter().any(|l| l.contains("escrow_deposit") && l.contains("\"token\":\"demo\"")));
    }

    #[test]
    fn demo_deposit_without_a_demo_entry_is_refunded() {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.set_demo_token(acc(DUSDC));
        set(DUSDC);
        assert_eq!(refund(c.ft_on_transfer(acc("agent.testnet"), U128(7), String::new())), 7);
    }

    #[test]
    fn a_claimed_returning_discount_comes_off_the_receipt_price() {
        let mut c = demo_setup();
        let n = hex::encode([1u8; 32]);
        submit_with_receipt(&mut c, envelope(1, "agent.testnet"));
        let m = acc("m01.bazaar.testnet");
        near_sdk::env::storage_write(format!("rc|{n}").as_bytes(), &[&500u16.to_le_bytes()[..], m.as_bytes()].concat());
        let _ = c.settle_demo(n.clone(), m, "demo-1".into(), U128(143_640_000));
        assert_eq!(c.nullifier_status(n), NullifierStatus::Spent);
        assert_eq!(c.demo_escrow_of(acc("agent.testnet")), Some(U128(56_360_000)));
    }

    #[test]
    fn settle_demo_pays_the_demo_token_never_usdc() {
        let mut c = demo_setup();
        let n = hex::encode([1u8; 32]);
        submit_with_receipt(&mut c, envelope(1, "agent.testnet"));
        let _ = c.settle_demo(n.clone(), acc("m01.bazaar.testnet"), "demo-1".into(), U128(151_200_000));
        assert_eq!(c.nullifier_status(n.clone()), NullifierStatus::Spent);
        assert_eq!(c.demo_escrow_of(acc("agent.testnet")), Some(U128(48_800_000)));
        assert_eq!(c.escrow_of(acc("agent.testnet")), Some(U128(200_000_000)));
        assert_eq!(c.paid_in(n), Some("demo".into()));
        let receipts = near_sdk::test_utils::get_created_receipts();
        assert!(receipts.iter().any(|r| r.receiver_id.as_str() == DUSDC));
        assert!(!receipts.iter().any(|r| r.receiver_id.as_str() == USDC));
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"settled\"") && l.contains("\"token\":\"demo\"")));
    }

    #[test]
    #[should_panic(expected = "nullifier spent")]
    fn a_record_paid_in_demo_cannot_pay_again_in_usdc() {
        let mut c = demo_setup();
        let n = hex::encode([1u8; 32]);
        submit_with_receipt(&mut c, envelope(1, "agent.testnet"));
        let _ = c.settle_demo(n.clone(), acc("m01.bazaar.testnet"), "demo-1".into(), U128(151_200_000));
        set("agent.testnet");
        let _ = c.settle(n, acc("m01.bazaar.testnet"), "demo-2".into(), U128(151_200_000));
    }

    #[test]
    #[should_panic(expected = "insufficient escrow")]
    fn usdc_escrow_never_pays_a_demo_settle() {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.set_demo_token(acc(DUSDC));
        let mut b = ctx("agent.testnet");
        b.attached_deposit(ESCROW_STORAGE_DEPOSIT);
        testing_env!(b.build());
        c.storage_deposit(None);
        // 200 USDC in escrow, 0 dUSDC.
        submit_with_receipt(&mut c, envelope(1, "agent.testnet"));
        let _ = c.settle_demo(hex::encode([1u8; 32]), acc("m01.bazaar.testnet"), "demo-1".into(), U128(151_200_000));
    }

    #[test]
    #[should_panic(expected = "insufficient escrow")]
    fn demo_escrow_never_pays_a_usdc_settle() {
        let mut c = demo_setup();
        // Drain the USDC side first, keep dUSDC.
        set("agent.testnet");
        let mut b = ctx("agent.testnet");
        b.attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(b.build());
        let _ = c.withdraw(U128(200_000_000));
        submit_with_receipt(&mut c, envelope(1, "agent.testnet"));
        let _ = c.settle(hex::encode([1u8; 32]), acc("m01.bazaar.testnet"), "x".into(), U128(151_200_000));
    }

    #[test]
    fn failed_demo_payout_credits_the_demo_escrow_back() {
        let mut c = demo_setup();
        let n = hex::encode([1u8; 32]);
        submit_with_receipt(&mut c, envelope(1, "agent.testnet"));
        let _ = c.settle_demo(n.clone(), acc("m01.bazaar.testnet"), "demo-1".into(), U128(151_200_000));
        testing_env!(
            ctx("bazaar.testnet").build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed],
        );
        assert!(!c.on_settle_transfer(n.clone(), acc("agent.testnet"), U128(151_200_000), Some(true)));
        assert_eq!(c.nullifier_status(n.clone()), NullifierStatus::Pending);
        assert_eq!(c.demo_escrow_of(acc("agent.testnet")), Some(U128(200_000_000)));
        assert_eq!(c.escrow_of(acc("agent.testnet")), Some(U128(200_000_000)));
        assert_eq!(c.paid_in(n), None);
    }

    #[test]
    fn demo_settle_confirmed_marks_paid_for_reviews() {
        let mut c = demo_setup();
        let n = hex::encode([1u8; 32]);
        submit_with_receipt(&mut c, envelope(1, "agent.testnet"));
        let _ = c.settle_demo(n.clone(), acc("m01.bazaar.testnet"), "demo-1".into(), U128(151_200_000));
        testing_env!(
            ctx("bazaar.testnet").build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Successful(vec![])],
        );
        assert!(c.on_settle_transfer(n.clone(), acc("agent.testnet"), U128(151_200_000), Some(true)));
        assert!(c.verdict(n).unwrap().paid);
    }

    #[test]
    fn withdraw_demo_pays_the_demo_token_and_reverts_on_failure() {
        let mut c = demo_setup();
        let mut b = ctx("agent.testnet");
        b.attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(b.build());
        let _ = c.withdraw_demo(U128(50_000_000));
        assert_eq!(c.demo_escrow_of(acc("agent.testnet")), Some(U128(150_000_000)));
        assert!(near_sdk::test_utils::get_created_receipts().iter().any(|r| r.receiver_id.as_str() == DUSDC));
        testing_env!(
            ctx("bazaar.testnet").build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed],
        );
        assert!(!c.on_withdraw(acc("agent.testnet"), U128(50_000_000), Some(true)));
        assert_eq!(c.demo_escrow_of(acc("agent.testnet")), Some(U128(200_000_000)));
        assert_eq!(c.escrow_of(acc("agent.testnet")), Some(U128(200_000_000)));
    }

    #[test]
    fn one_storage_deposit_opens_both_entries_and_a_repeat_is_refunded() {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.set_demo_token(acc(DUSDC));
        let mut b = ctx("new.testnet");
        b.attached_deposit(ESCROW_STORAGE_DEPOSIT);
        testing_env!(b.build());
        c.storage_deposit(None);
        assert_eq!((c.escrow_of(acc("new.testnet")), c.demo_escrow_of(acc("new.testnet"))), (Some(U128(0)), Some(U128(0))));
        let mut b = ctx("new.testnet");
        b.attached_deposit(ESCROW_STORAGE_DEPOSIT);
        testing_env!(b.build());
        c.storage_deposit(None);
        assert!(near_sdk::test_utils::get_created_receipts().iter().any(|r| r.receiver_id.as_str() == "new.testnet"), "repeat refunded");
    }

    #[test]
    fn review_rounds_shorten_on_testnet_only() {
        let mut c = setup();
        assert_eq!(c.review_round_ms(), REVIEW_ROUND_MS);
        set_no_deposit("owner.testnet");
        c.set_review_round_ms(600_000);
        assert_eq!(c.review_round_ms(), 600_000);
        assert_eq!(c.review_round_now(), NOW_MS / 600_000);
        let mut b = ctx("owner.testnet");
        b.current_account_id(acc("bazaar.near"));
        testing_env!(b.build());
        assert_eq!(c.review_round_ms(), REVIEW_ROUND_MS, "a stored value is ignored off testnet");
    }

    #[test]
    #[should_panic(expected = "round under one minute")]
    fn review_round_has_a_floor() {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.set_review_round_ms(59_999);
    }
}

/// The review k floor counts distinct World-bound persons, not purchases.
mod review_persons {
    use super::*;

    fn paid_record(c: &mut Bazaar, n: u8, agent: &str) -> String {
        let id = hex::encode([n; 32]);
        set(agent);
        let mut e = envelope(n, agent);
        e.nullifier = id.clone();
        if !c.is_human(acc(agent)) {
            e.predicates = vec!["airbnb_frequent".into()];
        }
        c.submit_verdict(sign_ed(e.clone()));
        let r = c.verdicts.get_mut(&id).unwrap();
        r.receipt = Some(RefereeReceipt {
            merchant: acc("m01.bazaar.testnet"),
            price: U128(1),
            receipt_hash: "00".repeat(32),
            referee: "00".repeat(32),
            result_sha256: "00".repeat(32),
        });
        r.spent = true;
        r.paid = true;
        id
    }

    #[test]
    #[should_panic(expected = "only a World-bound buyer joins a review group")]
    fn an_unbound_buyer_cannot_join() {
        let mut c = setup();
        let n = paid_record(&mut c, 40, "unbound.testnet");
        set("unbound.testnet");
        c.join_review_group(n, "1".into());
    }

    #[test]
    fn one_person_buying_twice_is_one_member_for_k() {
        let mut c = setup();
        // agent.testnet is World-bound (setup); two paid purchases, two memberships.
        let a = paid_record(&mut c, 41, "agent.testnet");
        let b = paid_record(&mut c, 42, "agent.testnet");
        set("agent.testnet");
        c.join_review_group(a, "11".into());
        set("agent.testnet");
        c.join_review_group(b, "12".into());
        let g = c.review_group(acc("m01.bazaar.testnet")).unwrap();
        assert_eq!(g.tree.size, 2, "both memberships are in the tree");
        assert_eq!(c.review_persons(acc("m01.bazaar.testnet")), 1, "but they are one person for the k floor");
    }
}

/// min_tcb: a verdict whose enclave TCB is below the floor is not quoted or paid.
mod tcb_floor {
    use super::*;

    fn with_tcb(c: &mut Bazaar, n: u8, status: &str) -> String {
        let mut e = envelope(n, "agent.testnet");
        e.attestation.tcb_status = status.into();
        submit_with_receipt(c, e);
        hex::encode([n; 32])
    }

    #[test]
    fn up_to_date_is_quoted_and_paid() {
        let mut c = setup();
        let n = with_tcb(&mut c, 1, "UpToDate");
        assert!(c.best_quote(n.clone(), None, None, None, None).is_some());
        let _ = c.settle(n, acc("m01.bazaar.testnet"), "o".into(), U128(151_200_000));
    }

    #[test]
    #[should_panic(expected = "verdict enclave TCB below min_tcb")]
    fn out_of_date_is_refused_at_settle() {
        let mut c = setup();
        let n = with_tcb(&mut c, 1, "OutOfDate");
        assert!(c.best_quote(n.clone(), None, None, None, None).is_none(), "and never quoted");
        set("agent.testnet");
        let _ = c.settle(n, acc("m01.bazaar.testnet"), "o".into(), U128(151_200_000));
    }

    #[test]
    fn the_owner_can_lower_the_floor_and_out_of_date_then_pays() {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.set_min_tcb("OutOfDate".into());
        assert_eq!(c.min_tcb(), "OutOfDate");
        let n = with_tcb(&mut c, 1, "OutOfDate");
        let _ = c.settle(n, acc("m01.bazaar.testnet"), "o".into(), U128(151_200_000));
    }

    #[test]
    #[should_panic(expected = "not a TCB status that can pass")]
    fn revoked_cannot_be_the_floor() {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.set_min_tcb("Revoked".into());
    }

    #[test]
    fn fixture_status_passes_on_testnet_only() {
        let mut c = setup();
        let n = with_tcb(&mut c, 1, "fixture");
        assert!(c.best_quote(n.clone(), None, None, None, None).is_some());
        let mut b = ctx("agent.testnet");
        b.current_account_id(acc("bazaar.near"));
        testing_env!(b.build());
        assert!(c.best_quote(n, None, None, None, None).is_none(), "a mainnet bazaar never quotes a fixture verdict");
    }
}

/// The open category: approval by bond, and one operator cannot stand twice in a round.
mod open_market {
    use super::*;

    fn join(c: &mut Bazaar, m: &str, payout: Option<&str>, bond: u128) {
        set(m);
        c.register_merchant(schedule(), OPEN_CATEGORY.into(), payout.map(acc));
        if bond > 0 {
            set(USDC);
            let _ = c.ft_on_transfer(acc(m), U128(bond), "bond".into());
        }
    }

    #[test]
    fn a_bonded_outside_merchant_is_approved_without_the_owner() {
        let mut c = setup();
        join(&mut c, "outside.testnet", None, OPEN_BOND);
        assert!(c.merchant(acc("outside.testnet")).unwrap().approved);
        assert!(get_logs().iter().any(|l| l.contains("merchant_approved") && l.contains("\"by\":\"bond\"")));
        // A schedule change keeps the approval while the bond stands.
        set("outside.testnet");
        c.register_merchant(cheap(), OPEN_CATEGORY.into(), None);
        assert!(c.merchant(acc("outside.testnet")).unwrap().approved);
    }

    #[test]
    fn an_under_bonded_or_other_category_merchant_is_not_approved_by_bond() {
        let mut c = setup();
        join(&mut c, "small.testnet", None, OPEN_BOND - 1);
        assert!(!c.merchant(acc("small.testnet")).unwrap().approved);
        set("hood.testnet");
        c.register_merchant(schedule(), "hoodie".into(), None);
        set(USDC);
        assert!(matches!(c.ft_on_transfer(acc("hood.testnet"), U128(OPEN_BOND), "bond".into()), PromiseOrValue::Value(U128(v)) if v == OPEN_BOND));
        assert!(!c.merchant(acc("hood.testnet")).unwrap().approved, "outside the open category only the owner approves");
    }

    fn open_round(c: &mut Bazaar) {
        set("agent.testnet");
        c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
        set_no_deposit("owner.testnet");
        c.open_round("o1".into(), OPEN_CATEGORY.into(), COMMIT_UNTIL, REVEAL_UNTIL);
    }

    fn bid(c: &mut Bazaar, m: &str, salt: u8) {
        at(m, NOW_MS);
        c.commit_bid("o1".into(), sealed(m, &schedule(), salt));
    }

    fn reveal(c: &mut Bazaar, m: &str, salt: u8, ms: u64) {
        at(m, ms);
        c.reveal_bid("o1".into(), schedule(), hex::encode([salt; 32]));
    }

    #[test]
    fn two_independent_outside_merchants_both_reveal_and_one_wins() {
        let mut c = setup();
        join(&mut c, "a.testnet", None, OPEN_BOND);
        join(&mut c, "b.testnet", None, OPEN_BOND);
        open_round(&mut c);
        bid(&mut c, "a.testnet", 1);
        bid(&mut c, "b.testnet", 2);
        reveal(&mut c, "a.testnet", 1, COMMIT_UNTIL);
        reveal(&mut c, "b.testnet", 2, COMMIT_UNTIL + 1);
        at("agent.testnet", REVEAL_UNTIL);
        assert!(c.round_best_quote("o1".into(), hex::encode([1u8; 32])).is_some());
    }

    #[test]
    #[should_panic(expected = "linked to a merchant already revealed in this round")]
    fn two_merchants_with_one_payout_cannot_both_reveal() {
        let mut c = setup();
        join(&mut c, "a.testnet", Some("wallet.testnet"), OPEN_BOND);
        join(&mut c, "b.testnet", Some("wallet.testnet"), OPEN_BOND);
        open_round(&mut c);
        bid(&mut c, "a.testnet", 1);
        bid(&mut c, "b.testnet", 2);
        reveal(&mut c, "a.testnet", 1, COMMIT_UNTIL);
        reveal(&mut c, "b.testnet", 2, COMMIT_UNTIL + 1);
    }

    #[test]
    fn a_hire_edge_drops_the_hirer_not_the_merchant_it_hired() {
        // Anyone may hire anyone. a hires its rival b and reveals first, hoping b's reveal is
        // refused as linked. b's reveal stands and a's bid is dropped: one bid per operator,
        // and the hire costs only the hirer.
        let mut c = setup();
        join(&mut c, "a.testnet", None, OPEN_BOND);
        join(&mut c, "b.testnet", None, OPEN_BOND);
        set("a.testnet");
        c.hire(acc("b.testnet"));
        open_round(&mut c);
        bid(&mut c, "a.testnet", 1);
        bid(&mut c, "b.testnet", 2);
        reveal(&mut c, "a.testnet", 1, COMMIT_UNTIL);
        reveal(&mut c, "b.testnet", 2, COMMIT_UNTIL + 1);
        assert!(get_logs().iter().any(|l| l.contains("bid_dropped") && l.contains("a.testnet")));
        assert_eq!(c.round("o1".into()).unwrap().revealed, vec![acc("b.testnet")]);
        at("agent.testnet", REVEAL_UNTIL);
        assert_eq!(c.round_best_quote("o1".into(), hex::encode([1u8; 32])).unwrap().merchant, acc("b.testnet"));
        // a cannot come back in: it hired a merchant revealed in this round.
        let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| reveal(&mut c, "a.testnet", 1, COMMIT_UNTIL + 2)));
        assert!(again.is_err());
    }

    #[test]
    #[should_panic(expected = "linked to a merchant already revealed in this round")]
    fn a_merchant_that_hired_a_revealed_one_cannot_reveal() {
        let mut c = setup();
        join(&mut c, "a.testnet", None, OPEN_BOND);
        join(&mut c, "b.testnet", None, OPEN_BOND);
        set("b.testnet");
        c.hire(acc("a.testnet"));
        open_round(&mut c);
        bid(&mut c, "a.testnet", 1);
        bid(&mut c, "b.testnet", 2);
        reveal(&mut c, "a.testnet", 1, COMMIT_UNTIL);
        reveal(&mut c, "b.testnet", 2, COMMIT_UNTIL + 1);
    }

    /// Rounds from TIE_HASH_FROM_MS on: two equal prices, and the winner is the lower
    /// sha256(nullifier | merchant) whichever revealed first. Each run is one fresh test.
    fn tied(first: &str, second: &str) -> (AccountId, String) {
        let mut c = setup();
        join(&mut c, "a.testnet", None, OPEN_BOND);
        join(&mut c, "b.testnet", None, OPEN_BOND);
        set("agent.testnet");
        c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
        let (cu, ru) = (TIE_HASH_FROM_MS + 60_000, TIE_HASH_FROM_MS + 120_000);
        at("owner.testnet", TIE_HASH_FROM_MS);
        c.open_round("t1".into(), OPEN_CATEGORY.into(), cu, ru);
        for (m, salt) in [("a.testnet", 1u8), ("b.testnet", 2u8)] {
            at(m, TIE_HASH_FROM_MS);
            c.commit_bid("t1".into(), sealed(m, &schedule(), salt));
        }
        for (i, m) in [first, second].iter().enumerate() {
            at(m, cu + i as u64);
            c.reveal_bid("t1".into(), schedule(), hex::encode([if *m == "a.testnet" { 1u8 } else { 2u8 }; 32]));
        }
        at("agent.testnet", ru);
        let n = hex::encode([1u8; 32]);
        (c.round_best_quote("t1".into(), n.clone()).unwrap().merchant, n)
    }

    fn hash_winner(n: &str) -> AccountId {
        let key = |m: &str| bookerbob_core::sha256(format!("{n}|{m}").as_bytes());
        acc(if key("a.testnet") < key("b.testnet") { "a.testnet" } else { "b.testnet" })
    }

    #[test]
    fn a_price_tie_is_broken_by_hash_when_a_reveals_first() {
        let (w, n) = tied("a.testnet", "b.testnet");
        assert_eq!(w, hash_winner(&n));
    }

    #[test]
    fn a_price_tie_is_broken_by_hash_when_b_reveals_first() {
        let (w, n) = tied("b.testnet", "a.testnet");
        assert_eq!(w, hash_winner(&n));
    }
}

/// A sealed bid never opened: `mark_unrevealed` records the default, takes part of the bond
/// and bars the merchant from `commit_bid` for a while.
mod unrevealed {
    use super::*;

    const M1: &str = "m01.bazaar.testnet";
    const M2: &str = "m02.bazaar.testnet";
    const MARKED_AT: u64 = REVEAL_UNTIL + 5;
    const BAR_ENDS: u64 = MARKED_AT + UNREVEALED_BAR_MS;

    /// Round r1 (hoodie): m01 and m02 commit, m01 reveals, m02 stays silent.
    fn silent_m02() -> Bazaar {
        let mut c = round_setup();
        at(M1, NOW_MS);
        c.commit_bid("r1".into(), sealed(M1, &schedule(), 1));
        at(M2, NOW_MS);
        c.commit_bid("r1".into(), sealed(M2, &cheap(), 2));
        at(M1, COMMIT_UNTIL);
        c.reveal_bid("r1".into(), schedule(), hex::encode([1u8; 32]));
        c
    }

    fn mark(c: &mut Bazaar, round: &str, merchant: &str, ms: u64) {
        at("anyone.testnet", ms);
        c.mark_unrevealed(round.into(), acc(merchant));
    }

    /// The owner opens a second hoodie round whose commit phase outlasts the bar.
    fn open_r2(c: &mut Bazaar) {
        at("owner.testnet", MARKED_AT);
        c.open_round("r2".into(), "hoodie".into(), BAR_ENDS + 60_000, BAR_ENDS + 120_000);
    }

    fn bond(c: &mut Bazaar, token: &str, merchant: &str, amount: u128) {
        set(token);
        assert!(matches!(c.ft_on_transfer(acc(merchant), U128(amount), "bond".into()), PromiseOrValue::Value(U128(0))));
    }

    #[test]
    fn a_silent_bid_is_marked_after_the_deadline_and_pays() {
        let mut c = silent_m02();
        bond(&mut c, USDC, M2, 5_000_000);
        assert_eq!((c.unrevealed_defaults(acc(M2)), c.barred_until(acc(M2)), c.is_barred(acc(M2))), (0, 0, false));
        mark(&mut c, "r1", M2, MARKED_AT);
        let log = get_logs().into_iter().find(|l| l.contains("\"event\":\"bid_unrevealed\"")).expect("one event per marking");
        for part in [
            "\"round\":\"r1\"",
            "\"merchant\":\"m02.bazaar.testnet\"",
            "\"by\":\"anyone.testnet\"",
            "\"defaults\":1",
            &format!("\"barred_until_ms\":{BAR_ENDS}"),
            "\"forfeit_usdc\":\"5000000\"",
            "\"forfeit_demo\":\"0\"",
        ] {
            assert!(log.contains(part), "{part} missing in {log}");
        }
        assert_eq!(c.unrevealed_defaults(acc(M2)), 1);
        assert!(c.unrevealed_in_round("r1".into(), acc(M2)));
        assert_eq!(c.barred_until(acc(M2)), BAR_ENDS);
        assert!(c.is_barred(acc(M2)));
        assert_eq!(c.merchant_bond(acc(M2), "usdc".into()), U128(5_000_000 - UNREVEALED_FORFEIT));
        assert_eq!(c.forfeited_bonds("usdc".into()), U128(UNREVEALED_FORFEIT));
        // The merchant that revealed carries nothing.
        assert_eq!((c.unrevealed_defaults(acc(M1)), c.barred_until(acc(M1)), c.unrevealed_in_round("r1".into(), acc(M1))), (0, 0, false));
    }

    #[test]
    fn a_merchant_with_no_bond_is_barred_and_forfeits_nothing() {
        let mut c = silent_m02();
        mark(&mut c, "r1", M2, MARKED_AT);
        assert!(c.is_barred(acc(M2)));
        assert_eq!((c.forfeited_bonds("usdc".into()), c.forfeited_bonds("demo".into())), (U128(0), U128(0)));
        assert!(get_logs().iter().any(|l| l.contains("bid_unrevealed") && l.contains("\"forfeit_usdc\":\"0\"")));
    }

    #[test]
    #[should_panic(expected = "this merchant revealed in time")]
    fn a_merchant_that_revealed_in_time_cannot_be_marked() {
        let mut c = silent_m02();
        mark(&mut c, "r1", M1, MARKED_AT);
    }

    #[test]
    fn a_reveal_in_the_last_millisecond_cannot_be_marked() {
        let mut c = silent_m02();
        at(M2, REVEAL_UNTIL - 1);
        c.reveal_bid("r1".into(), cheap(), hex::encode([2u8; 32]));
        at("anyone.testnet", REVEAL_UNTIL);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.mark_unrevealed("r1".into(), acc(M2)))).is_err());
        assert_eq!((c.unrevealed_defaults(acc(M2)), c.is_barred(acc(M2))), (0, false));
    }

    #[test]
    #[should_panic(expected = "reveal phase is still open")]
    fn marking_before_the_reveal_deadline_is_refused() {
        let mut c = silent_m02();
        mark(&mut c, "r1", M2, REVEAL_UNTIL - 1);
    }

    #[test]
    #[should_panic(expected = "already marked for this round")]
    fn marking_twice_is_refused() {
        let mut c = silent_m02();
        bond(&mut c, USDC, M2, 5_000_000);
        mark(&mut c, "r1", M2, MARKED_AT);
        mark(&mut c, "r1", M2, MARKED_AT + 1);
    }

    #[test]
    fn a_refused_second_marking_takes_nothing_more() {
        let mut c = silent_m02();
        bond(&mut c, USDC, M2, 5_000_000);
        mark(&mut c, "r1", M2, MARKED_AT);
        at("anyone.testnet", MARKED_AT + 1000);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.mark_unrevealed("r1".into(), acc(M2)))).is_err());
        assert_eq!(c.unrevealed_defaults(acc(M2)), 1);
        assert_eq!(c.barred_until(acc(M2)), BAR_ENDS);
        assert_eq!(c.merchant_bond(acc(M2), "usdc".into()), U128(5_000_000 - UNREVEALED_FORFEIT));
    }

    #[test]
    #[should_panic(expected = "no committed bid")]
    fn a_merchant_that_never_committed_cannot_be_marked() {
        let mut c = round_setup();
        at(M1, NOW_MS);
        c.commit_bid("r1".into(), sealed(M1, &schedule(), 1));
        mark(&mut c, "r1", M2, MARKED_AT);
    }

    #[test]
    #[should_panic(expected = "unknown round")]
    fn marking_in_an_unknown_round_is_refused() {
        let mut c = silent_m02();
        mark(&mut c, "nope", M2, MARKED_AT);
    }

    #[test]
    #[should_panic(expected = "too late to mark this round")]
    fn a_round_closed_long_ago_cannot_be_marked() {
        let mut c = silent_m02();
        mark(&mut c, "r1", M2, REVEAL_UNTIL + UNREVEALED_MARK_WINDOW_MS);
    }

    #[test]
    fn the_last_millisecond_of_the_marking_window_still_marks() {
        let mut c = silent_m02();
        mark(&mut c, "r1", M2, REVEAL_UNTIL + UNREVEALED_MARK_WINDOW_MS - 1);
        assert_eq!(c.unrevealed_defaults(acc(M2)), 1);
    }

    #[test]
    #[should_panic(expected = "barred from rounds: an earlier sealed bid was never revealed")]
    fn a_barred_merchants_commit_is_refused_until_the_bar_ends() {
        let mut c = silent_m02();
        mark(&mut c, "r1", M2, MARKED_AT);
        open_r2(&mut c);
        at(M2, BAR_ENDS - 1);
        c.commit_bid("r2".into(), sealed(M2, &cheap(), 3));
    }

    #[test]
    fn a_barred_merchant_commits_again_once_the_bar_ends() {
        let mut c = silent_m02();
        mark(&mut c, "r1", M2, MARKED_AT);
        open_r2(&mut c);
        // The bar does not touch the merchant that revealed.
        at(M1, MARKED_AT + 1);
        c.commit_bid("r2".into(), sealed(M1, &schedule(), 4));
        at(M2, BAR_ENDS);
        assert!(!c.is_barred(acc(M2)));
        c.commit_bid("r2".into(), sealed(M2, &cheap(), 3));
        assert_eq!(c.round("r2".into()).unwrap().commits.len(), 2);
        // The record of the default stays.
        assert_eq!(c.unrevealed_defaults(acc(M2)), 1);
    }

    #[test]
    fn a_forfeit_takes_usdc_first_then_the_demo_token_and_no_more_than_the_bond() {
        const DUSDC: &str = "dusdc.bazaar.testnet";
        let mut c = silent_m02();
        set_no_deposit("owner.testnet");
        c.set_demo_token(acc(DUSDC));
        bond(&mut c, USDC, M2, 2_000_000);
        bond(&mut c, DUSDC, M2, 4_500_000);
        mark(&mut c, "r1", M2, MARKED_AT);
        assert_eq!((c.merchant_bond(acc(M2), "usdc".into()), c.merchant_bond(acc(M2), "demo".into())), (U128(0), U128(1_500_000)));
        assert_eq!((c.forfeited_bonds("usdc".into()), c.forfeited_bonds("demo".into())), (U128(2_000_000), U128(3_000_000)));
        // A second default, in r2 after the bar: only the 1,500,000 left can go.
        open_r2(&mut c);
        at(M2, BAR_ENDS);
        c.commit_bid("r2".into(), sealed(M2, &cheap(), 3));
        mark(&mut c, "r2", M2, BAR_ENDS + 120_000);
        assert_eq!((c.merchant_bond(acc(M2), "usdc".into()), c.merchant_bond(acc(M2), "demo".into())), (U128(0), U128(0)));
        assert_eq!((c.forfeited_bonds("usdc".into()), c.forfeited_bonds("demo".into())), (U128(2_000_000), U128(4_500_000)));
        assert_eq!(c.unrevealed_defaults(acc(M2)), 2);
        assert_eq!(c.barred_until(acc(M2)), BAR_ENDS + 120_000 + UNREVEALED_BAR_MS);
    }

    /// Two bonded outside merchants in an open round `o1`; `a` reveals, `b` does not.
    fn open_round_with_silent_b(link: bool) -> Bazaar {
        let mut c = setup();
        for m in ["a.testnet", "b.testnet"] {
            set(m);
            c.register_merchant(schedule(), OPEN_CATEGORY.into(), None);
            bond(&mut c, USDC, m, OPEN_BOND);
        }
        if link {
            // `a` alone makes the link; `b` did nothing.
            set("a.testnet");
            c.hire(acc("b.testnet"));
        }
        set_no_deposit("owner.testnet");
        c.open_round("o1".into(), OPEN_CATEGORY.into(), COMMIT_UNTIL, REVEAL_UNTIL);
        for (m, salt) in [("a.testnet", 1), ("b.testnet", 2)] {
            at(m, NOW_MS);
            c.commit_bid("o1".into(), sealed(m, &schedule(), salt));
        }
        at("a.testnet", COMMIT_UNTIL);
        c.reveal_bid("o1".into(), schedule(), hex::encode([1u8; 32]));
        c
    }

    #[test]
    fn an_open_merchants_forfeit_is_exact_and_goes_to_no_one() {
        let mut c = open_round_with_silent_b(false);
        mark(&mut c, "o1", "b.testnet", MARKED_AT);
        assert_eq!(c.merchant_bond(acc("b.testnet"), "usdc".into()), U128(OPEN_BOND - UNREVEALED_FORFEIT));
        assert_eq!(c.merchant_bond(acc("a.testnet"), "usdc".into()), U128(OPEN_BOND));
        assert_eq!(c.forfeited_bonds("usdc".into()), U128(UNREVEALED_FORFEIT));
        // Bonds plus the forfeit counter still add up to what was bonded: nothing left the contract.
        let held = c.merchant_bond(acc("a.testnet"), "usdc".into()).0 + c.merchant_bond(acc("b.testnet"), "usdc".into()).0 + c.forfeited_bonds("usdc".into()).0;
        assert_eq!(held, 2 * OPEN_BOND);
        // No token moves and the caller is paid nothing but its unused storage deposit.
        let receipts = near_sdk::test_utils::get_created_receipts();
        assert!(!receipts.iter().any(|r| r.receiver_id.as_str() == USDC));
        assert!(c.escrow_of(acc("anyone.testnet")).is_none());
        assert_eq!(c.fees_accrued("usdc".into()), U128(0));
        // The approval is the owner's or the bond's business; a default does not withdraw it.
        assert!(c.merchant(acc("b.testnet")).unwrap().approved);
    }

    #[test]
    fn an_open_merchant_a_rival_hired_could_still_reveal_so_its_silence_is_marked() {
        // a hired b and revealed; b's reveal would have stood (and dropped a), so b's silence
        // is its own and it is marked like any other.
        let mut c = open_round_with_silent_b(true);
        mark(&mut c, "o1", "b.testnet", MARKED_AT);
        assert_eq!(c.unrevealed_defaults(acc("b.testnet")), 1);
    }

    #[test]
    fn the_marker_pays_the_storage_of_the_record() {
        let mut c = silent_m02();
        // storage_usage restarts with every testing_env!, so measure inside one context.
        at("anyone.testnet", MARKED_AT);
        let before = usage(&mut c);
        c.mark_unrevealed("r1".into(), acc(M2));
        let grown = (usage(&mut c) - before) as u128;
        assert!(grown > 0);
        let refund: u128 = near_sdk::test_utils::get_created_receipts()
            .iter()
            .filter(|r| r.receiver_id.as_str() == "anyone.testnet")
            .flat_map(|r| r.actions.iter())
            .filter_map(|a| match a {
                near_sdk::mock::MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()),
                _ => None,
            })
            .sum();
        assert_eq!(refund, RECORD_DEPOSIT.as_yoctonear() - grown * env::storage_byte_cost().as_yoctonear());
    }

    #[test]
    fn a_marking_leaves_earlier_rounds_and_settled_purchases_untouched() {
        let mut c = setup();
        set(M2);
        c.register_merchant(cheap(), "hoodie".into(), None);
        approve(&mut c, M2);
        set_no_deposit("owner.testnet");
        c.open_round("r1".into(), "hoodie".into(), COMMIT_UNTIL, REVEAL_UNTIL);
        // r1: m01 commits, reveals, wins and is paid.
        at(M1, NOW_MS);
        c.commit_bid("r1".into(), sealed(M1, &schedule(), 1));
        at(M1, COMMIT_UNTIL);
        c.reveal_bid("r1".into(), schedule(), hex::encode([1u8; 32]));
        submit_with_receipt(&mut c, envelope(1, "agent.testnet"));
        let n = hex::encode([1u8; 32]);
        at("agent.testnet", REVEAL_UNTIL);
        let _ = c.settle(n.clone(), acc(M1), "order-1".into(), U128(151_200_000));
        // r2: m01 commits and stays silent.
        at("owner.testnet", REVEAL_UNTIL);
        c.open_round("r2".into(), "hoodie".into(), REVEAL_UNTIL + 1000, REVEAL_UNTIL + 2000);
        at(M1, REVEAL_UNTIL);
        c.commit_bid("r2".into(), sealed(M1, &cheap(), 9));
        let snapshot = |c: &Bazaar| {
            let j = |v: serde_json::Value| v.to_string();
            (
                j(serde_json::to_value(c.round("r1".into())).unwrap()),
                j(serde_json::to_value(c.round("r2".into())).unwrap()),
                j(serde_json::to_value(c.verdict(n.clone())).unwrap()),
                j(serde_json::to_value(c.merchant(acc(M1))).unwrap()),
                c.liability(n.clone()),
                c.escrow_of(acc("agent.testnet")),
                c.spent_count(),
                c.round_best_quote("r1".into(), n.clone()).map(|w| (w.merchant, w.quote.price)),
            )
        };
        at("anyone.testnet", REVEAL_UNTIL + 2000);
        let before = snapshot(&c);
        c.mark_unrevealed("r2".into(), acc(M1));
        assert!(c.is_barred(acc(M1)));
        assert_eq!(snapshot(&c), before);
        assert_eq!(before.7, Some((acc(M1), 151_200_000)));
        assert_eq!(c.nullifier_status(n), NullifierStatus::Spent);
    }
}

/// Trust-anchor timelock: with a delay set, register_* queues, anyone executes after it.
mod anchor_timelock {
    use super::*;
    const KEY: &str = "ed25519:cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

    fn at_ms(who: &str, ms: u64) {
        let mut b = ctx(who);
        b.block_timestamp(ms * 1_000_000);
        testing_env!(b.build());
    }

    fn delayed() -> Bazaar {
        let mut c = setup();
        at_ms("owner.testnet", NOW_MS);
        c.set_anchor_delay(600_000);
        c.register_issuer(KEY.into(), "new issuer".into());
        c
    }

    #[test]
    fn without_a_delay_registration_applies_at_once() {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.register_issuer(KEY.into(), "x".into());
        assert!(c.issuers().iter().any(|(k, _)| k == KEY));
    }

    #[test]
    fn with_a_delay_a_registration_is_queued_and_public() {
        let c = delayed();
        assert!(!c.issuers().iter().any(|(k, _)| k == KEY), "not trusted yet");
        let p = c.pending_anchor(1).unwrap();
        assert_eq!((p.kind.as_str(), p.ready_ms), ("issuer", NOW_MS + 600_000));
        assert!(get_logs().iter().any(|l| l.contains("anchor_queued")));
    }

    #[test]
    #[should_panic(expected = "timelock: not ready yet")]
    fn executing_before_the_delay_is_refused() {
        let mut c = delayed();
        at_ms("anyone.testnet", NOW_MS + 599_999);
        c.execute_anchor(1);
    }

    #[test]
    fn anyone_executes_after_the_delay() {
        let mut c = delayed();
        at_ms("anyone.testnet", NOW_MS + 600_000);
        c.execute_anchor(1);
        assert!(c.issuers().iter().any(|(k, _)| k == KEY));
        assert!(c.pending_anchor(1).is_none());
    }

    #[test]
    #[should_panic(expected = "no such pending change")]
    fn the_owner_can_cancel_inside_the_delay() {
        let mut c = delayed();
        at_ms("owner.testnet", NOW_MS + 1);
        c.cancel_anchor(1);
        at_ms("anyone.testnet", NOW_MS + 600_000);
        c.execute_anchor(1);
    }

    #[test]
    fn lowering_the_delay_is_itself_delayed_raising_is_not() {
        let mut c = delayed();
        at_ms("owner.testnet", NOW_MS);
        c.set_anchor_delay(0);
        assert_eq!(c.anchor_delay(), 600_000, "lowering waits");
        c.set_anchor_delay(900_000);
        assert_eq!(c.anchor_delay(), 900_000, "raising applies");
        at_ms("anyone.testnet", NOW_MS + 600_000);
        c.execute_anchor(2);
        assert_eq!(c.anchor_delay(), 0);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn only_the_owner_cancels() {
        let mut c = delayed();
        at_ms("anyone.testnet", NOW_MS + 1);
        c.cancel_anchor(1);
    }
}

/// 2-of-3 arbiters: with the threshold at 2, one arbiter key cannot overturn a receipt.
mod arbiter_quorum {
    use super::*;

    fn key(n: u8) -> SigningKey {
        SigningKey::from_bytes(&[n; 32])
    }

    fn signed_by(v: &SignedVerdict, result: &WorkerResult, claims: Vec<Claim>, k: &SigningKey) -> bookerbob_core::DisputeDecision {
        let d = DisputeInput {
            salt: None,
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
        serde_json::from_str(&arbitrate(&d, k).unwrap()).unwrap()
    }

    /// Three arbiters, threshold 2, and a forged receipt on chain.
    fn quorum() -> (Bazaar, SignedVerdict, WorkerResult, Vec<Claim>) {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        for n in [31, 32, 33] {
            c.register_arbiter(hex::encode(key(n).verifying_key().to_bytes()), format!("arbiter {n}"));
        }
        c.set_arbiter_threshold(2);
        let e = envelope(1, "agent.testnet");
        let v = sign_ed(e.clone());
        set("agent.testnet");
        c.submit_verdict(v.clone());
        let (cheat, forged) = forged_receipt(&e);
        assert!(c.submit_referee_result(forged.clone()));
        (c, v, forged, cheat)
    }

    #[test]
    #[should_panic(expected = "needs several arbiter signatures")]
    fn one_arbiter_key_alone_is_refused() {
        let (mut c, v, r, cheat) = quorum();
        c.submit_dispute_decision(signed_by(&v, &r, cheat, &key(31)));
    }

    #[test]
    #[should_panic(expected = "needs 2 distinct arbiter signatures")]
    fn one_key_twice_is_still_one() {
        let (mut c, v, r, cheat) = quorum();
        let d = signed_by(&v, &r, cheat, &key(31));
        c.submit_dispute_decisions(vec![d.clone(), d]);
    }

    #[test]
    fn two_distinct_arbiters_overturn_the_receipt() {
        let (mut c, v, r, cheat) = quorum();
        let a = signed_by(&v, &r, cheat.clone(), &key(31));
        let b = signed_by(&v, &r, cheat, &key(32));
        assert!(c.submit_dispute_decisions(vec![a, b]));
        assert_eq!(c.verdict(v.envelope.nullifier).unwrap().receipt, None);
    }

    #[test]
    #[should_panic(expected = "threshold must be 1 to the number of arbiters")]
    fn the_threshold_cannot_exceed_the_arbiters() {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.set_arbiter_threshold(2);
    }
}

/// The referee input travels sealed: plaintext facts in `request_referee` args are refused.
mod sealed_referee_input {
    use super::*;

    fn with_outlayer() -> Bazaar {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.set_outlayer(acc("outlayer.testnet"));
        c
    }

    #[test]
    #[should_panic(expected = "referee input must be sealed")]
    fn plaintext_facts_are_refused() {
        let mut c = with_outlayer();
        let plain = serde_json::json!({ "proofs": proofs(), "claims": honest_claims() }).to_string();
        let _ = c.request_referee("owner/referee".into(), plain);
    }

    #[test]
    fn a_sealed_input_is_forwarded_to_outlayer() {
        let mut c = with_outlayer();
        let pk = bookerbob_referee_worker::sealed::public_hex(&[5u8; 32]);
        let s = bookerbob_referee_worker::sealed::seal(&pk, b"{\"v\":0}", [9u8; 32], [1u8; 24]).unwrap();
        let input = serde_json::json!({ "sealed": s }).to_string();
        let _ = c.request_referee("owner/referee".into(), input);
        assert!(near_sdk::test_utils::get_created_receipts().iter().any(|r| r.receiver_id.as_str() == "outlayer.testnet"));
    }

    /// OutLayer's worker reads the three limits as plain numbers: `{}` or a null would not parse.
    #[test]
    fn the_request_names_every_resource_limit_as_a_number() {
        let mut c = with_outlayer();
        let pk = bookerbob_referee_worker::sealed::public_hex(&[5u8; 32]);
        let s = bookerbob_referee_worker::sealed::seal(&pk, b"{\"v\":0}", [9u8; 32], [1u8; 24]).unwrap();
        let input = serde_json::json!({ "sealed": s }).to_string();
        let _ = c.request_referee("owner/referee".into(), input.clone());
        let receipts = near_sdk::test_utils::get_created_receipts();
        let args: Vec<serde_json::Value> = receipts
            .iter()
            .filter(|r| r.receiver_id.as_str() == "outlayer.testnet")
            .flat_map(|r| r.actions.iter())
            .filter_map(|a| match a {
                near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"request_execution" => {
                    Some(serde_json::from_slice(args).unwrap())
                }
                _ => None,
            })
            .collect();
        assert_eq!(args.len(), 1);
        assert_eq!(args[0]["resource_limits"], serde_json::json!({ "max_instructions": 1_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": 60 }));
        assert!(args[0]["resource_limits"].as_object().unwrap().values().all(|v| v.is_u64()));
        // The rest of the call is as before.
        assert_eq!(args[0]["source"], serde_json::json!({ "Project": { "project_id": "owner/referee", "version_key": null } }));
        assert_eq!(args[0]["input_data"], serde_json::json!(input));
        assert_eq!(args[0]["response_format"], serde_json::json!("Text"));
    }
}

#[test]
fn a_hybrid_v1_sealed_input_is_forwarded_and_a_truncated_kem_ciphertext_is_refused() {
    set("owner.testnet");
    let mut c = setup();
    set_no_deposit("owner.testnet");
    c.set_outlayer(acc("outlayer.testnet"));
    let pk = bookerbob_referee_worker::sealed::public_hex_v1(&[5u8; 32]);
    let s = bookerbob_referee_worker::sealed::seal_v1(&pk, b"{\"v\":1}", [9u8; 32], [3u8; 32], [1u8; 24]).unwrap();
    let _ = c.request_referee("owner/referee".into(), serde_json::json!({ "sealed": s.clone() }).to_string());
    assert!(near_sdk::test_utils::get_created_receipts().iter().any(|r| r.receiver_id.as_str() == "outlayer.testnet"));
    let mut bad = s;
    bad.kem_ct = bad.kem_ct.map(|k| k[..100].to_string());
    let r =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.request_referee("owner/referee".into(), serde_json::json!({ "sealed": bad }).to_string())));
    assert!(r.is_err(), "a truncated ML-KEM ciphertext is refused");
}

/// Buying groups: World-bound buyers with the same revealed set pool for a fixed-tier discount.
mod buying_groups {
    use super::*;
    const DUSDC: &str = "dusdc.bazaar.testnet";

    /// `n` buyers, each its own World person, each with a verdict and an m01 receipt, dUSDC in escrow.
    pub(super) fn buyers(n: u8) -> (Bazaar, Vec<(String, String)>) {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.set_demo_token(acc(DUSDC));
        let mut out = vec![];
        for i in 0..n {
            let agent = format!("buyer{i}.testnet");
            attest(&mut c, &agent, 100 + i);
            let mut b = ctx(&agent);
            b.attached_deposit(ESCROW_STORAGE_DEPOSIT);
            testing_env!(b.build());
            c.storage_deposit(None);
            set(DUSDC);
            let _ = c.ft_on_transfer(acc(&agent), U128(200_000_000), String::new());
            submit_with_receipt(&mut c, envelope(50 + i, &agent));
            out.push((agent, hex::encode([50 + i; 32])));
        }
        (c, out)
    }

    pub(super) fn join(c: &mut Bazaar, b: &[(String, String)]) -> String {
        let mut key = String::new();
        for (agent, n) in b {
            set(agent);
            key = c.post_intent(n.clone(), "hoodie".into(), "77".repeat(32));
        }
        key
    }

    #[test]
    fn five_persons_unlock_the_first_tier_and_each_pays_ten_percent_less() {
        let (mut c, b) = buyers(5);
        let key = join(&mut c, &b);
        let g = c.buying_group(key.clone()).unwrap();
        assert_eq!((g.members.len(), g.persons), (5, 5));
        set_no_deposit("m01.bazaar.testnet");
        c.offer_group(key.clone(), 1000);
        let (_, bps, price) = c.buying_group(key).unwrap().offer.unwrap();
        assert_eq!(bps, 1000);
        let receipt = c.verdict(b[0].1.clone()).unwrap().receipt.unwrap().price.0;
        assert_eq!(price.0, receipt - receipt / 10);
        set(&b[0].0);
        let _ = c.settle_group_demo(b[0].1.clone(), "g-1".into(), price);
        assert_eq!(c.nullifier_status(b[0].1.clone()), NullifierStatus::Spent);
        assert_eq!(c.demo_escrow_of(acc(&b[0].0)), Some(U128(200_000_000 - price.0)));
    }

    #[test]
    #[should_panic(expected = "the group has not reached that tier")]
    fn four_persons_cannot_get_an_offer() {
        let (mut c, b) = buyers(4);
        let key = join(&mut c, &b);
        set_no_deposit("m01.bazaar.testnet");
        c.offer_group(key, 1000);
    }

    #[test]
    #[should_panic(expected = "the group has not reached that tier")]
    fn the_second_tier_needs_ten_persons() {
        let (mut c, b) = buyers(5);
        let key = join(&mut c, &b);
        set_no_deposit("m01.bazaar.testnet");
        c.offer_group(key, 2000);
    }

    #[test]
    #[should_panic(expected = "offer one of the fixed tiers")]
    fn only_fixed_tiers_are_offered() {
        let (mut c, b) = buyers(5);
        let key = join(&mut c, &b);
        set_no_deposit("m01.bazaar.testnet");
        c.offer_group(key, 1234);
    }

    #[test]
    #[should_panic(expected = "amount differs from quote")]
    fn a_member_cannot_pay_the_undiscounted_or_another_amount() {
        let (mut c, b) = buyers(5);
        let key = join(&mut c, &b);
        set_no_deposit("m01.bazaar.testnet");
        c.offer_group(key, 1000);
        set(&b[1].0);
        let receipt = c.verdict(b[1].1.clone()).unwrap().receipt.unwrap().price;
        let _ = c.settle_group_demo(b[1].1.clone(), "g-2".into(), receipt);
    }

    #[test]
    #[should_panic(expected = "only a World-bound buyer joins a buying group")]
    fn an_unbound_buyer_cannot_post_an_intent() {
        let mut c = setup();
        let mut e = envelope(60, "unbound.testnet");
        e.predicates = vec!["airbnb_frequent".into()];
        set("unbound.testnet");
        c.submit_verdict(sign_ed(e.clone()));
        c.post_intent(e.nullifier, "hoodie".into(), "77".repeat(32));
    }

    #[test]
    fn another_revealed_set_is_another_group() {
        let (mut c, b) = buyers(2);
        set(&b[0].0);
        let k1 = c.post_intent(b[0].1.clone(), "hoodie".into(), "77".repeat(32));
        set(&b[1].0);
        let k2 = c.post_intent(b[1].1.clone(), "hotel".into(), "77".repeat(32));
        assert_ne!(k1, k2, "category is part of the key");
    }
}

/// The market fee: conserved (merchant + fee = price), swept to a treasury, given back on a
/// failed payout; at most 2%, and a raise waits out the anchor timelock.
mod market_fee {
    use super::*;
    const TREASURY: &str = "gov.sputnikv2.testnet";

    fn with_fee(bps: u64) -> Bazaar {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.set_fee(bps, acc(TREASURY));
        c
    }

    #[test]
    fn the_fee_is_taken_from_the_price_and_conserved() {
        let mut c = with_fee(100);
        let n = hex::encode([1u8; 32]);
        submit_with_receipt(&mut c, envelope(1, "agent.testnet"));
        let _ = c.settle(n.clone(), acc("m01.bazaar.testnet"), "o".into(), U128(151_200_000));
        assert_eq!(c.escrow_of(acc("agent.testnet")), Some(U128(200_000_000 - 151_200_000)), "the buyer pays the price, nothing more");
        assert_eq!(c.fees_accrued("usdc".into()), U128(1_512_000));
        let logs = get_logs();
        assert!(logs.iter().any(|l| l.contains("\"fee\":\"1512000\"")));
        // The merchant transfer is price - fee.
        let r = near_sdk::test_utils::get_created_receipts();
        let to_usdc = r.iter().find(|x| x.receiver_id.as_str() == USDC).unwrap();
        let amount = to_usdc.actions.iter().find_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"ft_transfer" => {
                serde_json::from_slice::<serde_json::Value>(args).ok().map(|v| v["amount"].as_str().unwrap_or("").to_string())
            }
            _ => None,
        });
        assert_eq!(amount.as_deref(), Some("149688000"), "merchant gets 151.2 - 1.512");
    }

    #[test]
    fn a_failed_payout_gives_back_price_and_fee() {
        let mut c = with_fee(100);
        let n = hex::encode([1u8; 32]);
        submit_with_receipt(&mut c, envelope(1, "agent.testnet"));
        let _ = c.settle(n.clone(), acc("m01.bazaar.testnet"), "o".into(), U128(151_200_000));
        testing_env!(
            ctx("bazaar.testnet").build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed]
        );
        assert!(!c.on_settle_transfer(n, acc("agent.testnet"), U128(151_200_000), None));
        assert_eq!(c.escrow_of(acc("agent.testnet")), Some(U128(200_000_000)));
        assert_eq!(c.fees_accrued("usdc".into()), U128(0));
    }

    #[test]
    fn anyone_sweeps_the_fees_to_the_treasury() {
        let mut c = with_fee(100);
        submit_with_receipt(&mut c, envelope(1, "agent.testnet"));
        let _ = c.settle(hex::encode([1u8; 32]), acc("m01.bazaar.testnet"), "o".into(), U128(151_200_000));
        set_no_deposit("anyone.testnet");
        let _ = c.sweep_fees("usdc".into());
        assert_eq!(c.fees_accrued("usdc".into()), U128(0));
        assert!(get_logs().iter().any(|l| l.contains("fees_swept") && l.contains(TREASURY)));
    }

    #[test]
    #[should_panic(expected = "fee over 2%")]
    fn the_fee_is_capped() {
        with_fee(201);
    }

    #[test]
    fn with_a_timelock_a_fee_raise_waits() {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.set_anchor_delay(600_000);
        c.set_fee(100, acc(TREASURY));
        assert_eq!(c.fee().0, 0, "queued, not applied");
        let mut b = ctx("anyone.testnet");
        b.block_timestamp((NOW_MS + 600_000) * 1_000_000);
        testing_env!(b.build());
        c.execute_anchor(1);
        assert_eq!(c.fee(), (100, Some(acc(TREASURY))));
    }
}

/// Certified private evals: a score over a sealed set, signed by a registered issuer.
mod certified_eval {
    use super::*;
    const ROOT: &str = "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1";

    fn cert(correct: u32, bucket: u8) -> EvalCertificate {
        EvalCertificate {
            v: 0,
            subject: "z-ai/glm-5.3-flash".into(),
            set_root: ROOT.into(),
            n: 20,
            correct,
            score_bucket: bucket,
            answers_hash: "ab".repeat(32),
            issued_at_ms: NOW_MS,
        }
    }

    fn signed(c: &EvalCertificate, k: &SigningKey) -> (String, String) {
        let mut msg = EVAL_TAG.to_vec();
        msg.extend(serde_json::to_vec(c).unwrap());
        (format!("ed25519:{}", hex::encode(k.verifying_key().to_bytes())), hex::encode(k.sign(&bookerbob_core::sha256(&msg)).to_bytes()))
    }

    fn with_set() -> Bazaar {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.register_eval_set(ROOT.into(), 20, "20 sealed arithmetic items".into());
        c
    }

    #[test]
    fn a_signed_certificate_is_stored_and_the_predicate_holds() {
        let mut c = with_set();
        let cert = cert(17, 80);
        let (k, sig) = signed(&cert, &ed_key());
        set("relayer.testnet");
        c.submit_eval_certificate(cert, k, sig);
        assert_eq!(c.eval_score("z-ai/glm-5.3-flash".into(), ROOT.into()), Some(80));
        assert!(c.eval_passes("z-ai/glm-5.3-flash".into(), ROOT.into(), 80));
        assert!(!c.eval_passes("z-ai/glm-5.3-flash".into(), ROOT.into(), 90));
    }

    #[test]
    fn anyone_commits_a_set_as_its_owner_and_its_certificates_count() {
        let mut c = setup();
        set("setmaker.testnet");
        c.commit_eval_set(ROOT.into(), 20, "made outside the bazaar owner".into());
        assert_eq!(c.eval_set(ROOT.into()), Some((20, "made outside the bazaar owner".into(), Some("setmaker.testnet".parse().unwrap()))));
        let cert = cert(17, 80);
        let (k, sig) = signed(&cert, &ed_key());
        set("relayer.testnet");
        c.submit_eval_certificate(cert, k, sig);
        assert_eq!(c.eval_score("z-ai/glm-5.3-flash".into(), ROOT.into()), Some(80));
    }

    #[test]
    #[should_panic(expected = "eval set already committed")]
    fn a_committed_root_cannot_be_taken_over() {
        let mut c = with_set();
        set("squatter.testnet");
        c.commit_eval_set(ROOT.into(), 99, "mine now".into());
    }

    const SUFFIX: &str = "@4000tok/referee-v4";
    const MODEL_KEY: &str = "4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d";

    fn gated() -> Bazaar {
        let mut c = with_set();
        set("m01.bazaar.testnet");
        c.set_eval_gate(Some(EvalGate { set_root: ROOT.into(), subject_suffix: SUFFIX.into(), threshold: 70 }));
        c
    }

    fn model_key(c: &mut Bazaar) {
        set_no_deposit("owner.testnet");
        c.register_model_attestation(
            MODEL_KEY.into(),
            ModelAttestation { model: "z-ai/glm-5.3-flash".into(), nonce: "aa".repeat(32), report_hash: "bb".repeat(32), tcb_status: "UpToDate".into() },
        );
    }

    #[test]
    #[should_panic(expected = "merchant's eval gate: the verdict was not issued by a NEAR AI model key")]
    fn a_gated_merchant_refuses_a_verdict_no_model_issued() {
        let mut c = gated();
        assert_eq!(c.eval_gate(acc("m01.bazaar.testnet")).unwrap().threshold, 70);
        let e = envelope(1, "agent.testnet");
        set(e.cnf.as_str());
        c.submit_verdict(sign_ed(e.clone()));
        c.submit_referee_result(referee_result(&e, honest_claims(), &referee_key()));
    }

    #[test]
    fn a_gated_merchant_takes_a_model_only_once_its_certificate_passes() {
        let mut c = gated();
        model_key(&mut c);
        let m = acc("m01.bazaar.testnet");
        let issuer = format!("near-ai:{MODEL_KEY}");
        let why = c.eval_gate_refusal(&m, &issuer).unwrap();
        assert!(why.contains("z-ai/glm-5.3-flash@4000tok/referee-v4 does not pass 70"), "{why}");
        let mut low = cert(12, 60);
        low.subject = format!("z-ai/glm-5.3-flash{SUFFIX}");
        let (k, sig) = signed(&low, &ed_key());
        set("relayer.testnet");
        c.submit_eval_certificate(low, k, sig);
        assert!(c.eval_gate_refusal(&m, &issuer).is_some(), "60 is under the gate's 70");
        let mut ok = cert(15, 70);
        ok.subject = format!("z-ai/glm-5.3-flash{SUFFIX}");
        let (k, sig) = signed(&ok, &ed_key());
        set("relayer.testnet");
        c.submit_eval_certificate(ok, k, sig);
        assert_eq!(c.eval_gate_refusal(&m, &issuer), None);
        // An ungated merchant takes any issuer.
        assert_eq!(c.eval_gate_refusal(&acc("other.bazaar.testnet"), "ed25519:00"), None);
    }

    #[test]
    fn an_unregistered_model_key_does_not_pass_a_gate() {
        let c = gated();
        assert!(c.eval_gate_refusal(&acc("m01.bazaar.testnet"), &format!("near-ai:{MODEL_KEY}")).unwrap().contains("not registered"));
    }

    #[test]
    #[should_panic(expected = "only a registered merchant sets its eval gate")]
    fn only_a_registered_merchant_sets_an_eval_gate() {
        let mut c = with_set();
        set("stranger.testnet");
        c.set_eval_gate(Some(EvalGate { set_root: ROOT.into(), subject_suffix: SUFFIX.into(), threshold: 70 }));
    }

    #[test]
    #[should_panic(expected = "unknown eval set")]
    fn an_eval_gate_names_a_committed_set() {
        let mut c = with_set();
        set("m01.bazaar.testnet");
        c.set_eval_gate(Some(EvalGate { set_root: "ff".repeat(32), subject_suffix: SUFFIX.into(), threshold: 70 }));
    }

    #[test]
    fn a_merchant_clears_its_eval_gate() {
        let mut c = gated();
        set("m01.bazaar.testnet");
        c.set_eval_gate(None);
        assert_eq!(c.eval_gate(acc("m01.bazaar.testnet")), None);
        let e = envelope(1, "agent.testnet");
        set(e.cnf.as_str());
        c.submit_verdict(sign_ed(e.clone()));
        assert!(c.submit_referee_result(referee_result(&e, honest_claims(), &referee_key())));
    }

    #[test]
    fn the_bazaar_owner_is_on_record_for_a_registered_set() {
        let c = with_set();
        assert_eq!(c.eval_set(ROOT.into()).unwrap().2, Some("owner.testnet".parse().unwrap()));
    }

    #[test]
    #[should_panic(expected = "score bucket must be the floored score")]
    fn an_inflated_bucket_is_refused() {
        let mut c = with_set();
        let cert = cert(17, 90);
        let (k, sig) = signed(&cert, &ed_key());
        set("relayer.testnet");
        c.submit_eval_certificate(cert, k, sig);
    }

    #[test]
    #[should_panic(expected = "bad issuer signature")]
    fn a_changed_score_breaks_the_signature() {
        let mut c = with_set();
        let (k, sig) = signed(&cert(10, 50), &ed_key());
        set("relayer.testnet");
        c.submit_eval_certificate(cert(17, 80), k, sig);
    }

    #[test]
    #[should_panic(expected = "unknown issuer key")]
    fn an_unregistered_issuer_is_refused() {
        let mut c = with_set();
        let cert = cert(17, 80);
        let (k, sig) = signed(&cert, &SigningKey::from_bytes(&[42u8; 32]));
        set("relayer.testnet");
        c.submit_eval_certificate(cert, k, sig);
    }

    #[test]
    #[should_panic(expected = "unknown eval set")]
    fn an_unregistered_set_is_refused() {
        let mut c = setup();
        let cert = cert(17, 80);
        let (k, sig) = signed(&cert, &ed_key());
        set("relayer.testnet");
        c.submit_eval_certificate(cert, k, sig);
    }
}

/// Panel round 3, action 1 prep: a sealed verdict puts hashes only on chain. The predicates,
/// tier and cap travel in an opening to the referee (and the chosen merchant), never in a tx.
mod sealed_verdict {
    use super::*;
    use bookerbob_core::Opening;
    use bookerbob_referee_worker::SealedVerdictInput;

    fn opening(cap: u128) -> Opening {
        Opening { predicates: vec!["airbnb_frequent".into(), "world_id_human".into()], tier: "silver".into(), max_spend: cap, salt: "5a".repeat(32) }
    }

    fn sealed(n: u8, agent: &str, o: &Opening) -> Envelope {
        let mut e = envelope(n, agent);
        e.predicates.clear();
        e.tier = bookerbob_core::SEALED_TIER.into();
        e.max_spend = 0;
        e.disclosure = Some(o.commitment());
        e
    }

    /// The real worker, opening the sealed verdict.
    fn sealed_result(e: &Envelope, o: &Opening) -> WorkerResult {
        let input = WorkerInput {
            salt: None,
            v: 0,
            verdict_digest: hex::encode(e.digest()),
            nullifier: e.nullifier.clone(),
            merchant: "m01.bazaar.testnet".into(),
            schedule: schedule(),
            revealed: o.predicates.clone(),
            claims: honest_claims(),
            proofs: proofs(),
            cohort_k: 0,
            sealed_verdict: Some(SealedVerdictInput { envelope: e.clone(), opening: o.clone() }),
        };
        serde_json::from_str(&run_referee(&input, &referee_key()).unwrap()).unwrap()
    }

    #[test]
    fn a_sealed_verdict_puts_hashes_only_on_chain_and_settles() {
        let mut c = setup();
        let o = opening(200_000_000);
        let e = sealed(1, "agent.testnet", &o);
        set("agent.testnet");
        c.submit_verdict(sign_ed(e.clone()));
        let n = e.nullifier.clone();
        let v = c.verdict(n.clone()).unwrap();
        assert!(v.predicates.is_empty() && v.tier == "sealed" && v.max_spend.0 == 0);
        assert_eq!(c.disclosure(n.clone()), Some(o.commitment()));
        let logs = get_logs().join("\n");
        assert!(!logs.contains("airbnb_frequent") && !logs.contains("200000000"), "{logs}");
        // No cohort counts it: nothing was revealed.
        assert_eq!(c.cohort_size(e.context.clone(), "airbnb_frequent".into()), 0);
        assert!(c.submit_referee_result(sealed_result(&e, &o)));
        let v = c.verdict(n.clone()).unwrap();
        assert_eq!(v.receipt.as_ref().unwrap().price.0, 151_200_000);
        assert_eq!(v.max_spend.0, 151_200_000, "the cap becomes the receipt price the referee checked");
        set("agent.testnet");
        let _ = c.settle(n.clone(), acc("m01.bazaar.testnet"), "order-s".into(), U128(151_200_000));
        assert_eq!(c.nullifier_status(n), NullifierStatus::Spent);
    }

    #[test]
    #[should_panic(expected = "a sealed verdict is priced by the referee from its opening")]
    fn quote_refuses_a_sealed_verdict() {
        let mut c = setup();
        let o = opening(200_000_000);
        let e = sealed(1, "agent.testnet", &o);
        set("agent.testnet");
        c.submit_verdict(sign_ed(e.clone()));
        let _ = c.quote(acc("m01.bazaar.testnet"), e.nullifier);
    }

    #[test]
    #[should_panic(expected = "referee price is not one the schedule can produce")]
    fn a_referee_price_the_code_cannot_produce_is_refused() {
        let mut c = setup();
        let o = opening(200_000_000);
        let e = sealed(1, "agent.testnet", &o);
        set("agent.testnet");
        c.submit_verdict(sign_ed(e.clone()));
        let mut r = sealed_result(&e, &o);
        r.body.price = 100_000_000;
        r.signature = hex::encode(referee_key().sign(&r.body.signing_message()).to_bytes());
        c.submit_referee_result(r);
    }

    #[test]
    #[should_panic(expected = "referee price is not one the schedule can produce")]
    fn the_world_discount_needs_a_world_bound_agent() {
        let mut c = setup();
        let o = opening(200_000_000);
        // other.testnet has no World attestation, so a price with the World line is refused.
        let e = sealed(2, "other.testnet", &o);
        set("other.testnet");
        c.submit_verdict(sign_ed(e.clone()));
        c.submit_referee_result(sealed_result(&e, &o));
    }

    #[test]
    #[should_panic(expected = "cannot join a buying group")]
    fn a_sealed_verdict_cannot_join_a_buying_group() {
        let mut c = setup();
        let o = opening(200_000_000);
        let e = sealed(1, "agent.testnet", &o);
        set("agent.testnet");
        c.submit_verdict(sign_ed(e.clone()));
        let _ = c.post_intent(e.nullifier, "hoodie".into(), "77".repeat(32));
    }

    #[test]
    #[should_panic(expected = "a sealed verdict carries no predicates, tier or cap in the clear")]
    fn a_sealed_verdict_with_plaintext_predicates_is_refused() {
        let mut c = setup();
        let mut e = envelope(1, "agent.testnet");
        e.disclosure = Some(opening(1).commitment());
        set("agent.testnet");
        c.submit_verdict(sign_ed(e));
    }
}

/// Panel round 3, action 6: every trust anchor waits out the delay, not only issuers.
mod anchors_all_timelocked {
    use super::*;
    const MODEL_KEY: &str = "abababababababababababababababababababababababababababababababab";

    fn at_ms(who: &str, ms: u64) {
        let mut b = ctx(who);
        b.block_timestamp(ms * 1_000_000);
        testing_env!(b.build());
    }

    fn delayed() -> Bazaar {
        let mut c = setup();
        at_ms("owner.testnet", NOW_MS);
        c.set_anchor_delay(600_000);
        c
    }

    fn att() -> ModelAttestation {
        ModelAttestation { model: "m".into(), nonce: "cd".repeat(32), report_hash: "ef".repeat(32), tcb_status: "UpToDate".into() }
    }

    #[test]
    fn an_owner_cannot_register_a_model_key_at_once() {
        let mut c = delayed();
        c.register_model_attestation(MODEL_KEY.into(), att());
        assert!(c.model_attestation(MODEL_KEY.into()).is_none(), "not trusted inside the delay");
        assert_eq!(c.pending_anchor(1).unwrap().kind, "model_attestation");
        at_ms("anyone.testnet", NOW_MS + 600_000);
        c.execute_anchor(1);
        assert_eq!(c.model_attestation(MODEL_KEY.into()).unwrap().tcb_status, "UpToDate");
    }

    #[test]
    fn lowering_the_tcb_floor_waits_raising_it_does_not() {
        let mut c = delayed();
        c.set_min_tcb("OutOfDate".into());
        assert_eq!(c.min_tcb(), "UpToDate", "a lower floor is queued");
        assert_eq!(c.pending_anchor(1).unwrap().kind, "min_tcb");
        at_ms("anyone.testnet", NOW_MS + 600_000);
        c.execute_anchor(1);
        assert_eq!(c.min_tcb(), "OutOfDate");
        at_ms("owner.testnet", NOW_MS + 600_001);
        c.set_min_tcb("UpToDate".into());
        assert_eq!(c.min_tcb(), "UpToDate", "raising applies at once");
        assert!(c.pending_anchor(2).is_none());
    }

    #[test]
    fn an_owner_cannot_swap_the_graph_program_at_once() {
        let mut c = delayed();
        c.set_graph_program("12".repeat(32));
        assert_eq!(c.graph_program(), None);
        assert_eq!(c.pending_anchor(1).unwrap().kind, "graph_program");
        at_ms("anyone.testnet", NOW_MS + 600_000);
        c.execute_anchor(1);
        assert_eq!(c.graph_program(), Some("12".repeat(32)));
    }

    #[test]
    #[should_panic(expected = "timelock: not ready yet")]
    fn a_queued_model_key_cannot_be_executed_early() {
        let mut c = delayed();
        c.register_model_attestation(MODEL_KEY.into(), att());
        at_ms("anyone.testnet", NOW_MS + 599_999);
        c.execute_anchor(1);
    }

    #[test]
    fn removing_an_issuer_stays_immediate() {
        let mut c = delayed();
        let k = sign_ed(envelope(1, "agent.testnet")).key_id();
        c.remove_issuer(k.clone());
        assert!(!c.issuers().iter().any(|(x, _)| x == &k), "a stolen key can be cut at once");
        assert!(c.pending_anchor(1).is_none());
    }
}

/// Panel round 3, action 8: a buying group's own Sputnik treasury. The pot stays in the
/// bazaar; only the group's DAO (a passed proposal) pays the merchant or refunds a member.
mod group_treasury {
    use super::buying_groups::{buyers, join};
    use super::*;
    const DAO: &str = "lisbon-g1.sputnikv2.testnet";

    /// 6 members, an m01 offer at 10%, the DAO bound, every member pledged.
    fn pledged() -> (Bazaar, Vec<(String, String)>, String, u128) {
        let (mut c, b) = buyers(6);
        let key = join(&mut c, &b);
        set_no_deposit("m01.bazaar.testnet");
        c.offer_group(key.clone(), 1000);
        let price = c.buying_group(key.clone()).unwrap().offer.unwrap().2 .0;
        set(&b[0].0);
        c.bind_group_treasury(key.clone(), acc(DAO));
        for (i, (agent, n)) in b.iter().enumerate() {
            set(agent);
            c.pledge_group_demo(n.clone(), format!("g-{i}"), U128(price));
        }
        (c, b, key, price)
    }

    /// An arbiter's overturning decision on what the chain holds for this pledge.
    fn overturn(c: &mut Bazaar, n: &str) -> bool {
        set("owner.testnet");
        c.register_arbiter(hex::encode(arbiter_key().verifying_key().to_bytes()), "fixture arbiter".into());
        let r = c.verdict(n.to_string()).unwrap();
        let body = bookerbob_core::DisputeBody {
            v: 0,
            nullifier: n.to_string(),
            verdict_digest: r.digest.clone(),
            referee_result_sha256: r.receipt.unwrap().result_sha256,
            decision: "overturned".into(),
            reasons: vec!["test".into()],
        };
        let signature = hex::encode(arbiter_key().sign(&body.signing_message()).to_bytes());
        c.submit_dispute_decision(bookerbob_core::DisputeDecision { body, arbiter_key: hex::encode(arbiter_key().verifying_key().to_bytes()), signature })
    }

    #[test]
    #[should_panic(expected = "payment not confirmed yet")]
    fn a_held_pledge_is_the_daos_to_refund_not_the_bonds() {
        let (mut c, b, _, _) = pledged();
        overturn(&mut c, &b[0].1);
    }

    #[test]
    #[should_panic(expected = "payment not confirmed yet")]
    fn a_pledge_the_dao_refunded_gets_nothing_from_the_bond() {
        let (mut c, b, key, _) = pledged();
        set_no_deposit(DAO);
        c.refund_group(key, b[0].1.clone());
        overturn(&mut c, &b[0].1);
    }

    #[test]
    fn an_offer_reopens_once_every_pledge_is_refunded() {
        let (mut c, b, key, _) = pledged();
        for (_, n) in &b {
            set_no_deposit(DAO);
            c.refund_group(key.clone(), n.clone());
        }
        set_no_deposit("m01.bazaar.testnet");
        c.offer_group(key, 1000);
    }

    #[test]
    #[should_panic(expected = "pledges stand on the current offer")]
    fn a_pledged_pot_cannot_be_moved_to_another_offer() {
        let (mut c, _, key, _) = pledged();
        set_no_deposit("m01.bazaar.testnet");
        c.offer_group(key, 1000);
    }

    #[test]
    fn pledges_stay_in_the_bazaar_until_the_dao_releases_them() {
        let (mut c, b, key, price) = pledged();
        let t = c.group_treasury(key.clone()).unwrap();
        assert_eq!((t.pledged.len(), t.released), (6, false));
        assert_eq!(c.nullifier_status(b[0].1.clone()), NullifierStatus::Spent);
        assert!(near_sdk::test_utils::get_created_receipts().iter().all(|r| r.receiver_id.as_str() != "dusdc.bazaar.testnet"), "no transfer at pledge");
        set_no_deposit(DAO);
        c.refund_group(key.clone(), b[5].1.clone());
        assert_eq!(c.demo_escrow_of(acc(&b[5].0)), Some(U128(200_000_000)), "the dropout got its pledge back");
        let _ = c.release_group(key.clone());
        assert!(c.group_treasury(key).unwrap().released);
        let logs = get_logs().join("\n");
        assert!(logs.contains("group_release") && logs.contains(&format!("\"amount\":\"{}\"", 5 * price)), "{logs}");
    }

    #[test]
    #[should_panic(expected = "only the group's treasury DAO")]
    fn payout_is_refused_without_the_dao_proposal() {
        let (mut c, b, key, _) = pledged();
        set_no_deposit(&b[0].0);
        let _ = c.release_group(key);
    }

    #[test]
    #[should_panic(expected = "only the group's treasury DAO")]
    fn a_refund_is_refused_without_the_dao_proposal() {
        let (mut c, b, key, _) = pledged();
        set_no_deposit("owner.testnet");
        c.refund_group(key, b[1].1.clone());
    }

    #[test]
    #[should_panic(expected = "fewer standing pledges than the tier needs")]
    fn the_dao_cannot_release_below_the_tier() {
        let (mut c, b, key, _) = pledged();
        set_no_deposit(DAO);
        c.refund_group(key.clone(), b[4].1.clone());
        c.refund_group(key.clone(), b[5].1.clone());
        let _ = c.release_group(key);
    }

    #[test]
    #[should_panic(expected = "only a group member binds its treasury")]
    fn an_outsider_cannot_bind_the_treasury() {
        let (mut c, b) = buyers(5);
        let key = join(&mut c, &b);
        set("outsider.testnet");
        c.bind_group_treasury(key, acc(DAO));
    }

    #[test]
    #[should_panic(expected = "the group has no treasury DAO yet")]
    fn no_pledge_before_a_treasury_is_bound() {
        let (mut c, b) = buyers(5);
        let key = join(&mut c, &b);
        set_no_deposit("m01.bazaar.testnet");
        c.offer_group(key.clone(), 1000);
        let price = c.buying_group(key).unwrap().offer.unwrap().2;
        set(&b[0].0);
        c.pledge_group_demo(b[0].1.clone(), "g".into(), price);
    }
}

mod price_anchor {
    use super::*;

    fn anchored() -> Bazaar {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.set_price_anchor(acc("m01.bazaar.testnet"), U128(200_000_000), "the store's public list price".into());
        c
    }

    #[test]
    #[should_panic(expected = "above its public price anchor")]
    fn an_inflated_base_is_refused() {
        let mut c = anchored();
        set("m01.bazaar.testnet");
        // Inflate the base so a "25% off" lands at the old price: refused.
        c.register_merchant(Schedule { base_price: 252_000_000, ..schedule() }, "hoodie".into(), None);
    }

    #[test]
    fn a_base_at_or_under_the_anchor_registers() {
        let mut c = anchored();
        set("m01.bazaar.testnet");
        c.register_merchant(Schedule { base_price: 200_000_000, ..schedule() }, "hoodie".into(), None);
        assert_eq!(c.merchant(acc("m01.bazaar.testnet")).unwrap().schedule.base_price, 200_000_000);
    }

    #[test]
    fn a_lower_anchor_applies_at_once_and_withdraws_an_approval_above_it() {
        let mut c = setup();
        assert!(c.merchant(acc("m01.bazaar.testnet")).unwrap().approved);
        set_no_deposit("owner.testnet");
        c.set_price_anchor(acc("m01.bazaar.testnet"), U128(150_000_000), "a public rate".into());
        assert!(!c.merchant(acc("m01.bazaar.testnet")).unwrap().approved, "base 189 is above 150");
    }

    #[test]
    fn a_higher_anchor_waits_out_the_delay() {
        let mut c = anchored();
        set_no_deposit("owner.testnet");
        c.set_anchor_delay(600_000);
        c.set_price_anchor(acc("m01.bazaar.testnet"), U128(400_000_000), "raised".into());
        assert_eq!(c.price_anchor(acc("m01.bazaar.testnet")).unwrap().0, U128(200_000_000), "queued, not applied");
        let lower = U128(180_000_000);
        c.set_price_anchor(acc("m01.bazaar.testnet"), lower, "lowered".into());
        assert_eq!(c.price_anchor(acc("m01.bazaar.testnet")).unwrap().0, lower, "lowering applies at once");
    }
}

mod onchain_quote {
    use super::*;
    const KEY: &str = "5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff";
    const NONCE: &str = "0b6e10a283da35ff00000000000000000000000000000000000000000000aaaa";

    fn att(tcb: &str) -> ModelAttestation {
        ModelAttestation { model: "z-ai/glm-5.3-flash".into(), nonce: NONCE.into(), report_hash: "ef".repeat(32), tcb_status: tcb.into() }
    }
    fn done(status: &str, rd: String) -> (String, Option<String>) {
        ("verified".into(), Some(format!("{status} {rd}")))
    }

    #[test]
    fn a_finalized_verification_of_this_key_and_nonce_admits_it() {
        assert_eq!(crate::check_quote_verification(&done("UpToDate", format!("{KEY}{NONCE}")), KEY, &att("UpToDate"), "UpToDate"), Ok(()));
    }

    #[test]
    fn an_unfinished_another_key_a_status_mismatch_or_a_low_tcb_is_refused() {
        let ok_rd = format!("{KEY}{NONCE}");
        assert!(crate::check_quote_verification(&("pck".into(), None), KEY, &att("UpToDate"), "UpToDate").unwrap_err().contains("not finalized"));
        assert!(crate::check_quote_verification(&done("UpToDate", format!("{}{NONCE}", "ab".repeat(32))), KEY, &att("UpToDate"), "UpToDate")
            .unwrap_err()
            .contains("report_data"));
        assert!(crate::check_quote_verification(&done("OutOfDate", ok_rd.clone()), KEY, &att("UpToDate"), "UpToDate")
            .unwrap_err()
            .contains("attestation says"));
        assert!(crate::check_quote_verification(&done("OutOfDate", ok_rd), KEY, &att("OutOfDate"), "UpToDate").unwrap_err().contains("below the floor"));
    }

    #[test]
    #[should_panic(expected = "a quote verifier is set")]
    fn once_a_verifier_is_set_the_off_chain_path_is_closed() {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.set_quote_verifier(acc("spike.bookerbob.testnet"));
        c.register_model_attestation(KEY.into(), att("UpToDate"));
    }
}

/// The VOPRF evaluator's public key: an owner anchor, timelocked like the others.
mod voprf_anchor {
    use super::*;
    const PK: &str = "d0f606f337bd38b6e0a329f8c621657163acaf752610b6256d16fc8d56d4526a";

    #[test]
    fn the_owner_sets_the_voprf_key() {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.set_voprf_key(PK.into());
        assert_eq!(c.voprf_key(), Some(PK.into()));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn only_the_owner_sets_the_voprf_key() {
        let mut c = setup();
        set_no_deposit("agent.testnet");
        c.set_voprf_key(PK.into());
    }

    #[test]
    #[should_panic(expected = "bad VOPRF public key")]
    fn a_malformed_voprf_key_is_refused() {
        let mut c = setup();
        set_no_deposit("owner.testnet");
        c.set_voprf_key("zz".into());
    }
}

/// The Leash: an owner's signed limits on an agent, checked where every payment passes.
mod leash {
    use super::*;
    use bookerbob_core::mandate::Mandate;

    const AGENT: &str = "agent.testnet";
    const PRICE: u128 = 151_200_000;

    fn owner() -> SigningKey {
        SigningKey::from_bytes(&[9u8; 32])
    }

    fn mandate(per: u128, total: u128, nonce: u64) -> Mandate {
        Mandate {
            bazaar: "bazaar.testnet".into(),
            agent: AGENT.into(),
            owner_key: hex::encode(owner().verifying_key().to_bytes()),
            max_per_purchase: per,
            max_total: total,
            expires_at_ms: NOW_MS + 3_000_000,
            round: None,
            nonce,
        }
    }

    fn sign(m: &Mandate) -> String {
        hex::encode(owner().sign(&m.signing_message()).to_bytes())
    }

    fn leash(c: &mut Bazaar, m: &Mandate) {
        set(AGENT);
        c.set_mandate(m.clone(), sign(m));
    }

    fn buy(c: &mut Bazaar, byte: u8) {
        submit_with_receipt(c, envelope(byte, AGENT));
        set_no_deposit(AGENT);
        let _ = c.settle(hex::encode([byte; 32]), acc("m01.bazaar.testnet"), format!("o-{byte}"), U128(PRICE));
    }

    #[test]
    fn a_purchase_inside_the_mandate_settles_counts_and_is_named_in_the_liability() {
        let mut c = setup();
        let m = mandate(PRICE, 2 * PRICE, 1);
        leash(&mut c, &m);
        buy(&mut c, 1);
        assert_eq!(c.mandate_spent(acc(AGENT)), U128(PRICE));
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"settled\"") && l.contains(&m.hash_hex())));
    }

    #[test]
    #[should_panic(expected = "over the mandate's limit per purchase")]
    fn over_the_limit_per_purchase_is_refused() {
        let mut c = setup();
        leash(&mut c, &mandate(PRICE - 1, 10 * PRICE, 1));
        buy(&mut c, 1);
    }

    #[test]
    #[should_panic(expected = "over the mandate's total limit")]
    fn over_the_total_limit_is_refused() {
        let mut c = setup();
        leash(&mut c, &mandate(PRICE, PRICE + 1, 1));
        buy(&mut c, 1);
        buy(&mut c, 2);
    }

    #[test]
    #[should_panic(expected = "mandate expired")]
    fn an_expired_mandate_stops_the_agent() {
        let mut c = setup();
        let mut m = mandate(PRICE, PRICE, 1);
        m.expires_at_ms = NOW_MS;
        leash(&mut c, &m);
        buy(&mut c, 1);
    }

    #[test]
    #[should_panic(expected = "a live mandate holds this escrow")]
    fn a_live_mandate_shuts_the_withdraw_door() {
        let mut c = setup();
        leash(&mut c, &mandate(PRICE, PRICE, 1));
        let mut b = ctx(AGENT);
        b.attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(b.build());
        let _ = c.withdraw(U128(1));
    }

    #[test]
    fn an_expired_mandate_opens_the_withdraw_door_again() {
        let mut c = setup();
        let mut m = mandate(PRICE, PRICE, 1);
        m.expires_at_ms = NOW_MS;
        leash(&mut c, &m);
        let mut b = ctx(AGENT);
        b.attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(b.build());
        let _ = c.withdraw(U128(1));
    }

    #[test]
    fn a_failed_payout_gives_the_limit_back() {
        let mut c = setup();
        leash(&mut c, &mandate(PRICE, PRICE, 1));
        buy(&mut c, 1);
        testing_env!(
            ctx("bazaar.testnet").build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed]
        );
        assert!(!c.on_settle_transfer(hex::encode([1u8; 32]), acc(AGENT), U128(PRICE), None));
        assert_eq!(c.mandate_spent(acc(AGENT)), U128(0));
    }

    #[test]
    #[should_panic(expected = "the agent sets its first mandate")]
    fn nobody_leashes_a_stranger() {
        let mut c = setup();
        let m = mandate(PRICE, PRICE, 1);
        set("stranger.testnet");
        c.set_mandate(m.clone(), sign(&m));
    }

    #[test]
    fn the_owner_replaces_it_from_any_sender_and_the_count_restarts() {
        let mut c = setup();
        leash(&mut c, &mandate(PRICE, PRICE, 1));
        buy(&mut c, 1);
        let m = mandate(PRICE, 3 * PRICE, 2);
        set("relayer.testnet");
        c.set_mandate(m.clone(), sign(&m));
        assert_eq!(c.mandate(acc(AGENT)), Some(m));
        assert_eq!(c.mandate_spent(acc(AGENT)), U128(0));
    }

    #[test]
    #[should_panic(expected = "stale mandate")]
    fn an_old_mandate_cannot_be_replayed() {
        let mut c = setup();
        leash(&mut c, &mandate(PRICE, PRICE, 2));
        leash(&mut c, &mandate(10 * PRICE, 10 * PRICE, 1));
    }

    #[test]
    #[should_panic(expected = "another owner holds this agent")]
    fn the_agent_cannot_swap_in_its_own_key() {
        let mut c = setup();
        leash(&mut c, &mandate(PRICE, PRICE, 1));
        let k = SigningKey::from_bytes(&[10u8; 32]);
        let mut m = mandate(10 * PRICE, 10 * PRICE, 2);
        m.owner_key = hex::encode(k.verifying_key().to_bytes());
        set(AGENT);
        c.set_mandate(m.clone(), hex::encode(k.sign(&m.signing_message()).to_bytes()));
    }

    #[test]
    #[should_panic(expected = "mandate is for another bazaar")]
    fn a_mandate_does_not_move_to_another_bazaar() {
        let mut c = setup();
        let mut m = mandate(PRICE, PRICE, 1);
        m.bazaar = "market.testnet".into();
        leash(&mut c, &m);
    }

    #[test]
    #[should_panic(expected = "not the winner of the mandate's round")]
    fn a_loser_that_later_undercuts_is_not_paid_its_old_receipt() {
        let mut c = round_mandate(true);
        at("m01.bazaar.testnet", REVEAL_UNTIL);
        let mut s = schedule();
        s.base_price = 50_000_000;
        c.merchants.get_mut(&acc("m01.bazaar.testnet")).unwrap().schedule = s;
        at(AGENT, REVEAL_UNTIL);
        let _ = c.settle(hex::encode([1u8; 32]), acc("m01.bazaar.testnet"), "o".into(), U128(PRICE));
    }

    #[test]
    #[should_panic(expected = "bad mandate signature")]
    fn a_mandate_the_owner_did_not_sign_is_refused() {
        let mut c = setup();
        leash(&mut c, &mandate(PRICE, PRICE, 1));
        let m = mandate(10 * PRICE, 10 * PRICE, 2);
        set(AGENT);
        c.set_mandate(m, sign(&mandate(PRICE, PRICE, 2)));
    }

    /// m01 and a cheaper m02 bid (`both`), or m01 alone; the mandate names the round.
    fn round_mandate(both: bool) -> Bazaar {
        let mut c = setup();
        set("m02.bazaar.testnet");
        c.register_merchant(Schedule { base_price: 189_000_000, rules: vec![], cap_bps: 0, cohort: None }, "hoodie".into(), None);
        approve(&mut c, "m02.bazaar.testnet");
        set_no_deposit("owner.testnet");
        c.open_round("r1".into(), "hoodie".into(), COMMIT_UNTIL, REVEAL_UNTIL);
        let mut m = mandate(PRICE, PRICE, 1);
        m.round = Some("r1".into());
        m.expires_at_ms = REVEAL_UNTIL + 1000;
        leash(&mut c, &m);
        at("m01.bazaar.testnet", NOW_MS);
        c.commit_bid("r1".into(), sealed("m01.bazaar.testnet", &schedule(), 1));
        if both {
            at("m02.bazaar.testnet", NOW_MS);
            c.commit_bid("r1".into(), sealed("m02.bazaar.testnet", &cheap(), 2));
        }
        at("m01.bazaar.testnet", COMMIT_UNTIL);
        c.reveal_bid("r1".into(), schedule(), hex::encode([1u8; 32]));
        if both {
            at("m02.bazaar.testnet", COMMIT_UNTIL);
            c.reveal_bid("r1".into(), cheap(), hex::encode([2u8; 32]));
        }
        submit_with_receipt(&mut c, envelope(1, AGENT));
        at(AGENT, REVEAL_UNTIL);
        c
    }

    #[test]
    #[should_panic(expected = "not the winner of the mandate's round")]
    fn a_mandate_on_a_round_refuses_the_loser() {
        let mut c = round_mandate(true);
        let _ = c.settle(hex::encode([1u8; 32]), acc("m01.bazaar.testnet"), "o".into(), U128(PRICE));
    }

    #[test]
    fn a_mandate_on_a_round_pays_the_winner() {
        let mut c = round_mandate(false);
        let _ = c.settle(hex::encode([1u8; 32]), acc("m01.bazaar.testnet"), "o".into(), U128(PRICE));
        assert_eq!(c.mandate_spent(acc(AGENT)), U128(PRICE));
    }
}

/// A revealed bid is pinned for its round: what the round pays is the bid, whatever the
/// merchant registers afterwards.
mod bid_pin {
    use super::*;
    use bookerbob_core::mandate::Mandate;

    const A: &str = "a.testnet";
    const B: &str = "b.testnet";
    const AGENT: &str = "agent.testnet";
    const N1: [u8; 32] = [1u8; 32];
    /// schedule() for the fixture verdict: 189 less 20%.
    const A_BID: u128 = 151_200_000;
    /// mid() for the fixture verdict: 189 less 30%.
    const B_BID: u128 = 132_300_000;
    /// cheap() for the fixture verdict: 189 less 50%.
    const CHEAP: u128 = 94_500_000;

    fn mid() -> Schedule {
        Schedule { base_price: 189_000_000, rules: vec![Rule { predicate: "airbnb_frequent".into(), bps: 3000 }], cap_bps: 3000, cohort: None }
    }

    fn flat() -> Schedule {
        Schedule { base_price: 189_000_000, rules: vec![], cap_bps: 0, cohort: None }
    }

    fn join(c: &mut Bazaar, m: &str) {
        set(m);
        c.register_merchant(flat(), OPEN_CATEGORY.into(), None);
        set(USDC);
        let _ = c.ft_on_transfer(acc(m), U128(OPEN_BOND), "bond".into());
    }

    fn winner(c: &Bazaar, round: &str) -> (AccountId, u128) {
        at(AGENT, REVEAL_UNTIL);
        let w = c.round_best_quote(round.into(), hex::encode(N1)).unwrap();
        (w.merchant, w.quote.price)
    }

    /// Open round o1: A bids schedule() (151.2), B bids mid() (132.3); both reveal. B wins.
    fn open_round_revealed() -> Bazaar {
        let mut c = setup();
        join(&mut c, A);
        join(&mut c, B);
        set(AGENT);
        c.submit_verdict(sign_ed(envelope(1, AGENT)));
        set_no_deposit("owner.testnet");
        c.open_round("o1".into(), OPEN_CATEGORY.into(), COMMIT_UNTIL, REVEAL_UNTIL);
        at(A, NOW_MS);
        c.commit_bid("o1".into(), sealed(A, &schedule(), 1));
        at(B, NOW_MS);
        c.commit_bid("o1".into(), sealed(B, &mid(), 2));
        at(A, COMMIT_UNTIL);
        c.reveal_bid("o1".into(), schedule(), hex::encode([1u8; 32]));
        at(B, COMMIT_UNTIL + 1);
        c.reveal_bid("o1".into(), mid(), hex::encode([2u8; 32]));
        c
    }

    fn reregister(c: &mut Bazaar, m: &str, s: Schedule, category: &str) {
        at(m, COMMIT_UNTIL + 2);
        c.register_merchant(s, category.into(), None);
    }

    #[test]
    fn open_reregistering_cheaper_after_the_reveal_does_not_win_the_round() {
        let mut c = open_round_revealed();
        // A read B's revealed bid and undercuts it on its public schedule.
        reregister(&mut c, A, cheap(), OPEN_CATEGORY);
        let a = c.merchant(acc(A)).unwrap();
        assert!(a.approved && a.schedule.cap_bps == 5000, "the bond keeps the approval and the public schedule did move");
        assert_eq!(winner(&c, "o1"), (acc(B), B_BID), "the round is priced from the revealed bids");
        assert_eq!(c.round_bid("o1".into(), acc(A)).unwrap().cap_bps, schedule().cap_bps);
        // Outside the round, the new public schedule quotes as before.
        assert_eq!(c.quote(acc(A), hex::encode(N1)).price, CHEAP);
    }

    #[test]
    fn open_reregistering_dearer_after_the_reveal_does_not_raise_the_price() {
        let mut c = open_round_revealed();
        reregister(&mut c, B, flat(), OPEN_CATEGORY);
        assert_eq!(winner(&c, "o1"), (acc(B), B_BID), "the winner cannot walk its own bid up to the runner-up");
    }

    #[test]
    fn a_round_revealed_without_a_pin_still_prices_the_current_schedule() {
        let mut c = open_round_revealed();
        // As a round revealed before pins existed: the same round record, no pin keys.
        env::storage_remove(&bid_pin_key("o1", &acc(A)));
        env::storage_remove(&bid_pin_key("o1", &acc(B)));
        assert!(c.round_bid("o1".into(), acc(A)).is_none());
        assert_eq!(winner(&c, "o1"), (acc(B), B_BID));
        reregister(&mut c, A, cheap(), OPEN_CATEGORY);
        assert_eq!(winner(&c, "o1"), (acc(A), CHEAP), "an unpinned round reads the live schedule, as before");
    }

    #[test]
    fn a_pin_belongs_to_one_round_and_one_merchant() {
        let c = open_round_revealed();
        assert_eq!(c.round_bid("o1".into(), acc(B)).unwrap().cap_bps, 3000);
        assert!(c.round_bid("o1".into(), acc("m01.bazaar.testnet")).is_none(), "no reveal, no pin");
        assert!(c.round_bid("o2".into(), acc(A)).is_none());
        assert!(c.round_bid("o1|a".into(), acc("testnet")).is_none());
        // The key splits at its last `|` only because no account id can hold one.
        assert!("a|b.testnet".parse::<AccountId>().is_err());
        assert_ne!(bid_pin_key("o1|a", &acc("b.testnet")), bid_pin_key("o1", &acc("a.b.testnet")));
    }

    /// Round o2 opens inside o1's reveal window; A bids cheap() there, so its public schedule moves.
    fn a_bids_cheap_in_o2(c: &mut Bazaar) {
        at("owner.testnet", COMMIT_UNTIL + 3);
        c.open_round("o2".into(), OPEN_CATEGORY.into(), COMMIT_UNTIL + 10, COMMIT_UNTIL + 20);
        at(A, COMMIT_UNTIL + 4);
        c.commit_bid("o2".into(), sealed(A, &cheap(), 3));
        at(A, COMMIT_UNTIL + 10);
        c.reveal_bid("o2".into(), cheap(), hex::encode([3u8; 32]));
    }

    #[test]
    fn a_bid_in_a_later_round_leaves_the_earlier_round_at_its_own_bid() {
        let mut c = open_round_revealed();
        a_bids_cheap_in_o2(&mut c);
        assert_eq!(c.merchant(acc(A)).unwrap().schedule, cheap(), "the later reveal is the public schedule");
        assert_eq!(c.round_bid("o1".into(), acc(A)), Some(schedule()));
        assert_eq!(c.round_bid("o2".into(), acc(A)), Some(cheap()));
        assert_eq!(winner(&c, "o1"), (acc(B), B_BID), "o1 is not re-priced by a bid made in o2");
        assert_eq!(winner(&c, "o2"), (acc(A), CHEAP));
    }

    #[test]
    fn an_agent_leashed_to_the_earlier_round_pays_that_rounds_bid_after_a_later_round() {
        // What an off-chain referee must do after this rule: price from `round_bid`, not `merchant`.
        let mut c = leashed_round(schedule());
        a_bids_cheap_in_o2(&mut c);
        let pinned = c.round_bid("o1".into(), acc(A)).unwrap();
        let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let live = c.merchant(acc(A)).unwrap().schedule;
            c.submit_referee_result(receipt_for(&envelope(1, AGENT), A, live))
        }));
        assert!(refused.is_err(), "a receipt priced from the current schedule is not this round's price");
        set(AGENT);
        assert!(c.submit_referee_result(receipt_for(&envelope(1, AGENT), A, pinned)));
        at(AGENT, REVEAL_UNTIL);
        let _ = c.settle(hex::encode(N1), acc(A), "o".into(), U128(A_BID));
        assert_eq!(c.mandate_spent(acc(AGENT)), U128(A_BID));
    }

    #[test]
    fn without_a_round_mandate_a_receipt_is_priced_from_the_current_schedule_as_before() {
        // The buyers of `make try` and `make demo-tester` hold no mandate: nothing changes for them.
        let mut c = open_round_revealed();
        reregister(&mut c, A, cheap(), OPEN_CATEGORY);
        set(AGENT);
        let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.submit_referee_result(receipt_for(&envelope(1, AGENT), A, schedule()))));
        assert!(refused.is_err(), "the pin prices nothing for an agent no round mandate binds");
        set(AGENT);
        assert!(c.submit_referee_result(receipt_for(&envelope(1, AGENT), A, cheap())));
        assert_eq!(c.verdict(hex::encode(N1)).unwrap().receipt.unwrap().price, U128(CHEAP));
    }

    #[test]
    #[should_panic(expected = "already revealed")]
    fn a_second_reveal_cannot_replace_the_pin() {
        let mut c = open_round_revealed();
        at(A, COMMIT_UNTIL + 3);
        c.reveal_bid("o1".into(), schedule(), hex::encode([1u8; 32]));
    }

    #[test]
    fn owner_approved_category_a_reregister_still_drops_the_merchant_from_the_round() {
        let mut c = round_setup();
        at("m01.bazaar.testnet", NOW_MS);
        c.commit_bid("r1".into(), sealed("m01.bazaar.testnet", &schedule(), 1));
        at("m02.bazaar.testnet", NOW_MS);
        c.commit_bid("r1".into(), sealed("m02.bazaar.testnet", &cheap(), 2));
        at("m01.bazaar.testnet", COMMIT_UNTIL);
        c.reveal_bid("r1".into(), schedule(), hex::encode([1u8; 32]));
        at("m02.bazaar.testnet", COMMIT_UNTIL + 1);
        c.reveal_bid("r1".into(), cheap(), hex::encode([2u8; 32]));
        assert_eq!(winner(&c, "r1"), (acc("m02.bazaar.testnet"), CHEAP));
        // A changed schedule waits for the owner again: out of the round, as before.
        reregister(&mut c, "m02.bazaar.testnet", flat(), "hoodie");
        assert!(!c.merchant(acc("m02.bazaar.testnet")).unwrap().approved);
        assert_eq!(winner(&c, "r1"), (acc("m01.bazaar.testnet"), A_BID));
        // Approved again, it is back at the bid it revealed, not at the schedule it holds now.
        approve(&mut c, "m02.bazaar.testnet");
        assert_eq!(winner(&c, "r1"), (acc("m02.bazaar.testnet"), CHEAP));
    }

    fn receipt_for(e: &Envelope, merchant: &str, s: Schedule) -> WorkerResult {
        let input = WorkerInput {
            salt: None,
            v: 0,
            verdict_digest: hex::encode(e.digest()),
            nullifier: e.nullifier.clone(),
            merchant: merchant.into(),
            schedule: s,
            revealed: e.predicates.clone(),
            claims: honest_claims(),
            proofs: proofs(),
            cohort_k: 0,
            sealed_verdict: None,
        };
        serde_json::from_str(&run_referee(&input, &referee_key()).unwrap()).unwrap()
    }

    /// Open round o1 with A alone, the agent leashed to the round; A reveals schedule() and
    /// then re-registers `after`. The verdict is on chain, no receipt yet.
    fn leashed_round(after: Schedule) -> Bazaar {
        let mut c = setup();
        join(&mut c, A);
        set_no_deposit("owner.testnet");
        c.open_round("o1".into(), OPEN_CATEGORY.into(), COMMIT_UNTIL, REVEAL_UNTIL);
        let owner = SigningKey::from_bytes(&[9u8; 32]);
        let m = Mandate {
            bazaar: "bazaar.testnet".into(),
            agent: AGENT.into(),
            owner_key: hex::encode(owner.verifying_key().to_bytes()),
            max_per_purchase: A_BID,
            max_total: A_BID,
            expires_at_ms: REVEAL_UNTIL + 1000,
            round: Some("o1".into()),
            nonce: 1,
        };
        set(AGENT);
        c.set_mandate(m.clone(), hex::encode(owner.sign(&m.signing_message()).to_bytes()));
        at(A, NOW_MS);
        c.commit_bid("o1".into(), sealed(A, &schedule(), 1));
        at(A, COMMIT_UNTIL);
        c.reveal_bid("o1".into(), schedule(), hex::encode([1u8; 32]));
        reregister(&mut c, A, after, OPEN_CATEGORY);
        set(AGENT);
        c.submit_verdict(sign_ed(envelope(1, AGENT)));
        c
    }

    #[test]
    fn a_round_settle_pays_the_pinned_bid_after_a_cheaper_reregister() {
        let mut c = leashed_round(cheap());
        assert!(c.submit_referee_result(receipt_for(&envelope(1, AGENT), A, schedule())));
        at(AGENT, REVEAL_UNTIL);
        let _ = c.settle(hex::encode(N1), acc(A), "o".into(), U128(A_BID));
        assert_eq!(c.mandate_spent(acc(AGENT)), U128(A_BID));
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"settled\"") && l.contains("\"amount\":\"151200000\"")));
    }

    #[test]
    fn a_round_settle_pays_the_pinned_bid_after_a_dearer_reregister() {
        let mut c = leashed_round(flat());
        assert!(c.submit_referee_result(receipt_for(&envelope(1, AGENT), A, schedule())));
        at(AGENT, REVEAL_UNTIL);
        let _ = c.settle(hex::encode(N1), acc(A), "o".into(), U128(A_BID));
        assert_eq!(c.mandate_spent(acc(AGENT)), U128(A_BID));
    }

    #[test]
    #[should_panic(expected = "referee price differs from quote")]
    fn a_round_receipt_priced_from_the_later_schedule_is_refused() {
        let mut c = leashed_round(flat());
        let _ = c.submit_referee_result(receipt_for(&envelope(1, AGENT), A, flat()));
    }

    #[test]
    #[should_panic(expected = "not the winner of the mandate's round")]
    fn a_receipt_from_before_the_mandate_at_another_price_cannot_settle_in_the_round() {
        // No mandate yet when the receipt is written: it is priced from the live schedule.
        let mut c = setup();
        join(&mut c, A);
        set_no_deposit("owner.testnet");
        c.open_round("o1".into(), OPEN_CATEGORY.into(), COMMIT_UNTIL, REVEAL_UNTIL);
        at(A, NOW_MS);
        c.commit_bid("o1".into(), sealed(A, &schedule(), 1));
        at(A, COMMIT_UNTIL);
        c.reveal_bid("o1".into(), schedule(), hex::encode([1u8; 32]));
        reregister(&mut c, A, cheap(), OPEN_CATEGORY);
        set(AGENT);
        c.submit_verdict(sign_ed(envelope(1, AGENT)));
        assert!(c.submit_referee_result(receipt_for(&envelope(1, AGENT), A, cheap())));
        let owner = SigningKey::from_bytes(&[9u8; 32]);
        let m = Mandate {
            bazaar: "bazaar.testnet".into(),
            agent: AGENT.into(),
            owner_key: hex::encode(owner.verifying_key().to_bytes()),
            max_per_purchase: A_BID,
            max_total: A_BID,
            expires_at_ms: REVEAL_UNTIL + 1000,
            round: Some("o1".into()),
            nonce: 1,
        };
        set(AGENT);
        c.set_mandate(m.clone(), hex::encode(owner.sign(&m.signing_message()).to_bytes()));
        at(AGENT, REVEAL_UNTIL);
        let _ = c.settle(hex::encode(N1), acc(A), "o".into(), U128(CHEAP));
    }

    #[test]
    fn the_reveal_charges_the_merchant_for_the_pin() {
        let mut c = setup();
        join(&mut c, A);
        set_no_deposit("owner.testnet");
        c.open_round("o1".into(), OPEN_CATEGORY.into(), COMMIT_UNTIL, REVEAL_UNTIL);
        at(A, NOW_MS);
        c.commit_bid("o1".into(), sealed(A, &schedule(), 1));
        c.flush_all();
        at(A, COMMIT_UNTIL);
        let before = env::storage_usage();
        c.reveal_bid("o1".into(), schedule(), hex::encode([1u8; 32]));
        let pin = bid_pin_key("o1", &acc(A)).len() + near_sdk::borsh::to_vec(&schedule()).unwrap().len();
        assert!(env::storage_usage() - before >= pin as u64, "the pin's bytes are inside the delta reveal_bid charges");
    }

    #[test]
    fn the_price_anchor_still_refuses_a_reveal_above_it() {
        let mut c = setup();
        join(&mut c, A);
        set_no_deposit("owner.testnet");
        c.open_round("o1".into(), OPEN_CATEGORY.into(), COMMIT_UNTIL, REVEAL_UNTIL);
        at(A, NOW_MS);
        c.commit_bid("o1".into(), sealed(A, &schedule(), 1));
        set_no_deposit("owner.testnet");
        c.set_price_anchor(acc(A), U128(100_000_000), "fixture".into());
        at(A, COMMIT_UNTIL);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.reveal_bid("o1".into(), schedule(), hex::encode([1u8; 32]))));
        assert!(r.is_err());
        assert!(c.round_bid("o1".into(), acc(A)).is_none(), "a refused reveal pins nothing");
    }
}

// ---------- stored layout, pinned against main at 2278b42 ----------

/// Both live bazaars keep their state across redeploys only while the root struct and every
/// borsh-stored type keep their layout. These bytes were captured from main at 2278b42: a
/// field added, removed, reordered or retyped in any of them fails here.
mod layout {
    use super::*;
    use near_sdk::borsh::to_vec;

    fn h<T: near_sdk::borsh::BorshSerialize>(v: &T) -> String {
        hex::encode(to_vec(v).unwrap())
    }

    fn samples() -> Vec<(&'static str, String)> {
        set("owner.testnet");
        let mut c = Bazaar::new(acc("owner.testnet"), acc(USDC));
        c.flush_all();
        let receipt =
            RefereeReceipt { merchant: acc("m01.bazaar.testnet"), price: U128(7), receipt_hash: "r".into(), referee: "k".into(), result_sha256: "s".into() };
        vec![
            ("Bazaar", hex::encode(env::storage_read(b"STATE").expect("root state"))),
            (
                "Round",
                h(&Round {
                    category: "hoodie".into(),
                    commit_until_ms: 1,
                    reveal_until_ms: 2,
                    commits: vec![(acc("m01.bazaar.testnet"), "ab".into())],
                    revealed: vec![acc("m01.bazaar.testnet")],
                }),
            ),
            ("Merchant", h(&Merchant { payout: acc("pay.testnet"), category: "open".into(), schedule: cohort_schedule(), approved: true })),
            (
                "VerdictRecord",
                h(&VerdictRecord {
                    agent: acc("agent.testnet"),
                    context: "c".into(),
                    predicates: vec!["p".into()],
                    commitment: "cm".into(),
                    proof_hash: "ph".into(),
                    tier: "silver".into(),
                    tcb_status: "UpToDate".into(),
                    issuer: "i".into(),
                    max_spend: U128(9),
                    expires_at_ms: 3,
                    spent: true,
                    checkout_ref: Some("o".into()),
                    digest: "d".into(),
                    receipt: Some(receipt),
                    disputed: false,
                    storage_reserve: 768,
                    review_joined: true,
                    paid: true,
                }),
            ),
            ("NullifierStatus", h(&NullifierStatus::Spent)),
            ("ReviewGroup", h(&ReviewGroup { tree: Default::default(), recent_roots: vec!["11".into()] })),
            (
                "ReviewRound",
                h(&ReviewRound {
                    sealed: vec![("n".into(), "c".into())],
                    revealed: vec![("n".into(), Review { rating: 5, delivered: true, reason_hash: "h".into() })],
                    published: true,
                }),
            ),
            ("ModelAttestation", h(&ModelAttestation { model: "m".into(), nonce: "n".into(), report_hash: "r".into(), tcb_status: "UpToDate".into() })),
            (
                "PendingGraphUpdate",
                h(&PendingGraphUpdate {
                    program_hash: "p".into(),
                    root: "r".into(),
                    scores_hash: "s".into(),
                    proof_sha256: "x".into(),
                    worker_key: "w".into(),
                    merchants: vec![(acc("m01.bazaar.testnet"), 1, 2)],
                    standing: vec![(acc("m01.bazaar.testnet"), U128(3))],
                    submitted_ms: 4,
                    challenger: Some((acc("ch.testnet"), U128(5))),
                }),
            ),
            ("PendingAnchor", h(&PendingAnchor { kind: "referee".into(), args: "{}".into(), ready_ms: 6 })),
            (
                "BuyingGroup",
                h(&BuyingGroup {
                    category: "hoodie".into(),
                    context: "c".into(),
                    predicates: vec!["p".into()],
                    members: vec!["n".into()],
                    budgets: vec!["b".into()],
                    persons: 1,
                    offer: Some((acc("m01.bazaar.testnet"), 500, U128(8))),
                }),
            ),
            (
                "GroupTreasury",
                h(&GroupTreasury { dao: Some(acc("dao.testnet")), pledged: vec![("n".into(), U128(1))], refunded: vec!["n".into()], released: true }),
            ),
            (
                "EvalCertificate",
                h(&EvalCertificate {
                    v: 0,
                    subject: "s".into(),
                    set_root: "r".into(),
                    n: 50,
                    correct: 49,
                    score_bucket: 9,
                    answers_hash: "a".into(),
                    issued_at_ms: 7,
                }),
            ),
            ("EvalGate", h(&EvalGate { set_root: "r".into(), subject_suffix: ".x".into(), threshold: 8 })),
        ]
    }

    /// Captured by running `samples()` on main at 2278b42, before `mark_unrevealed` existed.
    const MAIN_B6DC27C: [(&str, &str); 14] = [
        ("Bazaar", "0d0000006f776e65722e746573746e65740c000000757364632e746573746e65740000000002000000697602000000696d00000000020000006d76020000006d6d0100000076010000006500000000000000000000000002000000727602000000726d00010000006b0000000002000000777602000000776d00010000006101000000680000000002000000647602000000646d0100000062010000006e01000000670100000071010000006f010000007401000000780000000000000000000000000000000000000000000000000000000000000000000000000000000000010000007a000100000063"),
        ("Round", "06000000686f6f6469650100000000000000020000000000000001000000120000006d30312e62617a6161722e746573746e657402000000616201000000120000006d30312e62617a6161722e746573746e6574"),
        ("Merchant", "0b0000007061792e746573746e6574040000006f70656e40e9430b000000000000000000000000020000000f000000616972626e625f6672657175656e74b0040e000000776f726c645f69645f68756d616e2003c409010e000000776f726c645f69645f68756d616e05000000f40101"),
        ("VerdictRecord", "0d0000006167656e742e746573746e6574010000006301000000010000007002000000636d0200000070680600000073696c766572080000005570546f4461746501000000690900000000000000000000000000000003000000000000000101010000006f010000006401120000006d30312e62617a6161722e746573746e6574070000000000000000000000000000000100000072010000006b01000000730000030000000000000101"),
        ("NullifierStatus", "02"),
        ("ReviewGroup", "000000000000000000000000000000000000000001000000020000003131"),
        ("ReviewRound", "01000000010000006e010000006301000000010000006e0501010000006801"),
        ("ModelAttestation", "010000006d010000006e0100000072080000005570546f44617465"),
        ("PendingGraphUpdate", "0100000070010000007201000000730100000078010000007701000000120000006d30312e62617a6161722e746573746e65740100000000000000020000000000000001000000120000006d30312e62617a6161722e746573746e6574030000000000000000000000000000000400000000000000010a00000063682e746573746e657405000000000000000000000000000000"),
        ("PendingAnchor", "0700000072656665726565020000007b7d0600000000000000"),
        ("BuyingGroup", "06000000686f6f646965010000006301000000010000007001000000010000006e010000000100000062010000000000000001120000006d30312e62617a6161722e746573746e6574f40108000000000000000000000000000000"),
        ("GroupTreasury", "010b00000064616f2e746573746e657401000000010000006e0100000000000000000000000000000001000000010000006e01"),
        ("EvalCertificate", "000100000073010000007232000000310000000901000000610700000000000000"),
        ("EvalGate", "0100000072020000002e7808"),
    ];

    #[test]
    fn stored_types_keep_the_borsh_layout_of_main() {
        let now = samples();
        assert_eq!(now.len(), MAIN_B6DC27C.len());
        for ((name, bytes), (pinned_name, pinned)) in now.iter().zip(MAIN_B6DC27C) {
            assert_eq!(*name, pinned_name);
            assert_eq!(bytes, pinned, "the stored layout of {name} changed: a redeploy would not read the live state");
        }
    }
}
