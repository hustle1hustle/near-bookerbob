use super::*;
use near_sdk::json_types::U128;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

const NOW_MS: u64 = 1_794_000_000_000;
const DEADLINE: u64 = NOW_MS + 600_000;
const BOND: u128 = 5_000_000;
const BUDGET: u128 = 30_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(who: &str, at_ms: u64, deposit: NearToken) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("coalition.testnet")).predecessor_account_id(acc(who)).block_timestamp(at_ms * 1_000_000).attached_deposit(deposit);
    b
}

fn as_caller(who: &str) {
    testing_env!(ctx(who, NOW_MS, NearToken::from_yoctonear(0)).build());
}

fn at(who: &str, at_ms: u64) {
    testing_env!(ctx(who, at_ms, NearToken::from_yoctonear(0)).build());
}

/// A callback, run by the contract itself, with the given promise result.
fn callback(result: PromiseResult) {
    testing_env!(
        ctx("coalition.testnet", NOW_MS, NearToken::from_yoctonear(0)).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn refused(f: impl FnOnce() + std::panic::UnwindSafe, why: &str) {
    let err = std::panic::catch_unwind(f).expect_err("the call should be refused");
    let text = err.downcast_ref::<String>().cloned().or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
    assert!(text.contains(why), "expected `{why}`, got `{text}`");
}

fn legs() -> Vec<Leg> {
    vec![
        Leg { category: "hoodie".into(), max_price: U128(48_000_000) },
        Leg { category: "hotel".into(), max_price: U128(450_000_000) },
        Leg { category: "hoodie".into(), max_price: U128(48_000_000) },
    ]
}

fn proof(merchant: &str) -> Value {
    json!({ "merchant": merchant, "rank": 1, "n": 2, "score_commit": "00", "path": [] })
}

/// A contract with job 0 open and funded by buyer.testnet.
fn funded() -> Coalition {
    as_caller("deployer.testnet");
    let mut c = Coalition::new(acc("dusdc.testnet"), acc("bazaar.testnet"));
    testing_env!(ctx("buyer.testnet", NOW_MS, OPEN_DEPOSIT).build());
    assert_eq!(c.open_job(legs(), U128(BOND), U128(BUDGET), 100, DEADLINE), 0);
    as_caller("dusdc.testnet");
    assert!(matches!(c.ft_on_transfer(acc("buyer.testnet"), U128(BUDGET), json!({ "fund": 0 }).to_string()), PromiseOrValue::Value(U128(0))));
    c
}

fn join_msg(leg: u32, price: u128, proof: Option<Value>) -> String {
    json!({ "join": { "job": 0, "leg": leg, "price": price.to_string(), "proof": proof } }).to_string()
}

/// The bond's ft_on_transfer: None when the join went to the bazaar, Some(refund) when refused at once.
fn send_bond(c: &mut Coalition, member: &str, leg: u32, price: u128, p: Option<Value>, amount: u128) -> Option<u128> {
    as_caller("dusdc.testnet");
    match c.ft_on_transfer(acc(member), U128(amount), join_msg(leg, price, p)) {
        PromiseOrValue::Value(v) => Some(v.0),
        PromiseOrValue::Promise(_) => None,
    }
}

fn admit(c: &mut Coalition, member: &str, leg: u32, price: u128) {
    assert_eq!(send_bond(c, member, leg, price, Some(proof(member)), BOND), None);
    callback(PromiseResult::Successful(b"true".to_vec()));
    assert_eq!(c.on_admit(0, leg, acc(member), U128(BOND)), U128(0));
}

fn record(member: &str, price: u128) -> Vec<u8> {
    json!({ "agent": "buyer-agent.testnet", "spent": true, "paid": true, "disputed": false, "receipt": { "merchant": member, "price": price.to_string() } })
        .to_string()
        .into_bytes()
}

fn deliver(c: &mut Coalition, member: &str, leg: u32, nullifier: &str, rec: Vec<u8>) -> bool {
    as_caller(member);
    let _ = c.deliver(0, leg, nullifier.into());
    callback(PromiseResult::Successful(rec));
    c.on_verdict(0, leg, nullifier.into())
}

#[test]
fn three_members_join_two_deliver_one_is_slashed() {
    let mut c = funded();
    admit(&mut c, "m01.testnet", 0, 40_000_000);
    admit(&mut c, "h05.testnet", 1, 400_000_000);
    admit(&mut c, "m02.testnet", 2, 40_000_000);
    assert!(deliver(&mut c, "m01.testnet", 0, "n1", record("m01.testnet", 36_000_000)));
    assert!(deliver(&mut c, "h05.testnet", 1, "n2", record("h05.testnet", 400_000_000)));
    at("anyone.testnet", DEADLINE);
    assert_eq!(c.finalize(0), "failed");
    // P = 480; the budget: m01 30*40/480 = 2.5, h05 30*400/480 = 25, the buyer 2.5 (m02's share).
    // m02's bond (5): 2.5 to the buyer, 2.5 to the deliverers pro rata 40:400.
    let ev = get_logs().into_iter().find(|l| l.contains("job_finalized")).unwrap();
    let v: Value = serde_json::from_str(&ev["EVENT_JSON:".len()..]).unwrap();
    let d = &v["data"][0];
    assert_eq!(d["delivered"][0]["share"], "2500000");
    assert_eq!(d["delivered"][0]["from_slashed"], "227272");
    assert_eq!(d["delivered"][1]["share"], "25000000");
    assert_eq!(d["delivered"][1]["from_slashed"], "2272727");
    assert_eq!(d["slashed"][0]["member"], "m02.testnet");
    assert_eq!(d["to_buyer"], (2_500_000u128 + 2_500_000 + 1).to_string());
    assert_eq!(c.member(acc("m02.testnet")), MemberRecord { joined: 1, completed: 0, slashed: 1, earned: U128(0), lost: U128(BOND) });
    assert_eq!(c.member(acc("m01.testnet")).completed, 1);
    assert_eq!(c.member(acc("h05.testnet")).earned, U128(25_000_000 + 2_272_727));
    assert_eq!(c.job(0).unwrap().status, "failed");
    refused(
        move || {
            let _ = c.finalize(0);
        },
        "already finalized",
    );
}

#[test]
fn every_leg_delivered_is_complete_and_pays_the_whole_budget() {
    let mut c = funded();
    admit(&mut c, "m01.testnet", 0, 40_000_000);
    admit(&mut c, "h05.testnet", 1, 400_000_000);
    admit(&mut c, "m02.testnet", 2, 40_000_000);
    for (m, l, n) in [("m01.testnet", 0, "n1"), ("h05.testnet", 1, "n2"), ("m02.testnet", 2, "n3")] {
        assert!(deliver(&mut c, m, l, n, record(m, 1)));
    }
    at("anyone.testnet", DEADLINE);
    assert_eq!(c.finalize(0), "complete");
}

#[test]
fn the_split_conserves_the_money() {
    let m = |s: &str| acc(s);
    for (budget, bond, seats) in [
        (30_000_000u128, 5_000_000u128, vec![(m("a.t"), 40_000_000u128, true), (m("b.t"), 400_000_000, true), (m("c.t"), 40_000_000, false)]),
        (7, 3, vec![(m("a.t"), 1, true), (m("b.t"), 2, true), (m("c.t"), 4, true)]),
        (10, 5, vec![(m("a.t"), 3, false), (m("b.t"), 3, false)]),
        (10, 5, vec![]),
        (1_000_001, 999, vec![(m("a.t"), 7, true), (m("b.t"), 11, false), (m("c.t"), 13, true), (m("d.t"), 17, false)]),
    ] {
        let s = settle(budget, bond, &seats);
        let out: u128 = s.buyer + s.delivered.iter().map(|d| d.1 + d.2 + d.3).sum::<u128>();
        assert_eq!(out, budget + bond * seats.len() as u128, "conserved");
        assert_eq!(s.slashed.len(), seats.iter().filter(|x| !x.2).count());
    }
    // No deliverer: the buyer takes the whole budget and every slashed bond.
    assert_eq!(settle(10, 5, &[(m("a.t"), 3, false), (m("b.t"), 3, false)]).buyer, 20);
    // Nobody joined: the budget goes back.
    assert_eq!(settle(10, 5, &[]).buyer, 10);
}

#[test]
fn a_stranger_without_a_proof_is_refused_and_refunded() {
    let mut c = funded();
    assert_eq!(send_bond(&mut c, "stranger.testnet", 0, 40_000_000, None, BOND), Some(BOND));
    assert!(get_logs().iter().any(|l| l.contains("join_refused") && l.contains(REFUSE_NO_PROOF)));
    assert!(c.job(0).unwrap().seats[0].is_none());
}

#[test]
fn a_proof_for_another_leaf_is_refused() {
    let mut c = funded();
    assert_eq!(send_bond(&mut c, "stranger.testnet", 0, 40_000_000, Some(proof("m01.testnet")), BOND), Some(BOND));
    assert!(get_logs().iter().any(|l| l.contains(REFUSE_LEAF)));
}

#[test]
fn low_standing_is_refused_by_the_bazaar_and_the_seat_freed() {
    let mut c = funded();
    assert_eq!(send_bond(&mut c, "h05.testnet", 1, 400_000_000, Some(proof("h05.testnet")), BOND), None);
    assert!(c.job(0).unwrap().seats[1].as_ref().unwrap().pending);
    callback(PromiseResult::Successful(b"false".to_vec()));
    assert_eq!(c.on_admit(0, 1, acc("h05.testnet"), U128(BOND)), U128(BOND));
    assert!(get_logs().iter().any(|l| l.contains("join_refused") && l.contains(REFUSE_LOW)));
    assert!(c.job(0).unwrap().seats[1].is_none());
    // A failed bazaar call refunds too.
    assert_eq!(send_bond(&mut c, "h05.testnet", 1, 400_000_000, Some(proof("h05.testnet")), BOND), None);
    callback(PromiseResult::Failed);
    assert_eq!(c.on_admit(0, 1, acc("h05.testnet"), U128(BOND)), U128(BOND));
    assert_eq!(c.member(acc("h05.testnet")).joined, 0);
}

#[test]
fn double_join_taken_leg_wrong_bond_and_over_max_are_refused() {
    let mut c = funded();
    admit(&mut c, "m01.testnet", 0, 40_000_000);
    assert_eq!(send_bond(&mut c, "m01.testnet", 2, 40_000_000, Some(proof("m01.testnet")), BOND), Some(BOND));
    assert!(get_logs().iter().any(|l| l.contains("already a member of this job")));
    assert_eq!(send_bond(&mut c, "m02.testnet", 0, 40_000_000, Some(proof("m02.testnet")), BOND), Some(BOND));
    assert!(get_logs().iter().any(|l| l.contains("leg taken")));
    assert_eq!(send_bond(&mut c, "m02.testnet", 2, 40_000_000, Some(proof("m02.testnet")), BOND - 1), Some(BOND - 1));
    assert_eq!(send_bond(&mut c, "m02.testnet", 2, 48_000_001, Some(proof("m02.testnet")), BOND), Some(BOND));
    assert!(get_logs().iter().any(|l| l.contains("price above the leg's max")));
}

#[test]
fn an_unfunded_job_takes_no_joins_and_only_its_buyer_funds_it() {
    as_caller("deployer.testnet");
    let mut c = Coalition::new(acc("dusdc.testnet"), acc("bazaar.testnet"));
    testing_env!(ctx("buyer.testnet", NOW_MS, OPEN_DEPOSIT).build());
    c.open_job(legs(), U128(BOND), U128(BUDGET), 50, DEADLINE);
    assert_eq!(send_bond(&mut c, "m01.testnet", 0, 1, Some(proof("m01.testnet")), BOND), Some(BOND));
    as_caller("dusdc.testnet");
    refused(
        move || {
            let _ = c.ft_on_transfer(acc("other.testnet"), U128(BUDGET), json!({ "fund": 0 }).to_string());
        },
        "only the job's buyer",
    );
}

#[test]
fn only_the_token_calls_the_receiver() {
    let mut c = funded();
    as_caller("fake-token.testnet");
    refused(
        move || {
            let _ = c.ft_on_transfer(acc("buyer.testnet"), U128(1), json!({ "fund": 0 }).to_string());
        },
        "only the job token",
    );
}

#[test]
fn deliver_with_someone_elses_receipt_is_refused() {
    let mut c = funded();
    admit(&mut c, "m01.testnet", 0, 40_000_000);
    refused(
        move || {
            let _ = deliver(&mut c, "m01.testnet", 0, "n9", record("m07.testnet", 36_000_000));
        },
        "the receipt names another merchant",
    );
}

#[test]
fn deliver_refusals() {
    let mut c = funded();
    admit(&mut c, "m01.testnet", 0, 40_000_000);
    admit(&mut c, "m02.testnet", 2, 40_000_000);
    let unspent = json!({ "spent": false, "paid": false, "receipt": { "merchant": "m01.testnet", "price": "1" } }).to_string().into_bytes();
    let mut c1 = funded();
    admit(&mut c1, "m01.testnet", 0, 40_000_000);
    refused(
        move || {
            let _ = deliver(&mut c1, "m01.testnet", 0, "n1", unspent);
        },
        "purchase not settled",
    );
    let mut c2 = funded();
    admit(&mut c2, "m01.testnet", 0, 40_000_000);
    refused(
        move || {
            let _ = deliver(&mut c2, "m01.testnet", 0, "n1", record("m01.testnet", 40_000_001));
        },
        "above the member's quote",
    );
    let mut c3 = funded();
    admit(&mut c3, "m01.testnet", 0, 40_000_000);
    refused(
        move || {
            let _ = deliver(&mut c3, "m01.testnet", 0, "n1", b"null".to_vec());
        },
        "unknown nullifier",
    );
    // Not the leg's member.
    as_caller("m02.testnet");
    refused(
        {
            let mut c4 = funded();
            admit(&mut c4, "m01.testnet", 0, 40_000_000);
            as_caller("m02.testnet");
            move || {
                let _ = c4.deliver(0, 0, "n1".into());
            }
        },
        "not this leg's member",
    );
    // One purchase shows one delivery.
    assert!(deliver(&mut c, "m01.testnet", 0, "n1", record("m01.testnet", 1)));
    refused(
        move || {
            let _ = deliver(&mut c, "m02.testnet", 2, "n1", record("m02.testnet", 1));
        },
        "purchase already used",
    );
}

#[test]
fn finalize_before_the_deadline_is_refused() {
    let mut c = funded();
    at("anyone.testnet", DEADLINE - 1);
    refused(
        move || {
            let _ = c.finalize(0);
        },
        "deadline not reached",
    );
}

#[test]
fn no_join_or_delivery_after_the_deadline() {
    let mut c = funded();
    admit(&mut c, "m01.testnet", 0, 40_000_000);
    at("m01.testnet", DEADLINE);
    let mut c2 = funded();
    at("dusdc.testnet", DEADLINE);
    let r = c2.ft_on_transfer(acc("m02.testnet"), U128(BOND), join_msg(2, 1, Some(proof("m02.testnet"))));
    assert!(matches!(r, PromiseOrValue::Value(U128(BOND))));
    at("m01.testnet", DEADLINE);
    refused(
        move || {
            let _ = c.deliver(0, 0, "n1".into());
        },
        "job closed",
    );
}

#[test]
fn open_job_checks_its_arguments() {
    as_caller("deployer.testnet");
    let c = Coalition::new(acc("dusdc.testnet"), acc("bazaar.testnet"));
    let open = |legs: Vec<Leg>, pct: u8, deadline: u64, deposit: NearToken, why: &'static str| {
        let mut c = Coalition {
            token: c.token.clone(),
            bazaar: c.bazaar.clone(),
            next_id: 0,
            jobs: LookupMap::new(b"j"),
            members: LookupMap::new(b"m"),
            used: LookupMap::new(b"u"),
        };
        testing_env!(ctx("buyer.testnet", NOW_MS, deposit).build());
        refused(
            move || {
                let _ = c.open_job(legs, U128(BOND), U128(BUDGET), pct, deadline);
            },
            why,
        );
    };
    open(legs(), 100, DEADLINE, NearToken::from_yoctonear(0), "attach 0.02 NEAR");
    open(vec![], 100, DEADLINE, OPEN_DEPOSIT, "1 to 8 legs");
    open(legs(), 0, DEADLINE, OPEN_DEPOSIT, "min_top_pct");
    open(legs(), 100, NOW_MS - 1, OPEN_DEPOSIT, "deadline in the past");
}
