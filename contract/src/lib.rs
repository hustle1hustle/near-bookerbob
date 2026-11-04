//! BookerBob `bazaar` contract.
//!
//! State: merchant registry (one merchant per account, usually a sub-account), enclave /
//! issuer key registry, verdict store keyed by nullifier (pending or spent), USDC escrow.
//! The chain's job: a global spent-set for nullifiers, signature checks with host
//! functions, a code-computed price, and payout atomic with the nullifier burn.

use bookerbob_core::{quote_in_cohort, DisputeDecision, Quote, Schedule, SigAlg, SignedVerdict, WorkerResult, WorldAttestation};
use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

pub const EVENT_STANDARD: &str = "bookerbob";
pub const EVENT_VERSION: &str = "0.1.0";
/// Deposit `storage_deposit` must attach to open an escrow entry.
pub const ESCROW_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// Enough for one verdict or merchant record; the unused part is refunded.
pub const RECORD_DEPOSIT: NearToken = NearToken::from_millinear(50);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_SETTLE_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_OUTLAYER: Gas = Gas::from_tgas(100);
const GAS_REFEREE_CALLBACK: Gas = Gas::from_tgas(30);

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
    /// sha256 of the envelope signing message, hex. Referee results must name it.
    pub digest: String,
    /// The referee receipt for one merchant's quote; `settle` requires it.
    pub receipt: Option<RefereeReceipt>,
    /// Set when an arbiter overturned a receipt after the purchase settled.
    pub disputed: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RefereeReceipt {
    pub merchant: AccountId,
    pub price: U128,
    pub receipt_hash: String,
    pub referee: String,
    /// sha256 of the referee result's signing message, what a dispute names.
    pub result_sha256: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Merchant {
    pub payout: AccountId,
    /// What the merchant sells, e.g. `hoodie` or `hotel-lisbon-2n`. Quotes compare within a category.
    pub category: String,
    pub schedule: Schedule,
}

#[near(serializers = [json])]
pub struct MerchantQuote {
    pub merchant: AccountId,
    pub quote: Quote,
}

#[ext_contract(ext_outlayer)]
#[allow(dead_code)]
trait OutLayer {
    fn request_execution(
        &mut self,
        source: serde_json::Value,
        resource_limits: serde_json::Value,
        input_data: String,
        response_format: String,
    );
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
    /// Registered referee worker keys (hex ed25519) to labels.
    referees: IterableMap<String, String>,
    outlayer: Option<AccountId>,
    /// `context|predicate` to the number of verdicts in that context revealing it.
    cohorts: LookupMap<String, u32>,
    /// World ID verifier service keys (hex ed25519) to labels.
    world_verifiers: IterableMap<String, String>,
    /// The World action this bazaar accepts.
    world_action: Option<String>,
    /// World nullifier to the one agent it bound.
    world_agents: LookupMap<String, AccountId>,
    /// Agent to its World nullifier.
    humans: LookupMap<AccountId, String>,
    /// Dispute arbiter keys (hex ed25519) to labels.
    arbiters: IterableMap<String, String>,
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

/// Charge the caller for storage added since `before`, refund the rest of the deposit.
fn charge_storage(before: u64) {
    let after = env::storage_usage();
    let cost = env::storage_byte_cost().saturating_mul(after.saturating_sub(before) as u128);
    let attached = env::attached_deposit();
    require!(attached >= cost, format!("attach at least {} yoctoNEAR for storage", cost.as_yoctonear()));
    let refund = attached.saturating_sub(cost);
    if !refund.is_zero() {
        Promise::new(env::predecessor_account_id()).transfer(refund).detach();
    }
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
            referees: IterableMap::new(b"r"),
            outlayer: None,
            cohorts: LookupMap::new(b"k"),
            world_verifiers: IterableMap::new(b"w"),
            world_action: None,
            world_agents: LookupMap::new(b"a"),
            humans: LookupMap::new(b"h"),
            arbiters: IterableMap::new(b"d"),
        }
    }

    fn cohort_key(context: &str, predicate: &str) -> String {
        format!("{context}|{predicate}")
    }

    /// Code-computed quote including the group unlock for the verdict's context.
    fn quote_for(&self, schedule: &Schedule, record: &VerdictRecord) -> Quote {
        quote_in_cohort(schedule, &record.predicates, |p| *self.cohorts.get(&Self::cohort_key(&record.context, p)).unwrap_or(&0))
    }

    /// How many verdicts in `context` revealed `predicate`. Only the count is public.
    pub fn cohort_size(&self, context: String, predicate: String) -> u32 {
        *self.cohorts.get(&Self::cohort_key(&context, &predicate)).unwrap_or(&0)
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

    // ---------- World ID: one person, one agent ----------

    /// Register the World ID verifier service key (hex ed25519) and the accepted action.
    pub fn register_world_verifier(&mut self, key_hex: String, action: String, label: String) {
        self.assert_owner();
        require!(key_hex.len() == 64 && hex::decode(&key_hex).is_ok(), "bad verifier key");
        self.world_verifiers.insert(key_hex.clone(), label.clone());
        self.world_action = Some(action.clone());
        emit("world_verifier_registered", serde_json::json!({ "key": key_hex, "action": action, "label": label }));
    }

    /// Bind an agent to a World ID holder. Anyone may relay the attestation; the verifier
    /// signature is what counts. A World nullifier binds exactly one agent.
    #[payable]
    pub fn attest_human(&mut self, attestation: WorldAttestation) {
        let before = env::storage_usage();
        let b = &attestation.body;
        if let Err(e) = b.validate() {
            env::panic_str(e);
        }
        require!(self.world_verifiers.contains_key(&attestation.verifier_key), "unknown world verifier");
        require!(self.world_action.as_deref() == Some(b.action.as_str()), "wrong world action");
        let sig: [u8; 64] = decode(&attestation.signature, "world signature");
        let pk: [u8; 32] = decode(&attestation.verifier_key, "world verifier key");
        require!(env::ed25519_verify(&sig, b.signing_message(), &pk), "bad world signature");
        let agent: AccountId = b.agent.parse().unwrap_or_else(|_| env::panic_str("bad agent"));
        match self.world_agents.get(&b.world_nullifier) {
            Some(bound) if *bound == agent => return,
            Some(_) => env::panic_str("one person, one agent: world id already bound to another agent"),
            None => {}
        }
        require!(!self.humans.contains_key(&agent), "agent already bound to another world id");
        self.world_agents.insert(b.world_nullifier.clone(), agent.clone());
        self.humans.insert(agent.clone(), b.world_nullifier.clone());
        emit("human_attested", serde_json::json!({ "agent": agent, "action": b.action }));
        self.world_agents.flush();
        self.humans.flush();
        charge_storage(before);
    }

    pub fn is_human(&self, agent: AccountId) -> bool {
        self.humans.contains_key(&agent)
    }

    // ---------- merchants ----------

    /// A merchant agent registers its own account (usually `mNN.<bazaar>`) with a discount
    /// schedule. The payout account must already be registered with the USDC contract
    /// (`storage_deposit` there), or the payout fails and `settle` rolls back.
    #[payable]
    pub fn register_merchant(&mut self, schedule: Schedule, category: String, payout: Option<AccountId>) {
        let before = env::storage_usage();
        if let Err(e) = schedule.validate() {
            env::panic_str(e);
        }
        require!(
            !category.is_empty() && category.len() <= 32 && category.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
            "bad category"
        );
        let merchant = env::predecessor_account_id();
        let payout = payout.unwrap_or_else(|| merchant.clone());
        self.merchants.insert(merchant.clone(), Merchant { payout: payout.clone(), category: category.clone(), schedule });
        emit("merchant_registered", serde_json::json!({ "merchant": merchant, "category": category, "payout": payout }));
        // store:: collections write on flush; flush now so the storage delta is measurable.
        self.merchants.flush();
        charge_storage(before);
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
    /// nullifier that is already pending or spent. The caller pays the storage of the record.
    #[payable]
    pub fn submit_verdict(&mut self, verdict: SignedVerdict) {
        let before = env::storage_usage();
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
        if e.predicates.iter().any(|p| p == "world_id_human") {
            require!(self.humans.contains_key(&env::predecessor_account_id()), "world_id_human needs a world attestation for this agent");
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
            digest: hex::encode(env::sha256_array(e.signing_message())),
            receipt: None,
            disputed: false,
        };
        self.verdicts.insert(e.nullifier.clone(), record);
        for p in &e.predicates {
            let k = Self::cohort_key(&e.context, p);
            let n = *self.cohorts.get(&k).unwrap_or(&0);
            self.cohorts.insert(k, n + 1);
        }
        emit(
            "verdict_submitted",
            serde_json::json!({
                "nullifier": e.nullifier,
                "commitment": e.commitment,
                "predicates": e.predicates,
                "tcb_status": e.attestation.tcb_status,
            }),
        );
        self.verdicts.flush();
        self.cohorts.flush();
        charge_storage(before);
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
        self.quote_for(&m.schedule, v)
    }

    /// Lowest price across merchants in `category` (all when None); ties go to the
    /// merchant registered first.
    pub fn best_quote(&self, nullifier: String, category: Option<String>) -> Option<MerchantQuote> {
        let v = self.verdicts.get(&nullifier).unwrap_or_else(|| env::panic_str("unknown nullifier"));
        let mut best: Option<MerchantQuote> = None;
        for (id, m) in self.merchants.iter() {
            if category.as_ref().is_some_and(|c| c != &m.category) {
                continue;
            }
            let q = self.quote_for(&m.schedule, v);
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

    // ---------- referee ----------

    /// Register a referee worker key (hex ed25519), e.g. the key an OutLayer TDX worker
    /// registered. This is the trust anchor: the contract checks every result signature.
    pub fn register_referee(&mut self, key_hex: String, label: String) {
        self.assert_owner();
        require!(key_hex.len() == 64 && hex::decode(&key_hex).is_ok(), "bad referee key");
        self.referees.insert(key_hex.clone(), label.clone());
        emit("referee_registered", serde_json::json!({ "key": key_hex, "label": label }));
    }

    pub fn referees(&self) -> Vec<(String, String)> {
        self.referees.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    pub fn set_outlayer(&mut self, outlayer: AccountId) {
        self.assert_owner();
        self.outlayer = Some(outlayer);
    }

    /// Accept a signed referee result. Anyone may relay it; the signature is what counts.
    /// A receipt is stored on the verdict; a refusal is logged (`receipt_refused`) and
    /// leaves the verdict without a receipt. Returns true for a stored receipt.
    pub fn submit_referee_result(&mut self, result: WorkerResult) -> bool {
        self.apply_referee_result(result)
    }

    /// Ask OutLayer to run the referee worker (`project_id`, e.g. `you.testnet/bookerbob-referee`).
    /// `input_data` is public on chain: synthetic fixtures only; real proofs use the HTTPS path.
    #[payable]
    pub fn request_referee(&mut self, project_id: String, input_data: String) -> Promise {
        let outlayer = self.outlayer.clone().unwrap_or_else(|| env::panic_str("outlayer not set"));
        ext_outlayer::ext(outlayer)
            .with_attached_deposit(env::attached_deposit())
            .with_static_gas(GAS_OUTLAYER)
            .request_execution(
                serde_json::json!({ "Project": { "project_id": project_id, "version_key": null } }),
                serde_json::json!({}),
                input_data,
                "Text".into(),
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_REFEREE_CALLBACK).on_referee_result())
    }

    /// OutLayer yield/resume callback: `promise_result(0)` is the worker's stdout.
    /// UNVERIFIED until the testnet hello-world: whether stdout arrives raw or as a JSON string.
    #[private]
    pub fn on_referee_result(&mut self) -> bool {
        let Ok(bytes) = env::promise_result_checked(0, 2048) else {
            emit("referee_failed", serde_json::json!({}));
            return false;
        };
        let parsed: Option<WorkerResult> = serde_json::from_slice(&bytes).ok().or_else(|| {
            serde_json::from_slice::<String>(&bytes).ok().and_then(|s| serde_json::from_str(&s).ok())
        });
        match parsed {
            Some(r) => self.apply_referee_result(r),
            None => {
                emit("referee_failed", serde_json::json!({ "reason": "unparseable worker output" }));
                false
            }
        }
    }

    fn apply_referee_result(&mut self, result: WorkerResult) -> bool {
        let b = &result.body;
        require!(b.v == 0, "unsupported referee result");
        require!(self.referees.contains_key(&result.worker_key), "unknown referee key");
        let sig: [u8; 64] = decode(&result.signature, "referee signature");
        let pk: [u8; 32] = decode(&result.worker_key, "referee key");
        require!(env::ed25519_verify(&sig, b.signing_message(), &pk), "bad referee signature");
        let merchant: AccountId = b.merchant.parse().unwrap_or_else(|_| env::panic_str("bad merchant"));
        let m = self.merchants.get(&merchant).cloned().unwrap_or_else(|| env::panic_str("unknown merchant"));
        let current = self.verdicts.get(&b.nullifier).cloned().unwrap_or_else(|| env::panic_str("unknown nullifier"));
        let q = self.quote_for(&m.schedule, &current);
        let record = self.verdicts.get_mut(&b.nullifier).expect("checked above");
        require!(!record.spent, "nullifier spent");
        require!(record.digest == b.verdict_digest, "referee result is for another verdict");
        require!(q.price == b.price, "referee price differs from quote");
        match b.outcome.as_str() {
            "receipt" => {
                record.receipt = Some(RefereeReceipt {
                    merchant: merchant.clone(),
                    price: U128(q.price),
                    receipt_hash: b.detail.clone(),
                    referee: result.worker_key.clone(),
                    result_sha256: hex::encode(env::sha256_array(b.signing_message())),
                });
                emit("referee_receipt", serde_json::json!({ "nullifier": b.nullifier, "merchant": merchant, "receipt_hash": b.detail }));
                true
            }
            "refused" => {
                emit("receipt_refused", serde_json::json!({ "nullifier": b.nullifier, "merchant": merchant, "reason": b.detail }));
                false
            }
            _ => env::panic_str("bad referee outcome"),
        }
    }

    // ---------- disputes ----------

    /// Register a dispute arbiter key (hex ed25519), e.g. a second OutLayer worker.
    pub fn register_arbiter(&mut self, key_hex: String, label: String) {
        self.assert_owner();
        require!(key_hex.len() == 64 && hex::decode(&key_hex).is_ok(), "bad arbiter key");
        self.arbiters.insert(key_hex.clone(), label.clone());
        emit("arbiter_registered", serde_json::json!({ "key": key_hex, "label": label }));
    }

    /// Apply a signed arbiter decision about the stored referee receipt. Anyone may relay.
    /// `overturned` before settle clears the receipt, so `settle` is blocked again; after
    /// settle it marks the record `disputed` (refunds are out of scope for v0).
    /// Returns true when the receipt was overturned.
    pub fn submit_dispute_decision(&mut self, decision: DisputeDecision) -> bool {
        let b = &decision.body;
        require!(b.v == 0, "unsupported dispute decision");
        require!(self.arbiters.contains_key(&decision.arbiter_key), "unknown arbiter key");
        let sig: [u8; 64] = decode(&decision.signature, "arbiter signature");
        let pk: [u8; 32] = decode(&decision.arbiter_key, "arbiter key");
        require!(env::ed25519_verify(&sig, b.signing_message(), &pk), "bad arbiter signature");
        let record = self.verdicts.get_mut(&b.nullifier).unwrap_or_else(|| env::panic_str("unknown nullifier"));
        require!(record.digest == b.verdict_digest, "dispute is for another verdict");
        let receipt = record.receipt.clone().unwrap_or_else(|| env::panic_str("no receipt to dispute"));
        require!(receipt.result_sha256 == b.referee_result_sha256, "dispute is for another referee result");
        match b.decision.as_str() {
            "upheld" => {
                emit("dispute_upheld", serde_json::json!({ "nullifier": b.nullifier }));
                false
            }
            "overturned" => {
                if record.spent {
                    record.disputed = true;
                    emit("dispute_overturned_after_settle", serde_json::json!({ "nullifier": b.nullifier, "reasons": b.reasons }));
                } else {
                    record.receipt = None;
                    emit("dispute_overturned", serde_json::json!({ "nullifier": b.nullifier, "reasons": b.reasons, "referee": receipt.referee }));
                }
                true
            }
            _ => env::panic_str("bad dispute decision"),
        }
    }

    // ---------- settle ----------

    /// Pay `merchant` for the verdict under `nullifier`. Called by the verdict's agent (a
    /// function-call key limited to this method is enough). `amount` must equal the
    /// code-computed price, stay within the verdict's `max_spend`, and carry a referee
    /// receipt for this merchant and price (no proof, no receipt, no payment). In one call: escrow
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
        // The receipt fixes the price: a cohort that grows after the receipt cannot change it.
        let price = match &record.receipt {
            Some(r) if r.merchant == merchant => r.price.0,
            _ => env::panic_str("no referee receipt for this quote"),
        };
        require!(amount.0 == price, "amount differs from quote");
        require!(price <= record.max_spend.0, "over verdict cap");
        let bal = self.escrow.get_mut(&agent).unwrap_or_else(|| env::panic_str("no escrow"));
        require!(*bal >= price, "insufficient escrow");
        *bal -= price;
        record.spent = true;
        record.checkout_ref = Some(checkout_ref.clone());
        self.spent_count += 1;
        emit(
            "settled",
            serde_json::json!({
                "nullifier": nullifier,
                "merchant": merchant,
                "payout": m.payout,
                "amount": U128(price),
                "checkout_ref": checkout_ref,
            }),
        );
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(m.payout.clone(), U128(price), Some(format!("bookerbob:{checkout_ref}")))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_SETTLE_CALLBACK)
                    .on_settle_transfer(nullifier, agent, U128(price)),
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
