extern crate std;
use super::*;
use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
use soroban_sdk::{token::StellarAssetClient, IntoVal};

struct T {
    env: Env,
    id: Address,
    near: Address,
    usdc: Address,
}

fn setup() -> T {
    let env = Env::default();
    let admin = Address::generate(&env);
    let near = Address::generate(&env);
    let issuer = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(issuer).address();
    let id = env.register(BookerBobStellar, (admin, near.clone(), usdc.clone()));
    env.mock_all_auths();
    StellarAssetClient::new(&env, &usdc).mint(&id, &1_000_000_000);
    T { env, id, near, usdc }
}

fn n(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

#[test]
fn near_signed_settle_pays_the_merchant_once() {
    let t = setup();
    let c = BookerBobStellarClient::new(&t.env, &t.id);
    let merchant = Address::generate(&t.env);
    c.settle_from_near(&n(&t.env, 1), &merchant, &360_000_000, &String::from_str(&t.env, "order-1"));
    // The auth that was required is the NEAR Chain Signatures account (checked right after the call).
    assert_eq!(t.env.auths()[0].0, t.near);
    assert_eq!(token::Client::new(&t.env, &t.usdc).balance(&merchant), 360_000_000);
    assert!(c.is_spent(&n(&t.env, 1)));
}

#[test]
fn replayed_nullifier_is_rejected() {
    let t = setup();
    let c = BookerBobStellarClient::new(&t.env, &t.id);
    let merchant = Address::generate(&t.env);
    c.settle_from_near(&n(&t.env, 1), &merchant, &10, &String::from_str(&t.env, "order-1"));
    let again = c.try_settle_from_near(&n(&t.env, 1), &merchant, &10, &String::from_str(&t.env, "order-2"));
    assert_eq!(again, Err(Ok(Error::NullifierSpent)));
}

#[test]
fn bad_amount_is_rejected() {
    let t = setup();
    let c = BookerBobStellarClient::new(&t.env, &t.id);
    let r = c.try_settle_from_near(&n(&t.env, 2), &Address::generate(&t.env), &0, &String::from_str(&t.env, "o"));
    assert_eq!(r, Err(Ok(Error::BadAmount)));
}

#[test]
#[should_panic]
fn settle_signed_by_anyone_else_is_rejected() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let near = Address::generate(&env);
    let issuer = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(issuer).address();
    let id = env.register(BookerBobStellar, (admin, near, usdc));
    let c = BookerBobStellarClient::new(&env, &id);
    let thief = Address::generate(&env);
    let merchant = Address::generate(&env);
    let checkout = String::from_str(&env, "o");
    // Only the thief authorizes: the contract requires the NEAR signer, so this panics.
    env.mock_auths(&[MockAuth {
        address: &thief,
        invoke: &MockAuthInvoke {
            contract: &id,
            fn_name: "settle_from_near",
            args: (n(&env, 3), merchant.clone(), 5i128, checkout.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    c.settle_from_near(&n(&env, 3), &merchant, &5, &checkout);
}
