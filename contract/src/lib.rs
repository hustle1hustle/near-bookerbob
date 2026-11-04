//! BookerBob `bazaar` contract.
//!
//! State: merchant registry (one merchant per account, usually a sub-account), enclave /
//! issuer key registry, verdict store keyed by nullifier (pending or spent), USDC escrow.
//! The chain's job: a global spent-set for nullifiers, signature checks with host
//! functions, a code-computed price, and payout atomic with the nullifier burn.

use bookerbob_core::{quote as price_quote, Quote, Schedule, SigAlg, SignedVerdict};
use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

pub const EVENT_STANDARD: &str = "bookerbob";
pub const EVENT_VERSION: &str = "0.1.0";
/// Deposit `storage_deposit` must attach to open an escrow entry.
pub const ESCROW_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(10);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_SETTLE_CALLBACK: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum NullifierStatus {
    Unknown,
    Pending,
    Spent,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct VerdictRecord {
    pub agent: AccountId,
    pub context: String,
    pub predicates: Vec<String>,
    pub commitment: String,
    pub proof_hash: String,
    pub tier: String,
    pub tcb_status: String,
    pub issuer: String,
    pub max_spend: U128,
    pub expires_at_ms: u64,
    pub spent: bool,
    pub checkout_ref: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Merchant {
    pub payout: AccountId,
    pub schedule: Schedule,
}

#[near(serializers = [json])]
pub struct MerchantQuote {
    pub merchant: AccountId,
    pub quote: Quote,
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bazaar {
    owner: AccountId,
    usdc: AccountId,
    issuers: IterableMap<String, String>,
    merchants: IterableMap<AccountId, Merchant>,
    verdicts: LookupMap<String, VerdictRecord>,
    escrow: LookupMap<AccountId, u128>,
    spent_count: u64,
}

fn emit(event: &str, data: serde_json::Value) {
    let body = serde_json::json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{body}"));
}

fn decode<const N: usize>(hex_str: &str, what: &str) -> [u8; N] {
    let bytes = hex::decode(hex_str).unwrap_or_else(|_| env::panic_str(&format!("bad {what} hex")));
    bytes.try_into().unwrap_or_else(|_| env::panic_str(&format!("bad {what} length")))
}

/// Check a verdict signature with the NEAR host functions.
pub fn verify_signature(v: &SignedVerdict) -> bool {
    let digest: [u8; 32] = env::sha256_array(v.envelope.signing_message());
    let sig: [u8; 64] = decode(&v.signature, "signature");
    match v.alg {
        SigAlg::Ed25519 => {
            let pk: [u8; 32] = decode(&v.issuer_key, "issuer key");
            env::ed25519_verify(&sig, digest, &pk)
        }
        SigAlg::P256 => {
            let pk: [u8; 33] = decode(&v.issuer_key, "issuer key");
            env::p256_signature_is_low_s(&sig) && env::p256_verify(&sig, &digest, &pk)
        }
    }
}

#[near]
impl Bazaar {
    #[init]
    pub fn new(owner: AccountId, usdc: AccountId) -> Self {
        Self {
            owner,
            usdc,
            issuers: IterableMap::new(b"i"),
            merchants: IterableMap::new(b"m"),
            verdicts: LookupMap::new(b"v"),
            escrow: LookupMap::new(b"e"),
            spent_count: 0,
        }
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    // ---------- issuer / enclave keys ----------

    /// Register an enclave or issuer key. `key_id` is `ed25519:<hex>` or `p256:<hex>`.
    pub fn register_issuer(&mut self, key_id: String, label: String) {
        self.assert_owner();
        require!(key_id.starts_with("ed25519:") || key_id.starts_with("p256:"), "bad key id");
        self.issuers.insert(key_id.clone(), label.clone());
        emit("issuer_registered", serde_json::json!({ "key_id": key_id, "label": label }));
    }

    pub fn remove_issuer(&mut self, key_id: String) {
        self.assert_owner();
        self.issuers.remove(&key_id);
        emit("issuer_removed", serde_json::json!({ "key_id": key_id }));
    }

    pub fn issuers(&self) -> Vec<(String, String)> {
        self.issuers.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    // ---------- merchants ----------

    /// A merchant agent registers its own account (usually `mNN.<bazaar>`) with a discount
    /// schedule. The payout account must already be registered with the USDC contract
    /// (`storage_deposit` there), or the payout fails and `settle` rolls back.
    pub fn register_merchant(&mut self, schedule: Schedule, payout: Option<AccountId>) {
        if let Err(e) = schedule.validate() {
            env::panic_str(e);
        }
        let merchant = env::predecessor_account_id();
        let payout = payout.unwrap_or_else(|| merchant.clone());
        self.merchants.insert(merchant.clone(), Merchant { payout: payout.clone(), schedule });
        emit("merchant_registered", serde_json::json!({ "merchant": merchant, "payout": payout }));
    }

    pub fn merchant(&self, merchant: AccountId) -> Option<Merchant> {
        self.merchants.get(&merchant).cloned()
    }

    pub fn merchants(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<(AccountId, Merchant)> {
        self.merchants
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50) as usize)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    // ---------- verdicts and nullifiers ----------

    /// Submit a signed verdict. Called by the agent named in the envelope's `cnf`.
    /// Rejects: bad envelope, unknown key, bad signature, expired, agent mismatch, and a
    /// nullifier that is already pending or spent.
    pub fn submit_verdict(&mut self, verdict: SignedVerdict) {
        let e = &verdict.envelope;
        if let Err(msg) = e.validate() {
            env::panic_str(msg);
        }
        let key_id = verdict.key_id();
        require!(self.issuers.contains_key(&key_id), "unknown enclave key");
        require!(verify_signature(&verdict), "bad signature");
        require!(env::block_timestamp_ms() < e.expires_at_ms, "verdict expired");
        require!(env::predecessor_account_id().as_str() == e.cnf, "agent mismatch");
        if let Some(existing) = self.verdicts.get(&e.nullifier) {
            env::panic_str(if existing.spent { "nullifier spent" } else { "nullifier pending" });
        }
        let record = VerdictRecord {
            agent: env::predecessor_account_id(),
            context: e.context.clone(),
            predicates: e.predicates.clone(),
            commitment: e.commitment.clone(),
            proof_hash: e.proof_hash.clone(),
            tier: e.tier.clone(),
            tcb_status: e.attestation.tcb_status.clone(),
            issuer: key_id,
            max_spend: U128(e.max_spend),
            expires_at_ms: e.expires_at_ms,
            spent: false,
            checkout_ref: None,
        };
        self.verdicts.insert(e.nullifier.clone(), record);
        emit(
            "verdict_submitted",
            serde_json::json!({
                "nullifier": e.nullifier,
                "commitment": e.commitment,
                "predicates": e.predicates,
                "tcb_status": e.attestation.tcb_status,
            }),
        );
    }

    pub fn nullifier_status(&self, nullifier: String) -> NullifierStatus {
        match self.verdicts.get(&nullifier) {
            None => NullifierStatus::Unknown,
            Some(r) if r.spent => NullifierStatus::Spent,
            Some(_) => NullifierStatus::Pending,
        }
    }

    pub fn verdict(&self, nullifier: String) -> Option<VerdictRecord> {
        self.verdicts.get(&nullifier).cloned()
    }

    pub fn spent_count(&self) -> u64 {
        self.spent_count
    }

    // ---------- quotes ----------

    /// Code-computed price of `merchant` for the predicates revealed under `nullifier`.
    pub fn quote(&self, merchant: AccountId, nullifier: String) -> Quote {
        let m = self.merchants.get(&merchant).unwrap_or_else(|| env::panic_str("unknown merchant"));
        let v = self.verdicts.get(&nullifier).unwrap_or_else(|| env::panic_str("unknown nullifier"));
        price_quote(&m.schedule, &v.predicates)
    }

    /// Lowest price across merchants; ties go to the merchant registered first.
    pub fn best_quote(&self, nullifier: String) -> Option<MerchantQuote> {
        let v = self.verdicts.get(&nullifier).unwrap_or_else(|| env::panic_str("unknown nullifier"));
        let mut best: Option<MerchantQuote> = None;
        for (id, m) in self.merchants.iter() {
            let q = price_quote(&m.schedule, &v.predicates);
            if best.as_ref().map_or(true, |b| q.price < b.quote.price) {
                best = Some(MerchantQuote { merchant: id.clone(), quote: q });
            }
        }
        best
    }

    // ---------- escrow (NEP-141 receiver) ----------

    /// Open an escrow entry for the caller (or `account_id`). Pays for its storage.
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) {
        require!(env::attached_deposit() >= ESCROW_STORAGE_DEPOSIT, "attach at least 0.01 NEAR");
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        if !self.escrow.contains_key(&account) {
            self.escrow.insert(account, 0);
        }
    }

    pub fn escrow_of(&self, account_id: AccountId) -> Option<U128> {
        self.escrow.get(&account_id).map(|b| U128(*b))
    }

    /// NEP-141 `ft_transfer_call` receiver. Accepts USDC only, and only for an account with
    /// an open escrow entry; otherwise returns the full amount (the token refunds it).
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let _ = msg;
        if env::predecessor_account_id() != self.usdc {
            env::panic_str("only USDC is accepted");
        }
        match self.escrow.get_mut(&sender_id) {
            None => PromiseOrValue::Value(amount),
            Some(bal) => {
                *bal += amount.0;
                emit("escrow_deposit", serde_json::json!({ "account": sender_id, "amount": amount }));
                PromiseOrValue::Value(U128(0))
            }
        }
    }

    // ---------- settle ----------

    /// Pay `merchant` for the verdict under `nullifier`. Called by the verdict's agent (a
    /// function-call key limited to this method is enough). `amount` must equal the
    /// code-computed price and stay within the verdict's `max_spend`. In one call: escrow
    /// is debited, the nullifier is burned, a `settled` event is emitted and USDC
    /// `ft_transfer` to the merchant payout is scheduled. If the transfer fails, the
    /// callback restores escrow and the nullifier.
    pub fn settle(&mut self, nullifier: String, merchant: AccountId, checkout_ref: String, amount: U128) -> Promise {
        require!(!checkout_ref.is_empty() && checkout_ref.len() <= 128, "bad checkout_ref");
        let agent = env::predecessor_account_id();
        let m = self.merchants.get(&merchant).cloned().unwrap_or_else(|| env::panic_str("unknown merchant"));
        let record = self.verdicts.get_mut(&nullifier).unwrap_or_else(|| env::panic_str("unknown nullifier"));
        require!(!record.spent, "nullifier spent");
        require!(record.agent == agent, "agent mismatch");
        require!(env::block_timestamp_ms() < record.expires_at_ms, "verdict expired");
        let q = price_quote(&m.schedule, &record.predicates);
        require!(amount.0 == q.price, "amount differs from quote");
        require!(q.price <= record.max_spend.0, "over verdict cap");
        let bal = self.escrow.get_mut(&agent).unwrap_or_else(|| env::panic_str("no escrow"));
        require!(*bal >= q.price, "insufficient escrow");
        *bal -= q.price;
        record.spent = true;
        record.checkout_ref = Some(checkout_ref.clone());
        self.spent_count += 1;
        emit(
            "settled",
            serde_json::json!({
                "nullifier": nullifier,
                "merchant": merchant,
                "payout": m.payout,
                "amount": U128(q.price),
                "discount_bps": q.discount_bps,
                "checkout_ref": checkout_ref,
            }),
        );
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(m.payout.clone(), U128(q.price), Some(format!("bookerbob:{checkout_ref}")))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_SETTLE_CALLBACK)
                    .on_settle_transfer(nullifier, agent, U128(q.price)),
            )
    }

    #[private]
    pub fn on_settle_transfer(&mut self, nullifier: String, agent: AccountId, amount: U128) -> bool {
        if env::promise_result_checked(0, 64).is_ok() {
            return true;
        }
        if let Some(bal) = self.escrow.get_mut(&agent) {
            *bal += amount.0;
        }
        if let Some(r) = self.verdicts.get_mut(&nullifier) {
            r.spent = false;
            r.checkout_ref = None;
        }
        self.spent_count = self.spent_count.saturating_sub(1);
        emit("settle_reverted", serde_json::json!({ "nullifier": nullifier, "agent": agent, "amount": amount }));
        false
    }
}

#[cfg(test)]
mod tests;
