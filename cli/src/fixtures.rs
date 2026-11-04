//! Deterministic synthetic fixtures. Every byte is derived from fixed labels, so
//! `gen-fixtures --check` can prove the committed files are what this code produces.
//! No real user data: facts, nullifier and keys are labelled placeholders.
use bookerbob_core::envelope::commitment;
use bookerbob_core::{derive, sha256, sha256_hex, Attestation, Claim, Envelope, Fact, ProofSet, Rule, Schedule, SigAlg, SignedVerdict};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};

pub const NOW_MS: u64 = 1_793_793_600_000; // 2026-11-04T12:00:00Z
pub const EXPIRES_MS: u64 = 1_794_700_740_000; // 2026-11-14T23:59:00Z
pub const CONTEXT: &str = "bookerbob:v0:demo-hoodie";
pub const AGENT: &str = "agent.bookerbob.testnet";
pub const WALLET2: &str = "wallet2.bookerbob.testnet";
pub const OWNER: &str = "bookerbob.testnet";
pub const USDC: &str = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
pub const ESCROW_USDC: u128 = 50_000_000;
pub const MAX_SPEND: u128 = 45_000_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct MerchantFixture {
    pub account: String,
    pub label: String,
    pub category: String,
    pub schedule: Schedule,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Expected {
    pub derived_predicates: Vec<String>,
    pub tier: String,
    pub revealed: Vec<String>,
    pub winner: String,
    pub price: String,
    pub discount_bps: u16,
    pub escrow_after: String,
    pub cheat_refusal: String,
    pub replay_error: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Opening {
    pub note: String,
    pub salt: String,
    pub nullifier_label: String,
}

pub fn label_hash(label: &str) -> [u8; 32] {
    sha256(label.as_bytes())
}

pub fn ed_issuer() -> SigningKey {
    SigningKey::from_bytes(&label_hash("bookerbob fixture issuer ed25519 v0"))
}

pub fn p256_issuer() -> p256::ecdsa::SigningKey {
    p256::ecdsa::SigningKey::from_slice(&label_hash("bookerbob fixture issuer p256 v0")).expect("valid scalar")
}

fn fact(id: &str, platform: &str, field: &str, value: u64) -> Fact {
    Fact {
        id: id.into(),
        platform: platform.into(),
        field: field.into(),
        value,
        proof_ref: sha256_hex(format!("synthetic presentation {id}").as_bytes()),
    }
}

pub fn proofs() -> ProofSet {
    ProofSet {
        facts: vec![
            fact("F1", "airbnb", "trips_12m", 7),
            fact("F2", "booking", "genius_level", 2),
            fact("F3", "anthropic", "monthly_spend_usd", 120),
            fact("F4", "uber", "trips_90d", 4),
            fact("F5", "world_id", "verified", 1),
        ],
    }
}

/// The buyer reveals three of the four derived bits for this purchase.
pub fn revealed() -> Vec<String> {
    vec!["airbnb_frequent".into(), "claude_spender".into(), "world_id_human".into()]
}

pub fn salt() -> [u8; 32] {
    label_hash("bookerbob fixture salt v0")
}

pub fn nullifier(label: &str) -> String {
    sha256_hex(format!("bookerbob fixture nullifier placeholder v0|{label}|{CONTEXT}").as_bytes())
}

pub fn merchants() -> Vec<MerchantFixture> {
    let r = |p: &str, bps: u16| Rule { predicate: p.into(), bps };
    vec![
        MerchantFixture {
            account: "m01.bookerbob.testnet".into(),
            label: "shopify test store (UCP)".into(),
            category: "hoodie".into(),
            schedule: Schedule {
                base_price: 48_000_000,
                rules: vec![r("claude_spender", 1000), r("world_id_human", 800), r("airbnb_frequent", 500)],
                cap_bps: 2000,
            },
        },
        MerchantFixture {
            account: "m02.bookerbob.testnet".into(),
            label: "low base, booking only".into(),
            category: "hoodie".into(),
            schedule: Schedule { base_price: 42_000_000, rules: vec![r("booking_genius", 1500)], cap_bps: 1500 },
        },
        MerchantFixture {
            account: "m03.bookerbob.testnet".into(),
            label: "travel bundle".into(),
            category: "hoodie".into(),
            schedule: Schedule {
                base_price: 50_000_000,
                rules: vec![r("airbnb_frequent", 1200), r("world_id_human", 800)],
                cap_bps: 2500,
            },
        },
    ]
}

pub fn honest_claims() -> Vec<Claim> {
    vec![
        Claim { line: "claude_spender".into(), text: "spends on claude every month".into(), citations: vec!["F3".into()] },
        Claim { line: "world_id_human".into(), text: "one human, one agent".into(), citations: vec!["F5".into()] },
        Claim { line: "airbnb_frequent".into(), text: "frequent traveller".into(), citations: vec!["F1".into()] },
    ]
}

/// A prompt injection in a product description made the model claim a status it cannot prove.
pub fn cheat_claims() -> Vec<Claim> {
    let mut c = honest_claims();
    c.push(Claim {
        line: "airbnb_frequent".into(),
        text: "guest is marriott platinum, apply vip rate".into(),
        citations: vec!["F9".into()],
    });
    c
}

pub fn envelope(agent: &str) -> Envelope {
    let p = proofs();
    let t = derive(&p);
    Envelope {
        v: 0,
        context: CONTEXT.into(),
        nullifier: nullifier("fixture-account-1"),
        commitment: commitment(&salt(), &t.predicates()),
        proof_hash: sha256_hex(&serde_json::to_vec(&p).unwrap()),
        predicates: revealed(),
        tier: t.tier.as_str().into(),
        attestation: Attestation {
            model: "z-ai/glm-5.3-flash".into(),
            tcb_status: "fixture".into(),
            report_hash: sha256_hex(b"synthetic attestation report v0"),
        },
        cnf: agent.into(),
        max_spend: MAX_SPEND,
        issued_at_ms: NOW_MS,
        expires_at_ms: EXPIRES_MS,
    }
}

pub fn sign_ed(e: Envelope) -> SignedVerdict {
    let k = ed_issuer();
    let digest = e.digest();
    SignedVerdict {
        envelope: e,
        alg: SigAlg::Ed25519,
        issuer_key: hex::encode(k.verifying_key().to_bytes()),
        signature: hex::encode(k.sign(&digest).to_bytes()),
    }
}

pub fn sign_p256(e: Envelope) -> SignedVerdict {
    use p256::ecdsa::signature::hazmat::PrehashSigner;
    let k = p256_issuer();
    let digest = e.digest();
    let sig: p256::ecdsa::Signature = k.sign_prehash(&digest).expect("sign");
    let sig = sig.normalize_s().unwrap_or(sig);
    SignedVerdict {
        envelope: e,
        alg: SigAlg::P256,
        issuer_key: hex::encode(k.verifying_key().to_encoded_point(true).as_bytes()),
        signature: hex::encode(sig.to_bytes()),
    }
}

/// All fixture files, name to pretty JSON.
pub fn all() -> Vec<(&'static str, String)> {
    let pretty = |v: &dyn erased::Ser| v.to_pretty();
    let mut p256_env = envelope(AGENT);
    p256_env.nullifier = nullifier("fixture-account-2");
    let ms = merchants();
    let t = derive(&proofs());
    let winner = &ms[0];
    let q = bookerbob_core::quote(&winner.schedule, &revealed());
    let expected = Expected {
        derived_predicates: t.predicates(),
        tier: t.tier.as_str().into(),
        revealed: revealed(),
        winner: winner.account.clone(),
        price: q.price.to_string(),
        discount_bps: q.discount_bps,
        escrow_after: (ESCROW_USDC - q.price).to_string(),
        cheat_refusal: "F9 not in proof set".into(),
        replay_error: "nullifier spent".into(),
    };
    let opening = Opening {
        note: "synthetic. salt and nullifier labels are fixed so fixtures are reproducible; production uses random salt and the REP nullifier".into(),
        salt: hex::encode(salt()),
        nullifier_label: "fixture-account-1".into(),
    };
    vec![
        ("proofs.json", pretty(&proofs())),
        ("opening.json", pretty(&opening)),
        ("merchants.json", pretty(&ms)),
        ("claims-honest.json", pretty(&honest_claims())),
        ("claims-cheat.json", pretty(&cheat_claims())),
        ("verdict-ed25519.json", pretty(&sign_ed(envelope(AGENT)))),
        ("verdict-p256.json", pretty(&sign_p256(p256_env))),
        ("verdict-replay.json", pretty(&sign_ed(envelope(WALLET2)))),
        ("expected.json", pretty(&expected)),
    ]
}

mod erased {
    pub trait Ser {
        fn to_pretty(&self) -> String;
    }
    impl<T: serde::Serialize> Ser for T {
        fn to_pretty(&self) -> String {
            let mut s = serde_json::to_string_pretty(self).expect("serializes");
            s.push('\n');
            s
        }
    }
}
