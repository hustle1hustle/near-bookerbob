//! `bookerbob evidence`: storage and gas per contract method, measured by running the real
//! `bazaar` code once per method against near-sdk's MockedBlockchain on the fixtures.
//!
//! - Storage bytes are exact: `env::storage_usage()` before and after, which is what the
//!   contract charges the caller (`charge_storage`) at 10^19 yoctoNEAR per byte.
//! - Gas here is the host-function gas the mocked VM logic counts (sha256, ed25519_verify,
//!   storage reads and writes, logs). It does not include wasm instruction execution, so it
//!   is a lower bound. Real per-method gas comes from the testnet deploy (docs/testnet.md).
use std::process::ExitCode;
use std::time::Instant;

use bookerbob_bazaar::{Bazaar, ESCROW_STORAGE_DEPOSIT, RECORD_DEPOSIT};
use bookerbob_core::{bid_commitment, quote};
use bookerbob_referee_worker::{key_from_seed_hex, run as run_worker, WorkerInput};
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{env, testing_env, AccountId, NearToken};

use crate::fixtures::{self, AGENT, NOW_MS, OWNER, USDC};

fn acc(s: &str) -> AccountId {
    s.parse().expect("account id")
}

fn at(predecessor: &str, ms: u64, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(OWNER)).predecessor_account_id(acc(predecessor)).block_timestamp(ms * 1_000_000).attached_deposit(deposit);
    testing_env!(b.build());
}

pub struct Row {
    pub method: &'static str,
    pub caller: &'static str,
    pub storage_bytes: i64,
    pub host_tgas: f64,
}

impl Row {
    /// NEAR the caller pays for the storage it adds (refunded for a delete).
    pub fn storage_near(&self) -> f64 {
        self.storage_bytes as f64 * 1e-5
    }
}

fn measure(c: &mut Bazaar, rows: &mut Vec<Row>, method: &'static str, caller: &'static str, f: impl FnOnce(&mut Bazaar)) {
    c.flush_all();
    let before = env::storage_usage() as i64;
    f(c);
    c.flush_all();
    rows.push(Row { method, caller, storage_bytes: env::storage_usage() as i64 - before, host_tgas: env::used_gas().as_gas() as f64 / 1e12 });
}

/// One pass over the purchase path. Returns the rows and the referee worker's run time.
pub fn collect() -> (Vec<Row>, std::time::Duration) {
    let mut rows = Vec::new();
    let z = NearToken::from_yoctonear(0);
    let m = &fixtures::merchants()[0];
    let e = fixtures::envelope(AGENT);
    let v = fixtures::sign_ed(e.clone());
    let mut e2 = e.clone();
    e2.nullifier = fixtures::nullifier("evidence-p256");
    let v2 = fixtures::sign_p256(e2);
    let world = fixtures::world_attestation(AGENT, "fixture-person-1");
    let referee_key = key_from_seed_hex(&fixtures::referee_seed_hex()).expect("seed");

    at(OWNER, NOW_MS, z);
    let mut c = Bazaar::new(acc(OWNER), acc(USDC));
    measure(&mut c, &mut rows, "register_issuer", "owner", |c| c.register_issuer(v.key_id(), "fixture ed25519 issuer".into()));
    c.register_issuer(v2.key_id(), "fixture p256 issuer".into());
    c.register_referee(hex::encode(referee_key.verifying_key().to_bytes()), "fixture referee".into());
    measure(&mut c, &mut rows, "register_world_verifier", "owner", |c| {
        c.register_world_verifier(world.verifier_key.clone(), world.body.action.clone(), "fixture".into())
    });
    at(AGENT, NOW_MS, RECORD_DEPOSIT);
    measure(&mut c, &mut rows, "attest_human", "agent", |c| c.attest_human(world.clone()));
    at(&m.account, NOW_MS, RECORD_DEPOSIT);
    measure(&mut c, &mut rows, "register_merchant", "merchant", |c| c.register_merchant(m.schedule.clone(), m.category.clone(), None));
    at(OWNER, NOW_MS, z);
    measure(&mut c, &mut rows, "approve_merchant", "owner", |c| c.approve_merchant(acc(&m.account)));

    // Blind round.
    let salt = [7u8; 32];
    at(OWNER, NOW_MS, z);
    measure(&mut c, &mut rows, "open_round", "owner", |c| c.open_round("evidence".into(), m.category.clone(), NOW_MS + 60_000, NOW_MS + 120_000));
    at(&m.account, NOW_MS, RECORD_DEPOSIT);
    measure(&mut c, &mut rows, "commit_bid", "merchant", |c| c.commit_bid("evidence".into(), bid_commitment(&m.account, &m.schedule, &salt)));
    at(&m.account, NOW_MS + 60_000, RECORD_DEPOSIT);
    measure(&mut c, &mut rows, "reveal_bid", "merchant", |c| c.reveal_bid("evidence".into(), m.schedule.clone(), hex::encode(salt)));

    // Escrow, verdicts, referee, settle.
    let t = NOW_MS + 120_000;
    at(AGENT, t, ESCROW_STORAGE_DEPOSIT);
    measure(&mut c, &mut rows, "storage_deposit (escrow entry)", "agent", |c| c.storage_deposit(None));
    at(USDC, t, z);
    measure(&mut c, &mut rows, "ft_on_transfer (USDC in)", "USDC contract", |c| drop(c.ft_on_transfer(acc(AGENT), U128(fixtures::ESCROW_USDC), String::new())));
    at(AGENT, t, RECORD_DEPOSIT);
    measure(&mut c, &mut rows, "submit_verdict (ed25519, first in context)", "agent", |c| c.submit_verdict(v.clone()));
    at(AGENT, t, RECORD_DEPOSIT);
    measure(&mut c, &mut rows, "submit_verdict (p256, same context)", "agent", |c| c.submit_verdict(v2.clone()));
    let q = quote(&m.schedule, &e.predicates);
    let input = WorkerInput {
        v: 0,
        verdict_digest: hex::encode(e.digest()),
        nullifier: e.nullifier.clone(),
        merchant: m.account.clone(),
        schedule: m.schedule.clone(),
        revealed: e.predicates.clone(),
        claims: fixtures::honest_claims(),
        proofs: fixtures::proofs(),
        cohort_k: 0,
    };
    let started = Instant::now();
    let out = run_worker(&input, &referee_key).expect("worker runs");
    let worker_time = started.elapsed();
    let result = serde_json::from_str(&out).expect("worker json");
    at(AGENT, t, z);
    measure(&mut c, &mut rows, "submit_referee_result", "contract balance (only a referee-signed result is stored)", |c| {
        assert!(c.submit_referee_result(result))
    });
    at(AGENT, t, z);
    measure(&mut c, &mut rows, "best_quote (view, 1 merchant)", "free (view)", |c| drop(c.best_quote(e.nullifier.clone(), None, None, None)));
    at(AGENT, t, z);
    measure(&mut c, &mut rows, "settle (+ ft_transfer receipt)", "agent pays gas; contract balance pays the 14 bytes", |c| {
        drop(c.settle(e.nullifier.clone(), acc(&m.account), "evidence-1".into(), U128(q.price)))
    });
    (rows, worker_time)
}

pub fn table(rows: &[Row]) -> String {
    let mut s = String::from("| method | who pays | storage added (bytes) | storage cost (NEAR) | host gas, mocked (Tgas, lower bound; settle includes gas attached to its two receipts) |\n|---|---|---|---|---|\n");
    for r in rows {
        s.push_str(&format!("| `{}` | {} | {} | {:.5} | {:.3} |\n", r.method, r.caller, r.storage_bytes, r.storage_near(), r.host_tgas));
    }
    s
}

pub fn run() -> ExitCode {
    std::panic::set_hook(Box::new(|_| {}));
    let (rows, worker) = collect();
    print!("{}", table(&rows));
    let per = |m: &str| rows.iter().find(|r| r.method.starts_with(m)).map_or(0, |r| r.storage_bytes);
    println!(
        "\nper verdict: {} bytes ({:.5} NEAR, paid by the agent from its 0.05 NEAR deposit, rest refunded); referee worker run: {} us (native)",
        per("submit_verdict (ed25519"),
        per("submit_verdict (ed25519") as f64 * 1e-5,
        worker.as_micros()
    );
    ExitCode::SUCCESS
}
