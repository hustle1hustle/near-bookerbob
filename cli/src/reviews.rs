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

pub(crate) fn at(who: &str, ms: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(OWNER)).predecessor_account_id(acc(who)).block_timestamp(ms * 1_000_000).attached_deposit(RECORD_DEPOSIT);
    testing_env!(b.build());
}

thread_local! {
    /// (method, host Tgas) for each successful call measured here.
    static GAS: std::cell::RefCell<Vec<(&'static str, f64)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Mocked host gas of the call just made in the current context (one context per call).
fn note_gas(method: &'static str) {
    GAS.with(|g| g.borrow_mut().push((method, near_sdk::env::used_gas().as_gas() as f64 / 1e12)));
}

/// Mean host gas per method, for docs/evidence.md.
pub fn gas_table() -> Vec<(&'static str, f64, usize)> {
    GAS.with(|g| {
        let g = g.borrow();
        let mut names: Vec<&'static str> = g.iter().map(|x| x.0).collect();
        names.dedup();
        names.sort();
        names.dedup();
        names
            .iter()
            .map(|n| {
                let v: Vec<f64> = g.iter().filter(|x| x.0 == *n).map(|x| x.1).collect();
                (*n, v.iter().sum::<f64>() / v.len() as f64, v.len())
            })
            .collect()
    })
}

pub(crate) fn call<T>(f: impl FnOnce() -> T) -> Result<T, String> {
    catch_unwind(AssertUnwindSafe(f))
        .map_err(|e| e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default())
}

/// One purchase: World ID binding, escrow, verdict, referee receipt, settle.
pub(crate) fn buy(c: &mut Bazaar, v: &SignedVerdict, world: &bookerbob_core::WorldAttestation, merchant: &fixtures::MerchantFixture) -> Result<(), String> {
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
    call(|| drop(c.settle(e.nullifier.clone(), acc(&merchant.account), format!("review-order-{}", &e.nullifier[..8]), U128(q.price))))?;
    confirm_payout(c, &e.nullifier, &e.cnf, q.price)
}

/// The USDC contract's answer to settle's ft_transfer: success, as the runtime would
/// deliver it to the callback.
pub(crate) fn confirm_payout(c: &mut Bazaar, nullifier: &str, agent: &str, amount: u128) -> Result<(), String> {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(OWNER)).predecessor_account_id(acc(OWNER)).block_timestamp(NOW_MS * 1_000_000);
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![near_sdk::PromiseResult::Successful(vec![])]
    );
    if call(|| c.on_settle_transfer(nullifier.into(), acc(agent), U128(amount)))? {
        Ok(())
    } else {
        Err("payout not confirmed".into())
    }
}

pub(crate) fn proof(p: &Value) -> ReviewProof {
    let pts: Vec<String> = p["points"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().into()).collect();
    ReviewProof {
        depth: p["merkleTreeDepth"].as_u64().unwrap() as u32,
        merkle_root: p["merkleTreeRoot"].as_str().unwrap().into(),
        nullifier: p["nullifier"].as_str().unwrap().into(),
        points: pts.try_into().unwrap(),
    }
}

/// During the round: post the sealed rating with its Semaphore proof, from a relayer.
pub(crate) fn rate(c: &mut Bazaar, merchant: &str, review: &Value, p: &Value, relayer: &str) -> Result<(), String> {
    at(relayer, NOW_MS);
    let r = call(|| c.submit_review(acc(merchant), review["sealed"].as_str().unwrap().into(), proof(p)));
    if r.is_ok() {
        note_gas("submit_review (Groth16 on alt_bn128)");
    }
    r
}

/// After the round: open it, in the reveal window.
pub(crate) fn reveal(c: &mut Bazaar, merchant: &str, round: u64, r: &Value, relayer: &str) -> Result<(), String> {
    at(relayer, NOW_MS + REVIEW_ROUND_MS);
    let r = call(|| {
        c.reveal_review(
            acc(merchant),
            round,
            r["rating"].as_u64().unwrap() as u8,
            r["delivered"].as_bool().unwrap(),
            r["reason_hash"].as_str().unwrap().into(),
            r["salt"].as_str().unwrap().into(),
        )
    });
    if r.is_ok() {
        note_gas("reveal_review");
    }
    r
}

/// `out`: write or (with `check`) compare the public reviews page data.
pub fn run(dir: &Path, out_path: Option<&Path>, check: bool) -> ExitCode {
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
    // m03 sells the same hoodie on m01's schedule and registered first: the prices tie.
    let m03 = fixtures::MerchantFixture {
        account: "m03copy.bookerbob.testnet".into(),
        label: "same schedule as m01".into(),
        category: m01.category.clone(),
        schedule: m01.schedule.clone(),
    };
    for m in [&m03, m01, m02] {
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
                note_gas("join_review_group (LeanIMT insert, Poseidon)");
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
    // Before the real ratings: reviewer 3's proof with another sealed rating.
    let mut changed = proofs[3]["review"].clone();
    changed["sealed"] = bookerbob_core::sha256_hex(b"another rating").into();
    out.push((
        "a sealed rating swapped under a real proof is refused".into(),
        refused(rate(&mut c, &m01.account, &changed, &proofs[3]["proof"], "relayer7.testnet"), "invalid Semaphore proof"),
    ));
    let mut rated = 0;
    for (i, e) in proofs.iter().enumerate() {
        if rate(&mut c, &m01.account, &e["review"], &e["proof"], &format!("relayer{i}.testnet")).is_ok() {
            rated += 1;
        }
    }
    out.push((
        "6 buyers post sealed ratings for m01 with Semaphore proofs (Groth16 on alt_bn128), from relayer accounts".into(),
        if rated == 6 { Ok("6 sealed hashes, no rating on chain yet".into()) } else { Err(format!("{rated} of 6 accepted")) },
    ));
    out.push((
        "a second rating by the same member in the round is refused".into(),
        refused(
            rate(&mut c, &m01.account, &reviews["double_rating"]["review"], &reviews["double_rating"]["proof"], "relayer9.testnet"),
            "already rated this round",
        ),
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
    // After the round: reveals. A reveal that differs from the sealed rating is refused.
    let mut lie = proofs[1]["review"].clone();
    lie["rating"] = 5.into();
    out.push((
        "a reveal that does not open the sealed rating is refused".into(),
        refused(reveal(&mut c, &m01.account, round, &lie, "relayer6.testnet"), "no sealed rating opens to this"),
    ));
    let revealed = proofs.iter().enumerate().filter(|(i, e)| reveal(&mut c, &m01.account, round, &e["review"], &format!("relayer{i}.testnet")).is_ok()).count();
    let small_reveal = reveal(&mut c, &m02.account, round, &small["proofs"][0]["review"], "relayer20.testnet");
    out.push((
        "after the round, m01's members reveal; m02 (4 members) cannot reveal".into(),
        match (revealed, &small_reveal) {
            (6, Err(m)) if m.contains("group below k") => Ok("6 revealed; m02 refused: group below k".into()),
            _ => Err(format!("{revealed} revealed, m02 {small_reveal:?}")),
        },
    ));
    at("anyone.testnet", NOW_MS + 2 * REVIEW_ROUND_MS);
    let released = call(|| c.publish_reviews(acc(&m01.account), round)).unwrap_or(false);
    note_gas("publish_reviews (6 ratings)");
    let s = c.merchant_score(acc(&m01.account));
    out.push((
        "after the reveal window, m01's 6 ratings are released together, sorted by hash (k >= 5)".into(),
        if released && s.ratings == 6 {
            Ok(format!("mean {:.2}, delivered {}%, score {:.2}", s.mean_x100 as f64 / 100.0, s.delivered_pct, s.score_x100 as f64 / 100.0))
        } else {
            Err("not released".into())
        },
    ));
    // Conserved delegation: m01 hires a sub-agent, which spawns a ring of 8 that hire each
    // other and back; an unseeded ring sits next to it.
    let hire = |c: &mut Bazaar, who: &str, sub: &str| {
        at(who, NOW_MS + 2 * REVIEW_ROUND_MS);
        let _ = call(|| c.hire(acc(sub)));
    };
    hire(&mut c, &m01.account, "sub1.bookerbob.testnet");
    for i in 1..=8 {
        hire(&mut c, &format!("sub{i}.bookerbob.testnet"), &format!("sub{}.bookerbob.testnet", i % 8 + 1));
        hire(&mut c, &format!("sub{i}.bookerbob.testnet"), &format!("sub{}.bookerbob.testnet", (i + 2) % 8 + 1));
    }
    hire(&mut c, "sub8.bookerbob.testnet", &m01.account);
    hire(&mut c, "x1.bookerbob.testnet", "x2.bookerbob.testnet");
    hire(&mut c, "x2.bookerbob.testnet", "x1.bookerbob.testnet");
    let (seed, got) = c.standing_from(acc(&m01.account));
    let total: u128 = got.iter().map(|(_, v)| v.0).sum();
    let bound = bookerbob_core::delegation::bound(seed.0, bookerbob_core::delegation::W_HALF);
    out.push((
        "conserved delegation (w = 1/2): a spawned ring of 8 sub-agents gains at most w/(1-w) of m01's seed; an unseeded ring gets nothing".into(),
        if seed.0 > 0 && total <= bound && got.iter().all(|(a, _)| !a.as_str().starts_with('x')) {
            Ok(format!("seed {:.2}, conferred {:.4} on {} accounts, bound {:.2}", seed.0 as f64 / 1e6, total as f64 / 1e6, got.len(), bound as f64 / 1e6))
        } else {
            Err(format!("seed {}, conferred {total}, bound {bound}", seed.0))
        },
    ));
    let delegation = serde_json::json!({ "root": m01.account, "seed_units": seed.0 as f64 / 1e6, "conferred_units": total as f64 / 1e6, "bound_units": bound as f64 / 1e6, "accounts": got.len() });
    // Agents choose agents: on the tie, the reviewed merchant wins; a floor filters.
    let n0 = issuer.envelope.nullifier.clone();
    let pick = |c: &Bazaar, min: Option<u64>| c.best_quote(n0.clone(), Some(m01.category.clone()), None, None, min).map(|q| q.merchant.to_string());
    let (tie, floor) = (pick(&c, None), pick(&c, Some(350)));
    out.push((
        "best_quote: equal price goes to the better-reviewed merchant; min_score filters".into(),
        if tie.as_deref() == Some(m01.account.as_str()) && floor.as_deref() != Some(m01.account.as_str()) && floor.as_deref() != Some(m03.account.as_str()) {
            Ok(format!("tie -> {}, min 3.50 -> {}", m01.account, floor.unwrap_or_else(|| "none".into())))
        } else {
            Err(format!("tie -> {tie:?}, min 3.50 -> {floor:?}"))
        },
    ));
    let held = call(|| c.publish_reviews(acc(&m02.account), round)).unwrap_or(true);
    out.push((
        "m02 has 4 members: its ratings stay sealed (k-floor)".into(),
        if !held && c.reviews(acc(&m02.account), round).is_none() { Ok("held, 4 < 5".into()) } else { Err("released".into()) },
    ));

    // Public page data: what anyone can read from the contract after the round.
    let page = |c: &Bazaar, m: &str| {
        let s = c.merchant_score(acc(m));
        let released = c.reviews(acc(m), round);
        serde_json::json!({
            "merchant": m,
            "members": s.members,
            "round": round,
            "status": if released.is_some() { "released" } else { "sealed (k < 5)" },
            "ratings": released.map(|v| v.iter().map(|r| serde_json::json!({ "rating": r.rating, "delivered": r.delivered, "reason_hash": r.reason_hash })).collect::<Vec<_>>()),
            "mean_x100": s.mean_x100,
            "delivered_pct": s.delivered_pct,
            "score_x100": s.score_x100,
        })
    };
    let data = serde_json::json!({
        "note": "synthetic fixtures; Semaphore v4 proofs verified by the bazaar contract (MockedBlockchain). A rating names no member; ratings are released per round, only with k >= 5 members.",
        "k_min": bookerbob_core::K_MIN,
        "merchants": [page(&c, &m01.account), page(&c, &m02.account)],
        "delegation": delegation,
        "refused": out.iter().filter_map(|(n, r)| r.as_ref().ok().filter(|d| d.starts_with("refused")).map(|d| serde_json::json!({ "case": n, "result": d }))).collect::<Vec<_>>(),
    });
    let body = serde_json::to_string_pretty(&data).unwrap() + "\n";
    if let Some(p) = out_path {
        if check {
            let same = std::fs::read_to_string(p).ok().as_deref() == Some(body.as_str());
            out.push((
                format!("public reviews page data matches {}", p.display()),
                if same { Ok("ok".into()) } else { Err("stale (run make reviews)".into()) },
            ));
        } else {
            std::fs::write(p, &body).expect("write reviews page data");
        }
    }
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
    for (m, g, n) in gas_table() {
        println!("GAS   {m}: {g:.2} Tgas mocked host gas (mean of {n})");
    }
    if failed == 0 {
        println!("PASS  sealed reviews: {} checks", out.len());
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
