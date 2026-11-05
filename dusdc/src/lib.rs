//! BookerBob demo USDC (dUSDC): a testnet-only NEP-141 token with no value, so testers can
//! run the whole purchase without a faucet. Same 6 decimals and base units as USDC.
//!
//! - `mint(account_id, amount)`: free, 100 dUSDC by default and at most 500, at most once per account per hour, total supply
//!   capped at 1,000,000 dUSDC. No owner, no burn, no pause.
//! - NEP-141 (`ft_transfer`, `ft_transfer_call` with refunds) and the NEP-145 storage
//!   methods the bazaar and wallets call.
//! - Refuses to initialise on an account that is not `.testnet`.
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

pub const DECIMALS: u8 = 6;
pub const MINT_AMOUNT: u128 = 100_000_000;
/// The most one mint may ask for: a hotel-size demo purchase (a 3-night stay is about 408).
pub const MINT_MAX: u128 = 500_000_000;
pub const MINT_INTERVAL_MS: u64 = 3_600_000;
pub const SUPPLY_CAP: u128 = 1_000_000_000_000;
/// Storage for one account entry (balance + last mint), rounded up.
pub const STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const GAS_ON_TRANSFER: Gas = Gas::from_tgas(30);
const GAS_RESOLVE: Gas = Gas::from_tgas(10);

#[ext_contract(ext_receiver)]
pub trait Receiver {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128>;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Dusdc {
    balances: LookupMap<AccountId, u128>,
    last_mint: LookupMap<AccountId, u64>,
    total_supply: u128,
}

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[near(serializers = [json])]
pub struct FtMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
    pub decimals: u8,
}

fn event(kind: &str, data: serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", serde_json::json!({ "standard": "nep141", "version": "1.0.0", "event": kind, "data": [data] })));
}

#[near]
impl Dusdc {
    #[init]
    pub fn new() -> Self {
        require!(env::current_account_id().as_str().ends_with(".testnet"), "dUSDC is testnet only");
        Self { balances: LookupMap::new(b"b"), last_mint: LookupMap::new(b"l"), total_supply: 0 }
    }

    /// Free: 100 dUSDC (or `amount`, at most 500) to `account_id` (default the caller), once
    /// per hour, under the cap.
    pub fn mint(&mut self, account_id: Option<AccountId>, amount: Option<U128>) -> U128 {
        let amount = amount.map_or(MINT_AMOUNT, |a| a.0);
        require!(amount > 0 && amount <= MINT_MAX, "mint at most 500 dUSDC");
        let to = account_id.unwrap_or_else(env::predecessor_account_id);
        require!(self.balances.contains_key(&to), "account not registered (storage_deposit first)");
        let now = env::block_timestamp_ms();
        if let Some(last) = self.last_mint.get(&to) {
            require!(now >= last + MINT_INTERVAL_MS, "one mint per account per hour");
        }
        require!(self.total_supply + amount <= SUPPLY_CAP, "supply cap reached");
        self.total_supply += amount;
        *self.balances.get_mut(&to).expect("registered") += amount;
        self.last_mint.insert(to.clone(), now);
        event("ft_mint", serde_json::json!({ "owner_id": to, "amount": U128(amount), "memo": "free demo mint, no value" }));
        U128(self.balance(&to))
    }

    fn balance(&self, a: &AccountId) -> u128 {
        self.balances.get(a).copied().unwrap_or(0)
    }

    fn move_tokens(&mut self, from: &AccountId, to: &AccountId, amount: u128) {
        require!(amount > 0, "amount must be positive");
        require!(from != to, "sender and receiver are the same");
        require!(self.balances.contains_key(to), "receiver not registered");
        let fb = self.balances.get_mut(from).unwrap_or_else(|| env::panic_str("sender not registered"));
        require!(*fb >= amount, "insufficient balance");
        *fb -= amount;
        *self.balances.get_mut(to).expect("checked") += amount;
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        let from = env::predecessor_account_id();
        self.move_tokens(&from, &receiver_id, amount.0);
        event("ft_transfer", serde_json::json!({ "old_owner_id": from, "new_owner_id": receiver_id, "amount": amount, "memo": memo }));
    }

    #[payable]
    pub fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> Promise {
        near_sdk::assert_one_yocto();
        let from = env::predecessor_account_id();
        self.move_tokens(&from, &receiver_id, amount.0);
        event("ft_transfer", serde_json::json!({ "old_owner_id": from, "new_owner_id": receiver_id, "amount": amount, "memo": memo }));
        ext_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_ON_TRANSFER)
            .ft_on_transfer(from.clone(), amount, msg)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_RESOLVE).ft_resolve_transfer(from, receiver_id, amount))
    }

    /// Returns the amount the receiver kept; the rest goes back to the sender.
    #[private]
    pub fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let unused = match env::promise_result_checked(0, 64) {
            Ok(v) => serde_json::from_slice::<U128>(&v).map(|u| u.0.min(amount.0)).unwrap_or(amount.0),
            Err(_) => amount.0,
        };
        let refund = unused.min(self.balance(&receiver_id));
        if refund > 0 && self.balances.contains_key(&sender_id) {
            *self.balances.get_mut(&receiver_id).expect("receiver") -= refund;
            *self.balances.get_mut(&sender_id).expect("sender") += refund;
            event("ft_transfer", serde_json::json!({ "old_owner_id": receiver_id, "new_owner_id": sender_id, "amount": U128(refund), "memo": "refund" }));
        }
        U128(amount.0 - refund)
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balance(&account_id))
    }

    pub fn ft_metadata(&self) -> FtMetadata {
        FtMetadata {
            spec: "ft-1.0.0".into(),
            name: "BookerBob demo USDC (testnet, no value)".into(),
            symbol: "dUSDC".into(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        }
    }

    /// NEP-145: register `account_id` (default the caller). A repeat is refunded in full.
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let _ = registration_only;
        let a = account_id.unwrap_or_else(env::predecessor_account_id);
        let d = env::attached_deposit();
        if self.balances.contains_key(&a) {
            if !d.is_zero() {
                Promise::new(env::predecessor_account_id()).transfer(d).detach();
            }
        } else {
            require!(d >= STORAGE_DEPOSIT, "attach at least 0.00125 NEAR");
            self.balances.insert(a, 0);
            let extra = d.saturating_sub(STORAGE_DEPOSIT);
            if !extra.is_zero() {
                Promise::new(env::predecessor_account_id()).transfer(extra).detach();
            }
        }
        StorageBalance { total: U128(STORAGE_DEPOSIT.as_yoctonear()), available: U128(0) }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.balances.contains_key(&account_id).then(|| StorageBalance { total: U128(STORAGE_DEPOSIT.as_yoctonear()), available: U128(0) })
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds { min: U128(STORAGE_DEPOSIT.as_yoctonear()), max: Some(U128(STORAGE_DEPOSIT.as_yoctonear())) }
    }
}

#[cfg(test)]
mod tests;
