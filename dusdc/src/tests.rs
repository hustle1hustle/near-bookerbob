use super::*;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::testing_env;
use near_sdk::PromiseResult;

const T0: u64 = 1_793_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn at(who: &str, ms: u64, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("dusdc.bookerbob.testnet")).predecessor_account_id(acc(who)).block_timestamp(ms * 1_000_000).attached_deposit(deposit);
    testing_env!(b.build());
}

fn fresh() -> Dusdc {
    at("bookerbob.testnet", T0, NearToken::from_yoctonear(0));
    let mut t = Dusdc::new();
    for a in ["alice.testnet", "bazaar.testnet"] {
        at(a, T0, STORAGE_DEPOSIT);
        t.storage_deposit(None, Some(true));
    }
    t
}

#[test]
#[should_panic(expected = "dUSDC is testnet only")]
fn refuses_to_start_on_mainnet() {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("dusdc.near"));
    testing_env!(b.build());
    let _ = Dusdc::new();
}

#[test]
fn mint_gives_100_and_logs_it() {
    let mut t = fresh();
    at("alice.testnet", T0, NearToken::from_yoctonear(0));
    assert_eq!(t.mint(None, None), U128(MINT_AMOUNT));
    assert_eq!(t.ft_total_supply(), U128(MINT_AMOUNT));
    assert!(get_logs().iter().any(|l| l.contains("ft_mint")));
    assert_eq!(t.ft_metadata().decimals, 6);
}

#[test]
#[should_panic(expected = "one mint per account per hour")]
fn second_mint_within_the_hour_is_refused() {
    let mut t = fresh();
    at("alice.testnet", T0, NearToken::from_yoctonear(0));
    t.mint(None, None);
    at("bob.testnet", T0 + MINT_INTERVAL_MS - 1, NearToken::from_yoctonear(0));
    t.mint(Some(acc("alice.testnet")), None);
}

#[test]
fn mint_again_after_the_hour() {
    let mut t = fresh();
    at("alice.testnet", T0, NearToken::from_yoctonear(0));
    t.mint(None, None);
    at("alice.testnet", T0 + MINT_INTERVAL_MS, NearToken::from_yoctonear(0));
    assert_eq!(t.mint(None, None), U128(2 * MINT_AMOUNT));
}

#[test]
#[should_panic(expected = "account not registered")]
fn mint_to_an_unregistered_account_is_refused() {
    let mut t = fresh();
    at("carol.testnet", T0, NearToken::from_yoctonear(0));
    t.mint(None, None);
}

#[test]
#[should_panic(expected = "supply cap reached")]
fn supply_is_capped() {
    let mut t = fresh();
    t.total_supply = SUPPLY_CAP - MINT_AMOUNT + 1;
    at("alice.testnet", T0, NearToken::from_yoctonear(0));
    t.mint(None, None);
}

#[test]
fn transfer_moves_balance() {
    let mut t = fresh();
    at("alice.testnet", T0, NearToken::from_yoctonear(0));
    t.mint(None, None);
    at("alice.testnet", T0, NearToken::from_yoctonear(1));
    t.ft_transfer(acc("bazaar.testnet"), U128(40), None);
    assert_eq!((t.ft_balance_of(acc("alice.testnet")), t.ft_balance_of(acc("bazaar.testnet"))), (U128(MINT_AMOUNT - 40), U128(40)));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn transfer_needs_one_yocto() {
    let mut t = fresh();
    at("alice.testnet", T0, NearToken::from_yoctonear(0));
    t.mint(None, None);
    t.ft_transfer(acc("bazaar.testnet"), U128(40), None);
}

#[test]
#[should_panic(expected = "insufficient balance")]
fn overdraw_is_refused() {
    let mut t = fresh();
    at("alice.testnet", T0, NearToken::from_yoctonear(1));
    t.ft_transfer(acc("bazaar.testnet"), U128(1), None);
}

#[test]
#[should_panic(expected = "receiver not registered")]
fn transfer_to_unregistered_is_refused() {
    let mut t = fresh();
    at("alice.testnet", T0, NearToken::from_yoctonear(0));
    t.mint(None, None);
    at("alice.testnet", T0, NearToken::from_yoctonear(1));
    t.ft_transfer(acc("nobody.testnet"), U128(1), None);
}

fn resolve(t: &mut Dusdc, result: PromiseResult, amount: u128) -> U128 {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("dusdc.bookerbob.testnet")).predecessor_account_id(acc("dusdc.bookerbob.testnet"));
    testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![result]);
    t.ft_resolve_transfer(acc("alice.testnet"), acc("bazaar.testnet"), U128(amount))
}

#[test]
fn transfer_call_refunds_what_the_receiver_returns() {
    let mut t = fresh();
    at("alice.testnet", T0, NearToken::from_yoctonear(0));
    t.mint(None, None);
    at("alice.testnet", T0, NearToken::from_yoctonear(1));
    let _ = t.ft_transfer_call(acc("bazaar.testnet"), U128(1000), None, String::new());
    assert!(get_created_receipts().iter().any(|r| r.receiver_id.as_str() == "bazaar.testnet"));
    // The bazaar kept 0 of it (no escrow entry): all 1000 come back.
    assert_eq!(resolve(&mut t, PromiseResult::Successful(b"\"1000\"".to_vec()), 1000), U128(0));
    assert_eq!(t.ft_balance_of(acc("alice.testnet")), U128(MINT_AMOUNT));
}

#[test]
fn transfer_call_keeps_what_the_receiver_used_and_refunds_on_failure() {
    let mut t = fresh();
    at("alice.testnet", T0, NearToken::from_yoctonear(0));
    t.mint(None, None);
    at("alice.testnet", T0, NearToken::from_yoctonear(1));
    let _ = t.ft_transfer_call(acc("bazaar.testnet"), U128(1000), None, String::new());
    assert_eq!(resolve(&mut t, PromiseResult::Successful(b"\"0\"".to_vec()), 1000), U128(1000));
    assert_eq!(t.ft_balance_of(acc("bazaar.testnet")), U128(1000));
    at("alice.testnet", T0, NearToken::from_yoctonear(1));
    let _ = t.ft_transfer_call(acc("bazaar.testnet"), U128(500), None, String::new());
    assert_eq!(resolve(&mut t, PromiseResult::Failed, 500), U128(0));
    assert_eq!(t.ft_balance_of(acc("bazaar.testnet")), U128(1000));
}

#[test]
fn storage_repeat_is_refunded_and_short_deposit_refused() {
    let mut t = fresh();
    at("alice.testnet", T0, STORAGE_DEPOSIT);
    t.storage_deposit(None, None);
    assert!(get_created_receipts().iter().any(|r| r.receiver_id.as_str() == "alice.testnet"));
    assert!(t.storage_balance_of(acc("alice.testnet")).is_some());
    assert!(t.storage_balance_of(acc("carol.testnet")).is_none());
    at("carol.testnet", T0, NearToken::from_yoctonear(1));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.storage_deposit(None, None)));
    assert!(r.is_err());
}

#[test]
fn a_hotel_size_mint_is_allowed_up_to_500() {
    let mut t = fresh();
    at("alice.testnet", T0, NearToken::from_yoctonear(0));
    assert_eq!(t.mint(None, Some(U128(MINT_MAX))), U128(MINT_MAX));
}

#[test]
#[should_panic(expected = "mint at most 500 dUSDC")]
fn a_mint_over_500_is_refused() {
    let mut t = fresh();
    at("alice.testnet", T0, NearToken::from_yoctonear(0));
    t.mint(None, Some(U128(MINT_MAX + 1)));
}
