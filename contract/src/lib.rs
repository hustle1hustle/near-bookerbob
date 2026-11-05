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
pub const RECORD_RESERVE_BYTES: u64 = 768;
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
    /// Hash chain over every graph event (hires and review releases), see bookerbob-graph.
    graph_root: [u8; 32],
    graph_events: u64,
    /// sha256 of the Jolt guest ELF whose proofs a score update must come from.
    graph_program: Option<String>,
    /// Merchant scores from the latest accepted proven update, and the root it was for.
    proven_scores: LookupMap<AccountId, u64>,
    proven_root: Option<String>,
    /// `context|predicate` to the hash chain over the nullifiers of the verdicts counted in
    /// that cohort (bookerbob-zkcore::cohort): what the cohort guest proves k >= 5 against.
    cohort_roots: LookupMap<String, [u8; 32]>,
}

/// Domain tag of the worker's signature over a proven score update.
pub const GRAPH_UPDATE_TAG: &[u8] = b"bookerbob/graph-update/v0\x00";
/// An arbiter's signed resolution of a challenged graph update.
pub const GRAPH_CHALLENGE_TAG: &[u8] = b"bookerbob/graph-challenge/v0\x00";
/// The permissionless category: a merchant is approved by bonding OPEN_BOND (in USDC or the
/// testnet demo token) instead of by the owner.
pub const OPEN_CATEGORY: &str = "open";
pub const OPEN_BOND: u128 = 10_000_000;
/// Bond a worker key must hold to post a graph update; slashed to a successful challenger.
pub const WORKER_BOND: NearToken = NearToken::from_millinear(500);
/// Bond a challenger posts; paid to the worker's bonder if the update was valid.
pub const CHALLENGE_BOND: NearToken = NearToken::from_millinear(100);

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

// ---------- testnet demo mode, see docs/demo-mode-plan.md ----------

/// Demo mode exists only on a `.testnet` bazaar. Checked when it is switched on and again
/// on every use, so a mainnet deploy refuses the demo token even with one stored.
fn is_testnet() -> bool {
    env::current_account_id().as_str().ends_with(".testnet")
}

/// The free-mint demo token (dUSDC), if the owner set one. None off testnet.
fn demo_token_id() -> Option<AccountId> {
    if !is_testnet() {
        return None;
    }
    env::storage_read(b"demo_token").and_then(|b| String::from_utf8(b).ok()).and_then(|s| s.parse().ok())
}

/// Demo-token escrow, kept apart from USDC escrow: a balance in one never pays in the other.
fn demo_escrow() -> LookupMap<AccountId, u128> {
    LookupMap::new(b"D")
}

/// Sealed verdicts: nullifier to the `disclosure` commitment (predicates, tier, cap, salt).
fn disclosures() -> LookupMap<String, String> {
    LookupMap::new(b"Z")
}

/// Every price the code can produce for `schedule` from some subset of its discount
/// predicates, with no cohort. `world_id_human` counts only for a World-bound agent.
/// A sealed verdict's receipt price must be one of these.
fn achievable_price(schedule: &Schedule, price: u128, human: bool) -> bool {
    let preds: Vec<String> = schedule.rules.iter().map(|r| r.predicate.clone()).filter(|p| human || p != "world_id_human").collect();
    require!(preds.len() <= 8, "schedule too large for a sealed verdict");
    (0u32..1 << preds.len()).any(|mask| {
        let mut set: Vec<String> = preds.iter().enumerate().filter(|(i, _)| mask >> i & 1 == 1).map(|(_, p)| p.clone()).collect();
        set.sort();
        set.dedup();
        bookerbob_core::quote(schedule, &set).price == price
    })
}

/// Records paid in the demo token (absent means USDC).
fn demo_paid() -> LookupMap<String, bool> {
    LookupMap::new(b"T")
}

/// Distinct World-bound persons per merchant's review group: `merchant|world_nullifier`.
fn group_persons() -> LookupMap<String, bool> {
    LookupMap::new(b"P")
}

/// Per merchant: (distinct persons, joins tracked since person counting began). Members who
/// joined before (all World-bound demo buyers) count once each: tree size minus tracked.
fn group_person_counts() -> LookupMap<AccountId, (u64, u64)> {
    LookupMap::new(b"Q")
}

// ---------- challengeable graph updates and bonds, see docs/jolt.md ----------

/// A worker key's bond: (bonder account, yoctoNEAR).
fn worker_bonds() -> LookupMap<String, (AccountId, u128)> {
    LookupMap::new(b"W")
}

/// The graph update waiting out its challenge window (at most one at a time).
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct PendingGraphUpdate {
    pub program_hash: String,
    pub root: String,
    pub scores_hash: String,
    /// sha256 of the Jolt proof file the worker verified; anyone can fetch and re-verify it.
    pub proof_sha256: String,
    pub worker_key: String,
    pub merchants: Vec<(AccountId, u64, u64)>,
    pub submitted_ms: u64,
    /// The challenger and its bond, once challenged: the update is frozen until resolved.
    pub challenger: Option<(AccountId, U128)>,
}

fn pending_graph() -> Option<PendingGraphUpdate> {
    env::storage_read(b"pending_graph").and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}

fn set_pending_graph(p: Option<&PendingGraphUpdate>) {
    match p {
        Some(p) => {
            env::storage_write(b"pending_graph", &near_sdk::borsh::to_vec(p).expect("borsh"));
        }
        None => {
            env::storage_remove(b"pending_graph");
        }
    }
}

/// The challenge window: one review round (24 h; 5 min on the testnet demo).
fn challenge_window_ms() -> u64 {
    round_ms()
}

/// Per settled record: sha256 over what the payment relied on (the verdict digest, the
/// referee receipt hash, the merchant, the price, the token). What a dispute is judged against.
fn liabilities() -> LookupMap<String, String> {
    LookupMap::new(b"L")
}

/// A merchant's refund bond per token ("usdc" or "demo"), in token base units.
fn merchant_bonds() -> LookupMap<String, u128> {
    LookupMap::new(b"M")
}

/// The merchant's refund bond across tokens (USDC plus, on testnet, the demo token).
fn bonded(merchant: &AccountId) -> u128 {
    let b = merchant_bonds();
    b.get(&format!("{merchant}|usdc")).copied().unwrap_or(0) + b.get(&format!("{merchant}|demo")).copied().unwrap_or(0)
}

// ---------- timelock on trust anchors ----------

/// A trust-anchor change waiting out the owner's delay: anyone can watch it and object
/// before it takes effect.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct PendingAnchor {
    /// `issuer`, `referee`, `arbiter`, `world_verifier` or `delay`.
    pub kind: String,
    /// The call's arguments, as JSON.
    pub args: String,
    pub ready_ms: u64,
}

fn pending_anchors() -> LookupMap<u64, PendingAnchor> {
    LookupMap::new(b"A")
}

fn read_u64(key: &[u8]) -> u64 {
    env::storage_read(key).map(|b| u64::from_le_bytes(b.try_into().expect("u64"))).unwrap_or(0)
}

/// 0 (no delay) unless the owner set one with `set_anchor_delay`.
fn anchor_delay_ms() -> u64 {
    read_u64(b"anchor_delay_ms")
}

pub const MAX_ANCHOR_DELAY_MS: u64 = 30 * 24 * 3600 * 1000;

/// Distinct registered arbiters that must sign a dispute decision or a challenge resolution.
fn arbiter_quorum() -> u64 {
    read_u64(b"arbiter_threshold").max(1)
}

// ---------- buying groups on sealed intents ----------

/// A buying group: verdicts that revealed the same predicate set for the same category and
/// context. Members are indistinguishable by what they revealed; the discount is one of a few
/// fixed tiers, so the amount paid says only which tier the group reached.
#[near(serializers = [json, borsh])]
#[derive(Clone, Default)]
pub struct BuyingGroup {
    pub category: String,
    pub context: String,
    pub predicates: Vec<String>,
    /// Member nullifiers, in arrival order.
    pub members: Vec<String>,
    /// sha256(budget || salt) per member: a buyer's budget stays sealed.
    pub budgets: Vec<String>,
    /// Distinct World-bound persons among the members.
    pub persons: u64,
    /// The best merchant offer: (merchant, tier bps, the member price it gives).
    pub offer: Option<(AccountId, u16, U128)>,
}

// ---------- market fee into a treasury ----------

/// The most the owner may set as the market fee: 2%.
pub const MAX_FEE_BPS: u64 = 200;

fn fee_rate() -> u64 {
    read_u64(b"fee_bps")
}

/// Fees accrued in the contract per token ("usdc" or "demo"), swept to the treasury.
fn fee_ledger() -> LookupMap<String, u128> {
    LookupMap::new(b"F")
}

/// The fee taken on each settled nullifier, kept so a failed payout can give it back.
fn settle_fees() -> LookupMap<String, u128> {
    LookupMap::new(b"f")
}

// ---------- certified private evals (the envelope's second use) ----------

/// The tag an eval certificate's signing message starts with.
pub const EVAL_TAG: &[u8] = b"bookerbob/eval-certificate/v0\x00";

/// A certified result over a private eval set: the set is public only as a root of salted
/// item hashes, every answer is signed by the attested model key (checked off chain, its
/// signatures listed under `answers_hash`), the score is graded by code and quantized.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvalCertificate {
    pub v: u8,
    /// What was evaluated, e.g. a model id or an agent account.
    pub subject: String,
    pub set_root: String,
    pub n: u32,
    /// Correct answers out of n, and the score in whole percent, floored to a multiple of 10.
    pub correct: u32,
    pub score_bucket: u8,
    /// sha256 over the model's per-answer TEE signature texts.
    pub answers_hash: String,
    pub issued_at_ms: u64,
}

fn eval_sets() -> LookupMap<String, (u32, String)> {
    LookupMap::new(b"V")
}

fn eval_scores() -> LookupMap<String, u8> {
    LookupMap::new(b"S")
}

/// Quantized group tiers: (persons needed, the most a merchant may offer, bps).
pub const GROUP_TIERS: [(u64, u16); 2] = [(5, 1000), (10, 2000)];

fn groups() -> LookupMap<String, BuyingGroup> {
    LookupMap::new(b"G")
}

fn intents() -> LookupMap<String, String> {
    LookupMap::new(b"I")
}

fn group_persons_seen() -> LookupMap<String, bool> {
    LookupMap::new(b"H")
}

fn group_tier(persons: u64) -> u16 {
    GROUP_TIERS.iter().filter(|(k, _)| persons >= *k).map(|(_, b)| *b).max().unwrap_or(0)
}

/// The lowest TDX TCB status a verdict may carry to be quoted or paid. Default UpToDate.
fn tcb_floor() -> String {
    env::storage_read(b"min_tcb").and_then(|b| String::from_utf8(b).ok()).unwrap_or_else(|| "UpToDate".into())
}

/// The verdict's enclave status meets the floor. Synthetic `fixture` verdicts pass on a
/// `.testnet` bazaar only (demo and make verify), never on mainnet.
fn tcb_ok(status: &str) -> bool {
    bookerbob_core::envelope::tcb_meets(status, &tcb_floor(), is_testnet())
}

/// Review round length: 24 h, or a shorter testnet-only value for the demo.
fn round_ms() -> u64 {
    if !is_testnet() {
        return REVIEW_ROUND_MS;
    }
    env::storage_read(b"review_round_ms").map(|b| u64::from_le_bytes(b.try_into().expect("u64"))).unwrap_or(REVIEW_ROUND_MS)
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
            graph_root: [0u8; 32],
            graph_events: 0,
            graph_program: None,
            proven_scores: LookupMap::new(b"z"),
            proven_root: None,
            cohort_roots: LookupMap::new(b"c"),
        }
    }

    fn cohort_key(context: &str, predicate: &str) -> String {
        format!("{context}|{predicate}")
    }

    /// Code-computed quote including the group unlock for the verdict's context.
    fn quote_for(&self, schedule: &Schedule, record: &VerdictRecord) -> Quote {
        require!(record.tier != bookerbob_core::SEALED_TIER, "a sealed verdict is priced by the referee from its opening");
        quote_in_cohort(schedule, &record.predicates, |p| *self.cohorts.get(&Self::cohort_key(&record.context, p)).unwrap_or(&0))
    }

    /// The cohort commitment for (context, predicate) and its size.
    pub fn cohort_root(&self, context: String, predicate: String) -> (String, u32) {
        let k = Self::cohort_key(&context, &predicate);
        (hex::encode(self.cohort_roots.get(&k).copied().unwrap_or([0u8; 32])), *self.cohorts.get(&k).unwrap_or(&0))
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
    /// Owner: delay every later trust-anchor change by `ms` (at most 30 days). Raising the
    /// delay applies at once; lowering it is itself queued under the current delay.
    pub fn set_anchor_delay(&mut self, ms: u64) {
        self.assert_owner();
        require!(ms <= MAX_ANCHOR_DELAY_MS, "delay over 30 days");
        if ms < anchor_delay_ms() && self.queue_anchor("delay", serde_json::json!({ "ms": ms })) {
            return;
        }
        env::storage_write(b"anchor_delay_ms", &ms.to_le_bytes());
        emit("anchor_delay_set", serde_json::json!({ "ms": ms }));
    }

    /// Owner: how many distinct arbiters must sign. Raising applies at once (at most the
    /// registered arbiters); lowering waits out the anchor delay like any trust-anchor change.
    pub fn set_arbiter_threshold(&mut self, n: u64) {
        self.assert_owner();
        require!(n >= 1 && n <= self.arbiters.len() as u64, "threshold must be 1 to the number of arbiters");
        if n < arbiter_quorum() && self.queue_anchor("arbiter_threshold", serde_json::json!({ "n": n })) {
            return;
        }
        env::storage_write(b"arbiter_threshold", &n.to_le_bytes());
        emit("arbiter_threshold_set", serde_json::json!({ "n": n }));
    }

    pub fn arbiter_threshold(&self) -> u64 {
        arbiter_quorum()
    }

    /// Owner: the market fee (at most 2%) and the treasury it is swept to, e.g. a Sputnik DAO.
    /// Raising the fee, or changing the treasury, waits out the anchor timelock.
    pub fn set_fee(&mut self, bps: u64, treasury: AccountId) {
        self.assert_owner();
        require!(bps <= MAX_FEE_BPS, "fee over 2%");
        let same_to = env::storage_read(b"fee_to").map(|b| b == treasury.as_bytes()).unwrap_or(false);
        if (bps > fee_rate() || !same_to) && self.queue_anchor("fee", serde_json::json!({ "bps": bps, "to": treasury })) {
            return;
        }
        env::storage_write(b"fee_bps", &bps.to_le_bytes());
        env::storage_write(b"fee_to", treasury.as_bytes());
        emit("fee_set", serde_json::json!({ "bps": bps, "treasury": treasury }));
    }

    pub fn fee(&self) -> (u64, Option<AccountId>) {
        (fee_rate(), env::storage_read(b"fee_to").and_then(|b| String::from_utf8(b).ok()).and_then(|s| s.parse().ok()))
    }

    pub fn fees_accrued(&self, token: String) -> U128 {
        U128(fee_ledger().get(&token).copied().unwrap_or(0))
    }

    /// Anyone: send the accrued fees in `token` ("usdc" or "demo") to the treasury.
    pub fn sweep_fees(&mut self, token: String) -> Promise {
        let to: AccountId = env::storage_read(b"fee_to")
            .and_then(|b| String::from_utf8(b).ok())
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| env::panic_str("no treasury set"));
        let contract = match token.as_str() {
            "usdc" => self.usdc.clone(),
            "demo" => demo_token_id().unwrap_or_else(|| env::panic_str("no demo token")),
            _ => env::panic_str("token is usdc or demo"),
        };
        let mut fa = fee_ledger();
        let amount = fa.get(&token).copied().unwrap_or(0);
        require!(amount > 0, "no fees to sweep");
        fa.insert(token.clone(), 0);
        fa.flush();
        emit("fees_swept", serde_json::json!({ "token": token, "amount": U128(amount), "to": to }));
        ext_ft::ext(contract)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(to, U128(amount), Some("bookerbob:fees".into()))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_SETTLE_CALLBACK).on_sweep(token, U128(amount)))
    }

    #[private]
    pub fn on_sweep(&mut self, token: String, amount: U128) -> bool {
        if env::promise_result_checked(0, 64).is_ok() {
            return true;
        }
        let mut fa = fee_ledger();
        let v = fa.get(&token).copied().unwrap_or(0) + amount.0;
        fa.insert(token, v);
        fa.flush();
        false
    }

    /// Owner: an eval set, known only by its root of salted item hashes, and its size.
    pub fn register_eval_set(&mut self, set_root: String, n: u32, label: String) {
        self.assert_owner();
        require!(bookerbob_core::is_hex32(&set_root) && n > 0, "bad eval set");
        let mut e = eval_sets();
        e.insert(set_root.clone(), (n, label.clone()));
        e.flush();
        emit("eval_set_registered", serde_json::json!({ "set_root": set_root, "n": n, "label": label }));
    }

    /// Anyone relays an eval certificate signed by a registered issuer key (ed25519,
    /// `ed25519:<hex>` as in `issuers`); the score is stored per (subject, set).
    #[payable]
    pub fn submit_eval_certificate(&mut self, certificate: EvalCertificate, issuer_key: String, signature: String) {
        let before = env::storage_usage();
        let c = &certificate;
        require!(c.v == 0, "unsupported certificate");
        let (n, _) = eval_sets().get(&c.set_root).cloned().unwrap_or_else(|| env::panic_str("unknown eval set"));
        require!(c.n == n && c.correct <= n, "certificate does not match the set size");
        let pct = (c.correct as u64 * 100 / n as u64) as u8;
        require!(c.score_bucket == pct / 10 * 10, "score bucket must be the floored score");
        require!(bookerbob_core::is_hex32(&c.answers_hash), "bad answers hash");
        require!(self.issuers.contains_key(&issuer_key), "unknown issuer key");
        let pk: [u8; 32] = decode(issuer_key.strip_prefix("ed25519:").unwrap_or_else(|| env::panic_str("eval issuers are ed25519")), "issuer key");
        let sig: [u8; 64] = decode(&signature, "issuer signature");
        let mut msg = EVAL_TAG.to_vec();
        msg.extend(serde_json::to_vec(c).expect("json"));
        require!(env::ed25519_verify(&sig, env::sha256_array(&msg), &pk), "bad issuer signature");
        let mut s = eval_scores();
        s.insert(format!("{}|{}", c.subject, c.set_root), c.score_bucket);
        s.flush();
        emit("eval_certified", serde_json::json!({ "subject": c.subject, "set_root": c.set_root, "score_bucket": c.score_bucket, "n": n }));
        charge_storage(before);
    }

    pub fn eval_score(&self, subject: String, set_root: String) -> Option<u8> {
        eval_scores().get(&format!("{subject}|{set_root}")).copied()
    }

    /// The predicate a buyer or a merchant checks: `eval_score_gte(threshold)` for a subject.
    pub fn eval_passes(&self, subject: String, set_root: String, threshold: u8) -> bool {
        self.eval_score(subject, set_root).is_some_and(|s| s >= threshold)
    }

    pub fn anchor_delay(&self) -> u64 {
        anchor_delay_ms()
    }

    pub fn pending_anchor(&self, id: u64) -> Option<PendingAnchor> {
        pending_anchors().get(&id).cloned()
    }

    /// Queue `kind` when a delay is set; false (apply now) when there is none.
    fn queue_anchor(&mut self, kind: &str, args: serde_json::Value) -> bool {
        let delay = anchor_delay_ms();
        if delay == 0 {
            return false;
        }
        let id = read_u64(b"anchor_seq") + 1;
        env::storage_write(b"anchor_seq", &id.to_le_bytes());
        let p = PendingAnchor { kind: kind.into(), args: args.to_string(), ready_ms: env::block_timestamp_ms() + delay };
        emit("anchor_queued", serde_json::json!({ "id": id, "kind": kind, "args": args, "ready_ms": p.ready_ms }));
        let mut q = pending_anchors();
        q.insert(id, p);
        q.flush();
        true
    }

    /// Anyone, after the delay: apply a queued trust-anchor change.
    pub fn execute_anchor(&mut self, id: u64) {
        let mut q = pending_anchors();
        let p = q.remove(&id).unwrap_or_else(|| env::panic_str("no such pending change"));
        require!(env::block_timestamp_ms() >= p.ready_ms, "timelock: not ready yet");
        q.flush();
        let a: serde_json::Value = serde_json::from_str(&p.args).expect("stored json");
        let s = |k: &str| a[k].as_str().unwrap_or_default().to_string();
        match p.kind.as_str() {
            "issuer" => {
                self.issuers.insert(s("key_id"), s("label"));
                emit("issuer_registered", serde_json::json!({ "key_id": s("key_id"), "label": s("label"), "timelock": id }));
            }
            "referee" => {
                self.referees.insert(s("key_hex"), s("label"));
                emit("referee_registered", serde_json::json!({ "key": s("key_hex"), "label": s("label"), "timelock": id }));
            }
            "arbiter" => {
                self.arbiters.insert(s("key_hex"), s("label"));
                emit("arbiter_registered", serde_json::json!({ "key": s("key_hex"), "label": s("label"), "timelock": id }));
            }
            "world_verifier" => {
                self.world_verifiers.insert(s("key_hex"), s("label"));
                self.world_action = Some(s("action"));
                emit("world_verifier_registered", serde_json::json!({ "key": s("key_hex"), "action": s("action"), "label": s("label"), "timelock": id }));
            }
            "fee" => {
                let bps = a["bps"].as_u64().expect("bps");
                env::storage_write(b"fee_bps", &bps.to_le_bytes());
                env::storage_write(b"fee_to", s("to").as_bytes());
                emit("fee_set", serde_json::json!({ "bps": bps, "treasury": s("to"), "timelock": id }));
            }
            "arbiter_threshold" => {
                let n = a["n"].as_u64().expect("n");
                env::storage_write(b"arbiter_threshold", &n.to_le_bytes());
                emit("arbiter_threshold_set", serde_json::json!({ "n": n, "timelock": id }));
            }
            "model_attestation" => {
                let att: ModelAttestation = serde_json::from_value(a["attestation"].clone()).expect("stored attestation");
                self.store_model_attestation(s("signing_key"), att);
            }
            "min_tcb" => {
                env::storage_write(b"min_tcb", s("status").as_bytes());
                emit("min_tcb_set", serde_json::json!({ "status": s("status"), "timelock": id }));
            }
            "graph_program" => {
                self.graph_program = Some(s("program_hash"));
                emit("graph_program_set", serde_json::json!({ "program_hash": s("program_hash"), "timelock": id }));
            }
            "delay" => {
                let ms = a["ms"].as_u64().expect("ms");
                env::storage_write(b"anchor_delay_ms", &ms.to_le_bytes());
                emit("anchor_delay_set", serde_json::json!({ "ms": ms, "timelock": id }));
            }
            _ => env::panic_str("unknown pending kind"),
        }
    }

    /// Owner: drop a queued change before it executes.
    pub fn cancel_anchor(&mut self, id: u64) {
        self.assert_owner();
        let mut q = pending_anchors();
        require!(q.remove(&id).is_some(), "no such pending change");
        q.flush();
        emit("anchor_cancelled", serde_json::json!({ "id": id }));
    }

    pub fn register_issuer(&mut self, key_id: String, label: String) {
        self.assert_owner();
        require!(key_id.starts_with("ed25519:") || key_id.starts_with("p256:"), "bad key id");
        if self.queue_anchor("issuer", serde_json::json!({ "key_id": key_id, "label": label })) {
            return;
        }
        self.issuers.insert(key_id.clone(), label.clone());
        emit("issuer_registered", serde_json::json!({ "key_id": key_id, "label": label }));
    }

    /// Not timelocked on purpose: removing a key only narrows trust, and it is the response to
    /// a stolen issuer key. Adding its replacement waits out the delay.
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
        if self.queue_anchor("world_verifier", serde_json::json!({ "key_hex": key_hex, "action": action, "label": label })) {
            return;
        }
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
        // A new or changed schedule waits for approval again: no bait and switch. In the open
        // category the bond is the approval: a bonded merchant stays approved, and a schedule
        // change keeps the bond at stake.
        let approved = category == OPEN_CATEGORY && bonded(&merchant) >= OPEN_BOND;
        self.merchants.insert(merchant.clone(), Merchant { payout: payout.clone(), category: category.clone(), schedule, approved });
        emit("merchant_registered", serde_json::json!({ "merchant": merchant, "category": category, "payout": payout, "approved": approved }));
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
        self.proven_scores.flush();
        self.cohort_roots.flush();
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
        // k counts people, not purchases: one person buying twice is one member for the
        // release floor (a second membership still joins the tree, it adds no k).
        let person =
            self.humans.get(&env::predecessor_account_id()).cloned().unwrap_or_else(|| env::panic_str("only a World-bound buyer joins a review group"));
        let mut persons = group_persons();
        let key = format!("{merchant}|{person}");
        let mut counts = group_person_counts();
        let (mut distinct, mut tracked) = counts.get(&merchant).copied().unwrap_or((0, 0));
        tracked += 1;
        if !persons.contains_key(&key) {
            persons.insert(key, true);
            distinct += 1;
        }
        counts.insert(merchant.clone(), (distinct, tracked));
        persons.flush();
        counts.flush();
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

    /// Distinct persons in the merchant's review group: what the k floor counts.
    pub fn review_persons(&self, merchant: AccountId) -> u64 {
        let size = self.review_groups.get(&merchant).map_or(0, |g| g.tree.size);
        let (distinct, tracked) = group_person_counts().get(&merchant).copied().unwrap_or((0, 0));
        distinct + size.saturating_sub(tracked)
    }

    pub fn review_group(&self, merchant: AccountId) -> Option<ReviewGroup> {
        self.review_groups.get(&merchant).cloned()
    }

    pub fn review_round_now(&self) -> u64 {
        env::block_timestamp_ms() / round_ms()
    }

    pub fn review_round_ms(&self) -> u64 {
        round_ms()
    }

    /// Owner, testnet only: shorter review rounds so a demo can seal, reveal and release in
    /// minutes. At least one minute. Mainnet keeps 24 h whatever is stored.
    pub fn set_review_round_ms(&mut self, ms: u64) {
        self.assert_owner();
        require!(is_testnet(), "demo settings are testnet only");
        require!(ms >= 60_000, "round under one minute");
        env::storage_write(b"review_round_ms", &ms.to_le_bytes());
        emit("review_round_set", serde_json::json!({ "ms": ms }));
    }

    /// Owner, testnet only: accept `token` (the free-mint dUSDC) next to USDC, in its own
    /// escrow. Refused on any bazaar whose account is not `.testnet`.
    pub fn set_demo_token(&mut self, token: AccountId) {
        self.assert_owner();
        require!(is_testnet(), "demo token is testnet only");
        require!(token.as_str().ends_with(".testnet") && token != self.usdc, "demo token must be a .testnet account other than USDC");
        env::storage_write(b"demo_token", token.as_bytes());
        emit("demo_token_set", serde_json::json!({ "token": token }));
    }

    pub fn demo_token(&self) -> Option<AccountId> {
        demo_token_id()
    }

    pub fn demo_escrow_of(&self, account_id: AccountId) -> Option<U128> {
        demo_escrow().get(&account_id).map(|b| U128(*b))
    }

    /// "demo" for a record paid in the demo token, "usdc" for one paid in USDC, None unpaid.
    pub fn paid_in(&self, nullifier: String) -> Option<String> {
        let r = self.verdicts.get(&nullifier)?;
        r.spent.then(|| if demo_paid().contains_key(&nullifier) { "demo" } else { "usdc" }.to_string())
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
        let members = self.review_persons(merchant.clone());
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
        let members = self.review_persons(merchant.clone());
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
        // Released ratings seed standing on the graph: the merchant's running totals.
        self.push_graph_event(bookerbob_graph::Event::Seed { merchant: merchant.to_string(), ratings: n, sum });
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
        self.push_graph_event(bookerbob_graph::Event::Hire { agent: me.to_string(), sub: sub_agent.to_string() });
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

    // ---------- proven graph scores (Jolt), see docs/jolt.md ----------

    fn push_graph_event(&mut self, e: bookerbob_graph::Event) {
        self.graph_root = bookerbob_graph::extend_root(&self.graph_root, &e);
        self.graph_events += 1;
        // The bytes let an indexer rebuild the event list the prover needs.
        emit("graph_event", serde_json::json!({ "index": self.graph_events, "event": hex::encode(e.bytes()), "root": hex::encode(self.graph_root) }));
    }

    /// The Jolt program whose standing proofs the contract accepts.
    pub fn graph_program(&self) -> Option<String> {
        self.graph_program.clone()
    }

    pub fn graph_root(&self) -> (String, u64) {
        (hex::encode(self.graph_root), self.graph_events)
    }

    /// Owner sets the Jolt guest (sha256 of its ELF) whose proofs score updates come from.
    pub fn set_graph_program(&mut self, program_hash: String) {
        self.assert_owner();
        require!(bookerbob_core::is_hex32(&program_hash), "bad program hash");
        // A new program decides which standing proofs count: a trust anchor, timelocked.
        if self.queue_anchor("graph_program", serde_json::json!({ "program_hash": program_hash })) {
            return;
        }
        self.graph_program = Some(program_hash.clone());
        emit("graph_program_set", serde_json::json!({ "program_hash": program_hash }));
    }

    /// A score update computed off chain by the Jolt guest. The proof is too big for chain
    /// (and for OutLayer's 900-byte output), so a registered worker key verifies it off chain
    /// and signs `sha256(TAG || program_hash || root || scores_hash)`. Accepted only for the
    /// registered program and the current graph root (a stale root is refused).
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn submit_graph_scores(
        &mut self,
        program_hash: String,
        root: String,
        merchants: Vec<(AccountId, u64, u64)>,
        standing: Vec<(AccountId, U128)>,
        worker_key: String,
        signature: String,
        proof_sha256: String,
    ) {
        let before = env::storage_usage();
        require!(bookerbob_core::is_hex32(&proof_sha256), "bad proof hash");
        require!(pending_graph().is_none(), "a graph update is already pending");
        require!(self.graph_program.as_deref() == Some(program_hash.as_str()), "not the registered graph program");
        require!(root == hex::encode(self.graph_root), "stale graph root");
        require!(self.referees.contains_key(&worker_key), "unknown worker key");
        let bonded = worker_bonds().get(&worker_key).map_or(0, |b| b.1);
        require!(bonded >= WORKER_BOND.as_yoctonear(), "worker key has no bond (bond_worker)");
        let scores = bookerbob_graph::Scores {
            root: self.graph_root,
            merchants: merchants.iter().map(|(m, n, s)| (m.to_string(), *n, *s)).collect(),
            standing: standing.iter().map(|(a, v)| (a.to_string(), v.0)).collect(),
        };
        let mut msg = GRAPH_UPDATE_TAG.to_vec();
        msg.extend(hex::decode(&program_hash).expect("checked hex"));
        msg.extend(self.graph_root);
        msg.extend(scores.hash());
        let sig: [u8; 64] = decode(&signature, "worker signature");
        let pk: [u8; 32] = decode(&worker_key, "worker key");
        require!(env::ed25519_verify(&sig, env::sha256_array(&msg), &pk), "bad worker signature");
        let p = PendingGraphUpdate {
            program_hash,
            root,
            scores_hash: hex::encode(scores.hash()),
            proof_sha256,
            worker_key,
            merchants,
            submitted_ms: env::block_timestamp_ms(),
            challenger: None,
        };
        set_pending_graph(Some(&p));
        emit(
            "graph_update_pending",
            serde_json::json!({ "root": p.root, "program": p.program_hash, "scores_hash": p.scores_hash, "proof_sha256": p.proof_sha256, "merchants": p.merchants.len(), "challenge_until_ms": p.submitted_ms + challenge_window_ms() }),
        );
        charge_storage(before);
    }

    pub fn merchant_bond(&self, merchant: AccountId, token: String) -> U128 {
        U128(merchant_bonds().get(&format!("{merchant}|{token}")).copied().unwrap_or(0))
    }

    /// A World-bound buyer posts a sealed intent for its unspent verdict: it joins the group of
    /// verdicts that revealed the same predicates in the same category and context. Only the
    /// budget's commitment is stored. Returns the group key.
    #[payable]
    pub fn post_intent(&mut self, nullifier: String, category: String, budget_commitment: String) -> String {
        let before = env::storage_usage();
        require!(bookerbob_core::is_hex32(&budget_commitment), "bad budget commitment");
        let r = self.verdicts.get(&nullifier).unwrap_or_else(|| env::panic_str("unknown nullifier"));
        require!(r.agent == env::predecessor_account_id(), "agent mismatch");
        require!(!r.spent, "nullifier spent");
        require!(r.tier != bookerbob_core::SEALED_TIER, "a sealed verdict reveals no predicates, so it cannot join a buying group");
        let person = self.humans.get(&r.agent).cloned().unwrap_or_else(|| env::panic_str("only a World-bound buyer joins a buying group"));
        let mut preds = r.predicates.clone();
        preds.sort();
        let key = hex::encode(env::sha256_array(serde_json::to_vec(&(&category, &r.context, &preds)).expect("json").as_slice()));
        let mut ints = intents();
        require!(!ints.contains_key(&nullifier), "this verdict already posted an intent");
        let mut gs = groups();
        let mut g = gs.get(&key).cloned().unwrap_or_else(|| BuyingGroup {
            category: category.clone(),
            context: r.context.clone(),
            predicates: preds,
            ..Default::default()
        });
        let mut seen = group_persons_seen();
        let pk = format!("{key}|{person}");
        if !seen.contains_key(&pk) {
            seen.insert(pk, true);
            g.persons += 1;
        }
        g.members.push(nullifier.clone());
        g.budgets.push(budget_commitment);
        let (size, persons) = (g.members.len(), g.persons);
        gs.insert(key.clone(), g);
        ints.insert(nullifier, key.clone());
        gs.flush();
        ints.flush();
        seen.flush();
        emit("intent_posted", serde_json::json!({ "group": key, "members": size, "persons": persons, "tier_bps": group_tier(persons) }));
        charge_storage(before);
        key
    }

    pub fn buying_group(&self, group: String) -> Option<BuyingGroup> {
        groups().get(&group).cloned()
    }

    pub fn group_of(&self, nullifier: String) -> Option<String> {
        intents().get(&nullifier).cloned()
    }

    /// An approved merchant in the group's category offers one of the unlocked tiers. The
    /// offer giving the lowest member price stands.
    pub fn offer_group(&mut self, group: String, bps: u16) {
        let merchant = env::predecessor_account_id();
        let m = self.merchants.get(&merchant).cloned().unwrap_or_else(|| env::panic_str("unknown merchant"));
        require!(m.approved, "merchant not approved");
        let mut gs = groups();
        let mut g = gs.get(&group).cloned().unwrap_or_else(|| env::panic_str("unknown group"));
        require!(m.category == g.category, "another category");
        require!(GROUP_TIERS.iter().any(|(_, b)| *b == bps), "offer one of the fixed tiers (10% or 20%)");
        require!(bps <= group_tier(g.persons), "the group has not reached that tier");
        let first = g.members.first().expect("a group has members");
        let v = self.verdicts.get(first).expect("member verdict");
        let base = self.quote_for(&m.schedule, v).price;
        let price = base - base * bps as u128 / 10_000;
        if g.offer.as_ref().is_none_or(|(_, _, p)| price < p.0) {
            g.offer = Some((merchant.clone(), bps, U128(price)));
            gs.insert(group.clone(), g);
            gs.flush();
            emit("group_offer", serde_json::json!({ "group": group, "merchant": merchant, "bps": bps, "price": U128(price) }));
        }
    }

    /// A member pays the group's offer in the demo token: its own referee receipt for the
    /// offering merchant, minus the tier, debited from its own escrow, nullifier burned.
    pub fn settle_group_demo(&mut self, nullifier: String, checkout_ref: String, amount: U128) -> Promise {
        let token = demo_token_id().unwrap_or_else(|| env::panic_str("no demo token"));
        let key = intents().get(&nullifier).cloned().unwrap_or_else(|| env::panic_str("no intent for this verdict"));
        let g = groups().get(&key).cloned().expect("group");
        let (merchant, bps, _) = g.offer.clone().unwrap_or_else(|| env::panic_str("no group offer yet"));
        require!(bps <= group_tier(g.persons), "the group has not reached that tier");
        let (m, price, agent) = self.take_payment_at(&nullifier, &merchant, &checkout_ref, amount, "group", true, bps);
        ext_ft::ext(token)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(m.payout.clone(), U128(price - settle_fees().get(&nullifier).copied().unwrap_or(0)), Some(format!("bookerbob:{checkout_ref}")))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_SETTLE_CALLBACK).on_settle_transfer(nullifier, agent, U128(price), Some(true)))
    }

    /// The liability record of a settled purchase (see `liabilities`).
    pub fn liability(&self, nullifier: String) -> Option<String> {
        liabilities().get(&nullifier).cloned()
    }

    pub fn pending_graph_update(&self) -> Option<PendingGraphUpdate> {
        pending_graph()
    }

    /// Bond a worker key (anyone may bond it; the bonder gets it back on `unbond_worker`).
    #[payable]
    pub fn bond_worker(&mut self, worker_key: String) {
        require!(self.referees.contains_key(&worker_key), "unknown worker key");
        let mut b = worker_bonds();
        let me = env::predecessor_account_id();
        let (owner, amount) = b.get(&worker_key).cloned().unwrap_or((me.clone(), 0));
        require!(owner == me, "another account bonds this key");
        b.insert(worker_key.clone(), (owner, amount + env::attached_deposit().as_yoctonear()));
        b.flush();
        emit("worker_bonded", serde_json::json!({ "worker_key": worker_key, "amount": U128(amount + env::attached_deposit().as_yoctonear()) }));
    }

    pub fn worker_bond(&self, worker_key: String) -> Option<(AccountId, U128)> {
        worker_bonds().get(&worker_key).map(|(a, v)| (a.clone(), U128(*v)))
    }

    /// The bonder takes the bond back, only while no update by that key is pending.
    pub fn unbond_worker(&mut self, worker_key: String) -> Promise {
        require!(pending_graph().is_none_or(|p| p.worker_key != worker_key), "an update by this key is pending");
        let mut b = worker_bonds();
        let (owner, amount) = b.get(&worker_key).cloned().unwrap_or_else(|| env::panic_str("no bond"));
        require!(owner == env::predecessor_account_id(), "not the bonder");
        b.remove(&worker_key);
        b.flush();
        Promise::new(owner).transfer(NearToken::from_yoctonear(amount))
    }

    /// Anyone, inside the window, with CHALLENGE_BOND: freeze the pending update until an
    /// arbiter re-runs the Jolt verifier on the proof (sha256 `proof_sha256`) and resolves.
    #[payable]
    pub fn challenge_graph_scores(&mut self) {
        let mut p = pending_graph().unwrap_or_else(|| env::panic_str("no pending update"));
        require!(p.challenger.is_none(), "already challenged");
        require!(env::block_timestamp_ms() < p.submitted_ms + challenge_window_ms(), "challenge window is over");
        let d = env::attached_deposit();
        require!(d >= CHALLENGE_BOND, "attach the challenge bond (0.1 NEAR)");
        p.challenger = Some((env::predecessor_account_id(), U128(d.as_yoctonear())));
        set_pending_graph(Some(&p));
        emit("graph_update_challenged", serde_json::json!({ "root": p.root, "challenger": env::predecessor_account_id(), "proof_sha256": p.proof_sha256 }));
    }

    /// After the window, an unchallenged update applies. Anyone may call it.
    pub fn finalize_graph_scores(&mut self) {
        let p = pending_graph().unwrap_or_else(|| env::panic_str("no pending update"));
        require!(p.challenger.is_none(), "challenged: waits for the arbiter");
        require!(env::block_timestamp_ms() >= p.submitted_ms + challenge_window_ms(), "challenge window still open");
        self.apply_graph_update(&p);
        set_pending_graph(None);
    }

    /// An arbiter's signed resolution of a challenge: `valid` after re-running the Jolt
    /// verifier on the proof with that sha256 against this root and scores hash. Invalid:
    /// the update is dropped, the worker bond goes to the challenger with its own bond back.
    /// Valid: the update applies and the challenger's bond goes to the worker's bonder.
    pub fn resolve_graph_challenge(
        &mut self,
        proof_sha256: String,
        valid: bool,
        arbiter_key: String,
        signature: String,
        more: Option<Vec<(String, String)>>,
    ) -> bool {
        let p = pending_graph().unwrap_or_else(|| env::panic_str("no pending update"));
        let (challenger, cbond) = p.challenger.clone().unwrap_or_else(|| env::panic_str("not challenged"));
        require!(p.proof_sha256 == proof_sha256, "resolution is for another proof");
        let mut msg = GRAPH_CHALLENGE_TAG.to_vec();
        msg.extend(serde_json::to_vec(&(&p.root, &p.scores_hash, &proof_sha256, valid)).expect("json"));
        let digest = env::sha256_array(&msg);
        let mut keys: Vec<String> = Vec::new();
        for (k, sg) in std::iter::once((arbiter_key, signature)).chain(more.unwrap_or_default()) {
            require!(self.arbiters.contains_key(&k), "unknown arbiter key");
            let sig: [u8; 64] = decode(&sg, "arbiter signature");
            let pk: [u8; 32] = decode(&k, "arbiter key");
            require!(env::ed25519_verify(&sig, digest, &pk), "bad arbiter signature");
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
        require!(keys.len() as u64 >= arbiter_quorum(), format!("needs {} distinct arbiter signatures", arbiter_quorum()));
        let mut bonds = worker_bonds();
        if valid {
            let (bonder, _) = bonds.get(&p.worker_key).cloned().expect("bonded at submit");
            self.apply_graph_update(&p);
            Promise::new(bonder).transfer(NearToken::from_yoctonear(cbond.0)).detach();
        } else {
            let (_, slashed) = bonds.remove(&p.worker_key).unwrap_or_else(|| (challenger.clone(), 0));
            bonds.flush();
            Promise::new(challenger.clone()).transfer(NearToken::from_yoctonear(slashed + cbond.0)).detach();
            emit("graph_update_rejected", serde_json::json!({ "root": p.root, "worker_key": p.worker_key, "slashed": U128(slashed), "to": challenger }));
        }
        set_pending_graph(None);
        valid
    }

    fn apply_graph_update(&mut self, p: &PendingGraphUpdate) {
        for (m, _, s) in &p.merchants {
            self.proven_scores.insert(m.clone(), *s);
        }
        self.proven_root = Some(p.root.clone());
        emit(
            "graph_scores",
            serde_json::json!({ "root": p.root, "program": p.program_hash, "scores_hash": p.scores_hash, "proof_sha256": p.proof_sha256, "merchants": p.merchants.len() }),
        );
        self.proven_scores.flush();
    }

    pub fn proven_score(&self, merchant: AccountId) -> Option<(u64, String)> {
        self.proven_scores.get(&merchant).map(|s| (*s, self.proven_root.clone().unwrap_or_default()))
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
        // Open rounds: two bids under one operator cannot both stand. Same payout account, or a
        // hire edge either way, counts as one operator; the later reveal is refused.
        if round.category == OPEN_CATEGORY {
            let me = self.merchants.get(&merchant).unwrap_or_else(|| env::panic_str("unknown merchant"));
            let my_hires = self.hires.get(&merchant).cloned().unwrap_or_default();
            for other in &round.revealed {
                let o = self.merchants.get(other).expect("revealed merchants are registered");
                let linked = o.payout == me.payout || my_hires.contains(other) || self.hires.get(other).is_some_and(|h| h.contains(&merchant));
                require!(!linked, "linked to a merchant already revealed in this round (same payout or a hire edge)");
            }
        }
        let round = self.rounds.get_mut(&round_id).expect("checked above");
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
        // A model key is a verdict issuer: timelocked like register_issuer.
        if self.queue_anchor("model_attestation", serde_json::json!({ "signing_key": signing_key, "attestation": attestation })) {
            return;
        }
        self.store_model_attestation(signing_key, attestation);
    }

    fn store_model_attestation(&mut self, signing_key: String, attestation: ModelAttestation) {
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
        if let Some(d) = &e.disclosure {
            let mut ds = disclosures();
            ds.insert(e.nullifier.clone(), d.clone());
            ds.flush();
        }
        for p in &e.predicates {
            let k = Self::cohort_key(&e.context, p);
            let n = *self.cohorts.get(&k).unwrap_or(&0);
            self.cohorts.insert(k.clone(), n + 1);
            let r = self.cohort_roots.get(&k).copied().unwrap_or([0u8; 32]);
            self.cohort_roots.insert(k, bookerbob_zkcore::cohort::extend(&r, &e.context, p, &e.nullifier));
        }
        emit(
            "verdict_submitted",
            serde_json::json!({
                "nullifier": e.nullifier,
                "commitment": e.commitment,
                "predicates": e.predicates,
                "tcb_status": e.attestation.tcb_status,
                "disclosure": e.disclosure,
            }),
        );
        self.verdicts.flush();
        self.cohorts.flush();
        self.cohort_roots.flush();
    }

    pub fn nullifier_status(&self, nullifier: String) -> NullifierStatus {
        match self.verdicts.get(&nullifier) {
            None => NullifierStatus::Unknown,
            Some(r) if r.spent => NullifierStatus::Spent,
            Some(_) => NullifierStatus::Pending,
        }
    }

    /// For a sealed verdict the record holds hashes only: no predicates, tier `sealed`, and a
    /// cap of 0 until the referee's receipt fixes the price (then cap = that price).
    pub fn verdict(&self, nullifier: String) -> Option<VerdictRecord> {
        self.verdicts.get(&nullifier).cloned()
    }

    /// A sealed verdict's commitment to its predicates, tier and cap; None for an ordinary one.
    pub fn disclosure(&self, nullifier: String) -> Option<String> {
        disclosures().get(&nullifier).cloned()
    }

    pub fn spent_count(&self) -> u64 {
        self.spent_count
    }

    // ---------- quotes ----------

    /// Code-computed price of `merchant` for the predicates revealed under `nullifier`.
    /// Owner: the lowest TDX TCB status quoted or paid (a DCAP name, `UpToDate` by default).
    pub fn set_min_tcb(&mut self, status: String) {
        self.assert_owner();
        require!(bookerbob_core::envelope::tcb_rank(&status).is_some_and(|r| r > 0), "not a TCB status that can pass");
        // Raising the floor applies at once; lowering it lets weaker enclaves in, so it waits.
        let lowers = bookerbob_core::envelope::tcb_rank(&status) < bookerbob_core::envelope::tcb_rank(&tcb_floor());
        if lowers && self.queue_anchor("min_tcb", serde_json::json!({ "status": status })) {
            return;
        }
        env::storage_write(b"min_tcb", status.as_bytes());
        emit("min_tcb_set", serde_json::json!({ "status": status }));
    }

    pub fn min_tcb(&self) -> String {
        tcb_floor()
    }

    pub fn quote(&self, merchant: AccountId, nullifier: String) -> Quote {
        let m = self.merchants.get(&merchant).unwrap_or_else(|| env::panic_str("unknown merchant"));
        let v = self.verdicts.get(&nullifier).unwrap_or_else(|| env::panic_str("unknown nullifier"));
        require!(tcb_ok(&v.tcb_status), "verdict enclave TCB below min_tcb");
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
        if !tcb_ok(&v.tcb_status) {
            return None;
        }
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
        let mut demo = demo_escrow();
        let open_demo = demo_token_id().is_some() && !demo.contains_key(&account);
        if self.escrow.contains_key(&account) && !open_demo {
            // Already open: refund the whole deposit instead of keeping it (audit A8).
            let d = env::attached_deposit();
            if !d.is_zero() {
                Promise::new(env::predecessor_account_id()).transfer(d).detach();
            }
            return;
        }
        // One deposit covers both entries (USDC and, on a testnet with a demo token, dUSDC).
        require!(env::attached_deposit() >= ESCROW_STORAGE_DEPOSIT, "attach at least 0.01 NEAR");
        if open_demo {
            demo.insert(account.clone(), 0);
            demo.flush();
        }
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
        let token = env::predecessor_account_id();
        let kind = if token == self.usdc {
            "usdc"
        } else if demo_token_id().as_ref() == Some(&token) {
            "demo"
        } else {
            env::panic_str("only USDC is accepted")
        };
        // msg "bond": an approved merchant tops up its refund bond in this token.
        if msg == "bond" {
            let Some(m) = self.merchants.get(&sender_id).cloned() else { return PromiseOrValue::Value(amount) };
            // Approved merchants top up; in the open category, a registered merchant bonds in.
            if !m.approved && m.category != OPEN_CATEGORY {
                return PromiseOrValue::Value(amount);
            }
            let mut b = merchant_bonds();
            let key = format!("{sender_id}|{kind}");
            let v = b.get(&key).copied().unwrap_or(0) + amount.0;
            b.insert(key, v);
            b.flush();
            emit("merchant_bonded", serde_json::json!({ "merchant": sender_id, "token": kind, "amount": U128(v) }));
            if !m.approved && bonded(&sender_id) >= OPEN_BOND {
                self.merchants.get_mut(&sender_id).expect("registered").approved = true;
                self.merchants.flush();
                emit("merchant_approved", serde_json::json!({ "merchant": sender_id, "by": "bond" }));
            }
            return PromiseOrValue::Value(U128(0));
        }
        if token != self.usdc {
            // The demo token, on a testnet bazaar only (demo_token_id() is None elsewhere).
            if demo_token_id().as_ref() != Some(&token) {
                env::panic_str("only USDC is accepted");
            }
            let mut demo = demo_escrow();
            let Some(bal) = demo.get_mut(&sender_id) else { return PromiseOrValue::Value(amount) };
            *bal += amount.0;
            demo.flush();
            emit("escrow_deposit", serde_json::json!({ "account": sender_id, "amount": amount, "token": "demo" }));
            return PromiseOrValue::Value(U128(0));
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
        if self.queue_anchor("referee", serde_json::json!({ "key_hex": key_hex, "label": label })) {
            return;
        }
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
        // Tx args are public: the proof set may only travel sealed to the worker's key
        // (`{"sealed": {v, epk, nonce, ct, commitment}}`, worker/src/sealed.rs). Plaintext
        // input is refused, so real facts never land on chain (audit A20).
        let v: serde_json::Value = serde_json::from_str(&input_data).unwrap_or_else(|_| env::panic_str("input_data is not JSON"));
        let sealed = v.as_object().is_some_and(|o| o.len() == 1)
            && ["epk", "nonce", "ct", "commitment"]
                .iter()
                .all(|k| v["sealed"][k].as_str().is_some_and(|x| !x.is_empty() && x.bytes().all(|b| b.is_ascii_hexdigit())));
        require!(sealed, "referee input must be sealed to the worker key (plaintext facts would be public)");
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
        let sealed = current.tier == bookerbob_core::SEALED_TIER;
        // A sealed verdict: the referee opened its disclosure and priced it (the digest binds
        // the commitment); the contract accepts only a price its own code can produce.
        let price = if sealed {
            require!(achievable_price(&m.schedule, b.price, self.humans.contains_key(&current.agent)), "referee price is not one the schedule can produce");
            b.price
        } else {
            self.quote_for(&m.schedule, &current).price
        };
        let record = self.verdicts.get_mut(&b.nullifier).expect("checked above");
        require!(!record.spent, "nullifier spent");
        require!(record.digest == b.verdict_digest, "referee result is for another verdict");
        require!(price == b.price, "referee price differs from quote");
        match b.outcome.as_str() {
            "receipt" => {
                if sealed {
                    // The referee checked the price against the hidden cap.
                    record.max_spend = U128(price);
                }
                record.receipt = Some(RefereeReceipt {
                    merchant: merchant.clone(),
                    price: U128(price),
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
        if self.queue_anchor("arbiter", serde_json::json!({ "key_hex": key_hex, "label": label })) {
            return;
        }
        self.arbiters.insert(key_hex.clone(), label.clone());
        emit("arbiter_registered", serde_json::json!({ "key": key_hex, "label": label }));
    }

    /// Apply a signed arbiter decision about the stored referee receipt. Anyone may relay.
    /// `overturned` before settle clears the receipt, so `settle` is blocked again; after
    /// settle it marks the record `disputed` (refunds are out of scope for v0).
    /// Returns true when the receipt was overturned.
    pub fn submit_dispute_decision(&mut self, decision: DisputeDecision) -> bool {
        require!(arbiter_quorum() == 1, "this bazaar needs several arbiter signatures: submit_dispute_decisions");
        self.submit_dispute_decisions(vec![decision])
    }

    /// The same decision body signed by at least `arbiter_threshold` distinct registered
    /// arbiters; one key, or one key twice, is not enough when the threshold is above 1.
    pub fn submit_dispute_decisions(&mut self, decisions: Vec<DisputeDecision>) -> bool {
        let first = decisions.first().unwrap_or_else(|| env::panic_str("no decision"));
        let b = first.body.clone();
        require!(b.v == 0, "unsupported dispute decision");
        let mut keys: Vec<String> = Vec::new();
        for d in &decisions {
            require!(d.body == b, "decisions disagree");
            require!(self.arbiters.contains_key(&d.arbiter_key), "unknown arbiter key");
            let sig: [u8; 64] = decode(&d.signature, "arbiter signature");
            let pk: [u8; 32] = decode(&d.arbiter_key, "arbiter key");
            require!(env::ed25519_verify(&sig, b.signing_message(), &pk), "bad arbiter signature");
            if !keys.contains(&d.arbiter_key) {
                keys.push(d.arbiter_key.clone());
            }
        }
        require!(keys.len() as u64 >= arbiter_quorum(), format!("needs {} distinct arbiter signatures", arbiter_quorum()));
        let b = &b;
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
                    // The liability ledger pays: the merchant's bond in the token the buyer
                    // paid refunds the price (up to the bond) into the buyer's escrow.
                    let (agent, price, merchant) = (record.agent.clone(), receipt.price.0, receipt.merchant.clone());
                    let demo = demo_paid().contains_key(&b.nullifier);
                    let mut bonds = merchant_bonds();
                    let key = format!("{merchant}|{}", if demo { "demo" } else { "usdc" });
                    let have = bonds.get(&key).copied().unwrap_or(0);
                    let refund = have.min(price);
                    if refund > 0 {
                        bonds.insert(key, have - refund);
                        bonds.flush();
                        self.credit(&agent, refund, demo);
                    }
                    emit(
                        "dispute_overturned_after_settle",
                        serde_json::json!({ "nullifier": b.nullifier, "reasons": b.reasons, "refund": U128(refund), "token": if demo { "demo" } else { "usdc" } }),
                    );
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
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_SETTLE_CALLBACK).on_withdraw(account, amount, None))
    }

    /// `withdraw` for the demo token's escrow.
    #[payable]
    pub fn withdraw_demo(&mut self, amount: U128) -> Promise {
        near_sdk::assert_one_yocto();
        let token = demo_token_id().unwrap_or_else(|| env::panic_str("no demo token"));
        let account = env::predecessor_account_id();
        let mut demo = demo_escrow();
        let bal = demo.get_mut(&account).unwrap_or_else(|| env::panic_str("no escrow"));
        require!(amount.0 > 0 && *bal >= amount.0, "insufficient escrow");
        *bal -= amount.0;
        demo.flush();
        emit("escrow_withdraw", serde_json::json!({ "account": account, "amount": amount, "token": "demo" }));
        ext_ft::ext(token)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(account.clone(), amount, Some("bookerbob:withdraw".into()))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_SETTLE_CALLBACK).on_withdraw(account, amount, Some(true)))
    }

    #[private]
    pub fn on_withdraw(&mut self, account: AccountId, amount: U128, demo: Option<bool>) -> bool {
        if env::promise_result_checked(0, 64).is_ok() {
            return true;
        }
        self.credit(&account, amount.0, demo.unwrap_or(false));
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
        let (m, price, agent) = self.take_payment(&nullifier, &merchant, &checkout_ref, amount, "near", false);
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(m.payout.clone(), U128(price - settle_fees().get(&nullifier).copied().unwrap_or(0)), Some(format!("bookerbob:{checkout_ref}")))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_SETTLE_CALLBACK).on_settle_transfer(nullifier, agent, U128(price), None))
    }

    /// `settle` paid from the demo-token escrow, in the demo token (testnet only). Same
    /// checks, same receipt, same nullifier burn: a record pays once, in one token.
    pub fn settle_demo(&mut self, nullifier: String, merchant: AccountId, checkout_ref: String, amount: U128) -> Promise {
        let token = demo_token_id().unwrap_or_else(|| env::panic_str("no demo token"));
        let (m, price, agent) = self.take_payment(&nullifier, &merchant, &checkout_ref, amount, "near", true);
        ext_ft::ext(token)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(m.payout.clone(), U128(price - settle_fees().get(&nullifier).copied().unwrap_or(0)), Some(format!("bookerbob:{checkout_ref}")))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_SETTLE_CALLBACK).on_settle_transfer(nullifier, agent, U128(price), Some(true)))
    }

    fn credit(&mut self, account: &AccountId, amount: u128, demo: bool) {
        if demo {
            let mut d = demo_escrow();
            if let Some(bal) = d.get_mut(account) {
                *bal += amount;
            }
            d.flush();
        } else if let Some(bal) = self.escrow.get_mut(account) {
            *bal += amount;
        }
    }

    /// Every check a payout needs, then the escrow debit and the nullifier burn, in one
    /// place for both paths. One payout per receipt: a spent record cannot pay again,
    /// whichever path paid it.
    fn take_payment(&mut self, nullifier: &str, merchant: &AccountId, checkout_ref: &str, amount: U128, path: &str, demo: bool) -> (Merchant, u128, AccountId) {
        self.take_payment_at(nullifier, merchant, checkout_ref, amount, path, demo, 0)
    }

    /// `take_payment` at the receipt price minus a group tier (`group_bps`, 0 for a single buyer).
    #[allow(clippy::too_many_arguments)]
    fn take_payment_at(
        &mut self,
        nullifier: &str,
        merchant: &AccountId,
        checkout_ref: &str,
        amount: U128,
        path: &str,
        demo: bool,
        group_bps: u16,
    ) -> (Merchant, u128, AccountId) {
        require!(!checkout_ref.is_empty() && checkout_ref.len() <= 128, "bad checkout_ref");
        let agent = env::predecessor_account_id();
        let m = self.merchants.get(merchant).cloned().unwrap_or_else(|| env::panic_str("unknown merchant"));
        require!(m.approved, "merchant not approved");
        let record = self.verdicts.get_mut(nullifier).unwrap_or_else(|| env::panic_str("unknown nullifier"));
        require!(!record.spent, "nullifier spent");
        require!(record.agent == agent, "agent mismatch");
        require!(tcb_ok(&record.tcb_status), "verdict enclave TCB below min_tcb");
        require!(env::block_timestamp_ms() < record.expires_at_ms, "verdict expired");
        // The receipt fixes the price: a cohort that grows after the receipt cannot change it.
        let price = match &record.receipt {
            Some(r) if &r.merchant == merchant => r.price.0 - r.price.0 * group_bps as u128 / 10_000,
            _ => env::panic_str("no referee receipt for this quote"),
        };
        require!(amount.0 == price, "amount differs from quote");
        require!(price <= record.max_spend.0, "over verdict cap");
        if demo {
            let mut d = demo_escrow();
            let bal = d.get_mut(&agent).unwrap_or_else(|| env::panic_str("no escrow"));
            require!(*bal >= price, "insufficient escrow");
            *bal -= price;
            d.flush();
            let mut t = demo_paid();
            t.insert(nullifier.to_string(), true);
            t.flush();
        } else {
            let bal = self.escrow.get_mut(&agent).unwrap_or_else(|| env::panic_str("no escrow"));
            require!(*bal >= price, "insufficient escrow");
            *bal -= price;
        }
        self.verdicts.flush();
        let before = env::storage_usage();
        let record = self.verdicts.get_mut(nullifier).expect("checked above");
        record.spent = true;
        record.checkout_ref = Some(checkout_ref.to_string());
        // The liability record: what this payment relied on, hashed, queryable per nullifier.
        // Written before draw_reserve, so its bytes come from the agent's prepaid reserve.
        let record = self.verdicts.get(nullifier).expect("checked above");
        let receipt_hash = record.receipt.as_ref().map(|r| r.receipt_hash.clone()).unwrap_or_default();
        // The market fee: taken from the price, never added to it; conserved (merchant + fee = price).
        let fee = price * fee_rate() as u128 / 10_000;
        let liability = hex::encode(env::sha256_array(
            serde_json::to_vec(&(&record.digest, &receipt_hash, merchant.as_str(), price.to_string(), if demo { "demo" } else { "usdc" }, fee.to_string()))
                .expect("json")
                .as_slice(),
        ));
        if fee > 0 {
            let mut sf = settle_fees();
            sf.insert(nullifier.to_string(), fee);
            sf.flush();
            let mut fa = fee_ledger();
            let k = if demo { "demo" } else { "usdc" }.to_string();
            let v = fa.get(&k).copied().unwrap_or(0) + fee;
            fa.insert(k, v);
            fa.flush();
        }
        let mut l = liabilities();
        l.insert(nullifier.to_string(), liability.clone());
        l.flush();
        self.verdicts.flush();
        self.draw_reserve(nullifier, before);
        self.spent_count += 1;
        emit(
            "settled",
            serde_json::json!({
                "nullifier": nullifier,
                "merchant": merchant,
                "payout": m.payout,
                "amount": U128(price),
                "checkout_ref": checkout_ref,
                "path": path,
                "token": if demo { "demo" } else { "usdc" },
                "liability": liability,
                "fee": U128(fee),
            }),
        );
        (m, price, agent)
    }

    #[private]
    pub fn on_settle_transfer(&mut self, nullifier: String, agent: AccountId, amount: U128, demo: Option<bool>) -> bool {
        if env::promise_result_checked(0, 64).is_ok() {
            if let Some(r) = self.verdicts.get_mut(&nullifier) {
                r.paid = true;
            }
            return true;
        }
        self.on_settle_rollback(&nullifier, &agent, amount, demo.unwrap_or(false));
        false
    }

    fn on_settle_rollback(&mut self, nullifier: &str, agent: &AccountId, amount: U128, demo: bool) {
        self.credit(agent, amount.0, demo);
        let mut sf = settle_fees();
        if let Some(fee) = sf.remove(nullifier) {
            sf.flush();
            let mut fa = fee_ledger();
            let k = if demo { "demo" } else { "usdc" }.to_string();
            let v = fa.get(&k).copied().unwrap_or(0).saturating_sub(fee);
            fa.insert(k, v);
            fa.flush();
        }
        if demo {
            let mut t = demo_paid();
            t.remove(nullifier);
            t.flush();
        }
        if let Some(r) = self.verdicts.get_mut(nullifier) {
            r.spent = false;
            r.checkout_ref = None;
        }
        self.spent_count = self.spent_count.saturating_sub(1);
        emit("settle_reverted", serde_json::json!({ "nullifier": nullifier, "agent": agent, "amount": amount }));
    }
}

pub mod groth16;

#[cfg(test)]
mod tests;
