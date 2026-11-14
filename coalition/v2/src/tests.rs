use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

const NOW_MS: u64 = 1_794_000_000_000;
const DEADLINE: u64 = NOW_MS + 3_600_000;
const BOND: u128 = 5_000_000;
const BUDGET: u128 = 30_000_000;
const AGENT: &str = "buyer-agent.testnet";

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

/// A callback, run by the contract itself, with the given promise results.
fn callback_at(at_ms: u64, results: Vec<PromiseResult>) {
    testing_env!(
        ctx("coalition.testnet", at_ms, NearToken::from_yoctonear(0)).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn callback(results: Vec<PromiseResult>) {
    callback_at(NOW_MS, results)
}

fn ok(v: Value) -> PromiseResult {
    PromiseResult::Successful(v.to_string().into_bytes())
}

fn refused(f: impl FnOnce() + std::panic::UnwindSafe, why: &str) {
    let err = std::panic::catch_unwind(f).expect_err("the call should be refused");
    let text = err.downcast_ref::<String>().cloned().or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
    assert!(text.contains(why), "expected `{why}`, got `{text}`");
}

fn legs() -> Vec<Leg> {
    vec![
        Leg { category: "hoodie".into(), max_price: U128(48_000_000) },
        Leg { category: "hotel-lisbon".into(), max_price: U128(450_000_000) },
        Leg { category: "hoodie".into(), max_price: U128(48_000_000) },
    ]
}

fn category_of(member: &str) -> &'static str {
    if member.starts_with('h') {
        "hotel-lisbon"
    } else {
        "hoodie"
    }
}

fn merchant_rec(member: &str) -> Value {
    json!({ "payout": member, "category": category_of(member), "approved": true, "schedule": {} })
}

fn proof(merchant: &str) -> Value {
    json!({ "merchant": merchant, "rank": 1, "n": 2, "score_commit": "00", "path": [] })
}

fn fresh() -> Coalition {
    as_caller("deployer.testnet");
    Coalition::new(acc("dusdc.testnet"), acc("bazaar.testnet"))
}

/// A contract with job 0 open and funded by buyer.testnet, its buyer agent buyer-agent.testnet.
fn funded() -> Coalition {
    let mut c = fresh();
    testing_env!(ctx("buyer.testnet", NOW_MS, OPEN_DEPOSIT).build());
    assert_eq!(c.open_job(legs(), U128(BOND), U128(BUDGET), 100, DEADLINE, Some(vec![acc(AGENT)])), 0);
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
    callback(vec![ok(json!(true)), ok(merchant_rec(member))]);
    assert_eq!(c.on_admit(0, leg, acc(member), U128(BOND)), U128(0));
}

fn record(agent: &str, member: &str, price: u128, spent: bool) -> Value {
    json!({ "agent": agent, "spent": spent, "paid": spent, "disputed": false, "receipt": { "merchant": member, "price": price.to_string() } })
}

fn announce(c: &mut Coalition, leg: u32, nullifier: &str, rec: Value) -> bool {
    as_caller(AGENT);
    let _ = c.announce(0, leg, nullifier.into());
    callback(vec![ok(rec)]);
    c.on_announce(0, leg, nullifier.into())
}

fn deliver(c: &mut Coalition, leg: u32, nullifier: &str, rec: Value) -> bool {
    as_caller("anyone.testnet");
    let _ = c.deliver(0, leg, nullifier.into());
    callback(vec![ok(rec)]);
    c.on_verdict(0, leg, nullifier.into())
}

/// Announce while unspent, then deliver once spent: the normal path.
fn buy_and_deliver(c: &mut Coalition, member: &str, leg: u32, nullifier: &str, price: u128) {
    assert!(announce(c, leg, nullifier, record(AGENT, member, price, false)));
    assert!(deliver(c, leg, nullifier, record(AGENT, member, price, true)));
}

fn finalized(c: &mut Coalition, at_ms: u64) -> Value {
    at("anyone.testnet", at_ms);
    let _ = c.finalize(0);
    let ev = get_logs().into_iter().find(|l| l.contains("job_finalized")).unwrap();
    let v: Value = serde_json::from_str(&ev["EVENT_JSON:".len()..]).unwrap();
    assert_eq!(v["standard"], STANDARD);
    assert_eq!(v["version"], VERSION);
    v["data"][0].clone()
}

#[test]
fn three_members_join_two_deliver_one_is_slashed() {
    let mut c = funded();
    admit(&mut c, "m01.testnet", 0, 40_000_000);
    admit(&mut c, "h05.testnet", 1, 400_000_000);
    admit(&mut c, "m02.testnet", 2, 40_000_000);
    buy_and_deliver(&mut c, "m01.testnet", 0, "n1", 36_000_000);
    buy_and_deliver(&mut c, "h05.testnet", 1, "n2", 400_000_000);
    // A purchase from m02 was announced and never delivered: m02 is a no-show.
    assert!(announce(&mut c, 2, "n3", record(AGENT, "m02.testnet", 40_000_000, false)));
    let d = finalized(&mut c, DEADLINE);
    assert_eq!(d["status"], "failed");
    // P = 480; the budget: m01 30*40/480 = 2.5, h05 30*400/480 = 25, the buyer 2.5 (m02's share).
    // m02's bond (5): 2.5 to the buyer, 2.5 to the deliverers pro rata 40:400.
    assert_eq!(d["delivered"][0]["share"], "2500000");
    assert_eq!(d["delivered"][0]["from_slashed"], "227272");
    assert_eq!(d["delivered"][1]["share"], "25000000");
    assert_eq!(d["delivered"][1]["from_slashed"], "2272727");
    assert_eq!(d["slashed"][0]["member"], "m02.testnet");
    assert_eq!(d["to_buyer"], (2_500_000u128 + 2_500_000 + 1).to_string());
    assert_eq!(c.member(acc("m02.testnet")), MemberRecord { joined: 1, completed: 0, slashed: 1, released: 0, earned: U128(0), lost: U128(BOND) });
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
fn a_leg_the_buyer_never_bought_is_released_not_slashed() {
    let mut c = funded();
    admit(&mut c, "m01.testnet", 0, 40_000_000);
    admit(&mut c, "h05.testnet", 1, 400_000_000);
    buy_and_deliver(&mut c, "m01.testnet", 0, "n1", 36_000_000);
    let d = finalized(&mut c, DEADLINE);
    assert!(d["slashed"].as_array().unwrap().is_empty());
    assert_eq!(d["released"][0]["member"], "h05.testnet");
    assert_eq!(d["released"][0]["bond_back"], BOND.to_string());
    // P = 440: m01 30*40/440, the rest of the budget back to the buyer; no bond to the buyer.
    let share = BUDGET * 40 / 440;
    assert_eq!(d["delivered"][0]["share"], share.to_string());
    assert_eq!(d["to_buyer"], (BUDGET - share).to_string());
    assert_eq!(c.member(acc("h05.testnet")), MemberRecord { joined: 1, released: 1, ..Default::default() });
}

#[test]
fn every_leg_delivered_is_complete_and_pays_the_whole_budget() {
    let mut c = funded();
    admit(&mut c, "m01.testnet", 0, 40_000_000);
    admit(&mut c, "h05.testnet", 1, 400_000_000);
    admit(&mut c, "m02.testnet", 2, 40_000_000);
    for (m, l, n) in [("m01.testnet", 0, "n1"), ("h05.testnet", 1, "n2"), ("m02.testnet", 2, "n3")] {
        buy_and_deliver(&mut c, m, l, n, 1);
    }
    at("anyone.testnet", DEADLINE);
    assert_eq!(c.finalize(0), "complete");
}

#[test]
fn the_split_conserves_the_money() {
    use Outcome::*;
    let m = |s: &str| acc(s);
    for (budget, bond, seats) in [
        (30_000_000u128, 5_000_000u128, vec![(m("a.t"), 40_000_000u128, Delivered), (m("b.t"), 400_000_000, Delivered), (m("c.t"), 40_000_000, NoShow)]),
        (7, 3, vec![(m("a.t"), 1, Delivered), (m("b.t"), 2, Delivered), (m("c.t"), 4, Delivered)]),
        (10, 5, vec![(m("a.t"), 3, NoShow), (m("b.t"), 3, Unoffered)]),
        (10, 5, vec![]),
        (1_000_001, 999, vec![(m("a.t"), 7, Delivered), (m("b.t"), 11, NoShow), (m("c.t"), 13, Unoffered), (m("d.t"), 17, NoShow)]),
        (MAX_AMOUNT, MAX_AMOUNT, vec![(m("a.t"), MAX_AMOUNT, Delivered), (m("b.t"), MAX_AMOUNT, NoShow)]),
    ] {
        let s = settle(budget, bond, &seats);
        let out: u128 = s.buyer + s.delivered.iter().map(|d| d.1 + d.2 + d.3).sum::<u128>() + s.released.iter().map(|r| r.1).sum::<u128>();
        assert_eq!(out, budget + bond * seats.len() as u128, "conserved");
        assert_eq!(s.slashed.len(), seats.iter().filter(|x| x.2 == NoShow).count());
    }
    // No deliverer: the buyer takes the whole budget and every slashed bond.
    assert_eq!(settle(10, 5, &[(m("a.t"), 3, NoShow), (m("b.t"), 3, NoShow)]).buyer, 20);
    // A released seat never pays the buyer a bond.
    assert_eq!(settle(10, 5, &[(m("a.t"), 3, Unoffered)]).buyer, 10);
    assert_eq!(settle(10, 5, &[]).buyer, 10);
}

#[test]
fn a_purchase_by_an_agent_the_job_does_not_allow_is_refused() {
    // HIGH 1: a member buying from itself (or any account the buyer did not name) cannot deliver.
    let mut c = funded();
    admit(&mut c, "m01.testnet", 0, 40_000_000);
    refused(
        move || {
            let _ = announce(&mut c, 0, "n1", record("m01.testnet", "m01.testnet", 36_000_000, false));
        },
        REFUSE_BUYER,
    );
    // The default buyer set is the caller alone.
    let mut c2 = fresh();
    testing_env!(ctx("buyer.testnet", NOW_MS, OPEN_DEPOSIT).build());
    c2.open_job(legs(), U128(BOND), U128(BUDGET), 100, DEADLINE, None);
    assert_eq!(c2.job(0).unwrap().buyers, vec![acc("buyer.testnet")]);
}

#[test]
fn a_purchase_spent_before_it_was_announced_is_refused() {
    let mut c = funded();
    admit(&mut c, "m01.testnet", 0, 40_000_000);
    refused(
        move || {
            let _ = announce(&mut c, 0, "n1", record(AGENT, "m01.testnet", 36_000_000, true));
        },
        REFUSE_SPENT,
    );
}

#[test]
fn only_the_buyer_or_its_agents_announce() {
    let mut c = funded();
    admit(&mut c, "m01.testnet", 0, 40_000_000);
    as_caller("m01.testnet");
    refused(
        move || {
            let _ = c.announce(0, 0, "n1".into());
        },
        REFUSE_ANNOUNCER,
    );
}

#[test]
fn deliver_needs_the_announced_purchase() {
    let mut c = funded();
    admit(&mut c, "m01.testnet", 0, 40_000_000);
    as_caller("m01.testnet");
    refused(
        {
            let mut c = funded();
            admit(&mut c, "m01.testnet", 0, 40_000_000);
            as_caller("m01.testnet");
            move || {
                let _ = c.deliver(0, 0, "n1".into());
            }
        },
        REFUSE_NOT_ANNOUNCED,
    );
    assert!(announce(&mut c, 0, "n1", record(AGENT, "m01.testnet", 36_000_000, false)));
    as_caller("m01.testnet");
    refused(
        move || {
            let _ = c.deliver(0, 0, "n2".into());
        },
        REFUSE_NOT_ANNOUNCED,
    );
}

#[test]
fn a_member_in_another_category_is_refused_by_the_merchant_record() {
    let mut c = funded();
    // h05 sells hotel-lisbon; leg 0 is hoodie.
    assert_eq!(send_bond(&mut c, "h05.testnet", 0, 40_000_000, Some(proof("h05.testnet")), BOND), None);
    callback(vec![ok(json!(true)), ok(merchant_rec("h05.testnet"))]);
    assert_eq!(c.on_admit(0, 0, acc("h05.testnet"), U128(BOND)), U128(BOND));
    assert!(get_logs().iter().any(|l| l.contains(REFUSE_CATEGORY)));
    assert!(c.job(0).unwrap().seats[0].is_none());
    // An unapproved merchant or no merchant record at all: refused too.
    for rec in [json!({ "category": "hoodie", "approved": false }), Value::Null] {
        assert_eq!(send_bond(&mut c, "m09.testnet", 0, 40_000_000, Some(proof("m09.testnet")), BOND), None);
        callback(vec![ok(json!(true)), ok(rec)]);
        assert_eq!(c.on_admit(0, 0, acc("m09.testnet"), U128(BOND)), U128(BOND));
    }
}

#[test]
fn the_buyer_and_its_agents_cannot_join() {
    let mut c = funded();
    for who in ["buyer.testnet", AGENT] {
        assert_eq!(send_bond(&mut c, who, 0, 40_000_000, Some(proof(who)), BOND), Some(BOND));
        assert!(get_logs().iter().any(|l| l.contains(REFUSE_OWN_JOB)));
    }
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
    callback(vec![ok(json!(false)), ok(merchant_rec("h05.testnet"))]);
    assert_eq!(c.on_admit(0, 1, acc("h05.testnet"), U128(BOND)), U128(BOND));
    assert!(get_logs().iter().any(|l| l.contains("join_refused") && l.contains(REFUSE_LOW)));
    assert!(c.job(0).unwrap().seats[1].is_none());
    // A failed bazaar call refunds too.
    assert_eq!(send_bond(&mut c, "h05.testnet", 1, 400_000_000, Some(proof("h05.testnet")), BOND), None);
    callback(vec![PromiseResult::Failed, PromiseResult::Failed]);
    assert_eq!(c.on_admit(0, 1, acc("h05.testnet"), U128(BOND)), U128(BOND));
    assert_eq!(c.member(acc("h05.testnet")).joined, 0);
}

#[test]
fn a_join_still_pending_after_the_grace_period_counts_as_refused() {
    // M3: the seat cannot hold the job open forever.
    let mut c = funded();
    admit(&mut c, "m01.testnet", 0, 40_000_000);
    buy_and_deliver(&mut c, "m01.testnet", 0, "n1", 36_000_000);
    assert_eq!(send_bond(&mut c, "h05.testnet", 1, 400_000_000, Some(proof("h05.testnet")), BOND), None);
    at("anyone.testnet", DEADLINE + GRACE_MS - 1);
    refused(
        {
            let mut c = funded();
            assert_eq!(send_bond(&mut c, "h05.testnet", 1, 400_000_000, Some(proof("h05.testnet")), BOND), None);
            at("anyone.testnet", DEADLINE + GRACE_MS - 1);
            move || {
                let _ = c.finalize(0);
            }
        },
        "a join is still in flight",
    );
    let d = finalized(&mut c, DEADLINE + GRACE_MS);
    assert!(get_logs().iter().any(|l| l.contains("join_lapsed")));
    // The lapsed seat is in no payout: P = 40 alone, m01 takes the whole budget.
    assert_eq!(d["delivered"][0]["share"], BUDGET.to_string());
    assert!(d["slashed"].as_array().unwrap().is_empty() && d["released"].as_array().unwrap().is_empty());
    // A late bazaar answer refunds the bond through the token and seats nobody.
    callback_at(DEADLINE + GRACE_MS, vec![ok(json!(true)), ok(merchant_rec("h05.testnet"))]);
    assert_eq!(c.on_admit(0, 1, acc("h05.testnet"), U128(BOND)), U128(BOND));
    assert_eq!(c.member(acc("h05.testnet")).joined, 0);
}

#[test]
fn a_refused_payout_becomes_claimable() {
    // M4.
    let mut c = funded();
    callback(vec![PromiseResult::Failed]);
    assert!(!c.on_payout(acc("m01.testnet"), U128(7)));
    assert_eq!(c.claimable_of(acc("m01.testnet")), U128(7));
    callback(vec![ok(json!(null))]);
    assert!(c.on_payout(acc("m01.testnet"), U128(9)));
    assert_eq!(c.claimable_of(acc("m01.testnet")), U128(7));
    as_caller("m01.testnet");
    let _ = c.claim();
    assert_eq!(c.claimable_of(acc("m01.testnet")), U128(0));
    // The claim's own transfer refused: credited again.
    callback(vec![PromiseResult::Failed]);
    c.on_payout(acc("m01.testnet"), U128(7));
    assert_eq!(c.claimable_of(acc("m01.testnet")), U128(7));
    as_caller("m02.testnet");
    refused(
        move || {
            let _ = c.claim();
        },
        "nothing to claim",
    );
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
    let mut c = fresh();
    testing_env!(ctx("buyer.testnet", NOW_MS, OPEN_DEPOSIT).build());
    c.open_job(legs(), U128(BOND), U128(BUDGET), 50, DEADLINE, None);
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
fn deliver_refusals() {
    // Each case its own nullifier: the mocked storage outlives a refused call.
    let base = |n: &'static str, rec: Value, why: &'static str| {
        let mut c = funded();
        admit(&mut c, "m01.testnet", 0, 40_000_000);
        assert!(announce(&mut c, 0, n, record(AGENT, "m01.testnet", 36_000_000, false)));
        refused(
            move || {
                let _ = deliver(&mut c, 0, n, rec);
            },
            why,
        );
    };
    base("d1", record(AGENT, "m01.testnet", 36_000_000, false), "purchase not settled");
    base("d2", record(AGENT, "m07.testnet", 36_000_000, true), "the receipt names another merchant");
    base("d3", record(AGENT, "m01.testnet", 40_000_001, true), "above the member's quote");
    base("d4", record("other.testnet", "m01.testnet", 36_000_000, true), REFUSE_BUYER);
    base("d5", Value::Null, "unknown nullifier");
    // One purchase announces one leg.
    let mut c = funded();
    admit(&mut c, "m01.testnet", 0, 40_000_000);
    admit(&mut c, "m02.testnet", 2, 40_000_000);
    buy_and_deliver(&mut c, "m01.testnet", 0, "n1", 1);
    as_caller(AGENT);
    refused(
        move || {
            let _ = c.announce(0, 2, "n1".into());
        },
        "purchase already announced or used",
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
fn no_join_announce_or_delivery_after_the_deadline() {
    let mut c = funded();
    admit(&mut c, "m01.testnet", 0, 40_000_000);
    let mut c2 = funded();
    at("dusdc.testnet", DEADLINE);
    let r = c2.ft_on_transfer(acc("m02.testnet"), U128(BOND), join_msg(2, 1, Some(proof("m02.testnet"))));
    assert!(matches!(r, PromiseOrValue::Value(U128(BOND))));
    at(AGENT, DEADLINE);
    refused(
        move || {
            let _ = c.announce(0, 0, "n1".into());
        },
        "job closed",
    );
}

#[test]
fn open_job_checks_its_arguments() {
    let open = |legs: Vec<Leg>, amounts: (u128, u128), pct: u8, deadline: u64, deposit: NearToken, buyers: Option<Vec<AccountId>>, why: &'static str| {
        let mut c = fresh();
        testing_env!(ctx("buyer.testnet", NOW_MS, deposit).build());
        refused(
            move || {
                let _ = c.open_job(legs, U128(amounts.0), U128(amounts.1), pct, deadline, buyers);
            },
            why,
        );
    };
    let a = (BOND, BUDGET);
    open(legs(), a, 100, DEADLINE, NearToken::from_yoctonear(0), None, "attach 0.02 NEAR");
    open(vec![], a, 100, DEADLINE, OPEN_DEPOSIT, None, "1 to 8 legs");
    open(legs(), a, 0, DEADLINE, OPEN_DEPOSIT, None, "min_top_pct");
    open(legs(), a, 100, NOW_MS - 1, OPEN_DEPOSIT, None, "at least 10 minutes");
    open(legs(), a, 100, NOW_MS + MIN_DURATION_MS - 1, OPEN_DEPOSIT, None, "at least 10 minutes");
    open(legs(), (BOND, MAX_AMOUNT + 1), 100, DEADLINE, OPEN_DEPOSIT, None, "at most 10^15");
    open(vec![Leg { category: "hoodie".into(), max_price: U128(MAX_AMOUNT + 1) }], a, 100, DEADLINE, OPEN_DEPOSIT, None, "max price is 1 to 10^15");
    open(legs(), a, 100, DEADLINE, OPEN_DEPOSIT, Some(vec![]), "1 to 8 buyer agents");
    open(legs(), a, 100, DEADLINE, OPEN_DEPOSIT, Some(vec![acc(AGENT), acc(AGENT)]), "listed twice");
}
