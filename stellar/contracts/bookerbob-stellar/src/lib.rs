//! BookerBob Stellar leg. "One verified context, any chain."
//!
//! The NEAR bazaar decides (verdict, referee receipt, nullifier); this contract only
//! executes. Its `near_signer` is the Stellar account whose Ed25519 key is derived by NEAR
//! Chain Signatures (`v1.signer`, `domain_id: 1`) for the bazaar account and path
//! `stellar-1`. Only a transaction that key signs, i.e. one the bazaar asked the MPC
//! network to sign, can call `settle_from_near`. The contract keeps its own spent-set so a
//! nullifier pays once here too, and pays the merchant from its USDC balance.
#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env, String};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NullifierSpent = 1,
    BadAmount = 2,
    BadCheckoutRef = 3,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Admin,
    NearSigner,
    Usdc,
    Spent(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settled {
    pub nullifier: BytesN<32>,
    pub merchant: Address,
    pub amount: i128,
    pub checkout_ref: String,
}

#[contract]
pub struct BookerBobStellar;

#[contractimpl]
impl BookerBobStellar {
    /// `near_signer`: the G-address of the Chain Signatures key (see fixtures/live/views.json).
    pub fn __constructor(env: Env, admin: Address, near_signer: Address, usdc: Address) {
        env.storage().instance().set(&Key::Admin, &admin);
        env.storage().instance().set(&Key::NearSigner, &near_signer);
        env.storage().instance().set(&Key::Usdc, &usdc);
    }

    /// Pay `merchant` for a purchase the NEAR bazaar settled. Needs the NEAR signer's auth.
    pub fn settle_from_near(env: Env, nullifier: BytesN<32>, merchant: Address, amount: i128, checkout_ref: String) -> Result<(), Error> {
        let signer: Address = env.storage().instance().get(&Key::NearSigner).unwrap();
        signer.require_auth();
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        if checkout_ref.len() == 0 || checkout_ref.len() > 128 {
            return Err(Error::BadCheckoutRef);
        }
        let key = Key::Spent(nullifier.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::NullifierSpent);
        }
        env.storage().persistent().set(&key, &true);
        let usdc: Address = env.storage().instance().get(&Key::Usdc).unwrap();
        token::Client::new(&env, &usdc).transfer(&env.current_contract_address(), &merchant, &amount);
        #[allow(deprecated)]
        env.events().publish((symbol_short!("settled"),), Settled { nullifier, merchant, amount, checkout_ref });
        Ok(())
    }

    pub fn is_spent(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage().persistent().has(&Key::Spent(nullifier))
    }

    pub fn near_signer(env: Env) -> Address {
        env.storage().instance().get(&Key::NearSigner).unwrap()
    }

    /// Rotate the NEAR signer (new derivation path or MPC key version). Admin only.
    pub fn set_near_signer(env: Env, near_signer: Address) {
        let admin: Address = env.storage().instance().get(&Key::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&Key::NearSigner, &near_signer);
    }
}

#[cfg(test)]
mod test;
