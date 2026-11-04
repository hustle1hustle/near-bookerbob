//! Swarm round, offline and deterministic.
//!
//! Round 1 (blind): every merchant posts `sha256("bookerbob/bid/v0\0" || account || 0 ||
//! json(schedule) || salt)`. Nobody sees a schedule. Round 2 (reveal): schedules are
//! opened and checked against the commitments, registered in the `bazaar` contract
//! (MockedBlockchain), and the contract quotes every merchant for the buyer's revealed
//! predicates. The buyer column shows only the verdict commitment and the cohort size k.
//! Peer verdicts in `verdicts-cohort.json` (same context) drive the group unlock.
//! Prices come from code; no model output is read here.
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::process::ExitCode;

use bookerbob_bazaar::{Bazaar, RECORD_DEPOSIT};
use bookerbob_core::{sha256_hex, Schedule, SignedVerdict, K_MIN};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId};
use serde::{Deserialize, Serialize};

use crate::fixtures::{NOW_MS, OWNER, USDC};

pub const BID_TAG: &[u8] = b"bookerbob/bid/v0\x00";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SwarmMerchant {
    pub account: String,
    pub category: String,
    pub persona: String,
    pub source: String,
    pub schedule: Schedule,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BoardRow {
    pub rank: usize,
    pub merchant: String,
    pub persona: String,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub receipts: Vec<ReceiptRow>,
}

/// What revealing bits bought: the winner's base price against what the buyer pays.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Disclosure {
    pub category: String,
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

/// Claim sets and proofs that sit next to the verdict, if present.
#[derive(Default)]
pub struct Extras {
    pub proofs: Option<bookerbob_core::ProofSet>,
    pub claim_sets: Vec<(String, Vec<bookerbob_core::Claim>)>,
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

pub fn bid_commitment(account: &str, schedule: &Schedule, salt: &[u8; 32]) -> String {
    let mut b = BID_TAG.to_vec();
    b.extend_from_slice(account.as_bytes());
    b.push(0);
    b.extend(serde_json::to_vec(schedule).expect("serializes"));
    b.extend_from_slice(salt);
    sha256_hex(&b)
}

fn acc(s: &str) -> AccountId {
    s.parse().expect("account id")
}

fn as_caller(p: &str) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(OWNER)).predecessor_account_id(acc(p)).block_timestamp(NOW_MS * 1_000_000);
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
    // Round 1: blind commitments.
    let commits: Vec<String> = merchants.iter().map(|m| bid_commitment(&m.account, &m.schedule, &bid_salt(&m.account))).collect();
    // Round 2: reveal, check, register, quote on the contract.
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
    as_caller(OWNER);
    for (m, commit) in merchants.iter().zip(&commits) {
        if bid_commitment(&m.account, &m.schedule, &bid_salt(&m.account)) != *commit {
            return Err(format!("{} revealed a schedule that does not open its commitment", m.account));
        }
        as_caller(&m.account);
        catch_unwind(AssertUnwindSafe(|| c.register_merchant(m.schedule.clone(), m.category.clone(), None)))
            .map_err(|_| format!("{} schedule rejected by contract", m.account))?;
    }
    as_caller(&verdict.envelope.cnf);
    catch_unwind(AssertUnwindSafe(|| c.submit_verdict(verdict.clone()))).map_err(|_| "verdict rejected".to_string())?;
    for p in peers {
        as_caller(&p.envelope.cnf);
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
    for (cat, mut rows) in by_cat {
        // Lowest price first; ties keep config order (stable sort), same as the contract.
        rows.sort_by_key(|r| r.price.parse::<u128>().unwrap());
        for (i, r) in rows.iter_mut().enumerate() {
            r.rank = i + 1;
        }
        let onchain = c.best_quote(n.clone(), Some(cat.clone())).ok_or("no quote")?;
        if onchain.merchant.as_str() != rows[0].merchant {
            return Err(format!("contract best_quote {} differs from board winner {}", onchain.merchant, rows[0].merchant));
        }
        categories.push(CategoryBoard { category: cat, winner: rows[0].merchant.clone(), rows });
    }
    // The purchase is in the first category (the verdict's context names a hoodie).
    let buy = categories.iter().find(|c| c.category == "hoodie").or(categories.first());
    let disclosure = buy.map(|cat| {
        let w = &cat.rows[0];
        let (base, price): (u128, u128) = (w.base_price.parse().unwrap(), w.price.parse().unwrap());
        Disclosure { category: cat.category.clone(), revealed_bits: verdict.envelope.predicates.len(), base_price: base.to_string(), price: price.to_string(), saved: (base - price).to_string() }
    });
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
        receipts,
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
    let worlds: Vec<bookerbob_core::WorldAttestation> = std::fs::read_to_string(&worlds_path).ok().map(|s| serde_json::from_str(&s).expect("parse world attestations")).unwrap_or_default();
    let near = |name: &str| std::fs::read_to_string(verdict_path.with_file_name(name)).ok();
    let mut extras = Extras { proofs: near("proofs.json").map(|s| serde_json::from_str(&s).expect("parse proofs")), claim_sets: vec![] };
    for (label, file) in [("honest claims", "claims-honest.json"), ("claims after a prompt injection", "claims-cheat.json")] {
        if let Some(s) = near(file) {
            extras.claim_sets.push((label.into(), serde_json::from_str(&s).expect("parse claims")));
        }
    }
    let board = match build(&merchants, &verdict, &peers, &worlds, &extras) {
        Ok(b) => b,
        Err(e) => {
            println!("FAIL  swarm  ({e})");
            return ExitCode::FAILURE;
        }
    };
    println!("board: {} merchant agents, blind commit then reveal", board.merchants);
    println!("buyer: commitment {}..  revealed {} bits  {}", &board.buyer.verdict_commitment[..12], board.buyer.revealed_bits, board.buyer.group_unlock);
    if let Some(d) = &board.disclosure {
        println!("disclosure: revealed {} bits, saved {} USDC on {}", d.revealed_bits, usdc(d.saved.parse().unwrap()), d.category);
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
        println!("\n{}  swarm board matches {} and contract best_quote per category", if same { "PASS" } else { "FAIL" }, out.display());
        return if same { ExitCode::SUCCESS } else { ExitCode::FAILURE };
    }
    std::fs::write(out, body).expect("write board");
    println!("\nwrote {}", out.display());
    ExitCode::SUCCESS
}
