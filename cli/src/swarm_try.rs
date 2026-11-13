//! `bookerbob swarm-try`: a mini swarm on one fresh bazaar (near-sdk's MockedBlockchain, the
//! real contract code), printed as it happens. Five merchant agents commit sealed schedules
//! and reveal them after the deadline; six buyer agents each submit a signed verdict (checked
//! on chain with `ed25519_verify`), get the round's winning quote for their revealed bits, a
//! referee receipt, and settle; a replay of a spent verdict is refused. No network, no keys:
//! every key is a fixture seed and every fact is synthetic. `scripts/swarm-try.mjs` wraps it.
use std::process::ExitCode;
use std::time::Instant;

use bookerbob_bazaar::Bazaar;
use bookerbob_core::{bid_commitment, Rule, Schedule};
use near_sdk::AccountId;

use crate::fixtures::{self, MerchantFixture, AGENT, NOW_MS, OWNER, USDC, WALLET2};
use crate::reviews::{at, call, enter, pay};

fn acc(s: &str) -> AccountId {
    s.parse().expect("account id")
}

const ROUND: &str = "swarm-try";
const COMMIT_UNTIL: u64 = NOW_MS + 60_000;
const REVEAL_UNTIL: u64 = NOW_MS + 120_000;

fn short(a: &str) -> &str {
    a.split('.').next().unwrap_or(a)
}

fn usd(x: u128) -> String {
    format!("{}.{:02}", x / 1_000_000, (x % 1_000_000) / 10_000)
}

/// The three fixture hoodie merchants plus two more, so five agents bid.
fn merchants() -> Vec<MerchantFixture> {
    let r = |p: &str, bps: u16| Rule { predicate: p.into(), bps };
    let mut v = fixtures::merchants();
    v.push(MerchantFixture {
        account: "m04.bookerbob.testnet".into(),
        label: "humans only".into(),
        category: "hoodie".into(),
        schedule: Schedule { base_price: 46_000_000, rules: vec![r("world_id_human", 1500)], cap_bps: 1500, cohort: None },
    });
    v.push(MerchantFixture {
        account: "m05.bookerbob.testnet".into(),
        label: "builders".into(),
        category: "hoodie".into(),
        schedule: Schedule { base_price: 44_000_000, rules: vec![r("claude_spender", 800)], cap_bps: 800, cohort: None },
    });
    v
}

pub fn run() -> ExitCode {
    std::panic::set_hook(Box::new(|_| {}));
    let t0 = Instant::now();
    let ms = || format!("{:>5} ms", t0.elapsed().as_millis());
    let ms_ = &ms;
    let mut fails = 0;
    let mut line = |ok: bool, what: String| {
        fails += (!ok) as usize;
        println!("{}  {}  {what}", ms_(), if ok { "ok  " } else { "FAIL" });
    };

    println!("swarm-try: the bazaar contract's own code on near-sdk's mocked chain (not testnet); fixture keys, synthetic facts, no network");
    let verdict = fixtures::sign_ed(fixtures::envelope(AGENT));
    at(OWNER, NOW_MS);
    let mut c = Bazaar::new(acc(OWNER), acc(USDC));
    c.register_issuer(verdict.key_id(), "fixture issuer".into());
    let referee = bookerbob_referee_worker::key_from_seed_hex(&fixtures::referee_seed_hex()).expect("seed");
    c.register_referee(hex::encode(referee.verifying_key().to_bytes()), "fixture referee".into());
    let worlds = fixtures::world_attestations();
    c.register_world_verifier(worlds[0].verifier_key.clone(), worlds[0].body.action.clone(), "fixture world verifier".into());
    let ms_list = merchants();
    for m in &ms_list {
        at(&m.account, NOW_MS);
        c.register_merchant(Schedule { base_price: m.schedule.base_price, rules: vec![], cap_bps: 0, cohort: None }, m.category.clone(), None);
        at(OWNER, NOW_MS);
        c.approve_merchant(acc(&m.account));
    }
    at(OWNER, NOW_MS);
    c.open_round(ROUND.into(), "hoodie".into(), COMMIT_UNTIL, REVEAL_UNTIL);
    line(true, format!("round {ROUND} open: hoodie, {} merchant agents, commit for 60 s, reveal for 60 s", ms_list.len()));

    // Sealed bids: only a hash is on chain until the commit deadline.
    let salt = |a: &str| bookerbob_core::sha256(format!("swarm-try bid salt|{a}").as_bytes());
    for m in &ms_list {
        at(&m.account, NOW_MS);
        let h = bid_commitment(&m.account, &m.schedule, &salt(&m.account));
        let ok = call(|| c.commit_bid(ROUND.into(), h.clone())).is_ok();
        line(ok, format!("{:<4} commits a sealed bid  {}..", short(&m.account), &h[..16]));
    }
    // A reveal before the deadline is refused; after it, each schedule opens to its hash.
    let early = call(|| c.reveal_bid(ROUND.into(), ms_list[0].schedule.clone(), hex::encode(salt(&ms_list[0].account))));
    line(early.is_err(), format!("an early reveal is refused: {}", early.err().unwrap_or_default()));
    for m in &ms_list {
        at(&m.account, COMMIT_UNTIL);
        let ok = call(|| c.reveal_bid(ROUND.into(), m.schedule.clone(), hex::encode(salt(&m.account)))).is_ok();
        let rules: Vec<String> = m.schedule.rules.iter().map(|r| format!("{} -{}%", r.predicate, r.bps / 100)).collect();
        line(
            ok,
            format!(
                "{:<4} reveals: base {}, {}",
                short(&m.account),
                usd(m.schedule.base_price),
                if rules.is_empty() { "no discounts".into() } else { rules.join(", ") }
            ),
        );
    }

    // Six buyers: the fixture buyer and five peers, each one World-bound person.
    line(true, "6 buyer agents: buyer 1 reveals 3 proven bits, buyers 2 to 6 reveal only world_id_human, so the winner differs".into());
    let mut buyers = vec![verdict.clone()];
    buyers.extend(fixtures::cohort_verdicts());
    let mut paid: u128 = 0;
    for (i, (v, w)) in buyers.iter().zip(&worlds).enumerate() {
        let e = &v.envelope;
        if let Err(x) = enter(&mut c, v, w) {
            line(false, format!("buyer {}: verdict refused: {x}", i + 1));
            continue;
        }
        at(OWNER, REVEAL_UNTIL);
        let Some(win) = call(|| c.round_best_quote(ROUND.into(), e.nullifier.clone())).ok().flatten() else {
            line(false, format!("buyer {}: no quote", i + 1));
            continue;
        };
        let m = ms_list.iter().find(|m| m.account == win.merchant.as_str()).expect("a known merchant");
        let r = pay(&mut c, v, m, None);
        if r.is_ok() {
            paid += win.quote.price;
        }
        line(
            r.is_ok(),
            format!(
                "buyer {} reveals [{}]: verdict signature checked by the contract, winner {} at {} (list {}), referee receipt, settled{}",
                i + 1,
                e.predicates.join(", "),
                short(win.merchant.as_str()),
                usd(win.quote.price),
                usd(win.quote.base_price),
                r.err().map(|x| format!(": {x}")).unwrap_or_default()
            ),
        );
    }

    // Replay: the first buyer's account, signed again from another wallet.
    at(WALLET2, NOW_MS);
    let replay = call(|| c.submit_verdict(fixtures::sign_ed(fixtures::envelope(WALLET2))));
    let refused = replay.as_ref().err().is_some_and(|m| m.contains("nullifier spent"));
    line(
        refused,
        format!(
            "a replay of buyer 1's spent verdict from another wallet is refused: {}",
            if refused { "nullifier spent".to_string() } else { format!("{replay:?}") }
        ),
    );

    if fails == 0 {
        println!(
            "PASS  swarm-try: {} merchants bid sealed, {} buyers settled ({} test dUSDC), 1 replay refused, in {} ms",
            ms_list.len(),
            buyers.len(),
            usd(paid),
            t0.elapsed().as_millis()
        );
        ExitCode::SUCCESS
    } else {
        println!("FAIL  swarm-try: {fails} steps failed");
        ExitCode::FAILURE
    }
}
