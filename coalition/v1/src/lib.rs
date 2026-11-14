//! Coalitions of merchant agents (docs/coalitions.md). A buyer or a lead agent opens a job of
//! several legs and escrows its budget in the bazaar's demo token. A merchant agent joins one leg
//! by posting a bond with its standing proof: the bazaar answers `in_top(proof, min_top_pct)`
//! over its Jolt-proven standing tree, and the proof's leaf must be the sender. A member shows
//! delivery with a bazaar purchase: the verdict is spent, its referee receipt names the member,
//! at or under the member's quote. After the deadline anyone finalizes: deliverers get their
//! bond back and a share of the budget pro rata to their quoted price; a member that did not
//! deliver loses its bond, half to the buyer and half to the deliverers.
//!
//! The contract has no owner and no admin method. It trusts the bazaar's views and the token.
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

pub const MAX_LEGS: usize = 8;
/// Attached to `open_job` for the job's storage; kept by the contract.
pub const OPEN_DEPOSIT: NearToken = NearToken::from_millinear(20);
const GAS_IN_TOP: Gas = Gas::from_tgas(10);
const GAS_ON_ADMIT: Gas = Gas::from_tgas(8);
const GAS_VERDICT: Gas = Gas::from_tgas(15);
const GAS_ON_VERDICT: Gas = Gas::from_tgas(15);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(8);

pub const REFUSE_NO_PROOF: &str = "no standing proof";
pub const REFUSE_LEAF: &str = "the proof's leaf is not the sender";
pub const REFUSE_LOW: &str = "not in the top of the proven standing";

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Leg {
    pub category: String,
    pub max_price: near_sdk::json_types::U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Seat {
    pub member: AccountId,
    /// The member's quote for this leg; the delivering receipt must be at or under it.
    pub price: near_sdk::json_types::U128,
    /// True while the bazaar's `in_top` answer is in flight.
    pub pending: bool,
    /// The bazaar nullifier whose spent purchase delivered this leg.
    pub delivered: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    pub id: u64,
    pub buyer: AccountId,
    pub legs: Vec<Leg>,
    pub seats: Vec<Option<Seat>>,
    pub bond: near_sdk::json_types::U128,
    pub budget: near_sdk::json_types::U128,
    pub funded: bool,
    pub min_top_pct: u8,
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
    /// Budget shares received plus slashed bonds received, in token base units.
    pub earned: near_sdk::json_types::U128,
    /// Bonds lost.
    pub lost: near_sdk::json_types::U128,
}

/// What `finalize` pays: to whom, and why. Pure, so the split and slash rules are tested alone.
#[derive(Clone, Debug, PartialEq)]
pub struct Settlement {
    pub buyer: u128,
    /// (member, bond back, budget share, share of slashed bonds)
    pub delivered: Vec<(AccountId, u128, u128, u128)>,
    /// (member, bond lost)
    pub slashed: Vec<(AccountId, u128)>,
}

/// The split and slash rule. `seats` are the joined seats: (member, quoted price, delivered).
///
/// - Budget: a deliverer gets `budget * price / P`, P the sum of the quoted prices of every
///   joined seat (floor). Whatever is left (undelivered seats, unfilled legs, rounding) goes
///   back to the buyer. No seat joined: the whole budget goes back.
/// - Bonds: a deliverer gets its bond back. A seat that did not deliver loses its bond: half
///   (floor) to the buyer as compensation, the rest to the deliverers pro rata to their quoted
///   price (floor, the remainder to the buyer). No deliverer: the whole slashed bond to the buyer.
///
/// Conserved: buyer + every payout = budget + bond * seats.
pub fn settle(budget: u128, bond: u128, seats: &[(AccountId, u128, bool)]) -> Settlement {
    let p: u128 = seats.iter().map(|s| s.1).sum();
    let d: u128 = seats.iter().filter(|s| s.2).map(|s| s.1).sum();
    let slashed_total = bond * seats.iter().filter(|s| !s.2).count() as u128;
    let to_deliverers = if d > 0 { slashed_total - slashed_total / 2 } else { 0 };
    let mut out = Settlement { buyer: 0, delivered: vec![], slashed: vec![] };
    let mut paid = 0u128;
    for (m, price, ok) in seats {
        if *ok {
            let share = budget * price / p;
            let comp = to_deliverers * price / d;
            paid += bond + share + comp;
            out.delivered.push((m.clone(), bond, share, comp));
        } else {
            out.slashed.push((m.clone(), bond));
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
    next_id: u64,
    jobs: LookupMap<u64, Job>,
    members: LookupMap<AccountId, MemberRecord>,
    /// Bazaar nullifiers already used to show a delivery.
    used: LookupMap<String, u64>,
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "bookerbob-coalition", "version": "1.0.0", "event": event, "data": [data] })));
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

#[near(serializers = [json])]
pub struct JoinMsg {
    pub job: u64,
    pub leg: u32,
    pub price: near_sdk::json_types::U128,
    /// The bazaar's `TopProof` for the sender's leaf, passed to `in_top` as it is.
    pub proof: Option<Value>,
}

#[near]
impl Coalition {
    #[init]
    pub fn new(token: AccountId, bazaar: AccountId) -> Self {
        Self { token, bazaar, next_id: 0, jobs: LookupMap::new(b"j"), members: LookupMap::new(b"m"), used: LookupMap::new(b"u") }
    }

    /// The buyer (or a lead agent) opens a job; it then funds the budget with
    /// `ft_transfer_call(msg {"fund": id})`. Members can join only a funded job.
    #[payable]
    pub fn open_job(&mut self, legs: Vec<Leg>, bond: near_sdk::json_types::U128, budget: near_sdk::json_types::U128, min_top_pct: u8, deadline_ms: u64) -> u64 {
        require!(env::attached_deposit() >= OPEN_DEPOSIT, "attach 0.02 NEAR for the job's storage");
        require!(!legs.is_empty() && legs.len() <= MAX_LEGS, "1 to 8 legs");
        for l in &legs {
            require!(!l.category.is_empty() && l.category.len() <= 32, "bad category");
            require!(l.max_price.0 > 0, "a leg needs a max price");
        }
        require!(bond.0 > 0 && budget.0 > 0, "bond and budget must be positive");
        require!((1..=100).contains(&min_top_pct), "min_top_pct is 1 to 100");
        require!(deadline_ms > now_ms(), "deadline in the past");
        let id = self.next_id;
        self.next_id += 1;
        let job = Job {
            id,
            buyer: env::predecessor_account_id(),
            seats: vec![None; legs.len()],
            legs,
            bond,
            budget,
            funded: false,
            min_top_pct,
            deadline_ms,
            status: "open".into(),
        };
        emit(
            "job_opened",
            json!({ "job": id, "buyer": job.buyer, "legs": job.legs, "bond": job.bond, "budget": job.budget, "min_top_pct": min_top_pct, "deadline_ms": deadline_ms }),
        );
        self.jobs.insert(id, job);
        id
    }

    /// NEP-141 receiver. `{"fund": id}` from the buyer escrows the budget; `{"join": {...}}`
    /// posts a member's bond with its standing proof. A refused join returns the bond.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: near_sdk::json_types::U128, msg: String) -> PromiseOrValue<near_sdk::json_types::U128> {
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
            return PromiseOrValue::Value(near_sdk::json_types::U128(0));
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
                job.seats[j.leg as usize] = Some(Seat { member: sender_id.clone(), price: j.price, pending: true, delivered: None });
                let args = serde_json::to_vec(&json!({ "proof": proof, "pct": pct })).expect("json");
                Promise::new(self.bazaar.clone())
                    .function_call("in_top", args, NearToken::from_yoctonear(0), GAS_IN_TOP)
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

    /// The bazaar's answer: admitted, or the seat is cleared and the bond goes back
    /// (the returned amount is what the token refunds).
    #[private]
    pub fn on_admit(&mut self, job: u64, leg: u32, member: AccountId, bond: near_sdk::json_types::U128) -> near_sdk::json_types::U128 {
        let yes = matches!(env::promise_result_checked(0, 16), Ok(b) if b == b"true");
        let j = self.jobs.get_mut(&job).expect("job");
        let open = j.status == "open";
        let seat = j.seats[leg as usize].as_mut().filter(|s| s.member == member && s.pending);
        match seat {
            Some(s) if yes && open => {
                s.pending = false;
                let price = s.price;
                let mut r = self.members.get(&member).cloned().unwrap_or_default();
                r.joined += 1;
                self.members.insert(member.clone(), r);
                emit("joined", json!({ "job": job, "leg": leg, "member": member, "price": price, "bond": bond }));
                near_sdk::json_types::U128(0)
            }
            _ => {
                if j.seats[leg as usize].as_ref().is_some_and(|s| s.member == member && s.pending) {
                    j.seats[leg as usize] = None;
                }
                let reason = if !open { "job closed".to_string() } else { format!("{REFUSE_LOW} {}%", j.min_top_pct) };
                emit("join_refused", json!({ "job": job, "leg": leg, "member": member, "reason": reason, "refund": bond }));
                bond
            }
        }
    }

    /// A member shows its leg delivered: a bazaar purchase (`nullifier`) that is spent and paid,
    /// whose referee receipt names this member at or under its quote.
    pub fn deliver(&mut self, job: u64, leg: u32, nullifier: String) -> Promise {
        let j = self.jobs.get(&job).unwrap_or_else(|| env::panic_str("unknown job"));
        require!(j.status == "open" && now_ms() < j.deadline_ms, "job closed");
        let seat = j.seats.get(leg as usize).cloned().flatten().unwrap_or_else(|| env::panic_str("empty leg"));
        require!(seat.member == env::predecessor_account_id() && !seat.pending, "not this leg's member");
        require!(seat.delivered.is_none(), "already delivered");
        require!(!self.used.contains_key(&nullifier), "purchase already used for a delivery");
        let args = serde_json::to_vec(&json!({ "nullifier": nullifier })).expect("json");
        Promise::new(self.bazaar.clone())
            .function_call("verdict", args, NearToken::from_yoctonear(0), GAS_VERDICT)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_VERDICT).on_verdict(job, leg, nullifier))
    }

    /// Checks the bazaar's verdict record; panics with the reason on a refusal.
    #[private]
    pub fn on_verdict(&mut self, job: u64, leg: u32, nullifier: String) -> bool {
        let bytes = env::promise_result_checked(0, 16_384).unwrap_or_else(|_| env::panic_str("bazaar verdict view failed"));
        let rec: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        require!(!rec.is_null(), "unknown nullifier");
        let j = self.jobs.get_mut(&job).expect("job");
        require!(j.status == "open", "job closed");
        let seat = j.seats[leg as usize].as_mut().expect("seat");
        require!(seat.delivered.is_none(), "already delivered");
        require!(!self.used.contains_key(&nullifier), "purchase already used for a delivery");
        require!(rec["spent"] == Value::Bool(true) && rec["paid"] == Value::Bool(true), "purchase not settled");
        require!(rec["disputed"] != Value::Bool(true), "purchase disputed");
        let receipt = &rec["receipt"];
        require!(receipt["merchant"].as_str() == Some(seat.member.as_str()), "the receipt names another merchant");
        let price: u128 = receipt["price"].as_str().and_then(|p| p.parse().ok()).unwrap_or_else(|| env::panic_str("receipt has no price"));
        require!(price <= seat.price.0, "receipt price above the member's quote");
        seat.delivered = Some(nullifier.clone());
        let member = seat.member.clone();
        self.used.insert(nullifier.clone(), job);
        emit(
            "delivered",
            json!({ "job": job, "leg": leg, "member": member, "nullifier": nullifier, "receipt_price": price.to_string(), "buyer_agent": rec["agent"] }),
        );
        true
    }

    /// After the deadline, anyone: pays out by `settle`, records each member, closes the job.
    pub fn finalize(&mut self, job: u64) -> String {
        let j = self.jobs.get(&job).cloned().unwrap_or_else(|| env::panic_str("unknown job"));
        require!(j.status == "open", "already finalized");
        require!(now_ms() >= j.deadline_ms, "deadline not reached");
        require!(j.seats.iter().flatten().all(|s| !s.pending), "a join is still in flight");
        let seats: Vec<(AccountId, u128, bool)> = j.seats.iter().flatten().map(|s| (s.member.clone(), s.price.0, s.delivered.is_some())).collect();
        let budget = if j.funded { j.budget.0 } else { 0 };
        let s = settle(budget, j.bond.0, &seats);
        let complete = j.funded && j.seats.iter().all(|x| x.as_ref().is_some_and(|s| s.delivered.is_some()));
        let status = if complete { "complete" } else { "failed" };
        let mut pays: Vec<(AccountId, u128)> = vec![];
        for (m, bond, share, comp) in &s.delivered {
            let mut r = self.members.get(m).cloned().unwrap_or_default();
            r.completed += 1;
            r.earned.0 += share + comp;
            self.members.insert(m.clone(), r);
            pays.push((m.clone(), bond + share + comp));
        }
        for (m, bond) in &s.slashed {
            let mut r = self.members.get(m).cloned().unwrap_or_default();
            r.slashed += 1;
            r.lost.0 += bond;
            self.members.insert(m.clone(), r);
        }
        pays.push((j.buyer.clone(), s.buyer));
        self.jobs.get_mut(&job).expect("job").status = status.into();
        emit(
            "job_finalized",
            json!({
                "job": job,
                "status": status,
                "buyer": j.buyer,
                "to_buyer": s.buyer.to_string(),
                "delivered": s.delivered.iter().map(|(m, b, sh, c)| json!({ "member": m, "bond_back": b.to_string(), "share": sh.to_string(), "from_slashed": c.to_string() })).collect::<Vec<_>>(),
                "slashed": s.slashed.iter().map(|(m, b)| json!({ "member": m, "bond_lost": b.to_string() })).collect::<Vec<_>>(),
            }),
        );
        for (to, amount) in pays.into_iter().filter(|p| p.1 > 0) {
            let args = serde_json::to_vec(&json!({ "receiver_id": to, "amount": amount.to_string(), "memo": format!("coalition job {job}") })).expect("json");
            // Detached: scheduled when dropped. A failed transfer leaves the amount here (docs).
            let _ = Promise::new(self.token.clone()).function_call("ft_transfer", args, NearToken::from_yoctonear(1), GAS_FT_TRANSFER);
        }
        status.into()
    }

    pub fn job(&self, job: u64) -> Option<Job> {
        self.jobs.get(&job).cloned()
    }

    pub fn member(&self, account: AccountId) -> MemberRecord {
        self.members.get(&account).cloned().unwrap_or_default()
    }

    pub fn config(&self) -> Value {
        json!({ "token": self.token, "bazaar": self.bazaar, "jobs": self.next_id })
    }
}

#[cfg(test)]
mod tests;
