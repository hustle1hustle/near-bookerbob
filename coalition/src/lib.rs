//! Coalitions of merchant agents (docs/coalitions.md), version 3. A buyer (or a lead agent) opens
//! a job of several legs, names the buyer-agent accounts allowed to make the delivering
//! purchases, and escrows its budget in the bazaar's demo token. A merchant agent joins one leg
//! by posting a bond with its standing proof: the bazaar answers `in_top(proof, min_top_pct)`
//! over its Jolt-proven standing tree, the proof's leaf must be the sender, and the bazaar's
//! merchant record must be approved in the leg's category.
//!
//! A delivery takes two steps. A named buyer agent announces its own purchase for a leg while
//! the purchase is still unspent on the bazaar: the verdict's `agent` is the announcer, and its
//! referee receipt names the leg's member at or under the member's quote. A leg keeps every
//! purchase announced for it (up to `MAX_ANNOUNCES`). Anyone then shows the leg delivered with
//! any of them once it is spent and paid. A purchase that settled before it was announced cannot
//! deliver, so every delivering settle postdates the job.
//!
//! After the deadline anyone finalizes: deliverers get their bond back and a share of the budget
//! pro rata to their quoted price; a member whose leg had announced purchases and none delivered
//! loses its bond, half to the buyer and half to the treasury set at init; a member whose leg
//! had no announced purchase gets its bond back and no share (released).
//! A payout the token refuses stays here as a claimable balance (`claim`).
//!
//! The contract has no owner and no admin method. It trusts the bazaar's views and the token.
//! Version 1 (jobs A to C) is kept as it ran in coalition/v1/, version 2 (job D) in coalition/v2/.
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

pub const MAX_LEGS: usize = 8;
pub const MAX_BUYERS: usize = 8;
/// Purchases one leg may hold announced at once.
pub const MAX_ANNOUNCES: usize = 4;
/// Budget, bond and every max price are at most this (10^9 dUSDC): `budget * price` fits u128.
pub const MAX_AMOUNT: u128 = 1_000_000_000_000_000;
/// A job runs at least this long, so members have time to join and deliver.
pub const MIN_DURATION_MS: u64 = 10 * 60_000;
/// After the deadline plus this, a seat whose bazaar answer never came back counts as refused.
pub const GRACE_MS: u64 = 10 * 60_000;
/// Attached to `open_job` for the job's storage; kept by the contract.
pub const OPEN_DEPOSIT: NearToken = NearToken::from_millinear(20);
const GAS_VIEW: Gas = Gas::from_tgas(10);
const GAS_ON_ADMIT: Gas = Gas::from_tgas(10);
const GAS_ON_VERDICT: Gas = Gas::from_tgas(15);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(8);
const GAS_ON_PAYOUT: Gas = Gas::from_tgas(5);
const VIEW_CAP: usize = 65_536;

pub const STANDARD: &str = "bookerbob-coalition";
pub const VERSION: &str = "3.0.0";
pub const REFUSE_NO_PROOF: &str = "no standing proof";
pub const REFUSE_LEAF: &str = "the proof's leaf is not the sender";
pub const REFUSE_LOW: &str = "not in the top of the proven standing";
pub const REFUSE_CATEGORY: &str = "not an approved bazaar merchant in the leg's category";
pub const REFUSE_OWN_JOB: &str = "the buyer and its buyer agents cannot join its job";
pub const REFUSE_BUYER: &str = "the purchase's buyer agent is not allowed in this job";
pub const REFUSE_SPENT: &str = "the purchase settled before it was announced";
pub const REFUSE_NOT_ANNOUNCED: &str = "this purchase was not announced for this leg";
pub const REFUSE_ANNOUNCER: &str = "only the job's buyer agents announce";
pub const REFUSE_NOT_AGENT: &str = "the announcer is not the purchase's buyer agent";

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Leg {
    /// Must equal the member's `category` in the bazaar's merchant record.
    pub category: String,
    pub max_price: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Seat {
    pub member: AccountId,
    /// The member's quote for this leg; the delivering receipt must be at or under it.
    pub price: U128,
    /// True while the bazaar's `in_top` and `merchant` answers are in flight.
    pub pending: bool,
    /// Every bazaar nullifier a buyer agent announced for this leg while it was unspent.
    pub announced: Vec<String>,
    /// The announced nullifier, once spent and paid.
    pub delivered: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    pub id: u64,
    pub buyer: AccountId,
    /// The accounts whose purchases may deliver a leg (the verdict's `agent`).
    pub buyers: Vec<AccountId>,
    pub legs: Vec<Leg>,
    pub seats: Vec<Option<Seat>>,
    pub bond: U128,
    pub budget: U128,
    pub funded: bool,
    pub min_top_pct: u8,
    pub opened_ms: u64,
    pub deadline_ms: u64,
    /// "open", then "complete" (every leg filled and delivered) or "failed".
    pub status: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct MemberRecord {
    pub joined: u32,
    pub completed: u32,
    pub slashed: u32,
    /// Seats the buyer never announced a purchase for: bond back, no share, no slash.
    pub released: u32,
    /// Budget shares received plus slashed bonds received, in token base units.
    pub earned: U128,
    /// Bonds lost.
    pub lost: U128,
}

/// What became of a joined seat at the deadline.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Outcome {
    Delivered,
    /// A purchase was announced for the leg and not delivered: slashed.
    NoShow,
    /// No purchase was announced for the leg: released.
    Unoffered,
}

/// What `finalize` pays: to whom, and why. Pure, so the split and slash rules are tested alone.
#[derive(Clone, Debug, PartialEq)]
pub struct Settlement {
    pub buyer: u128,
    /// The treasury's half of the slashed bonds.
    pub treasury: u128,
    /// (member, bond back, budget share)
    pub delivered: Vec<(AccountId, u128, u128)>,
    /// (member, bond lost)
    pub slashed: Vec<(AccountId, u128)>,
    /// (member, bond back)
    pub released: Vec<(AccountId, u128)>,
}

/// The split and slash rule. `seats` are the joined seats: (member, quoted price, outcome).
///
/// - Budget: a deliverer gets `budget * price / P`, P the sum of the quoted prices of every
///   joined seat (floor). Whatever is left (no-shows, released seats, unfilled legs, rounding)
///   goes back to the buyer. No seat joined: the whole budget goes back.
/// - Bonds: a deliverer gets its bond back, a released seat too. A no-show loses its bond: half
///   (floor) to the buyer as compensation, the rest to the treasury. No member gains from
///   another member's slash, so a buyer with a member of its own cannot take the whole bond.
///
/// Conserved: buyer + treasury + every payout = budget + bond * seats.
pub fn settle(budget: u128, bond: u128, seats: &[(AccountId, u128, Outcome)]) -> Settlement {
    let p: u128 = seats.iter().map(|s| s.1).sum();
    let slashed_total = bond * seats.iter().filter(|s| s.2 == Outcome::NoShow).count() as u128;
    let mut out = Settlement { buyer: 0, treasury: slashed_total - slashed_total / 2, delivered: vec![], slashed: vec![], released: vec![] };
    let mut paid = out.treasury;
    for (m, price, o) in seats {
        match o {
            Outcome::Delivered => {
                let share = budget * price / p;
                paid += bond + share;
                out.delivered.push((m.clone(), bond, share));
            }
            Outcome::NoShow => out.slashed.push((m.clone(), bond)),
            Outcome::Unoffered => {
                paid += bond;
                out.released.push((m.clone(), bond));
            }
        }
    }
    out.buyer = budget + bond * seats.len() as u128 - paid;
    out
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Coalition {
    token: AccountId,
    bazaar: AccountId,
    /// Receives the half of each slashed bond that does not go to the buyer.
    treasury: AccountId,
    next_id: u64,
    jobs: LookupMap<u64, Job>,
    members: LookupMap<AccountId, MemberRecord>,
    /// Bazaar nullifiers used for a delivery, with their job: one purchase delivers one leg.
    used: LookupMap<String, u64>,
    /// `job:nullifier` announced in a job, with its leg. Scoped to the job, so no other job can
    /// take a purchase first.
    announced: LookupMap<String, u32>,
    /// Payouts the token refused, claimable by their owner.
    claimable: LookupMap<AccountId, u128>,
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": STANDARD, "version": VERSION, "event": event, "data": [data] })));
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

fn result_json(i: u64) -> Option<Value> {
    env::promise_result_checked(i, VIEW_CAP).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok())
}

#[near(serializers = [json])]
pub struct JoinMsg {
    pub job: u64,
    pub leg: u32,
    pub price: U128,
    /// The bazaar's `TopProof` for the sender's leaf, passed to `in_top` as it is.
    pub proof: Option<Value>,
}

#[near]
impl Coalition {
    #[init]
    pub fn new(token: AccountId, bazaar: AccountId, treasury: AccountId) -> Self {
        Self {
            token,
            bazaar,
            treasury,
            announced: LookupMap::new(b"a"),
            next_id: 0,
            jobs: LookupMap::new(b"j"),
            members: LookupMap::new(b"m"),
            used: LookupMap::new(b"u"),
            claimable: LookupMap::new(b"c"),
        }
    }

    /// The buyer (or a lead agent) opens a job; it then funds the budget with
    /// `ft_transfer_call(msg {"fund": id})`. Members can join only a funded job. `buyers` are the
    /// accounts whose bazaar purchases may deliver a leg; none given: the caller alone.
    #[payable]
    pub fn open_job(&mut self, legs: Vec<Leg>, bond: U128, budget: U128, min_top_pct: u8, deadline_ms: u64, buyers: Option<Vec<AccountId>>) -> u64 {
        require!(env::attached_deposit() >= OPEN_DEPOSIT, "attach 0.02 NEAR for the job's storage");
        require!(!legs.is_empty() && legs.len() <= MAX_LEGS, "1 to 8 legs");
        for l in &legs {
            require!(!l.category.is_empty() && l.category.len() <= 32, "bad category");
            require!(l.max_price.0 > 0 && l.max_price.0 <= MAX_AMOUNT, "a leg's max price is 1 to 10^15");
        }
        require!(bond.0 > 0 && budget.0 > 0, "bond and budget must be positive");
        require!(bond.0 <= MAX_AMOUNT && budget.0 <= MAX_AMOUNT, "bond and budget are at most 10^15");
        require!((1..=100).contains(&min_top_pct), "min_top_pct is 1 to 100");
        require!(deadline_ms >= now_ms() + MIN_DURATION_MS, "the deadline is at least 10 minutes away");
        let buyer = env::predecessor_account_id();
        let buyers = buyers.unwrap_or_else(|| vec![buyer.clone()]);
        require!(!buyers.is_empty() && buyers.len() <= MAX_BUYERS, "1 to 8 buyer agents");
        for (i, b) in buyers.iter().enumerate() {
            require!(!buyers[..i].contains(b), "a buyer agent listed twice");
        }
        let id = self.next_id;
        self.next_id += 1;
        let job = Job {
            id,
            buyer,
            buyers,
            seats: vec![None; legs.len()],
            legs,
            bond,
            budget,
            funded: false,
            min_top_pct,
            opened_ms: now_ms(),
            deadline_ms,
            status: "open".into(),
        };
        emit(
            "job_opened",
            json!({ "job": id, "buyer": job.buyer, "buyers": job.buyers, "legs": job.legs, "bond": job.bond, "budget": job.budget, "min_top_pct": min_top_pct, "opened_ms": job.opened_ms, "deadline_ms": deadline_ms }),
        );
        self.jobs.insert(id, job);
        id
    }

    /// NEP-141 receiver. `{"fund": id}` from the buyer escrows the budget; `{"join": {...}}`
    /// posts a member's bond with its standing proof. A refused join returns the bond.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token, "only the job token");
        let v: Value = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("msg is not JSON"));
        if let Some(id) = v.get("fund").and_then(Value::as_u64) {
            let job = self.jobs.get_mut(&id).unwrap_or_else(|| env::panic_str("unknown job"));
            require!(job.buyer == sender_id, "only the job's buyer funds it");
            require!(!job.funded, "already funded");
            require!(job.status == "open" && now_ms() < job.deadline_ms, "job closed");
            require!(amount == job.budget, "send exactly the budget");
            job.funded = true;
            emit("job_funded", json!({ "job": id, "buyer": sender_id, "budget": amount }));
            return PromiseOrValue::Value(U128(0));
        }
        let j: JoinMsg = serde_json::from_value(v.get("join").cloned().unwrap_or_else(|| env::panic_str("msg: fund or join")))
            .unwrap_or_else(|_| env::panic_str("bad join msg"));
        match self.join_check(&sender_id, amount.0, &j) {
            Err(why) => {
                emit("join_refused", json!({ "job": j.job, "leg": j.leg, "member": sender_id, "reason": why, "refund": amount }));
                PromiseOrValue::Value(amount)
            }
            Ok((proof, pct)) => {
                let job = self.jobs.get_mut(&j.job).expect("checked");
                job.seats[j.leg as usize] = Some(Seat { member: sender_id.clone(), price: j.price, pending: true, announced: vec![], delivered: None });
                let top = serde_json::to_vec(&json!({ "proof": proof, "pct": pct })).expect("json");
                let who = serde_json::to_vec(&json!({ "merchant": sender_id })).expect("json");
                Promise::new(self.bazaar.clone())
                    .function_call("in_top", top, NearToken::from_yoctonear(0), GAS_VIEW)
                    .and(Promise::new(self.bazaar.clone()).function_call("merchant", who, NearToken::from_yoctonear(0), GAS_VIEW))
                    .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_ADMIT).on_admit(j.job, j.leg, sender_id, amount))
                    .into()
            }
        }
    }

    fn join_check(&self, sender: &AccountId, amount: u128, j: &JoinMsg) -> Result<(Value, u8), String> {
        let job = self.jobs.get(&j.job).ok_or("unknown job")?;
        if !job.funded || job.status != "open" || now_ms() >= job.deadline_ms {
            return Err("job not open for joins".into());
        }
        let leg = job.legs.get(j.leg as usize).ok_or("no such leg")?;
        if &job.buyer == sender || job.buyers.contains(sender) {
            return Err(REFUSE_OWN_JOB.into());
        }
        if job.seats[j.leg as usize].is_some() {
            return Err("leg taken".into());
        }
        if job.seats.iter().flatten().any(|s| &s.member == sender) {
            return Err("already a member of this job".into());
        }
        if amount != job.bond.0 {
            return Err(format!("bond is {}", job.bond.0));
        }
        if j.price.0 == 0 || j.price.0 > leg.max_price.0 {
            return Err("price above the leg's max".into());
        }
        let proof = j.proof.clone().filter(|p| p.is_object()).ok_or(REFUSE_NO_PROOF)?;
        if proof.get("merchant").and_then(Value::as_str) != Some(sender.as_str()) {
            return Err(REFUSE_LEAF.into());
        }
        Ok((proof, job.min_top_pct))
    }

    /// The bazaar's answers (`in_top`, then `merchant`): admitted, or the seat is cleared and
    /// the bond goes back (the returned amount is what the token refunds).
    #[private]
    pub fn on_admit(&mut self, job: u64, leg: u32, member: AccountId, bond: U128) -> U128 {
        let yes = matches!(env::promise_result_checked(0, 16), Ok(b) if b == b"true");
        let rec = result_json(1).unwrap_or(Value::Null);
        let j = self.jobs.get_mut(&job).expect("job");
        let open = j.status == "open";
        let category_ok = rec["approved"] == Value::Bool(true) && rec["category"].as_str() == Some(j.legs[leg as usize].category.as_str());
        let seat = j.seats[leg as usize].as_mut().filter(|s| s.member == member && s.pending);
        match seat {
            Some(s) if yes && open && category_ok => {
                s.pending = false;
                let price = s.price;
                let mut r = self.members.get(&member).cloned().unwrap_or_default();
                r.joined += 1;
                self.members.insert(member.clone(), r);
                emit("joined", json!({ "job": job, "leg": leg, "member": member, "price": price, "bond": bond, "category": j.legs[leg as usize].category }));
                U128(0)
            }
            _ => {
                let was_pending = j.seats[leg as usize].as_ref().is_some_and(|s| s.member == member && s.pending);
                if was_pending {
                    j.seats[leg as usize] = None;
                }
                let reason = if !open || !was_pending {
                    "job closed".to_string()
                } else if !yes {
                    format!("{REFUSE_LOW} {}%", j.min_top_pct)
                } else {
                    REFUSE_CATEGORY.to_string()
                };
                emit("join_refused", json!({ "job": job, "leg": leg, "member": member, "reason": reason, "refund": bond }));
                bond
            }
        }
    }

    /// A named buyer agent announces its own purchase for `leg`, while it is still unspent on
    /// the bazaar. Every announce is kept; any of them may deliver the leg.
    pub fn announce(&mut self, job: u64, leg: u32, nullifier: String) -> Promise {
        let j = self.jobs.get(&job).unwrap_or_else(|| env::panic_str("unknown job"));
        require!(j.buyers.contains(&env::predecessor_account_id()), REFUSE_ANNOUNCER);
        require!(j.status == "open" && now_ms() < j.deadline_ms, "job closed");
        let seat = j.seats.get(leg as usize).cloned().flatten().unwrap_or_else(|| env::panic_str("empty leg"));
        require!(!seat.pending, "the leg's join is in flight");
        require!(seat.delivered.is_none(), "already delivered");
        require!(seat.announced.len() < MAX_ANNOUNCES, "this leg holds the most announced purchases");
        require!(!self.announced.contains_key(&format!("{job}:{nullifier}")), "purchase already announced in this job");
        require!(!self.used.contains_key(&nullifier), "purchase already used for a delivery");
        let caller = env::predecessor_account_id();
        self.read_verdict(&nullifier).then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_VERDICT).on_announce(job, leg, nullifier, caller))
    }

    fn read_verdict(&self, nullifier: &str) -> Promise {
        let args = serde_json::to_vec(&json!({ "nullifier": nullifier })).expect("json");
        Promise::new(self.bazaar.clone()).function_call("verdict", args, NearToken::from_yoctonear(0), GAS_VIEW)
    }

    /// The checks a purchase passes to stand for a leg: an allowed buyer agent, a receipt that
    /// names the member at or under its quote, no dispute.
    fn check_purchase(j: &Job, seat: &Seat, rec: &Value) {
        require!(!rec.is_null(), "unknown nullifier");
        let agent: Option<AccountId> = rec["agent"].as_str().and_then(|a| a.parse().ok());
        require!(agent.is_some_and(|a| j.buyers.contains(&a)), REFUSE_BUYER);
        require!(rec["disputed"] != Value::Bool(true), "purchase disputed");
        let receipt = &rec["receipt"];
        require!(receipt["merchant"].as_str() == Some(seat.member.as_str()), "the receipt names another merchant");
        let price: u128 = receipt["price"].as_str().and_then(|p| p.parse().ok()).unwrap_or_else(|| env::panic_str("receipt has no price"));
        require!(price <= seat.price.0, "receipt price above the member's quote");
    }

    #[private]
    pub fn on_announce(&mut self, job: u64, leg: u32, nullifier: String, caller: AccountId) -> bool {
        let rec = result_json(0).unwrap_or_else(|| env::panic_str("bazaar verdict view failed"));
        let j = self.jobs.get(&job).cloned().expect("job");
        require!(j.status == "open" && now_ms() < j.deadline_ms, "job closed");
        let seat = j.seats[leg as usize].clone().expect("seat");
        require!(seat.delivered.is_none(), "already delivered");
        require!(seat.announced.len() < MAX_ANNOUNCES, "this leg holds the most announced purchases");
        let key = format!("{job}:{nullifier}");
        require!(!self.announced.contains_key(&key), "purchase already announced in this job");
        require!(!self.used.contains_key(&nullifier), "purchase already used for a delivery");
        Self::check_purchase(&j, &seat, &rec);
        require!(rec["agent"].as_str() == Some(caller.as_str()), REFUSE_NOT_AGENT);
        require!(rec["spent"] != Value::Bool(true), REFUSE_SPENT);
        self.announced.insert(key, leg);
        self.jobs.get_mut(&job).expect("job").seats[leg as usize].as_mut().expect("seat").announced.push(nullifier.clone());
        emit(
            "announced",
            json!({ "job": job, "leg": leg, "member": seat.member, "nullifier": nullifier, "buyer_agent": rec["agent"], "receipt_price": rec["receipt"]["price"] }),
        );
        true
    }

    /// Anyone shows a leg delivered: its announced purchase is now spent and paid.
    pub fn deliver(&mut self, job: u64, leg: u32, nullifier: String) -> Promise {
        let j = self.jobs.get(&job).unwrap_or_else(|| env::panic_str("unknown job"));
        require!(j.status == "open" && now_ms() < j.deadline_ms, "job closed");
        let seat = j.seats.get(leg as usize).cloned().flatten().unwrap_or_else(|| env::panic_str("empty leg"));
        require!(seat.delivered.is_none(), "already delivered");
        require!(seat.announced.contains(&nullifier), REFUSE_NOT_ANNOUNCED);
        require!(!self.used.contains_key(&nullifier), "purchase already used for a delivery");
        self.read_verdict(&nullifier).then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_VERDICT).on_verdict(job, leg, nullifier))
    }

    /// Checks the bazaar's verdict record; panics with the reason on a refusal.
    #[private]
    pub fn on_verdict(&mut self, job: u64, leg: u32, nullifier: String) -> bool {
        let rec = result_json(0).unwrap_or_else(|| env::panic_str("bazaar verdict view failed"));
        let j = self.jobs.get(&job).cloned().expect("job");
        require!(j.status == "open" && now_ms() < j.deadline_ms, "job closed");
        let seat = j.seats[leg as usize].clone().expect("seat");
        require!(seat.delivered.is_none(), "already delivered");
        require!(seat.announced.contains(&nullifier), REFUSE_NOT_ANNOUNCED);
        require!(!self.used.contains_key(&nullifier), "purchase already used for a delivery");
        Self::check_purchase(&j, &seat, &rec);
        require!(rec["spent"] == Value::Bool(true) && rec["paid"] == Value::Bool(true), "purchase not settled");
        self.used.insert(nullifier.clone(), job);
        self.jobs.get_mut(&job).expect("job").seats[leg as usize].as_mut().expect("seat").delivered = Some(nullifier.clone());
        emit(
            "delivered",
            json!({ "job": job, "leg": leg, "member": seat.member, "nullifier": nullifier, "receipt_price": rec["receipt"]["price"], "buyer_agent": rec["agent"] }),
        );
        true
    }

    /// After the deadline, anyone: pays out by `settle`, records each member, closes the job.
    /// Gas: each payout is a transfer (8 Tgas) and its callback (5 Tgas); with 8 legs, the buyer
    /// and the treasury that is 10 payouts, so attach at least 150 Tgas.
    /// A seat still waiting on the bazaar after the deadline plus `GRACE_MS` counts as refused
    /// (its bond went back through the token's refund, or goes back when the answer lands).
    pub fn finalize(&mut self, job: u64) -> String {
        let mut j = self.jobs.get(&job).cloned().unwrap_or_else(|| env::panic_str("unknown job"));
        require!(j.status == "open", "already finalized");
        require!(now_ms() >= j.deadline_ms, "deadline not reached");
        let pending = j.seats.iter().flatten().any(|s| s.pending);
        require!(!pending || now_ms() >= j.deadline_ms + GRACE_MS, "a join is still in flight");
        for (leg, s) in j.seats.iter_mut().enumerate() {
            if s.as_ref().is_some_and(|x| x.pending) {
                emit("join_lapsed", json!({ "job": job, "leg": leg, "member": s.as_ref().map(|x| x.member.clone()) }));
                *s = None;
            }
        }
        let outcome = |s: &Seat| match (&s.delivered, s.announced.is_empty()) {
            (Some(_), _) => Outcome::Delivered,
            (None, false) => Outcome::NoShow,
            (None, true) => Outcome::Unoffered,
        };
        let seats: Vec<(AccountId, u128, Outcome)> = j.seats.iter().flatten().map(|s| (s.member.clone(), s.price.0, outcome(s))).collect();
        let budget = if j.funded { j.budget.0 } else { 0 };
        let s = settle(budget, j.bond.0, &seats);
        let complete = j.funded && j.seats.iter().all(|x| x.as_ref().is_some_and(|s| s.delivered.is_some()));
        let status = if complete { "complete" } else { "failed" };
        let mut pays: Vec<(AccountId, u128)> = vec![];
        for (m, bond, share) in &s.delivered {
            let mut r = self.members.get(m).cloned().unwrap_or_default();
            r.completed += 1;
            r.earned.0 += share;
            self.members.insert(m.clone(), r);
            pays.push((m.clone(), bond + share));
        }
        for (m, bond) in &s.slashed {
            let mut r = self.members.get(m).cloned().unwrap_or_default();
            r.slashed += 1;
            r.lost.0 += bond;
            self.members.insert(m.clone(), r);
        }
        for (m, bond) in &s.released {
            let mut r = self.members.get(m).cloned().unwrap_or_default();
            r.released += 1;
            self.members.insert(m.clone(), r);
            pays.push((m.clone(), *bond));
        }
        pays.push((j.buyer.clone(), s.buyer));
        pays.push((self.treasury.clone(), s.treasury));
        j.status = status.into();
        self.jobs.insert(job, j.clone());
        emit(
            "job_finalized",
            json!({
                "job": job,
                "status": status,
                "buyer": j.buyer,
                "to_buyer": s.buyer.to_string(),
                "treasury": self.treasury,
                "to_treasury": s.treasury.to_string(),
                "delivered": s.delivered.iter().map(|(m, b, sh)| json!({ "member": m, "bond_back": b.to_string(), "share": sh.to_string() })).collect::<Vec<_>>(),
                "slashed": s.slashed.iter().map(|(m, b)| json!({ "member": m, "bond_lost": b.to_string() })).collect::<Vec<_>>(),
                "released": s.released.iter().map(|(m, b)| json!({ "member": m, "bond_back": b.to_string() })).collect::<Vec<_>>(),
            }),
        );
        for (to, amount) in pays.into_iter().filter(|p| p.1 > 0) {
            // Detached; a refused transfer becomes a claimable balance (on_payout).
            let _ = self.pay(to, amount, format!("coalition job {job}"));
        }
        status.into()
    }

    fn pay(&self, to: AccountId, amount: u128, memo: String) -> Promise {
        let args = serde_json::to_vec(&json!({ "receiver_id": to, "amount": amount.to_string(), "memo": memo })).expect("json");
        Promise::new(self.token.clone())
            .function_call("ft_transfer", args, NearToken::from_yoctonear(1), GAS_FT_TRANSFER)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_PAYOUT).on_payout(to, U128(amount)))
    }

    /// A refused transfer is credited to the receiver, who can `claim` it.
    #[private]
    pub fn on_payout(&mut self, to: AccountId, amount: U128) -> bool {
        if env::promise_result_checked(0, 1024).is_ok() {
            return true;
        }
        let c = self.claimable.get(&to).copied().unwrap_or(0) + amount.0;
        self.claimable.insert(to.clone(), c);
        emit("payout_failed", json!({ "account": to, "amount": amount, "claimable": c.to_string() }));
        false
    }

    /// Withdraw a balance a refused payout left here.
    pub fn claim(&mut self) -> Promise {
        let me = env::predecessor_account_id();
        let amount = self.claimable.get(&me).copied().unwrap_or(0);
        require!(amount > 0, "nothing to claim");
        self.claimable.remove(&me);
        emit("claimed", json!({ "account": me, "amount": amount.to_string() }));
        self.pay(me, amount, "coalition claim".into())
    }

    pub fn claimable_of(&self, account: AccountId) -> U128 {
        U128(self.claimable.get(&account).copied().unwrap_or(0))
    }

    pub fn job(&self, job: u64) -> Option<Job> {
        self.jobs.get(&job).cloned()
    }

    pub fn member(&self, account: AccountId) -> MemberRecord {
        self.members.get(&account).cloned().unwrap_or_default()
    }

    pub fn config(&self) -> Value {
        json!({ "token": self.token, "bazaar": self.bazaar, "treasury": self.treasury, "jobs": self.next_id, "version": VERSION })
    }
}

#[cfg(test)]
mod tests;
