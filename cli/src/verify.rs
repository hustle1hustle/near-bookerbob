//! Offline end-to-end: fixtures -> tier -> envelope -> signatures -> contract -> quotes ->
//! referee -> settle -> replay. One PASS/FAIL line per link.
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::process::ExitCode;

use bookerbob_bazaar::{Bazaar, NullifierStatus, ESCROW_STORAGE_DEPOSIT};
use bookerbob_core::envelope::commitment;
use bookerbob_core::{derive, quote, referee, sha256_hex, Claim, ProofSet, RefereeOutcome, SigAlg, SignedVerdict};
use near_sdk::json_types::U128;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId};
use serde::de::DeserializeOwned;

use crate::fixtures::{Expected, MerchantFixture, Opening, ESCROW_USDC, NOW_MS, OWNER, USDC};

struct Report {
    n: usize,
    failed: usize,
}

impl Report {
    fn check(&mut self, ok: bool, what: &str, detail: impl AsRef<str>) -> bool {
        self.n += 1;
        let tag = if ok { "PASS" } else { "FAIL" };
        let d = detail.as_ref();
        if d.is_empty() {
            println!("{tag}  {:02}  {what}", self.n);
        } else {
            println!("{tag}  {:02}  {what}  ({d})", self.n);
        }
        if !ok {
            self.failed += 1;
        }
        ok
    }
}

fn load<T: DeserializeOwned>(dir: &Path, name: &str) -> T {
    let path = dir.join(name);
    let s = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&s).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

fn acc(s: &str) -> AccountId {
    s.parse().expect("account id")
}

fn as_caller(predecessor: &str, deposit: Option<near_sdk::NearToken>) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(OWNER)).predecessor_account_id(acc(predecessor)).block_timestamp(NOW_MS * 1_000_000);
    if let Some(d) = deposit {
        b.attached_deposit(d);
    }
    testing_env!(b.build());
}

/// Run a contract call, turning a contract panic into Err(message).
fn call<R>(f: impl FnOnce() -> R) -> Result<R, String> {
    catch_unwind(AssertUnwindSafe(f)).map_err(|e| {
        e.downcast_ref::<String>()
            .cloned()
            .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_else(|| "panic".into())
    })
}

fn verify_offchain(v: &SignedVerdict) -> bool {
    let digest = v.envelope.digest();
    let (Ok(sig), Ok(key)) = (hex::decode(&v.signature), hex::decode(&v.issuer_key)) else { return false };
    match v.alg {
        SigAlg::Ed25519 => {
            use ed25519_dalek::{Signature, Verifier, VerifyingKey};
            let (Ok(sig), Ok(key)) = (<[u8; 64]>::try_from(sig.as_slice()), <[u8; 32]>::try_from(key.as_slice())) else { return false };
            VerifyingKey::from_bytes(&key).is_ok_and(|k| k.verify(&digest, &Signature::from_bytes(&sig)).is_ok())
        }
        SigAlg::P256 => {
            use p256::ecdsa::signature::hazmat::PrehashVerifier;
            use p256::ecdsa::{Signature, VerifyingKey};
            let (Ok(k), Ok(s)) = (VerifyingKey::from_sec1_bytes(&key), Signature::from_slice(&sig)) else { return false };
            k.verify_prehash(&digest, &s).is_ok()
        }
    }
}

pub fn run(dir: &Path) -> ExitCode {
    // Contract panics are expected in some links; keep their default stderr noise out.
    std::panic::set_hook(Box::new(|_| {}));
    let mut r = Report { n: 0, failed: 0 };

    let proofs: ProofSet = load(dir, "proofs.json");
    let opening: Opening = load(dir, "opening.json");
    let merchants: Vec<MerchantFixture> = load(dir, "merchants.json");
    let honest: Vec<Claim> = load(dir, "claims-honest.json");
    let cheat: Vec<Claim> = load(dir, "claims-cheat.json");
    let v_ed: SignedVerdict = load(dir, "verdict-ed25519.json");
    let v_p256: SignedVerdict = load(dir, "verdict-p256.json");
    let v_replay: SignedVerdict = load(dir, "verdict-replay.json");
    let exp: Expected = load(dir, "expected.json");
    let e = &v_ed.envelope;
    println!("bookerbob verify: {} (synthetic fixtures, offline)", dir.display());

    // --- proof set and tier (code, not model) ---
    let ph = sha256_hex(&serde_json::to_vec(&proofs).unwrap());
    r.check(ph == e.proof_hash, "proof set hash matches envelope.proof_hash", &ph[..16]);
    let t = derive(&proofs);
    r.check(
        t.predicates() == exp.derived_predicates && t.tier.as_str() == exp.tier && e.tier == exp.tier,
        "tier derived by code from proven fields",
        format!("{} -> {}", t.predicates().join(","), t.tier.as_str()),
    );
    r.check(
        e.predicates.iter().all(|p| t.predicates().contains(p)) && e.predicates == exp.revealed,
        "revealed predicates are a subset of derived",
        format!("revealed {} of {}", e.predicates.len(), t.derived.len()),
    );
    let salt: [u8; 32] = hex::decode(&opening.salt).unwrap().try_into().unwrap();
    r.check(commitment(&salt, &t.predicates()) == e.commitment, "commitment opens to the derived set", "");

    // --- envelope and signatures ---
    r.check(e.validate().is_ok() && v_p256.envelope.validate().is_ok(), "envelope v0 well formed", "");
    r.check(verify_offchain(&v_ed), "ed25519 signature verifies off-chain (ed25519-dalek)", "");
    r.check(verify_offchain(&v_p256), "p256 signature verifies off-chain (RustCrypto p256)", "");

    // --- contract, MockedBlockchain ---
    as_caller(OWNER, None);
    let mut c = Bazaar::new(acc(OWNER), acc(USDC));
    c.register_issuer(v_ed.key_id(), "fixture ed25519 issuer".into());
    c.register_issuer(v_p256.key_id(), "fixture p256 issuer".into());
    for m in &merchants {
        as_caller(&m.account, None);
        c.register_merchant(m.schedule.clone(), None);
    }
    as_caller(&e.cnf, Some(ESCROW_STORAGE_DEPOSIT));
    c.storage_deposit(None);
    as_caller(USDC, None);
    let _ = c.ft_on_transfer(acc(&e.cnf), U128(ESCROW_USDC), String::new());
    r.check(
        c.escrow_of(acc(&e.cnf)) == Some(U128(ESCROW_USDC)) && c.merchants(None, None).len() == merchants.len(),
        "contract set up: 2 enclave keys, merchants, escrow",
        format!("{} merchants, escrow {} USDC base units", merchants.len(), ESCROW_USDC),
    );

    as_caller(&e.cnf, None);
    let sub = call(|| c.submit_verdict(v_ed.clone()));
    r.check(
        sub.is_ok() && c.nullifier_status(e.nullifier.clone()) == NullifierStatus::Pending,
        "contract accepts ed25519 verdict (env::ed25519_verify), nullifier pending",
        sub.err().unwrap_or_default(),
    );
    as_caller(&v_p256.envelope.cnf, None);
    let sub = call(|| c.submit_verdict(v_p256.clone()));
    r.check(sub.is_ok(), "contract accepts p256 verdict (env::p256_verify, low-S)", sub.err().unwrap_or_default());

    // --- quotes ---
    let best = c.best_quote(e.nullifier.clone()).expect("a quote");
    let offchain_ok = merchants.iter().all(|m| quote(&m.schedule, &e.predicates) == c.quote(acc(&m.account), e.nullifier.clone()));
    r.check(offchain_ok, "on-chain quotes equal the core library, every merchant", "");
    r.check(
        best.merchant.as_str() == exp.winner && best.quote.price.to_string() == exp.price && best.quote.discount_bps == exp.discount_bps,
        "winner and price are code-computed",
        format!("{} at {} after {} bps", best.merchant, best.quote.price, best.quote.discount_bps),
    );

    // --- referee ---
    let honest_out = referee(&proofs, &e.predicates, &best.quote, &honest);
    r.check(honest_out.is_receipt(), "referee: honest cited claims get a receipt", "");
    let cheat_out = referee(&proofs, &e.predicates, &best.quote, &cheat);
    r.check(
        cheat_out == RefereeOutcome::Refused { reason: exp.cheat_refusal.clone() },
        "referee: injected claim refuses the receipt",
        match &cheat_out {
            RefereeOutcome::Refused { reason } => reason.clone(),
            RefereeOutcome::Receipt { .. } => "receipt issued".into(),
        },
    );

    // --- settle ---
    as_caller(&e.cnf, None);
    // A near-sdk Promise is scheduled when dropped, as at the end of a real call.
    let settled = call(|| drop(c.settle(e.nullifier.clone(), best.merchant.clone(), "fixture-order-1".into(), U128(best.quote.price))));
    let logs = get_logs();
    let ft_receipt = near_sdk::test_utils::get_created_receipts().iter().any(|rc| {
        rc.receiver_id.as_str() == USDC
            && rc.actions.iter().any(|a| matches!(a, near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. } if method_name == b"ft_transfer"))
    });
    r.check(
        settled.is_ok()
            && c.nullifier_status(e.nullifier.clone()) == NullifierStatus::Spent
            && c.escrow_of(acc(&e.cnf)).map(|b| b.0.to_string()) == Some(exp.escrow_after.clone())
            && logs.iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"event\":\"settled\""))
            && ft_receipt,
        "settle: escrow debited, nullifier burned, NEP-297 settled event, ft_transfer scheduled",
        settled.err().unwrap_or_else(|| format!("escrow left {}", exp.escrow_after)),
    );

    // --- replay ---
    as_caller(&v_replay.envelope.cnf, None);
    let replay = call(|| c.submit_verdict(v_replay.clone()));
    let msg = replay.err().unwrap_or_else(|| "accepted".into());
    r.check(
        msg.contains(&exp.replay_error) && v_replay.envelope.nullifier == e.nullifier && v_replay.envelope.cnf != e.cnf,
        "same proof from another wallet is rejected",
        exp.replay_error.clone(),
    );
    as_caller(&e.cnf, None);
    let again = call(|| drop(c.settle(e.nullifier.clone(), best.merchant.clone(), "fixture-order-2".into(), U128(best.quote.price))));
    r.check(
        again.as_ref().err().is_some_and(|m| m.contains("nullifier spent")) && c.spent_count() == 1,
        "second settle on the same nullifier is rejected",
        "",
    );

    println!();
    if r.failed == 0 {
        println!("ALL PASS ({} checks)", r.n);
        ExitCode::SUCCESS
    } else {
        println!("FAILED {} of {} checks", r.failed, r.n);
        ExitCode::FAILURE
    }
}
