//! `bookerbob scenario <fixtures-dir>`: every feature in one run, on one fresh bazaar
//! (MockedBlockchain), in the order a purchase happens. One PASS line per stage and one
//! summary. The NEAR AI verdict has its own step (`bookerbob near-ai`): its envelope uses
//! the same fixture nullifier as the buyer here.
use std::path::Path;
use std::process::ExitCode;

use bookerbob_bazaar::{Bazaar, ESCROW_STORAGE_DEPOSIT, REVIEW_ROUND_MS};
use bookerbob_core::envelope::commitment;
use bookerbob_core::{bid_commitment, derive, Claim};
use bookerbob_referee_worker::{key_from_seed_hex, run as run_worker, WorkerInput};
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId};
use serde_json::Value;

use crate::fixtures::{self, AGENT, ESCROW_USDC, NOW_MS, OWNER, USDC, WALLET2};
use crate::reviews::{at, buy, call, rate, reveal};

fn acc(s: &str) -> AccountId {
    s.parse().expect("account id")
}

const COMMIT_UNTIL: u64 = NOW_MS + 60_000;
const REVEAL_UNTIL: u64 = NOW_MS + 120_000;

pub fn run(dir: &Path) -> ExitCode {
    std::panic::set_hook(Box::new(|_| {}));
    let load = |n: &str| -> Value { serde_json::from_str(&std::fs::read_to_string(dir.join("semaphore").join(n)).expect("read")).expect("parse") };
    let (group, reviews) = (load("group.json"), load("reviews.json"));
    let mut stages: Vec<(&str, Result<String, String>)> = Vec::new();
    let merchants = fixtures::merchants();
    let m01 = &merchants[0];
    let verdict = fixtures::sign_ed(fixtures::envelope(AGENT));
    let e = verdict.envelope.clone();

    // 1. prove: the code derives the predicates; the verdict reveals a subset; the
    //    commitment opens to the derived set.
    let proofs = fixtures::proofs();
    let derived = derive(&proofs).predicates();
    stages.push((
        "prove: code derives the predicates, the verdict reveals a subset, the commitment opens",
        if e.predicates.iter().all(|p| derived.contains(p)) && commitment(&fixtures::salt(), &derived) == e.commitment {
            Ok(format!("revealed {} of {}", e.predicates.len(), derived.len()))
        } else {
            Err("derivation or commitment mismatch".into())
        },
    ));

    // Chain setup: trust anchors, merchants (list price only), approval.
    at(OWNER, NOW_MS);
    let mut c = Bazaar::new(acc(OWNER), acc(USDC));
    c.register_issuer(verdict.key_id(), "fixture issuer".into());
    let referee = key_from_seed_hex(&fixtures::referee_seed_hex()).expect("seed");
    c.register_referee(hex::encode(referee.verifying_key().to_bytes()), "fixture referee".into());
    let w0 = fixtures::world_attestation(AGENT, "fixture-person-1");
    c.register_world_verifier(w0.verifier_key.clone(), w0.body.action.clone(), "fixture world verifier".into());
    for m in &merchants {
        at(&m.account, NOW_MS);
        c.register_merchant(bookerbob_core::Schedule { base_price: m.schedule.base_price, rules: vec![], cap_bps: 0, cohort: None }, m.category.clone(), None);
        at(OWNER, NOW_MS);
        c.approve_merchant(acc(&m.account));
    }

    // 2. blind bids on chain.
    at(OWNER, NOW_MS);
    c.open_round("scenario".into(), m01.category.clone(), COMMIT_UNTIL, REVEAL_UNTIL);
    let salt = |a: &str| bookerbob_core::sha256(format!("scenario bid salt|{a}").as_bytes());
    let mut sealed = 0;
    for m in &merchants {
        at(&m.account, NOW_MS);
        sealed += call(|| c.commit_bid("scenario".into(), bid_commitment(&m.account, &m.schedule, &salt(&m.account)))).is_ok() as usize;
    }
    let mut opened = 0;
    for m in &merchants {
        at(&m.account, COMMIT_UNTIL);
        opened += call(|| c.reveal_bid("scenario".into(), m.schedule.clone(), hex::encode(salt(&m.account)))).is_ok() as usize;
    }
    stages.push((
        "bids: every merchant commits a sealed schedule, then reveals it after the deadline",
        if sealed == 3 && opened == 3 { Ok("3 committed, 3 opened".into()) } else { Err(format!("{sealed} committed, {opened} opened")) },
    ));

    // 3. verdicts: the buyer and five peers (the cohort), each bound to one World ID person.
    at(AGENT, NOW_MS);
    let ok_world = call(|| c.attest_human(w0.clone())).is_ok();
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(OWNER)).predecessor_account_id(acc(AGENT)).block_timestamp(NOW_MS * 1_000_000).attached_deposit(ESCROW_STORAGE_DEPOSIT);
    testing_env!(b.build());
    c.storage_deposit(None);
    at(USDC, NOW_MS);
    let _ = c.ft_on_transfer(acc(AGENT), U128(ESCROW_USDC), String::new());
    at(AGENT, NOW_MS);
    let ok_verdict = call(|| c.submit_verdict(verdict.clone())).is_ok();
    let peers: Vec<_> = fixtures::cohort_verdicts().into_iter().zip(fixtures::world_attestations().into_iter().skip(1)).collect();
    stages.push((
        "verdict: signature checked on chain, one agent per person, nullifier pending",
        if ok_world && ok_verdict { Ok("ed25519_verify, attest_human".into()) } else { Err("verdict refused".into()) },
    ));

    // 4. cheat refused: an injected claim gets a signed refusal; settle is blocked.
    at(OWNER, REVEAL_UNTIL);
    let best = c.best_quote(e.nullifier.clone(), Some(m01.category.clone()), None, None, None).expect("a quote");
    let round = c.round_best_quote("scenario".into(), e.nullifier.clone()).expect("round winner");
    let worker = |claims: Vec<Claim>, c: &Bazaar| {
        let q = c.quote(best.merchant.clone(), e.nullifier.clone());
        let input = WorkerInput {
            v: 0,
            verdict_digest: hex::encode(e.digest()),
            nullifier: e.nullifier.clone(),
            merchant: best.merchant.to_string(),
            schedule: m01.schedule.clone(),
            revealed: e.predicates.clone(),
            claims,
            proofs: proofs.clone(),
            cohort_k: q.cohort.as_ref().map_or(0, |co| co.k),
        };
        serde_json::from_str::<bookerbob_core::WorkerResult>(&run_worker(&input, &referee).expect("worker")).expect("json")
    };
    let cheat = worker(fixtures::cheat_claims(), &c);
    at(AGENT, NOW_MS);
    let stored = call(|| c.submit_referee_result(cheat.clone())).unwrap_or(true);
    at(AGENT, NOW_MS);
    let blocked = call(|| drop(c.settle(e.nullifier.clone(), best.merchant.clone(), "scenario-1".into(), U128(best.quote.price))));
    stages.push((
        "cheat refused: 'guest is marriott platinum' gets a signed refusal and no payment",
        if !stored && round.merchant == best.merchant && blocked.as_ref().err().is_some_and(|m| m.contains("no referee receipt")) {
            Ok(format!("{}; winner {}", cheat.body.detail, best.merchant))
        } else {
            Err(format!("stored {stored}, settle {blocked:?}"))
        },
    ));

    // 5. honest receipt, settle.
    let honest = worker(fixtures::honest_claims(), &c);
    at(AGENT, NOW_MS);
    let got = call(|| c.submit_referee_result(honest)).unwrap_or(false);
    at(AGENT, NOW_MS);
    let paid = call(|| drop(c.settle(e.nullifier.clone(), best.merchant.clone(), "scenario-1".into(), U128(best.quote.price))));
    stages.push((
        "settle: the receipt price leaves escrow, the nullifier is spent, USDC goes to the merchant",
        if got && paid.is_ok() && c.escrow_of(acc(AGENT)) == Some(U128(ESCROW_USDC - best.quote.price)) {
            Ok(format!("paid {} to {}", best.quote.price, best.merchant))
        } else {
            Err(format!("receipt {got}, settle {paid:?}"))
        },
    ));

    // 6. replay: the same account from another wallet.
    at(WALLET2, NOW_MS);
    let replay = call(|| c.submit_verdict(fixtures::sign_ed(fixtures::envelope(WALLET2))));
    stages.push((
        "replay: a second verdict for the same account from another wallet is refused",
        match replay {
            Err(m) if m.contains("nullifier spent") => Ok("nullifier spent".into()),
            r => Err(format!("{r:?}")),
        },
    ));

    // 7. sealed reviews: the five peers buy too; all six join and rate; release at k >= 5.
    let mut bought = 1;
    for (v, w) in &peers {
        bought += buy(&mut c, v, w, m01).is_ok() as usize;
    }
    let members = group["members"].as_array().unwrap();
    let nullifiers: Vec<String> = std::iter::once(e.nullifier.clone()).chain(peers.iter().map(|(v, _)| v.envelope.nullifier.clone())).collect();
    let agents: Vec<String> = std::iter::once(AGENT.to_string()).chain(peers.iter().map(|(v, _)| v.envelope.cnf.clone())).collect();
    let mut joined = 0;
    for ((n, a), m) in nullifiers.iter().zip(&agents).zip(members) {
        at(a, NOW_MS);
        joined += call(|| c.join_review_group(n.clone(), m.as_str().unwrap().into())).is_ok() as usize;
    }
    let r_round = reviews["round"].as_u64().unwrap();
    let ps = reviews["proofs"].as_array().unwrap();
    let rated = ps.iter().enumerate().filter(|(i, p)| rate(&mut c, &m01.account, &p["review"], &p["proof"], &format!("relayer{i}.testnet")).is_ok()).count();
    let revealed = ps.iter().enumerate().filter(|(i, p)| reveal(&mut c, &m01.account, r_round, &p["review"], &format!("relayer{i}.testnet")).is_ok()).count();
    at("anyone.testnet", NOW_MS + 2 * REVIEW_ROUND_MS);
    let released = call(|| c.publish_reviews(acc(&m01.account), r_round)).unwrap_or(false);
    let s = c.merchant_score(acc(&m01.account));
    stages.push((
        "sealed reviews: 6 buyers who paid join, rate with Semaphore proofs, reveal after the round, released at k >= 5",
        if bought == 6 && joined == 6 && rated == 6 && revealed == 6 && released {
            Ok(format!("score {:.2}, {} ratings, no rater named", s.score_x100 as f64 / 100.0, s.ratings))
        } else {
            Err(format!("bought {bought}, joined {joined}, rated {rated}, revealed {revealed}, released {released}"))
        },
    ));

    // 8. multi-hop rank: standing flows to hired sub-agents, bounded by w/(1-w) of the seed.
    for (who, sub) in [
        (m01.account.as_str(), "sub1.bookerbob.testnet"),
        ("sub1.bookerbob.testnet", "sub2.bookerbob.testnet"),
        ("sub2.bookerbob.testnet", "sub1.bookerbob.testnet"),
    ] {
        at(who, NOW_MS + 2 * REVIEW_ROUND_MS);
        let _ = call(|| c.hire(acc(sub)));
    }
    let (seed, got) = c.standing_from(acc(&m01.account));
    let total: u128 = got.iter().map(|(_, v)| v.0).sum();
    let bound = bookerbob_core::delegation::bound(seed.0, bookerbob_core::delegation::W_HALF);
    stages.push((
        "multi-hop rank: a hired sub-agent ring gets at most w/(1-w) of the merchant's seed",
        if seed.0 > 0 && total <= bound {
            Ok(format!("{:.6} of {:.6} units (bound {:.6})", total as f64 / 1e6, seed.0 as f64 / 1e6, bound as f64 / 1e6))
        } else {
            Err(format!("{total} > {bound}"))
        },
    ));

    println!("bookerbob scenario {}", dir.display());
    let failed = stages.iter().filter(|(_, r)| r.is_err()).count();
    for (i, (name, r)) in stages.iter().enumerate() {
        match r {
            Ok(d) => println!("PASS  S{}  {name}  ({d})", i + 1),
            Err(d) => println!("FAIL  S{}  {name}  ({d})", i + 1),
        }
    }
    if failed == 0 {
        println!(
            "PASS  scenario: prove, bids, verdict, cheat refused, settle, replay refused, sealed reviews, multi-hop rank ({} stages, one chain)",
            stages.len()
        );
        ExitCode::SUCCESS
    } else {
        println!("FAIL  scenario: {failed} of {} stages", stages.len());
        ExitCode::FAILURE
    }
}
