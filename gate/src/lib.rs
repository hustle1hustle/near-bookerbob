//! Verdict Gate (`gate.bookerbob.testnet`): a Sputnik DAO role adapter. A DAO opts in by calling
//! `set_rule(role, predicate, ...)` itself (a proposal of its own), and gives this account a
//! policy role that may propose and approve `AddMemberToRole`. Then any agent calls
//! `join(dao, role, nullifier)`: the gate reads that verdict from the bazaar, checks it names the
//! caller, reveals the predicate, is in the context and not expired, and the nullifier has not
//! been used for this role, then proposes and approves adding the caller to the role.
//!
//! The DAO learns one bit (the predicate holds) and the agent account; never the facts. A sealed
//! verdict reveals no predicate on chain, so it cannot pass a gate. No owner: rules belong to
//! the DAO that set them.
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};
use serde_json::{json, Value};

const GAS_VIEW: Gas = Gas::from_tgas(10);
const GAS_ON_VERDICT: Gas = Gas::from_tgas(200);
const GAS_PROPOSE: Gas = Gas::from_tgas(30);
const GAS_ON_PROPOSAL: Gas = Gas::from_tgas(140);
const GAS_VOTE: Gas = Gas::from_tgas(100);
const GAS_ON_VOTE: Gas = Gas::from_tgas(10);
/// What `join` needs attached: the whole chain above plus its own step.
pub const GAS_JOIN: Gas = Gas::from_tgas(290);

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Rule {
    pub predicate: String,
    /// Only verdicts in this context count; None accepts any context.
    pub context: Option<String>,
    /// The DAO's proposal bond, attached by the gate (refunded by the DAO on approval).
    pub bond: U128,
}

#[ext_contract(ext_bazaar)]
pub trait Bazaar {
    fn verdict(&self, nullifier: String) -> Option<Value>;
}

#[ext_contract(ext_dao)]
pub trait Dao {
    fn add_proposal(&mut self, proposal: Value) -> u64;
    fn act_proposal(&mut self, id: u64, action: String, proposal: Value);
}

/// The admission check, on the bazaar's `verdict` view: Ok, or the reason it is refused.
pub fn admit(rule: &Rule, verdict: Option<&Value>, member: &str, now_ms: u64) -> Result<(), String> {
    let v = verdict.filter(|v| !v.is_null()).ok_or("no verdict under this nullifier")?;
    if v["agent"].as_str() != Some(member) {
        return Err("the verdict belongs to another agent".into());
    }
    if v["tier"].as_str() == Some("sealed") {
        return Err("a sealed verdict reveals no predicate on chain".into());
    }
    if !v["predicates"].as_array().is_some_and(|ps| ps.iter().any(|p| p.as_str() == Some(rule.predicate.as_str()))) {
        return Err(format!("the verdict does not reveal {}", rule.predicate));
    }
    if let Some(c) = &rule.context {
        if v["context"].as_str() != Some(c.as_str()) {
            return Err("the verdict is for another context".into());
        }
    }
    if v["expires_at_ms"].as_u64().is_none_or(|e| e <= now_ms) {
        return Err("the verdict has expired".into());
    }
    Ok(())
}

fn key(dao: &AccountId, role: &str) -> String {
    format!("{dao}|{role}")
}

fn kind(member: &AccountId, role: &str) -> Value {
    json!({ "AddMemberToRole": { "member_id": member, "role": role } })
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Gate {
    bazaar: AccountId,
    rules: LookupMap<String, Rule>,
    /// `dao|role|nullifier`: one verdict admits one agent to one role, once.
    used: LookupSet<String>,
}

#[near]
impl Gate {
    #[init]
    pub fn new(bazaar: AccountId) -> Self {
        Self { bazaar, rules: LookupMap::new(b"r"), used: LookupSet::new(b"u") }
    }

    pub fn bazaar(&self) -> AccountId {
        self.bazaar.clone()
    }

    /// Called by the DAO itself: its role `role` admits agents whose verdict reveals `predicate`.
    #[payable]
    pub fn set_rule(&mut self, role: String, predicate: String, context: Option<String>, bond: Option<U128>) {
        require!(!role.is_empty() && role.len() <= 64 && !predicate.is_empty() && predicate.len() <= 64, "bad rule");
        let before = env::storage_usage();
        let dao = env::predecessor_account_id();
        let rule = Rule { predicate, context, bond: bond.unwrap_or(U128(0)) };
        self.rules.insert(key(&dao, &role), rule.clone());
        self.rules.flush();
        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({ "standard": "bookerbob-gate", "version": "1.0.0", "event": "rule_set", "data": [{ "dao": dao, "role": role, "rule": rule }] })
        ));
        let cost = env::storage_byte_cost().saturating_mul(env::storage_usage().saturating_sub(before) as u128);
        require!(env::attached_deposit() >= cost, "attach storage for the rule");
    }

    pub fn remove_rule(&mut self, role: String) {
        self.rules.remove(&key(&env::predecessor_account_id(), &role));
        self.rules.flush();
    }

    pub fn rule(&self, dao: AccountId, role: String) -> Option<Rule> {
        self.rules.get(&key(&dao, &role)).cloned()
    }

    pub fn used(&self, dao: AccountId, role: String, nullifier: String) -> bool {
        self.used.contains(&format!("{}|{nullifier}", key(&dao, &role)))
    }

    /// Ask to join `dao`'s `role` with the verdict under `nullifier`. Attach 290 Tgas.
    pub fn join(&mut self, dao: AccountId, role: String, nullifier: String) -> Promise {
        require!(self.rules.contains_key(&key(&dao, &role)), "this DAO has no gate rule for that role");
        require!(!self.used(dao.clone(), role.clone(), nullifier.clone()), "this verdict already admitted an agent to this role");
        require!(env::prepaid_gas() >= GAS_JOIN, "attach 290 Tgas");
        ext_bazaar::ext(self.bazaar.clone())
            .with_static_gas(GAS_VIEW)
            .verdict(nullifier.clone())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_VERDICT).on_verdict(dao, role, nullifier, env::predecessor_account_id()))
    }

    #[private]
    pub fn on_verdict(
        &mut self,
        dao: AccountId,
        role: String,
        nullifier: String,
        member: AccountId,
        #[callback_result] verdict: Result<Option<Value>, PromiseError>,
    ) -> Promise {
        let rule = self.rules.get(&key(&dao, &role)).cloned().unwrap_or_else(|| env::panic_str("the rule was removed"));
        let v = verdict.unwrap_or_else(|_| env::panic_str("the bazaar view failed"));
        if let Err(e) = admit(&rule, v.as_ref(), member.as_str(), env::block_timestamp_ms()) {
            env::panic_str(&e);
        }
        let u = format!("{}|{nullifier}", key(&dao, &role));
        require!(!self.used.contains(&u), "this verdict already admitted an agent to this role");
        self.used.insert(u);
        let proposal = json!({ "description": format!("Verdict Gate: {member} holds a verdict revealing {} ({})", rule.predicate, env::current_account_id()), "kind": kind(&member, &role) });
        ext_dao::ext(dao.clone())
            .with_attached_deposit(NearToken::from_yoctonear(rule.bond.0))
            .with_static_gas(GAS_PROPOSE)
            .add_proposal(proposal)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_PROPOSAL).on_proposal(dao, role, nullifier, member))
    }

    #[private]
    pub fn on_proposal(
        &mut self,
        dao: AccountId,
        role: String,
        nullifier: String,
        member: AccountId,
        #[callback_result] id: Result<u64, PromiseError>,
    ) -> Option<Promise> {
        let Ok(id) = id else {
            // The DAO refused the proposal (no gate role in its policy, or the bond): free the verdict.
            self.used.remove(&format!("{}|{nullifier}", key(&dao, &role)));
            env::log_str("gate: the DAO refused the proposal");
            return None;
        };
        Some(
            ext_dao::ext(dao.clone())
                .with_static_gas(GAS_VOTE)
                .act_proposal(id, "VoteApprove".into(), kind(&member, &role))
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_VOTE).on_vote(dao, role, member, id)),
        )
    }

    #[private]
    pub fn on_vote(&mut self, dao: AccountId, role: String, member: AccountId, id: u64, #[callback_result] r: Result<(), PromiseError>) -> bool {
        let ok = r.is_ok();
        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({ "standard": "bookerbob-gate", "version": "1.0.0", "event": if ok { "admitted" } else { "vote_failed" }, "data": [{ "dao": dao, "role": role, "member": member, "proposal": id }] })
        ));
        ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule() -> Rule {
        Rule { predicate: "world_id_human".into(), context: Some("bookerbob:v0:demo-hoodie".into()), bond: U128(0) }
    }
    fn verdict(agent: &str, preds: &[&str], tier: &str) -> Value {
        json!({ "agent": agent, "context": "bookerbob:v0:demo-hoodie", "predicates": preds, "tier": tier, "expires_at_ms": 2_000, "spent": true })
    }

    #[test]
    fn a_verdict_that_names_the_caller_and_reveals_the_predicate_admits() {
        assert_eq!(admit(&rule(), Some(&verdict("t-1.testnet", &["airbnb_frequent", "world_id_human"], "gold")), "t-1.testnet", 1_000), Ok(()));
    }

    #[test]
    fn someone_elses_verdict_a_sealed_one_a_missing_predicate_and_an_expired_one_are_refused() {
        let r = rule();
        assert_eq!(
            admit(&r, Some(&verdict("t-1.testnet", &["world_id_human"], "gold")), "thief.testnet", 1_000).unwrap_err(),
            "the verdict belongs to another agent"
        );
        assert_eq!(
            admit(&r, Some(&verdict("t-1.testnet", &[], "sealed")), "t-1.testnet", 1_000).unwrap_err(),
            "a sealed verdict reveals no predicate on chain"
        );
        assert_eq!(
            admit(&r, Some(&verdict("t-1.testnet", &["airbnb_frequent"], "silver")), "t-1.testnet", 1_000).unwrap_err(),
            "the verdict does not reveal world_id_human"
        );
        assert_eq!(admit(&r, Some(&verdict("t-1.testnet", &["world_id_human"], "gold")), "t-1.testnet", 3_000).unwrap_err(), "the verdict has expired");
        assert_eq!(admit(&r, None, "t-1.testnet", 1_000).unwrap_err(), "no verdict under this nullifier");
        let mut other = verdict("t-1.testnet", &["world_id_human"], "gold");
        other["context"] = json!("elsewhere");
        assert_eq!(admit(&r, Some(&other), "t-1.testnet", 1_000).unwrap_err(), "the verdict is for another context");
    }

    #[test]
    fn a_rule_belongs_to_the_dao_that_set_it() {
        let mut ctx = near_sdk::test_utils::VMContextBuilder::new();
        ctx.predecessor_account_id("club.sputnikv2.testnet".parse().unwrap()).attached_deposit(NearToken::from_millinear(10));
        near_sdk::testing_env!(ctx.build());
        let mut g = Gate::new("bookerbob.testnet".parse().unwrap());
        g.set_rule("human".into(), "world_id_human".into(), None, None);
        assert_eq!(g.rule("club.sputnikv2.testnet".parse().unwrap(), "human".into()).unwrap().predicate, "world_id_human");
        assert_eq!(g.rule("other.sputnikv2.testnet".parse().unwrap(), "human".into()), None);
    }
}
