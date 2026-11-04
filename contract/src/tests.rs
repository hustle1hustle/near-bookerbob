use super::*;
use bookerbob_core::{Attestation, Envelope, Rule};
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
        cap_bps: 2500,
    }
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
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
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
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
    let _ = c.settle(n, acc("m01.bazaar.testnet"), "order-1".into(), U128(151_200_000));
    set("wallet2.testnet");
    c.submit_verdict(sign_ed(envelope(1, "wallet2.testnet")));
}

#[test]
#[should_panic(expected = "nullifier spent")]
fn double_settle_is_rejected() {
    let mut c = setup();
    let n = hex::encode([1u8; 32]);
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
    let _ = c.settle(n.clone(), acc("m01.bazaar.testnet"), "order-1".into(), U128(151_200_000));
    let _ = c.settle(n, acc("m01.bazaar.testnet"), "order-2".into(), U128(151_200_000));
}

#[test]
#[should_panic(expected = "over verdict cap")]
fn settle_over_cap_is_rejected() {
    let mut c = setup();
    let mut e = envelope(1, "agent.testnet");
    e.max_spend = 100_000_000; // below the 151.2 USDC price
    set("agent.testnet");
    c.submit_verdict(sign_ed(e));
    let _ = c.settle(hex::encode([1u8; 32]), acc("m01.bazaar.testnet"), "order-1".into(), U128(151_200_000));
}

#[test]
#[should_panic(expected = "amount differs from quote")]
fn settle_with_wrong_amount_is_rejected() {
    let mut c = setup();
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
    let _ = c.settle(hex::encode([1u8; 32]), acc("m01.bazaar.testnet"), "order-1".into(), U128(100));
}

#[test]
#[should_panic(expected = "insufficient escrow")]
fn settle_without_enough_escrow_is_rejected() {
    set("owner.testnet");
    let mut c = Bazaar::new(acc("owner.testnet"), acc(USDC));
    let v = sign_ed(envelope(1, "agent.testnet"));
    c.register_issuer(v.key_id(), "x".into());
    set("m01.bazaar.testnet");
    c.register_merchant(schedule(), "hoodie".into(), None);
    let mut b = ctx("agent.testnet");
    b.attached_deposit(ESCROW_STORAGE_DEPOSIT);
    testing_env!(b.build());
    c.storage_deposit(None);
    set("agent.testnet");
    c.submit_verdict(v);
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
    set("agent.testnet");
    c.submit_verdict(sign_ed(envelope(1, "agent.testnet")));
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
    c.register_merchant(Schedule { base_price: 160_000_000, rules: vec![], cap_bps: 0 }, "hoodie".into(), None);
    set("h01.bazaar.testnet");
    c.register_merchant(Schedule { base_price: 90_000_000, rules: vec![], cap_bps: 0 }, "hotel-lisbon-2n".into(), None);
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
