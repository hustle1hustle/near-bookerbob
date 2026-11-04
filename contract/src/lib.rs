//! BookerBob `bazaar` contract.
//!
//! State: merchant registry (one merchant per account, usually a sub-account), enclave /
//! issuer key registry, verdict store keyed by nullifier (pending or spent), USDC escrow.
//! The chain's job: a global spent-set for nullifiers, signature checks with host
//! functions, a code-computed price, and payout atomic with the nullifier burn.

use bookerbob_core::near_ai::NearAiProof;
use bookerbob_core::{quote_in_cohort, DisputeDecision, Envelope, Quote, Schedule, SigAlg, SignedVerdict, WorkerResult, WorldAttestation};
use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

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
    /// Bytes the agent prepaid at submit for this record's later growth (referee receipt,
    /// settle). Growth is drawn from it, shrinkage goes back; the contract balance pays none.
    pub storage_reserve: u64,
    /// Set when the agent added a Semaphore identity to the merchant's review group.
    pub review_joined: bool,
    /// Set by the settle callback once the USDC transfer to the merchant succeeded.
    pub paid: bool,
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
    /// What the merchant sells, e.g. `hoodie` or `hotel-lisbon`. Quotes compare within a category.
    pub category: String,
    pub schedule: Schedule,
    /// Set by the owner. Unapproved merchants are never quoted and cannot be paid, so a
    /// flood of registrations cannot crowd out or undercut the board.
    pub approved: bool,
}

/// Largest `best_quote` page, so one view call has a bounded cost.
pub const MAX_QUOTE_PAGE: u32 = 100;
/// Prepaid growth per verdict record: a referee receipt (about 250 bytes) plus the settle
/// fields (checkout_ref up to 128 bytes). Charged to the agent in `submit_verdict`.
pub const RECORD_RESERVE_BYTES: u64 = 512;
/// Review rounds: ratings are released per round, after it closes, all at once.
pub const REVIEW_ROUND_MS: u64 = 24 * 3600 * 1000;
/// Recent group roots a review proof may use (members keep joining while others prove).
pub const REVIEW_ROOT_HISTORY: usize = 32;
/// Neutral prior for the merchant score: `(n * mean + C * 3) / (n + C)`.
pub const REVIEW_PRIOR_WEIGHT: u64 = 5;
/// Accounts one agent may hire.
pub const MAX_HIRES: usize = 16;
/// Seed mass per released rating (micro-units).
pub const SEED_PER_RATING: u128 = 1_000_000;

/// One merchant's review group: the LeanIMT and its recent roots.
#[near(serializers = [json, borsh])]
#[derive(Clone, Default)]
pub struct ReviewGroup {
    pub tree: bookerbob_core::semaphore::LeanImt,
    pub recent_roots: Vec<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Review {
    pub rating: u8,
    pub delivered: bool,
    pub reason_hash: String,
}

/// Ratings for one merchant and round. During the round only sealed hashes are posted
/// (chain state and tx arguments are public, so a plain rating would be visible the moment
/// it is sent). After the round closes, members reveal in a one-round window, only if the
/// group has at least `K_MIN` members; then `publish_reviews` releases them sorted by hash.
#[near(serializers = [json, borsh])]
#[derive(Clone, Default)]
pub struct ReviewRound {
    /// (Semaphore nullifier, sealed hash), posted during the round.
    pub sealed: Vec<(String, String)>,
    /// (sealed hash, rating), revealed after the round.
    pub revealed: Vec<(String, Review)>,
    pub published: bool,
}

#[near(serializers = [json])]
pub struct MerchantScore {
    pub merchant: AccountId,
    pub ratings: u64,
    pub mean_x100: u64,
    pub delivered_pct: u64,
    /// `(n * mean + 5 * 3) / (n + 5)`, times 100.
    pub score_x100: u64,
    pub members: u64,
}

#[near(serializers = [json])]
pub struct ReviewProof {
    pub depth: u32,
    pub merkle_root: String,
    pub nullifier: String,
    pub points: [String; 8],
}
/// Most sealed bids one round holds, so a round record stays small.
pub const MAX_ROUND_BIDS: usize = 100;

/// A blind round in one category. Approved merchants commit a hash of their discount
/// schedule before `commit_until_ms`, then reveal it before `reveal_until_ms`. A reveal
/// that does not open its commitment is refused; a bid not revealed in time is void. The
/// winner is readable only after the reveal deadline.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Round {
    pub category: String,
    pub commit_until_ms: u64,
    pub reveal_until_ms: u64,
    /// (merchant, commitment hex).
    pub commits: Vec<(AccountId, String)>,
    pub revealed: Vec<AccountId>,
}

#[near(serializers = [json])]
pub struct MerchantQuote {
    pub merchant: AccountId,
    pub quote: Quote,
}

#[ext_contract(ext_outlayer)]
#[allow(dead_code)]
trait OutLayer {
    fn request_execution(&mut self, source: serde_json::Value, resource_limits: serde_json::Value, input_data: String, response_format: String);
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
    /// Blind bid rounds by id.
    rounds: LookupMap<String, Round>,
    /// NEAR AI model signing key (hex) to the attestation the owner checked for it.
    model_attestations: LookupMap<String, ModelAttestation>,
    review_groups: LookupMap<AccountId, ReviewGroup>,
    /// `scope|nullifier` of every review accepted.
    review_nullifiers: LookupMap<String, bool>,
    /// `merchant|round` to its ratings.
    review_rounds: LookupMap<String, ReviewRound>,
    /// Merchant to (released ratings, rating sum, delivered count).
    review_totals: LookupMap<AccountId, (u64, u64, u64)>,
    /// Hire edges: who an agent hired (at most MAX_HIRES).
    hires: LookupMap<AccountId, Vec<AccountId>>,
}

/// A NEAR AI model key whose attestation the owner checked off chain (TDX quote to Intel's
/// root, report_data = key || nonce; `make verify` repeats that check on the committed
/// report). Verdicts signed with this key must name the same nonce.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct ModelAttestation {
    pub model: String,
    pub nonce: String,
    pub report_hash: String,
    pub tcb_status: String,
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
    charge_storage_plus(before, 0);
}

/// As `charge_storage`, plus `extra` bytes prepaid now for later growth.
fn charge_storage_plus(before: u64, extra: u64) {
    let after = env::storage_usage();
    let cost = env::storage_byte_cost().saturating_mul((after.saturating_sub(before) + extra) as u128);
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
            rounds: LookupMap::new(b"b"),
            model_attestations: LookupMap::new(b"n"),
            review_groups: LookupMap::new(b"g"),
            review_nullifiers: LookupMap::new(b"q"),
            review_rounds: LookupMap::new(b"o"),
            review_totals: LookupMap::new(b"t"),
            hires: LookupMap::new(b"x"),
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
        // A new or changed schedule waits for approval again: no bait and switch.
        self.merchants.insert(merchant.clone(), Merchant { payout: payout.clone(), category: category.clone(), schedule, approved: false });
        emit("merchant_registered", serde_json::json!({ "merchant": merchant, "category": category, "payout": payout, "approved": false }));
        // store:: collections write on flush; flush now so the storage delta is measurable.
        self.merchants.flush();
        charge_storage(before);
    }

    /// Owner approves a registered merchant's current schedule.
    pub fn approve_merchant(&mut self, merchant: AccountId) {
        self.assert_owner();
        let m = self.merchants.get_mut(&merchant).unwrap_or_else(|| env::panic_str("unknown merchant"));
        m.approved = true;
        emit("merchant_approved", serde_json::json!({ "merchant": merchant }));
    }

    /// Owner withdraws approval: the merchant drops out of quotes and cannot be paid.
    pub fn revoke_merchant(&mut self, merchant: AccountId) {
        self.assert_owner();
        let m = self.merchants.get_mut(&merchant).unwrap_or_else(|| env::panic_str("unknown merchant"));
        m.approved = false;
        emit("merchant_revoked", serde_json::json!({ "merchant": merchant }));
    }

    /// Test and measurement helper (unit-testing feature only): write every collection
    /// and the root state, as the runtime does at the end of a call.
    #[cfg(any(test, feature = "unit-testing"))]
    pub fn flush_all(&mut self) {
        self.issuers.flush();
        self.merchants.flush();
        self.verdicts.flush();
        self.escrow.flush();
        self.referees.flush();
        self.cohorts.flush();
        self.world_verifiers.flush();
        self.world_agents.flush();
        self.humans.flush();
        self.arbiters.flush();
        self.rounds.flush();
        self.model_attestations.flush();
        self.review_groups.flush();
        self.review_nullifiers.flush();
        self.review_rounds.flush();
        self.review_totals.flush();
        self.hires.flush();
        env::state_write(self);
    }

    // ---------- sealed reviews (Semaphore v4), see docs/semaphore.md ----------

    /// After `settle`, the record's agent adds one Semaphore identity commitment to the
    /// paid merchant's review group. One settled purchase, one membership.
    #[payable]
    pub fn join_review_group(&mut self, nullifier: String, identity_commitment: String) -> String {
        let before = env::storage_usage();
        let r = self.verdicts.get_mut(&nullifier).unwrap_or_else(|| env::panic_str("unknown nullifier"));
        require!(r.agent == env::predecessor_account_id(), "agent mismatch");
        require!(r.spent, "only a settled purchase joins a review group");
        // Not just spent: spent is set before the USDC transfer, and a failed transfer rolls
        // it back (audit finding A2). Only a confirmed payment earns a membership.
        require!(r.paid, "payment not confirmed yet");
        require!(!r.review_joined, "this purchase already joined");
        let merchant = r.receipt.as_ref().map(|x| x.merchant.clone()).unwrap_or_else(|| env::panic_str("no receipt"));
        r.review_joined = true;
        let mut g = self.review_groups.get(&merchant).cloned().unwrap_or_default();
        let root = g.tree.insert(&identity_commitment).unwrap_or_else(|e| env::panic_str(e));
        g.recent_roots.push(root.clone());
        if g.recent_roots.len() > REVIEW_ROOT_HISTORY {
            g.recent_roots.remove(0);
        }
        let size = g.tree.size;
        self.review_groups.insert(merchant.clone(), g);
        emit("review_member_added", serde_json::json!({ "merchant": merchant, "identity_commitment": identity_commitment, "root": root, "size": size }));
        self.verdicts.flush();
        self.review_groups.flush();
        charge_storage(before);
        root
    }

    pub fn review_group(&self, merchant: AccountId) -> Option<ReviewGroup> {
        self.review_groups.get(&merchant).cloned()
    }

    pub fn review_round_now(&self) -> u64 {
        env::block_timestamp_ms() / REVIEW_ROUND_MS
    }

    /// A sealed rating with a Semaphore proof of membership in the merchant's group. The
    /// scope is (merchant, current round): one rating per member per round. `sealed` =
    /// `review_seal(rating, delivered, reason_hash, salt)`; the rating is revealed after the
    /// round. Send it from an account that is not the buyer's agent (a fresh account or a
    /// relayer); the sender is public.
    #[payable]
    pub fn submit_review(&mut self, merchant: AccountId, sealed: String, proof: ReviewProof) {
        let before = env::storage_usage();
        let message = bookerbob_core::semaphore::review_message(&sealed).unwrap_or_else(|| env::panic_str("bad sealed rating"));
        let round = self.review_round_now();
        let g = self.review_groups.get(&merchant).unwrap_or_else(|| env::panic_str("merchant has no review group"));
        // Canonical decimals only: "0123" and "123" are one field element, and the
        // nullifier set compares strings (audit finding A5).
        require!(
            bookerbob_core::semaphore::is_canonical_field(&proof.nullifier) && bookerbob_core::semaphore::is_canonical_field(&proof.merkle_root),
            "nullifier and root must be canonical field elements"
        );
        require!(g.recent_roots.contains(&proof.merkle_root), "proof is not for this merchant's group");
        let scope = bookerbob_core::semaphore::review_scope(merchant.as_str(), round);
        let key = format!("{scope}|{}", proof.nullifier);
        require!(!self.review_nullifiers.contains_key(&key), "already rated this round");
        let ok =
            groth16::verify(&groth16::SemaphoreProof { depth: proof.depth, points: &proof.points }, [&proof.merkle_root, &proof.nullifier, &message, &scope])
                .unwrap_or_else(|e| env::panic_str(e));
        require!(ok, "invalid Semaphore proof");
        self.review_nullifiers.insert(key, true);
        let rk = format!("{merchant}|{round}");
        let mut rr = self.review_rounds.get(&rk).cloned().unwrap_or_default();
        rr.sealed.push((proof.nullifier.clone(), sealed));
        self.review_rounds.insert(rk, rr);
        emit("review_sealed", serde_json::json!({ "merchant": merchant, "round": round }));
        self.review_nullifiers.flush();
        self.review_rounds.flush();
        charge_storage(before);
    }

    /// After the round closes (within the next round): open a sealed rating. Refused while
    /// the group has fewer than K_MIN members, so a small group's ratings never appear.
    #[payable]
    pub fn reveal_review(&mut self, merchant: AccountId, round: u64, rating: u8, delivered: bool, reason_hash: String, salt: String) {
        let before = env::storage_usage();
        let now = self.review_round_now();
        require!(round < now, "round still open");
        require!(now <= round + 1, "reveal window is over");
        require!((1..=5).contains(&rating), "rating must be 1 to 5");
        require!(bookerbob_core::is_hex32(&reason_hash) && bookerbob_core::is_hex32(&salt), "bad reason hash or salt");
        let members = self.review_groups.get(&merchant).map_or(0, |g| g.tree.size);
        require!(members >= bookerbob_core::K_MIN as u64, "group below k: keep it sealed");
        let sealed = bookerbob_core::semaphore::review_seal(rating, delivered, &reason_hash, &salt);
        let rk = format!("{merchant}|{round}");
        let mut rr = self.review_rounds.get(&rk).cloned().unwrap_or_else(|| env::panic_str("no ratings for this round"));
        require!(rr.sealed.iter().any(|(_, h)| h == &sealed), "no sealed rating opens to this");
        require!(!rr.revealed.iter().any(|(h, _)| h == &sealed), "already revealed");
        rr.revealed.push((sealed, Review { rating, delivered, reason_hash }));
        self.review_rounds.insert(rk, rr);
        self.review_rounds.flush();
        charge_storage(before);
    }

    /// After the reveal window, release the round's revealed ratings together, sorted by
    /// sealed hash (not by arrival). False, and nothing released, below K_MIN members.
    /// The caller pays the storage it adds (the merchant's totals entry, audit A9).
    #[payable]
    pub fn publish_reviews(&mut self, merchant: AccountId, round: u64) -> bool {
        let before = env::storage_usage();
        let released = self.publish_reviews_inner(merchant, round);
        self.review_rounds.flush();
        self.review_totals.flush();
        charge_storage(before);
        released
    }

    fn publish_reviews_inner(&mut self, merchant: AccountId, round: u64) -> bool {
        require!(self.review_round_now() > round + 1, "reveal window still open");
        let rk = format!("{merchant}|{round}");
        let mut rr = self.review_rounds.get(&rk).cloned().unwrap_or_else(|| env::panic_str("no ratings for this round"));
        require!(!rr.published, "already published");
        let members = self.review_groups.get(&merchant).map_or(0, |g| g.tree.size);
        if members < bookerbob_core::K_MIN as u64 {
            emit("reviews_held", serde_json::json!({ "merchant": merchant, "round": round, "members": members, "k_min": bookerbob_core::K_MIN }));
            return false;
        }
        rr.revealed.sort_by(|a, b| a.0.cmp(&b.0));
        rr.published = true;
        let (mut n, mut sum, mut del) = self.review_totals.get(&merchant).copied().unwrap_or((0, 0, 0));
        for (_, r) in &rr.revealed {
            n += 1;
            sum += r.rating as u64;
            del += r.delivered as u64;
        }
        let (count, sealed) = (rr.revealed.len(), rr.sealed.len());
        self.review_rounds.insert(rk, rr);
        self.review_totals.insert(merchant.clone(), (n, sum, del));
        emit("reviews_published", serde_json::json!({ "merchant": merchant, "round": round, "ratings": count, "sealed": sealed, "members": members }));
        true
    }

    /// Released ratings only; a sealed round returns None.
    pub fn reviews(&self, merchant: AccountId, round: u64) -> Option<Vec<Review>> {
        self.review_rounds.get(&format!("{merchant}|{round}")).filter(|r| r.published).map(|r| r.revealed.iter().map(|(_, x)| x.clone()).collect())
    }

    pub fn merchant_score(&self, merchant: AccountId) -> MerchantScore {
        let (n, sum, del) = self.review_totals.get(&merchant).copied().unwrap_or((0, 0, 0));
        let members = self.review_groups.get(&merchant).map_or(0, |g| g.tree.size);
        let c = REVIEW_PRIOR_WEIGHT;
        MerchantScore {
            merchant,
            ratings: n,
            mean_x100: (sum * 100).checked_div(n).unwrap_or(0),
            delivered_pct: (del * 100).checked_div(n).unwrap_or(0),
            score_x100: (sum * 100 + c * 300) / (n + c),
            members,
        }
    }

    // ---------- conserved delegation along hire edges ----------

    /// The caller hires `sub_agent`: part of the caller's standing flows to it (damped,
    /// conserved). Anyone may hire; standing only starts at merchants with released ratings.
    #[payable]
    pub fn hire(&mut self, sub_agent: AccountId) {
        let before = env::storage_usage();
        let me = env::predecessor_account_id();
        let mut v = self.hires.get(&me).cloned().unwrap_or_default();
        require!(!v.contains(&sub_agent), "already hired");
        require!(v.len() < MAX_HIRES, "hire limit reached");
        v.push(sub_agent.clone());
        self.hires.insert(me.clone(), v);
        emit("hired", serde_json::json!({ "agent": me, "sub_agent": sub_agent }));
        self.hires.flush();
        charge_storage(before);
    }

    pub fn hired(&self, agent: AccountId) -> Vec<AccountId> {
        self.hires.get(&agent).cloned().unwrap_or_default()
    }

    /// Standing conferred by `merchant`'s seed (released ratings x 10^6 micro-units) on the
    /// agents it hired and theirs, with conserved transport w = 1/2: in total at most one
    /// seed's worth, following Design rule 3.6 (see core::delegation).
    pub fn standing_from(&self, merchant: AccountId) -> (U128, Vec<(AccountId, U128)>) {
        let (n, _, _) = self.review_totals.get(&merchant).copied().unwrap_or((0, 0, 0));
        let seed = n as u128 * SEED_PER_RATING;
        let got = bookerbob_core::delegation::conferred(merchant.as_str(), seed, bookerbob_core::delegation::W_HALF, |a: &str| {
            a.parse::<AccountId>().ok().and_then(|id| self.hires.get(&id).cloned()).unwrap_or_default().into_iter().map(|x| x.to_string())
        });
        (U128(seed), got.into_iter().map(|(k, v)| (k.parse().expect("account"), U128(v))).collect())
    }

    // ---------- blind bid rounds ----------

    /// Owner opens a round in `category` with a commit and a reveal deadline.
    pub fn open_round(&mut self, round_id: String, category: String, commit_until_ms: u64, reveal_until_ms: u64) {
        self.assert_owner();
        require!(!round_id.is_empty() && round_id.len() <= 64, "bad round id");
        require!(!self.rounds.contains_key(&round_id), "round exists");
        require!(env::block_timestamp_ms() < commit_until_ms && commit_until_ms < reveal_until_ms, "bad round deadlines");
        self.rounds.insert(round_id.clone(), Round { category: category.clone(), commit_until_ms, reveal_until_ms, commits: vec![], revealed: vec![] });
        emit(
            "round_opened",
            serde_json::json!({ "round": round_id, "category": category, "commit_until_ms": commit_until_ms, "reveal_until_ms": reveal_until_ms }),
        );
    }

    /// Phase 1: an approved merchant in the round's category posts a sealed bid.
    #[payable]
    pub fn commit_bid(&mut self, round_id: String, commitment: String) {
        let before = env::storage_usage();
        require!(bookerbob_core::is_hex32(&commitment), "bad commitment");
        let merchant = env::predecessor_account_id();
        let m = self.merchants.get(&merchant).cloned().unwrap_or_else(|| env::panic_str("unknown merchant"));
        require!(m.approved, "merchant not approved");
        let round = self.rounds.get_mut(&round_id).unwrap_or_else(|| env::panic_str("unknown round"));
        require!(m.category == round.category, "wrong category for this round");
        require!(env::block_timestamp_ms() < round.commit_until_ms, "commit phase is over");
        require!(!round.commits.iter().any(|(a, _)| a == &merchant), "already committed");
        require!(round.commits.len() < MAX_ROUND_BIDS, "round is full");
        round.commits.push((merchant.clone(), commitment.clone()));
        emit("bid_committed", serde_json::json!({ "round": round_id, "merchant": merchant, "commitment": commitment }));
        self.rounds.flush();
        charge_storage(before);
    }

    /// Phase 2: the merchant opens its bid. The schedule becomes its quoting schedule.
    #[payable]
    pub fn reveal_bid(&mut self, round_id: String, schedule: Schedule, salt: String) {
        let before = env::storage_usage();
        if let Err(e) = schedule.validate() {
            env::panic_str(e);
        }
        let salt: [u8; 32] = decode(&salt, "salt");
        let merchant = env::predecessor_account_id();
        let round = self.rounds.get_mut(&round_id).unwrap_or_else(|| env::panic_str("unknown round"));
        let now = env::block_timestamp_ms();
        require!(now >= round.commit_until_ms, "reveal opens after the commit deadline");
        require!(now < round.reveal_until_ms, "reveal phase is over");
        let (_, commitment) = round.commits.iter().find(|(a, _)| a == &merchant).cloned().unwrap_or_else(|| env::panic_str("no committed bid"));
        require!(!round.revealed.contains(&merchant), "already revealed");
        require!(bookerbob_core::bid_commitment(merchant.as_str(), &schedule, &salt) == commitment, "bid does not open its commitment");
        round.revealed.push(merchant.clone());
        let m = self.merchants.get_mut(&merchant).unwrap_or_else(|| env::panic_str("unknown merchant"));
        // Committed blind before the deadline, so this change keeps the approval.
        m.schedule = schedule;
        emit("bid_revealed", serde_json::json!({ "round": round_id, "merchant": merchant }));
        self.rounds.flush();
        self.merchants.flush();
        charge_storage(before);
    }

    pub fn round(&self, round_id: String) -> Option<Round> {
        self.rounds.get(&round_id).cloned()
    }

    /// Lowest price among bids revealed in the round, for this verdict. Only after the
    /// reveal deadline: before it, a merchant could still learn and react.
    pub fn round_best_quote(&self, round_id: String, nullifier: String) -> Option<MerchantQuote> {
        let round = self.rounds.get(&round_id).unwrap_or_else(|| env::panic_str("unknown round"));
        require!(env::block_timestamp_ms() >= round.reveal_until_ms, "round still open");
        let v = self.verdicts.get(&nullifier).unwrap_or_else(|| env::panic_str("unknown nullifier"));
        let mut best: Option<MerchantQuote> = None;
        for id in &round.revealed {
            let Some(m) = self.merchants.get(id).filter(|m| m.approved) else { continue };
            let q = self.quote_for(&m.schedule, v);
            if best.as_ref().is_none_or(|b| q.price < b.quote.price) {
                best = Some(MerchantQuote { merchant: id.clone(), quote: q });
            }
        }
        best
    }

    pub fn merchant(&self, merchant: AccountId) -> Option<Merchant> {
        self.merchants.get(&merchant).cloned()
    }

    pub fn merchants(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<(AccountId, Merchant)> {
        self.merchants.iter().skip(from_index.unwrap_or(0) as usize).take(limit.unwrap_or(50) as usize).map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    // ---------- verdicts and nullifiers ----------

    /// Submit a signed verdict. Called by the agent named in the envelope's `cnf`.
    /// Rejects: bad envelope, unknown key, bad signature, expired, agent mismatch, and a
    /// nullifier that is already pending or spent. The caller pays the storage of the record.
    #[payable]
    pub fn submit_verdict(&mut self, verdict: SignedVerdict) {
        let before = env::storage_usage();
        if let Err(msg) = verdict.envelope.validate() {
            env::panic_str(msg);
        }
        let key_id = verdict.key_id();
        require!(self.issuers.contains_key(&key_id), "unknown enclave key");
        require!(verify_signature(&verdict), "bad signature");
        self.accept_verdict(&verdict.envelope, key_id);
        charge_storage_plus(before, RECORD_RESERVE_BYTES);
    }

    /// Owner registers a NEAR AI model key after checking its attestation report off chain.
    pub fn register_model_attestation(&mut self, signing_key: String, attestation: ModelAttestation) {
        self.assert_owner();
        require!(bookerbob_core::is_hex32(&signing_key) && bookerbob_core::is_hex32(&attestation.nonce), "bad key or nonce");
        self.model_attestations.insert(signing_key.clone(), attestation.clone());
        emit(
            "model_attestation_registered",
            serde_json::json!({ "signing_key": signing_key, "model": attestation.model, "nonce": attestation.nonce, "tcb_status": attestation.tcb_status }),
        );
    }

    pub fn model_attestation(&self, signing_key: String) -> Option<ModelAttestation> {
        self.model_attestations.get(&signing_key).cloned()
    }

    /// A verdict issued by a NEAR AI model under E2EE v2. Accepted only with the proof: a
    /// registered model key with the same attestation nonce, the TEE signature over
    /// `model:request_sha256:sha256(response)`, and a sealed answer that opens with the
    /// disclosed key, echoes this envelope's binding and lists every revealed predicate.
    #[payable]
    pub fn submit_near_ai_verdict(&mut self, envelope: Envelope, proof: NearAiProof) {
        let before = env::storage_usage();
        if let Err(msg) = envelope.validate() {
            env::panic_str(msg);
        }
        let att = self.model_attestations.get(&proof.signing_key).cloned().unwrap_or_else(|| env::panic_str("unregistered model key"));
        require!(att.nonce == proof.nonce, "attestation nonce mismatch");
        require!(envelope.attestation.model == att.model && envelope.attestation.report_hash == att.report_hash, "envelope names another attestation");
        require!(envelope.attestation.tcb_status == att.tcb_status, "envelope tcb_status differs from the attestation");
        let sig: [u8; 64] = decode(&proof.signature, "TEE signature");
        let pk: [u8; 32] = decode(&proof.signing_key, "model key");
        require!(env::ed25519_verify(&sig, proof.signed_text(&att.model).as_bytes(), &pk), "bad TEE signature");
        if let Err(msg) = bookerbob_core::near_ai::check_binding(&envelope, &proof) {
            env::panic_str(msg);
        }
        self.accept_verdict(&envelope, format!("near-ai:{}", proof.signing_key));
        emit("near_ai_verdict", serde_json::json!({ "nullifier": envelope.nullifier, "chat_id": proof.chat_id, "signing_key": proof.signing_key }));
        charge_storage_plus(before, RECORD_RESERVE_BYTES);
    }

    /// Settle a record's storage change since `before` against its prepaid reserve.
    fn draw_reserve(&mut self, nullifier: &str, before: u64) {
        self.verdicts.flush();
        let after = env::storage_usage();
        let r = self.verdicts.get_mut(nullifier).unwrap_or_else(|| env::panic_str("unknown nullifier"));
        if after > before {
            let grow = after - before;
            require!(grow <= r.storage_reserve, "record storage reserve exhausted");
            r.storage_reserve -= grow;
        } else {
            r.storage_reserve += before - after;
        }
        // The reserve is a fixed-size u64: updating it does not change storage again.
        self.verdicts.flush();
    }

    /// Checks shared by every issuer path, then the record and the cohort counters.
    fn accept_verdict(&mut self, e: &Envelope, key_id: String) {
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
            storage_reserve: RECORD_RESERVE_BYTES,
            review_joined: false,
            paid: false,
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

    /// Lowest price across approved merchants in `category` (all when None), over the page
    /// `from_index .. from_index + limit` of the registry (default 50, at most
    /// `MAX_QUOTE_PAGE`). Ties go to the merchant registered first. A client with more
    /// merchants than one page asks page by page and keeps the lowest.
    ///
    /// Agents choose agents: on an equal price the merchant with the higher sealed-review
    /// score wins, and `min_score` (score times 100, see `merchant_score`) drops merchants
    /// below it. A merchant with no released ratings scores the neutral 3.00.
    pub fn best_quote(
        &self,
        nullifier: String,
        category: Option<String>,
        from_index: Option<u32>,
        limit: Option<u32>,
        min_score: Option<u64>,
    ) -> Option<MerchantQuote> {
        let v = self.verdicts.get(&nullifier).unwrap_or_else(|| env::panic_str("unknown nullifier"));
        let limit = limit.unwrap_or(50).min(MAX_QUOTE_PAGE) as usize;
        let mut best: Option<(MerchantQuote, u64)> = None;
        for (id, m) in self.merchants.iter().skip(from_index.unwrap_or(0) as usize).take(limit) {
            if !m.approved || category.as_ref().is_some_and(|c| c != &m.category) {
                continue;
            }
            let score = self.score_x100(id);
            if min_score.is_some_and(|min| score < min) {
                continue;
            }
            let q = self.quote_for(&m.schedule, v);
            let better = match &best {
                None => true,
                Some((b, bs)) => q.price < b.quote.price || (q.price == b.quote.price && score > *bs),
            };
            if better {
                best = Some((MerchantQuote { merchant: id.clone(), quote: q }, score));
            }
        }
        best.map(|(q, _)| q)
    }

    fn score_x100(&self, merchant: &AccountId) -> u64 {
        let (n, sum, _) = self.review_totals.get(merchant).copied().unwrap_or((0, 0, 0));
        (sum * 100 + REVIEW_PRIOR_WEIGHT * 300) / (n + REVIEW_PRIOR_WEIGHT)
    }

    // ---------- escrow (NEP-141 receiver) ----------

    /// Open an escrow entry for the caller (or `account_id`). Pays for its storage.
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) {
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        if self.escrow.contains_key(&account) {
            // Already open: refund the whole deposit instead of keeping it (audit A8).
            let d = env::attached_deposit();
            if !d.is_zero() {
                Promise::new(env::predecessor_account_id()).transfer(d).detach();
            }
            return;
        }
        require!(env::attached_deposit() >= ESCROW_STORAGE_DEPOSIT, "attach at least 0.01 NEAR");
        self.escrow.insert(account, 0);
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
        let parsed: Option<WorkerResult> =
            serde_json::from_slice(&bytes).ok().or_else(|| serde_json::from_slice::<String>(&bytes).ok().and_then(|s| serde_json::from_str(&s).ok()));
        match parsed {
            // Report instead of panicking, so a hello-world run shows the output arrived.
            Some(r) if !self.verdicts.contains_key(&r.body.nullifier) => {
                emit(
                    "referee_failed",
                    serde_json::json!({ "reason": "unknown nullifier", "output_sha256": hex::encode(env::sha256_array(&bytes)), "outcome": r.body.outcome }),
                );
                false
            }
            Some(r) => self.apply_referee_result(r),
            None => {
                emit("referee_failed", serde_json::json!({ "reason": "unparseable worker output" }));
                false
            }
        }
    }

    fn apply_referee_result(&mut self, result: WorkerResult) -> bool {
        self.verdicts.flush();
        let before = env::storage_usage();
        let nullifier = result.body.nullifier.clone();
        let stored = self.apply_referee_result_inner(result);
        self.draw_reserve(&nullifier, before);
        stored
    }

    fn apply_referee_result_inner(&mut self, result: WorkerResult) -> bool {
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

    // ---------- withdraw ----------

    /// Take unspent USDC back out of escrow. Requires 1 yoctoNEAR (full-access key), like
    /// NEP-141 transfers, so an agent's function-call key cannot drain escrow this way.
    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        near_sdk::assert_one_yocto();
        let account = env::predecessor_account_id();
        let bal = self.escrow.get_mut(&account).unwrap_or_else(|| env::panic_str("no escrow"));
        require!(amount.0 > 0 && *bal >= amount.0, "insufficient escrow");
        *bal -= amount.0;
        emit("escrow_withdraw", serde_json::json!({ "account": account, "amount": amount }));
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(account.clone(), amount, Some("bookerbob:withdraw".into()))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_SETTLE_CALLBACK).on_withdraw(account, amount))
    }

    #[private]
    pub fn on_withdraw(&mut self, account: AccountId, amount: U128) -> bool {
        if env::promise_result_checked(0, 64).is_ok() {
            return true;
        }
        if let Some(bal) = self.escrow.get_mut(&account) {
            *bal += amount.0;
        }
        emit("withdraw_reverted", serde_json::json!({ "account": account, "amount": amount }));
        false
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
        require!(m.approved, "merchant not approved");
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
        self.verdicts.flush();
        let before = env::storage_usage();
        let record = self.verdicts.get_mut(&nullifier).expect("checked above");
        record.spent = true;
        record.checkout_ref = Some(checkout_ref.clone());
        self.draw_reserve(&nullifier, before);
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
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_SETTLE_CALLBACK).on_settle_transfer(nullifier, agent, U128(price)))
    }

    #[private]
    pub fn on_settle_transfer(&mut self, nullifier: String, agent: AccountId, amount: U128) -> bool {
        if env::promise_result_checked(0, 64).is_ok() {
            if let Some(r) = self.verdicts.get_mut(&nullifier) {
                r.paid = true;
            }
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

pub mod groth16;

#[cfg(test)]
mod tests;
