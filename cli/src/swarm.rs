//! Swarm round, offline and deterministic, run through the `bazaar` contract
//! (MockedBlockchain).
//!
//! Merchants register a public list price only and are approved by the owner. The owner
//! opens one blind round per category. Round 1 (commit): every merchant calls `commit_bid`
//! with `sha256("bookerbob/bid/v0\0" || account || 0 || json(schedule) || salt)`; nobody
//! sees a discount schedule. Round 2 (reveal, after the commit deadline): `reveal_bid`
//! opens each schedule and the contract checks it against the commitment. After the reveal
//! deadline the contract quotes every merchant for the buyer's revealed predicates, and
//! `round_best_quote` must agree with the board's winner. The buyer column shows only the verdict commitment and the cohort size k.
//! Peer verdicts in `verdicts-cohort.json` (same context) drive the group unlock.
//! Prices come from code; no model output is read here.
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::process::ExitCode;

use bookerbob_bazaar::{Bazaar, RECORD_DEPOSIT};
use bookerbob_core::{Schedule, SignedVerdict, K_MIN};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId};
use serde::{Deserialize, Serialize};

use crate::fixtures::{NOW_MS, OWNER, USDC};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SwarmMerchant {
    pub account: String,
    pub category: String,
    pub persona: String,
    pub source: String,
    pub schedule: Schedule,
    /// Perks as text (JMPR elite perks); shown, never priced.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub perks: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BoardRow {
    pub rank: usize,
    pub merchant: String,
    pub persona: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub perks: Vec<String>,
    pub bid_commitment: String,
    pub base_price: String,
    pub lines: Vec<String>,
    pub discount_bps: u16,
    pub price: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CategoryBoard {
    pub category: String,
    pub rows: Vec<BoardRow>,
    pub winner: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Board {
    pub note: String,
    pub merchants: usize,
    pub buyer: BuyerColumn,
    pub categories: Vec<CategoryBoard>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disclosure: Option<Disclosure>,
    /// The same counter for every category (the purchase is `disclosure`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disclosures: Vec<Disclosure>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub receipts: Vec<ReceiptRow>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asks: Vec<AskRow>,
    /// The on-chain blind round per category.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rounds: Vec<RoundRow>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RoundRow {
    pub round: String,
    pub category: String,
    pub commit_until_ms: u64,
    pub reveal_until_ms: u64,
    pub commits: usize,
    pub reveals: usize,
    pub winner: String,
}

/// Round deadlines, relative to the fixture clock.
const COMMIT_UNTIL_MS: u64 = NOW_MS + 60_000;
const REVEAL_UNTIL_MS: u64 = NOW_MS + 120_000;

/// What revealing bits bought: the winner's base price against what the buyer pays.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Disclosure {
    pub category: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bits: Option<usize>,
    /// The bits the budget plan picks; must equal the verdict's revealed predicates.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plan: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub per_bit: Vec<bookerbob_core::disclosure::BitSaving>,
    pub revealed_bits: usize,
    pub base_price: String,
    pub price: String,
    pub saved: String,
}

/// Referee outcome for the winner's quote, for each claim set next to the verdict.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ReceiptRow {
    pub label: String,
    pub claims: Vec<bookerbob_core::Claim>,
    pub outcome: String,
    pub detail: String,
}

/// A merchant's ask and the buyer agent's rule-based answer.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AskRow {
    pub merchant: String,
    pub text: String,
    pub ask: bookerbob_core::disclosure::Ask,
    pub answer: bookerbob_core::disclosure::Answer,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AskIn {
    pub merchant: String,
    pub text: String,
    pub ask: bookerbob_core::disclosure::Ask,
}

/// Claim sets, proofs, policy and asks that sit next to the verdict, if present.
#[derive(Default)]
pub struct Extras {
    pub proofs: Option<bookerbob_core::ProofSet>,
    pub claim_sets: Vec<(String, Vec<bookerbob_core::Claim>)>,
    pub policy: Option<bookerbob_core::disclosure::Policy>,
    pub asks: Vec<AskIn>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BuyerColumn {
    pub verdict_commitment: String,
    pub revealed_bits: usize,
    pub cohort_k: u32,
    pub group_unlock: String,
}

pub fn bid_salt(account: &str) -> [u8; 32] {
    bookerbob_core::sha256(format!("bookerbob fixture bid salt v0|{account}").as_bytes())
}

pub use bookerbob_core::bid_commitment;

fn acc(s: &str) -> AccountId {
    s.parse().expect("account id")
}

fn as_caller(p: &str) {
    as_caller_at(p, NOW_MS);
}

fn as_caller_at(p: &str, ms: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(OWNER)).predecessor_account_id(acc(p)).block_timestamp(ms * 1_000_000);
    b.attached_deposit(RECORD_DEPOSIT);
    testing_env!(b.build());
}

fn usdc(v: u128) -> String {
    format!("{}.{:02}", v / 1_000_000, (v % 1_000_000) / 10_000)
}

pub fn build(
    merchants: &[SwarmMerchant],
    verdict: &SignedVerdict,
    peers: &[SignedVerdict],
    worlds: &[bookerbob_core::WorldAttestation],
    extras: &Extras,
) -> Result<Board, String> {
    let commits: Vec<String> = merchants.iter().map(|m| bid_commitment(&m.account, &m.schedule, &bid_salt(&m.account))).collect();
    as_caller(OWNER);
    let mut c = Bazaar::new(acc(OWNER), acc(USDC));
    c.register_issuer(verdict.key_id(), "fixture issuer".into());
    if let Some(w) = worlds.first() {
        c.register_world_verifier(w.verifier_key.clone(), w.body.action.clone(), "fixture world verifier".into());
    }
    for w in worlds {
        as_caller(&w.body.agent);
        catch_unwind(AssertUnwindSafe(|| c.attest_human(w.clone()))).map_err(|_| "world attestation rejected".to_string())?;
    }
    // Registration: a public list price only (no discounts), then owner approval.
    for m in merchants {
        as_caller(&m.account);
        let list = Schedule { base_price: m.schedule.base_price, rules: vec![], cap_bps: 0, cohort: None };
        catch_unwind(AssertUnwindSafe(|| c.register_merchant(list, m.category.clone(), None))).map_err(|_| format!("{} rejected by contract", m.account))?;
        as_caller(OWNER);
        c.approve_merchant(acc(&m.account));
    }
    // Round 1 (commit), on chain: one round per category, sealed discount schedules.
    let round_of = |cat: &str| format!("swarm-{cat}");
    let cats: std::collections::BTreeSet<String> = merchants.iter().map(|m| m.category.clone()).collect();
    for cat in &cats {
        as_caller(OWNER);
        c.open_round(round_of(cat), cat.clone(), COMMIT_UNTIL_MS, REVEAL_UNTIL_MS);
    }
    for (m, commit) in merchants.iter().zip(&commits) {
        as_caller(&m.account);
        catch_unwind(AssertUnwindSafe(|| c.commit_bid(round_of(&m.category), commit.clone()))).map_err(|_| format!("{} commit rejected", m.account))?;
    }
    // Round 2 (reveal), after the commit deadline: the contract checks every opening.
    for m in merchants {
        as_caller_at(&m.account, COMMIT_UNTIL_MS);
        catch_unwind(AssertUnwindSafe(|| c.reveal_bid(round_of(&m.category), m.schedule.clone(), hex::encode(bid_salt(&m.account)))))
            .map_err(|_| format!("{} revealed a schedule that does not open its commitment", m.account))?;
    }
    // After the reveal deadline: verdicts and quotes.
    as_caller_at(&verdict.envelope.cnf, REVEAL_UNTIL_MS);
    catch_unwind(AssertUnwindSafe(|| c.submit_verdict(verdict.clone()))).map_err(|_| "verdict rejected".to_string())?;
    for p in peers {
        as_caller_at(&p.envelope.cnf, REVEAL_UNTIL_MS);
        catch_unwind(AssertUnwindSafe(|| c.submit_verdict(p.clone()))).map_err(|_| "peer verdict rejected".to_string())?;
    }
    let n = verdict.envelope.nullifier.clone();
    let ctx = verdict.envelope.context.clone();
    let cohort_k = verdict.envelope.predicates.iter().map(|p| c.cohort_size(ctx.clone(), p.clone())).max().unwrap_or(0);

    let mut by_cat: BTreeMap<String, Vec<BoardRow>> = BTreeMap::new();
    for (m, commit) in merchants.iter().zip(&commits) {
        let q = c.quote(acc(&m.account), n.clone());
        by_cat.entry(m.category.clone()).or_default().push(BoardRow {
            rank: 0,
            merchant: m.account.clone(),
            persona: m.persona.clone(),
            source: m.source.clone(),
            perks: m.perks.clone(),
            bid_commitment: commit.clone(),
            base_price: q.base_price.to_string(),
            lines: q
                .lines
                .iter()
                .map(|l| format!("-{}bps {}", l.bps, l.predicate))
                .chain(q.cohort.iter().map(|co| format!("-{}bps group k={} {}", co.bps, co.k, co.predicate)))
                .collect(),
            discount_bps: q.discount_bps,
            price: q.price.to_string(),
        });
    }
    let mut categories = Vec::new();
    let mut rounds = Vec::new();
    for (cat, mut rows) in by_cat {
        // Lowest price first; ties keep config order (stable sort), same as the contract.
        rows.sort_by_key(|r| r.price.parse::<u128>().unwrap());
        for (i, r) in rows.iter_mut().enumerate() {
            r.rank = i + 1;
        }
        let onchain = c.best_quote(n.clone(), Some(cat.clone()), None, None, None).ok_or("no quote")?;
        if onchain.merchant.as_str() != rows[0].merchant {
            return Err(format!("contract best_quote {} differs from board winner {}", onchain.merchant, rows[0].merchant));
        }
        let round = c.round_best_quote(round_of(&cat), n.clone()).ok_or("no round winner")?;
        if round.merchant.as_str() != rows[0].merchant {
            return Err(format!("round_best_quote {} differs from board winner {}", round.merchant, rows[0].merchant));
        }
        let r = c.round(round_of(&cat)).expect("round exists");
        rounds.push(RoundRow {
            round: round_of(&cat),
            category: cat.clone(),
            commit_until_ms: r.commit_until_ms,
            reveal_until_ms: r.reveal_until_ms,
            commits: r.commits.len(),
            reveals: r.revealed.len(),
            winner: round.merchant.to_string(),
        });
        categories.push(CategoryBoard { category: cat, winner: rows[0].merchant.clone(), rows });
    }
    // The purchase is in the first category (the verdict's context names a hoodie).
    let buy = categories.iter().find(|c| c.category == "hoodie").or(categories.first());
    let derived: Vec<String> = extras.proofs.as_ref().map(|p| bookerbob_core::derive(p).predicates()).unwrap_or_default();
    let others = |p: &str| peers.iter().filter(|v| v.envelope.context == ctx && v.envelope.predicates.iter().any(|q| q == p)).count() as u32;
    let disclose = |cat: &CategoryBoard| {
        let w = &cat.rows[0];
        let (base, price): (u128, u128) = (w.base_price.parse().unwrap(), w.price.parse().unwrap());
        let in_cat: Vec<(String, Schedule)> =
            merchants.iter().filter(|m| m.category == cat.category).map(|m| (m.account.clone(), m.schedule.clone())).collect();
        let plan = extras.policy.as_ref().and_then(|pol| bookerbob_core::disclosure::plan(pol, &derived, &in_cat, &others));
        Disclosure {
            category: cat.category.clone(),
            max_bits: extras.policy.map(|p| p.max_bits),
            plan: plan.as_ref().map(|p| p.revealed.clone()).unwrap_or_default(),
            // What each actually revealed bit saved in this category.
            per_bit: {
                let rev = &verdict.envelope.predicates;
                let with = bookerbob_core::disclosure::best_price(&in_cat, rev, &others).map(|x| x.1).unwrap_or(0);
                rev.iter()
                    .map(|p| {
                        let without: Vec<String> = rev.iter().filter(|q| *q != p).cloned().collect();
                        let w = bookerbob_core::disclosure::best_price(&in_cat, &without, &others).map(|x| x.1).unwrap_or(0);
                        bookerbob_core::disclosure::BitSaving { predicate: p.clone(), saved: w.saturating_sub(with) }
                    })
                    .collect()
            },
            revealed_bits: verdict.envelope.predicates.len(),
            base_price: base.to_string(),
            price: price.to_string(),
            saved: (base - price).to_string(),
        }
    };
    let disclosure = buy.map(disclose);
    let disclosures: Vec<Disclosure> = categories.iter().map(disclose).collect();
    if let (Some(d), Some(_)) = (&disclosure, &extras.policy) {
        if d.plan != verdict.envelope.predicates {
            return Err(format!("budget plan {:?} differs from the verdict's revealed bits {:?}", d.plan, verdict.envelope.predicates));
        }
    }
    let asks: Vec<AskRow> = match &extras.policy {
        Some(pol) => extras
            .asks
            .iter()
            .map(|a| AskRow {
                merchant: a.merchant.clone(),
                text: a.text.clone(),
                ask: a.ask.clone(),
                answer: bookerbob_core::disclosure::answer(pol, &derived, &verdict.envelope.predicates, &a.ask),
            })
            .collect(),
        None => vec![],
    };
    let mut receipts = Vec::new();
    if let (Some(proofs), Some(cat)) = (&extras.proofs, buy) {
        let q = c.quote(acc(&cat.winner), n.clone());
        for (label, claims) in &extras.claim_sets {
            let (outcome, detail) = match bookerbob_core::referee(proofs, &verdict.envelope.predicates, &q, claims) {
                bookerbob_core::RefereeOutcome::Receipt { receipt_hash } => ("receipt".to_string(), receipt_hash),
                bookerbob_core::RefereeOutcome::Refused { reason } => ("refused".to_string(), reason),
            };
            receipts.push(ReceiptRow { label: label.clone(), claims: claims.clone(), outcome, detail });
        }
    }
    Ok(Board {
        note: "synthetic fixtures; prices computed by bookerbob-core inside the bazaar contract".into(),
        merchants: merchants.len(),
        buyer: BuyerColumn {
            verdict_commitment: verdict.envelope.commitment.clone(),
            revealed_bits: verdict.envelope.predicates.len(),
            cohort_k,
            group_unlock: if cohort_k >= K_MIN { format!("unlocked (k={cohort_k})") } else { format!("locked (k={cohort_k}, needs k>={K_MIN})") },
        },
        categories,
        disclosure,
        disclosures,
        receipts,
        asks,
        rounds,
    })
}

pub fn run(merchants_path: &Path, verdict_path: &Path, out: &Path, check: bool) -> ExitCode {
    std::panic::set_hook(Box::new(|_| {}));
    let merchants: Vec<SwarmMerchant> = serde_json::from_str(&std::fs::read_to_string(merchants_path).expect("read merchants")).expect("parse merchants");
    let verdict: SignedVerdict = serde_json::from_str(&std::fs::read_to_string(verdict_path).expect("read verdict")).expect("parse verdict");
    // Peer verdicts for the group unlock sit next to the buyer's verdict, if present.
    let peers_path = verdict_path.with_file_name("verdicts-cohort.json");
    let peers: Vec<SignedVerdict> = std::fs::read_to_string(&peers_path).ok().map(|s| serde_json::from_str(&s).expect("parse peers")).unwrap_or_default();
    let worlds_path = verdict_path.with_file_name("world-attestations.json");
    let worlds: Vec<bookerbob_core::WorldAttestation> =
        std::fs::read_to_string(&worlds_path).ok().map(|s| serde_json::from_str(&s).expect("parse world attestations")).unwrap_or_default();
    let near = |name: &str| std::fs::read_to_string(verdict_path.with_file_name(name)).ok();
    let mut extras = Extras { proofs: near("proofs.json").map(|s| serde_json::from_str(&s).expect("parse proofs")), claim_sets: vec![], ..Default::default() };
    for (label, file) in [("honest claims", "claims-honest.json"), ("claims after a prompt injection", "claims-cheat.json")] {
        if let Some(s) = near(file) {
            extras.claim_sets.push((label.into(), serde_json::from_str(&s).expect("parse claims")));
        }
    }
    extras.policy = near("disclosure-policy.json").map(|s| serde_json::from_str(&s).expect("parse policy"));
    extras.asks = near("merchant-asks.json").map(|s| serde_json::from_str(&s).expect("parse asks")).unwrap_or_default();
    let board = match build(&merchants, &verdict, &peers, &worlds, &extras) {
        Ok(b) => b,
        Err(e) => {
            println!("FAIL  swarm  ({e})");
            return ExitCode::FAILURE;
        }
    };
    println!("board: {} merchant agents, blind commit then reveal", board.merchants);
    println!("buyer: commitment {}..  revealed {} bits  {}", &board.buyer.verdict_commitment[..12], board.buyer.revealed_bits, board.buyer.group_unlock);
    for d in &board.disclosures {
        println!(
            "disclosure: revealed {} bits, saved {} USDC on {} ({} to {})",
            d.revealed_bits,
            usdc(d.saved.parse().unwrap()),
            d.category,
            usdc(d.base_price.parse().unwrap()),
            usdc(d.price.parse().unwrap())
        );
    }
    for d in &board.disclosures {
        for b in &d.per_bit {
            println!("  {} bit {}: saved {} USDC", d.category, b.predicate, usdc(b.saved));
        }
    }
    for a in &board.asks {
        let ans = match &a.answer {
            bookerbob_core::disclosure::Answer::Declined { reason } => format!("declined: {reason}"),
            bookerbob_core::disclosure::Answer::Revealed { predicate } => format!("revealed {predicate}"),
            bookerbob_core::disclosure::Answer::AlreadyRevealed { predicate } => format!("already revealed {predicate}"),
        };
        println!("ask: {} \"{}\": {ans}", a.merchant.split('.').next().unwrap_or(""), a.text);
    }
    for r in &board.receipts {
        println!("receipt: {}: {} ({})", r.label, r.outcome, if r.outcome == "receipt" { &r.detail[..12] } else { &r.detail });
    }
    for cat in &board.categories {
        println!("\n[{}]", cat.category);
        println!("{:>3}  {:<26} {:>9} {:>6} {:>9}  lines", "#", "merchant", "base", "disc", "price");
        for r in cat.rows.iter().take(8) {
            println!(
                "{:>3}  {:<26} {:>9} {:>5}% {:>9}  {}",
                r.rank,
                r.merchant,
                usdc(r.base_price.parse().unwrap()),
                r.discount_bps as f64 / 100.0,
                usdc(r.price.parse().unwrap()),
                r.lines.join(", ")
            );
        }
        if cat.rows.len() > 8 {
            println!("     ... {} more", cat.rows.len() - 8);
        }
    }
    let mut body = serde_json::to_string_pretty(&board).unwrap();
    body.push('\n');
    if check {
        let same = std::fs::read_to_string(out).ok().as_deref() == Some(body.as_str());
        for r in &board.rounds {
            println!(
                "PASS  blind round {} on chain: {} commit_bid, {} reveal_bid opened their commitments, round_best_quote {}",
                r.round, r.commits, r.reveals, r.winner
            );
        }
        println!("\n{}  swarm board matches {} and contract best_quote per category", if same { "PASS" } else { "FAIL" }, out.display());
        return if same { ExitCode::SUCCESS } else { ExitCode::FAILURE };
    }
    std::fs::write(out, body).expect("write board");
    println!("\nwrote {}", out.display());
    ExitCode::SUCCESS
}
