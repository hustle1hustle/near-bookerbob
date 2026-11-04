//! `bookerbob reviews <fixtures-dir>`: sealed reviews end to end on the bazaar contract
//! (MockedBlockchain). Every member joins through a real purchase: verdict, referee
//! receipt from the worker, USDC escrow, `settle`. Then Semaphore v4 proofs
//! (fixtures/semaphore, made by semaphore/gen-fixtures.mjs) rate the merchant.
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::process::ExitCode;

use bookerbob_bazaar::{Bazaar, ReviewProof, ESCROW_STORAGE_DEPOSIT, RECORD_DEPOSIT, REVIEW_ROUND_MS};
use bookerbob_core::{Claim, SignedVerdict};
use bookerbob_referee_worker::{key_from_seed_hex, run as run_worker, WorkerInput};
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId};
use serde_json::Value;

use crate::fixtures::{self, ESCROW_USDC, NOW_MS, OWNER, USDC};

fn acc(s: &str) -> AccountId {
    s.parse().expect("account id")
}

fn at(who: &str, ms: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(OWNER)).predecessor_account_id(acc(who)).block_timestamp(ms * 1_000_000).attached_deposit(RECORD_DEPOSIT);
    testing_env!(b.build());
}

fn call<T>(f: impl FnOnce() -> T) -> Result<T, String> {
    catch_unwind(AssertUnwindSafe(f))
        .map_err(|e| e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default())
}

/// One purchase: World ID binding, escrow, verdict, referee receipt, settle.
fn buy(c: &mut Bazaar, v: &SignedVerdict, world: &bookerbob_core::WorldAttestation, merchant: &fixtures::MerchantFixture) -> Result<(), String> {
    let e = &v.envelope;
    at(&e.cnf, NOW_MS);
    call(|| c.attest_human(world.clone()))?;
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(OWNER)).predecessor_account_id(acc(&e.cnf)).block_timestamp(NOW_MS * 1_000_000).attached_deposit(ESCROW_STORAGE_DEPOSIT);
    testing_env!(b.build());
    c.storage_deposit(None);
    at(USDC, NOW_MS);
    let _ = c.ft_on_transfer(acc(&e.cnf), U128(ESCROW_USDC), String::new());
    at(&e.cnf, NOW_MS);
    call(|| c.submit_verdict(v.clone()))?;
    let q = c.quote(acc(&merchant.account), e.nullifier.clone());
    let claims: Vec<Claim> = fixtures::honest_claims().into_iter().filter(|cl| e.predicates.contains(&cl.line)).collect();
    let cohort_k = q.cohort.as_ref().map_or(0, |co| co.k);
    let input = WorkerInput {
        v: 0,
        verdict_digest: hex::encode(e.digest()),
        nullifier: e.nullifier.clone(),
        merchant: merchant.account.clone(),
        schedule: merchant.schedule.clone(),
        revealed: e.predicates.clone(),
        claims,
        proofs: fixtures::proofs(),
        cohort_k,
    };
    let key = key_from_seed_hex(&fixtures::referee_seed_hex()).expect("seed");
    let result = serde_json::from_str(&run_worker(&input, &key)?).map_err(|x| x.to_string())?;
    at(&e.cnf, NOW_MS);
    if !call(|| c.submit_referee_result(result))? {
        return Err("no receipt".into());
    }
    at(&e.cnf, NOW_MS);
    call(|| drop(c.settle(e.nullifier.clone(), acc(&merchant.account), format!("review-order-{}", &e.nullifier[..8]), U128(q.price))))
}

fn proof(p: &Value) -> ReviewProof {
    let pts: Vec<String> = p["points"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().into()).collect();
    ReviewProof {
        depth: p["merkleTreeDepth"].as_u64().unwrap() as u32,
        merkle_root: p["merkleTreeRoot"].as_str().unwrap().into(),
        nullifier: p["nullifier"].as_str().unwrap().into(),
        points: pts.try_into().unwrap(),
    }
}

fn rate(c: &mut Bazaar, merchant: &str, review: &Value, p: &Value, relayer: &str) -> Result<(), String> {
    at(relayer, NOW_MS);
    call(|| {
        c.submit_review(
            acc(merchant),
            review["rating"].as_u64().unwrap() as u8,
            review["delivered"].as_bool().unwrap(),
            review["reason_hash"].as_str().unwrap().into(),
            proof(p),
        )
    })
}

pub fn run(dir: &Path) -> ExitCode {
    std::panic::set_hook(Box::new(|_| {}));
    let load = |n: &str| -> Value { serde_json::from_str(&std::fs::read_to_string(dir.join("semaphore").join(n)).expect("read")).expect("parse") };
    let (group, reviews, small) = (load("group.json"), load("reviews.json"), load("reviews-small-group.json"));
    let merchants = fixtures::merchants();
    let (m01, m02) = (&merchants[0], &merchants[1]);
    let mut out: Vec<(String, Result<String, String>)> = Vec::new();

    at(OWNER, NOW_MS);
    let mut c = Bazaar::new(acc(OWNER), acc(USDC));
    let issuer = fixtures::sign_ed(fixtures::envelope(fixtures::AGENT));
    c.register_issuer(issuer.key_id(), "fixture issuer".into());
    let referee = key_from_seed_hex(&fixtures::referee_seed_hex()).expect("seed");
    c.register_referee(hex::encode(referee.verifying_key().to_bytes()), "fixture referee".into());
    let w0 = fixtures::world_attestation(fixtures::AGENT, "fixture-person-1");
    c.register_world_verifier(w0.verifier_key.clone(), w0.body.action.clone(), "fixture world verifier".into());
    for m in [m01, m02] {
        at(&m.account, NOW_MS);
        c.register_merchant(m.schedule.clone(), m.category.clone(), None);
        at(OWNER, NOW_MS);
        c.approve_merchant(acc(&m.account));
    }

    // Six buyers of m01: the fixture agent and the five cohort peers, in reviewer order.
    let mut m01_buyers: Vec<(SignedVerdict, bookerbob_core::WorldAttestation)> = vec![(issuer.clone(), w0.clone())];
    m01_buyers.extend(fixtures::cohort_verdicts().into_iter().zip(fixtures::world_attestations().into_iter().skip(1)));
    // Four buyers of m02 for the k-floor case.
    let m02_buyers: Vec<(SignedVerdict, bookerbob_core::WorldAttestation)> = (0..4)
        .map(|i| {
            let agent = format!("m02buyer{i}.bookerbob.testnet");
            let mut e = fixtures::envelope(&agent);
            e.nullifier = fixtures::nullifier(&format!("reviews-m02-{i}"));
            (fixtures::sign_ed(e), fixtures::world_attestation(&agent, &format!("fixture-person-m02-{i}")))
        })
        .collect();
    let mut bought = 0;
    let mut joined = 0;
    let members = group["members"].as_array().unwrap();
    let small_members = small["members"].as_array().unwrap();
    for (list, merchant, commitments) in [(&m01_buyers, m01, members), (&m02_buyers, m02, small_members)] {
        for ((v, w), commitment) in list.iter().zip(commitments) {
            if let Err(e) = buy(&mut c, v, w, merchant) {
                out.push((format!("purchase by {}", v.envelope.cnf), Err(e)));
                continue;
            }
            bought += 1;
            at(&v.envelope.cnf, NOW_MS);
            if call(|| c.join_review_group(v.envelope.nullifier.clone(), commitment.as_str().unwrap().into())).is_ok() {
                joined += 1;
            }
        }
    }
    let root = c.review_group(acc(&m01.account)).map(|g| g.tree.root).unwrap_or_default();
    out.push((
        "10 settled purchases join their merchant's Semaphore group; the contract's root equals the JS group's".into(),
        if bought == 10 && joined == 10 && root == group["roots_after_each_insert"].as_array().unwrap().last().unwrap().as_str().unwrap() {
            Ok(format!("m01: 6 members, m02: 4, root {}..", &root[..12]))
        } else {
            Err(format!("bought {bought}, joined {joined}"))
        },
    ));

    let proofs = reviews["proofs"].as_array().unwrap();
    let refused = |r: Result<(), String>, want: &str| match r {
        Err(m) if m.contains(want) => Ok(format!("refused: {want}")),
        Err(m) => Err(format!("refused for another reason: {m}")),
        Ok(()) => Err("accepted".into()),
    };
    // Before the real ratings: reviewer 3's proof with a different rating.
    let mut changed = proofs[3]["review"].clone();
    changed["rating"] = 5.into();
    out.push((
        "a rating changed under a real proof is refused".into(),
        refused(rate(&mut c, &m01.account, &changed, &proofs[3]["proof"], "relayer7.testnet"), "invalid Semaphore proof"),
    ));
    let mut rated = 0;
    for (i, e) in proofs.iter().enumerate() {
        if rate(&mut c, &m01.account, &e["review"], &e["proof"], &format!("relayer{i}.testnet")).is_ok() {
            rated += 1;
        }
    }
    out.push((
        "6 buyers rate m01 with Semaphore proofs (Groth16 on alt_bn128), sent from relayer accounts".into(),
        if rated == 6 { Ok("6 sealed".into()) } else { Err(format!("{rated} of 6 accepted")) },
    ));
    let double_review = serde_json::json!({ "rating": 1, "delivered": false, "reason_hash": bookerbob_core::sha256_hex(b"changed my mind") });
    out.push((
        "a second rating by the same member in the round is refused".into(),
        refused(rate(&mut c, &m01.account, &double_review, &reviews["double_rating"], "relayer9.testnet"), "already rated this round"),
    ));
    out.push((
        "a valid proof from outside the group is refused".into(),
        refused(rate(&mut c, &m01.account, &proofs[0]["review"], &reviews["non_member"], "relayer8.testnet"), "proof is not for this merchant's group"),
    ));
    let round = reviews["round"].as_u64().unwrap();
    out.push((
        "ratings stay sealed while the round is open".into(),
        if c.reviews(acc(&m01.account), round).is_none() { Ok("reviews(m01) = none".into()) } else { Err("visible".into()) },
    ));
    for (i, e) in small["proofs"].as_array().unwrap().iter().enumerate() {
        let _ = rate(&mut c, &m02.account, &e["review"], &e["proof"], &format!("relayer{}.testnet", 20 + i));
    }
    at("anyone.testnet", NOW_MS + REVIEW_ROUND_MS);
    let released = call(|| c.publish_reviews(acc(&m01.account), round)).unwrap_or(false);
    let s = c.merchant_score(acc(&m01.account));
    out.push((
        "after the round closes, m01's 6 ratings are released together (k >= 5)".into(),
        if released && s.ratings == 6 {
            Ok(format!("mean {:.2}, delivered {}%, score {:.2}", s.mean_x100 as f64 / 100.0, s.delivered_pct, s.score_x100 as f64 / 100.0))
        } else {
            Err("not released".into())
        },
    ));
    let held = call(|| c.publish_reviews(acc(&m02.account), round)).unwrap_or(true);
    out.push((
        "m02 has 4 members: its ratings stay sealed (k-floor)".into(),
        if !held && c.reviews(acc(&m02.account), round).is_none() { Ok("held, 4 < 5".into()) } else { Err("released".into()) },
    ));

    println!("bookerbob reviews {}", dir.display());
    let mut failed = 0;
    for (i, (name, r)) in out.iter().enumerate() {
        match r {
            Ok(d) => println!("PASS  R{}  {name}  ({d})", i + 1),
            Err(d) => {
                failed += 1;
                println!("FAIL  R{}  {name}  ({d})", i + 1)
            }
        }
    }
    if failed == 0 {
        println!("PASS  sealed reviews: {} checks", out.len());
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
