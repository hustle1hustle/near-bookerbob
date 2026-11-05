//! Offline end-to-end: fixtures -> tier -> envelope -> signatures -> contract -> quotes ->
//! referee -> settle -> replay. One PASS/FAIL line per link.
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::process::ExitCode;

use bookerbob_bazaar::{Bazaar, NullifierStatus, ESCROW_STORAGE_DEPOSIT, RECORD_DEPOSIT};
use bookerbob_core::envelope::commitment;
use bookerbob_core::{derive, quote, referee, sha256_hex, Claim, ProofSet, RefereeOutcome, SigAlg, SignedVerdict};
use near_sdk::json_types::U128;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId};
use serde::de::DeserializeOwned;

use bookerbob_referee_worker::{key_from_seed_hex, run as run_worker, WorkerInput};

use crate::fixtures::{arbiter_seed_hex, referee_seed_hex, Expected, MerchantFixture, Opening, ESCROW_USDC, NOW_MS, OWNER, USDC};

struct Report {
    n: usize,
    failed: usize,
}

impl Report {
    fn check(&mut self, ok: bool, what: &str, detail: impl AsRef<str>) -> bool {
        self.n += 1;
        let tag = if ok { "PASS" } else { "FAIL" };
        let d = detail.as_ref();
        if d.is_empty() {
            println!("{tag}  {:02}  {what}", self.n);
        } else {
            println!("{tag}  {:02}  {what}  ({d})", self.n);
        }
        if !ok {
            self.failed += 1;
        }
        ok
    }
}

fn load<T: DeserializeOwned>(dir: &Path, name: &str) -> T {
    let path = dir.join(name);
    let s = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&s).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

fn acc(s: &str) -> AccountId {
    s.parse().expect("account id")
}

thread_local! {
    /// Every NEP-297 event the contract logged during the run, in order.
    static EVENTS: std::cell::RefCell<Vec<serde_json::Value>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Move the current call's contract logs into EVENTS (the next testing_env resets them).
fn harvest() {
    for l in get_logs() {
        if let Some(j) = l.strip_prefix("EVENT_JSON:").and_then(|j| serde_json::from_str(j).ok()) {
            EVENTS.with(|e| e.borrow_mut().push(j));
        }
    }
}

fn as_caller(predecessor: &str, deposit: Option<near_sdk::NearToken>) {
    harvest();
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(OWNER)).predecessor_account_id(acc(predecessor)).block_timestamp(NOW_MS * 1_000_000);
    if let Some(d) = deposit {
        b.attached_deposit(d);
    }
    testing_env!(b.build());
}

/// Run a contract call, turning a contract panic into Err(message).
fn call<R>(f: impl FnOnce() -> R) -> Result<R, String> {
    catch_unwind(AssertUnwindSafe(f))
        .map_err(|e| e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "panic".into()))
}

fn verify_offchain(v: &SignedVerdict) -> bool {
    let digest = v.envelope.digest();
    let (Ok(sig), Ok(key)) = (hex::decode(&v.signature), hex::decode(&v.issuer_key)) else { return false };
    match v.alg {
        SigAlg::Ed25519 => {
            use ed25519_dalek::{Signature, Verifier, VerifyingKey};
            let (Ok(sig), Ok(key)) = (<[u8; 64]>::try_from(sig.as_slice()), <[u8; 32]>::try_from(key.as_slice())) else { return false };
            VerifyingKey::from_bytes(&key).is_ok_and(|k| k.verify(&digest, &Signature::from_bytes(&sig)).is_ok())
        }
        SigAlg::P256 => {
            use p256::ecdsa::signature::hazmat::PrehashVerifier;
            use p256::ecdsa::{Signature, VerifyingKey};
            let (Ok(k), Ok(s)) = (VerifyingKey::from_sec1_bytes(&key), Signature::from_slice(&sig)) else { return false };
            k.verify_prehash(&digest, &s).is_ok()
        }
    }
}

/// Public receipts: per nullifier, hashes and the settled payment, nothing about the buyer.
fn receipts_from(events: &[serde_json::Value]) -> serde_json::Value {
    use serde_json::{json, Value};
    let mut rows: Vec<(String, serde_json::Map<String, Value>)> = Vec::new();
    for ev in events {
        let name = ev["event"].as_str().unwrap_or("");
        let d = &ev["data"][0];
        let Some(n) = d["nullifier"].as_str() else { continue };
        let idx = match rows.iter().position(|(k, _)| k == n) {
            Some(i) => i,
            None => {
                rows.push((n.to_string(), serde_json::Map::new()));
                rows.len() - 1
            }
        };
        let row = &mut rows[idx].1;
        let mut push = |field: &str, v: Value| row.entry(field.to_string()).or_insert_with(|| json!([])).as_array_mut().unwrap().push(v);
        match name {
            "verdict_submitted" => push("timeline", json!({ "event": name, "commitment": d["commitment"] })),
            "referee_receipt" => push("timeline", json!({ "event": name, "receipt_hash": d["receipt_hash"] })),
            "receipt_refused" | "dispute_overturned" => push("timeline", json!({ "event": name })),
            "settled" => push("timeline", json!({ "event": name, "merchant": d["merchant"], "amount": d["amount"], "checkout_ref": d["checkout_ref"] })),
            _ => {}
        }
    }
    let list: Vec<Value> = rows
        .into_iter()
        .filter_map(|(n, row)| {
            let tl = row.get("timeline")?.as_array()?.clone();
            let settled = tl.iter().find(|x| x["event"] == "settled").cloned();
            let receipt = tl.iter().rev().find(|x| x["event"] == "referee_receipt").map(|x| x["receipt_hash"].clone());
            let commitment = tl.iter().find(|x| x["event"] == "verdict_submitted").map(|x| x["commitment"].clone());
            Some(json!({
                "nullifier": n,
                "commitment": commitment,
                "status": if settled.is_some() { "settled" } else if receipt.is_some() { "receipt" } else { "pending" },
                "receipt_hash": receipt,
                "merchant": settled.as_ref().map(|x| x["merchant"].clone()),
                "amount": settled.as_ref().map(|x| x["amount"].clone()),
                "checkout_ref": settled.as_ref().map(|x| x["checkout_ref"].clone()),
                "near_tx": null,
                "timeline": tl.iter().map(|x| x["event"].clone()).collect::<Vec<_>>(),
            }))
        })
        .collect();
    json!({
        "note": "built from the bazaar contract's NEP-297 events in the offline make verify run (synthetic fixtures); near_tx is filled once purchases run on testnet",
        "receipts": list,
    })
}

pub fn run_with_receipts(dir: &Path, receipts: Option<(&Path, bool)>) -> ExitCode {
    let code = run(dir);
    harvest();
    let Some((path, check)) = receipts else { return code };
    let mut body = serde_json::to_string_pretty(&EVENTS.with(|e| receipts_from(&e.borrow()))).unwrap();
    body.push('\n');
    if check {
        let same = std::fs::read_to_string(path).ok().as_deref() == Some(body.as_str());
        println!("{}  public receipts page data matches {}", if same { "PASS" } else { "FAIL" }, path.display());
        if !same {
            return ExitCode::FAILURE;
        }
    } else {
        std::fs::write(path, body).expect("write receipts");
        println!("wrote {}", path.display());
    }
    code
}

pub fn run(dir: &Path) -> ExitCode {
    // Contract panics are expected in some links; keep their default stderr noise out.
    std::panic::set_hook(Box::new(|_| {}));
    let mut r = Report { n: 0, failed: 0 };

    let proofs: ProofSet = load(dir, "proofs.json");
    let opening: Opening = load(dir, "opening.json");
    let merchants: Vec<MerchantFixture> = load(dir, "merchants.json");
    let honest: Vec<Claim> = load(dir, "claims-honest.json");
    let cheat: Vec<Claim> = load(dir, "claims-cheat.json");
    let v_ed: SignedVerdict = load(dir, "verdict-ed25519.json");
    let v_p256: SignedVerdict = load(dir, "verdict-p256.json");
    let v_replay: SignedVerdict = load(dir, "verdict-replay.json");
    let peers: Vec<SignedVerdict> = load(dir, "verdicts-cohort.json");
    let worlds: Vec<bookerbob_core::WorldAttestation> = load(dir, "world-attestations.json");
    let policy: bookerbob_core::disclosure::Policy = load(dir, "disclosure-policy.json");
    let asks: Vec<crate::swarm::AskIn> = load(dir, "merchant-asks.json");
    let second_agent: bookerbob_core::WorldAttestation = load(dir, "world-attestation-second-agent.json");
    let exp: Expected = load(dir, "expected.json");
    let e = &v_ed.envelope;
    println!("bookerbob verify: {} (synthetic fixtures, offline)", dir.display());

    // --- proof set and tier (code, not model) ---
    let ph = sha256_hex(&serde_json::to_vec(&proofs).unwrap());
    r.check(ph == e.proof_hash, "proof set hash matches envelope.proof_hash", &ph[..16]);
    let t = derive(&proofs);
    r.check(
        t.predicates() == exp.derived_predicates && t.tier.as_str() == exp.tier && e.tier == exp.tier,
        "tier derived by code from proven fields",
        format!("{} -> {}", t.predicates().join(","), t.tier.as_str()),
    );
    r.check(
        e.predicates.iter().all(|p| t.predicates().contains(p)) && e.predicates == exp.revealed,
        "revealed predicates are a subset of derived",
        format!("revealed {} of {}", e.predicates.len(), t.derived.len()),
    );
    // --- disclosure: budget plan and merchant asks (buyer agent, by rule) ---
    {
        use bookerbob_core::disclosure::{answer, plan, Answer, Ask};
        let others = |p: &str| peers.iter().filter(|v| v.envelope.context == e.context && v.envelope.predicates.iter().any(|q| q == p)).count() as u32;
        let ms: Vec<(String, bookerbob_core::Schedule)> = merchants.iter().map(|m| (m.account.clone(), m.schedule.clone())).collect();
        let pl = plan(&policy, &t.predicates(), &ms, &others);
        r.check(
            pl.as_ref().is_some_and(|p| p.revealed == e.predicates && p.revealed.len() <= policy.max_bits && p.winner == exp.winner),
            "disclosure budget: the plan under the cap picks exactly the revealed bits",
            pl.as_ref()
                .map(|p| {
                    format!(
                        "max {} bits, {}",
                        policy.max_bits,
                        p.per_bit.iter().map(|b| format!("{} saves {}", b.predicate, b.saved)).collect::<Vec<_>>().join(", ")
                    )
                })
                .unwrap_or_default(),
        );
        let raw = asks.iter().find(|a| matches!(a.ask, Ask::RawHistory { .. })).expect("a raw history ask in fixtures");
        let raw_ans = answer(&policy, &t.predicates(), &e.predicates, &raw.ask);
        let all_declined = asks.iter().all(|a| matches!(answer(&policy, &t.predicates(), &e.predicates, &a.ask), Answer::Declined { .. }));
        r.check(
            raw_ans == Answer::Declined { reason: "raw history never leaves the enclave".into() } && all_declined,
            "merchant asks for raw history: declined; identity, unproven and over-budget asks too",
            format!("{} asks declined", asks.len()),
        );
    }
    let salt: [u8; 32] = hex::decode(&opening.salt).unwrap().try_into().unwrap();
    r.check(commitment(&salt, &t.predicates()) == e.commitment, "commitment opens to the derived set", "");

    // --- envelope and signatures ---
    r.check(e.validate().is_ok() && v_p256.envelope.validate().is_ok(), "envelope v0 well formed", "");
    r.check(verify_offchain(&v_ed), "ed25519 signature verifies off-chain (ed25519-dalek)", "");
    r.check(verify_offchain(&v_p256), "p256 signature verifies off-chain (RustCrypto p256)", "");

    // --- contract, MockedBlockchain ---
    as_caller(OWNER, None);
    let mut c = Bazaar::new(acc(OWNER), acc(USDC));
    c.register_issuer(v_ed.key_id(), "fixture ed25519 issuer".into());
    c.register_issuer(v_p256.key_id(), "fixture p256 issuer".into());
    let worker_key = key_from_seed_hex(&referee_seed_hex()).expect("seed");
    c.register_referee(hex::encode(worker_key.verifying_key().to_bytes()), "fixture referee worker".into());
    let arbiter_key = key_from_seed_hex(&arbiter_seed_hex()).expect("seed");
    c.register_arbiter(hex::encode(arbiter_key.verifying_key().to_bytes()), "fixture dispute arbiter".into());
    c.register_world_verifier(worlds[0].verifier_key.clone(), worlds[0].body.action.clone(), "fixture world verifier".into());
    for m in &merchants {
        as_caller(&m.account, Some(RECORD_DEPOSIT));
        c.register_merchant(m.schedule.clone(), m.category.clone(), None);
        as_caller(OWNER, None);
        c.approve_merchant(acc(&m.account));
    }
    as_caller(&e.cnf, Some(ESCROW_STORAGE_DEPOSIT));
    c.storage_deposit(None);
    as_caller(USDC, None);
    let _ = c.ft_on_transfer(acc(&e.cnf), U128(ESCROW_USDC), String::new());
    r.check(
        c.escrow_of(acc(&e.cnf)) == Some(U128(ESCROW_USDC)) && c.merchants(None, None).len() == merchants.len(),
        "contract set up: 2 enclave keys, 1 referee key, merchants, escrow",
        format!("{} merchants, escrow {} USDC base units", merchants.len(), ESCROW_USDC),
    );

    // --- World ID: one person, one agent ---
    let mut attested = 0;
    for w in &worlds {
        as_caller(&w.body.agent, Some(RECORD_DEPOSIT));
        attested += call(|| c.attest_human(w.clone())).is_ok() as usize;
    }
    r.check(
        attested == worlds.len() && c.is_human(acc(&e.cnf)),
        "world id attestations accepted (verifier ed25519 signature), buyer agent bound",
        format!("{attested} agents, action {}", worlds[0].body.action),
    );
    as_caller(&second_agent.body.agent, Some(RECORD_DEPOSIT));
    let second = call(|| c.attest_human(second_agent.clone()));
    r.check(
        second.as_ref().err().is_some_and(|m| m.contains(&exp.second_agent_error)) && second_agent.body.world_nullifier == worlds[0].body.world_nullifier,
        "second agent of the same person is blocked",
        exp.second_agent_error.clone(),
    );

    as_caller(&e.cnf, Some(RECORD_DEPOSIT));
    let sub = call(|| c.submit_verdict(v_ed.clone()));
    r.check(
        sub.is_ok() && c.nullifier_status(e.nullifier.clone()) == NullifierStatus::Pending,
        "contract accepts ed25519 verdict (env::ed25519_verify), nullifier pending",
        sub.err().unwrap_or_default(),
    );
    as_caller(&v_p256.envelope.cnf, Some(RECORD_DEPOSIT));
    let sub = call(|| c.submit_verdict(v_p256.clone()));
    r.check(sub.is_ok(), "contract accepts p256 verdict (env::p256_verify, low-S)", sub.err().unwrap_or_default());

    // --- quotes ---
    let best = c.best_quote(e.nullifier.clone(), Some("hoodie".into()), None, None, None).expect("a quote");
    let offchain_ok = merchants.iter().all(|m| quote(&m.schedule, &e.predicates) == c.quote(acc(&m.account), e.nullifier.clone()));
    r.check(offchain_ok, "on-chain quotes equal the core library, every merchant", "");
    r.check(
        best.merchant.as_str() == exp.winner && best.quote.price.to_string() == exp.price_locked && best.quote.cohort.is_none(),
        "winner and price are code-computed, group price locked at k=1",
        format!("{} at {} after {} bps", best.merchant, best.quote.price, best.quote.discount_bps),
    );

    // --- group unlock ---
    for p in &peers {
        as_caller(&p.envelope.cnf, Some(RECORD_DEPOSIT));
        let _ = call(|| c.submit_verdict(p.clone()));
    }
    let k = c.cohort_size(e.context.clone(), "world_id_human".into());
    let best = c.best_quote(e.nullifier.clone(), Some("hoodie".into()), None, None, None).expect("a quote");
    r.check(
        k == exp.cohort_k
            && best.merchant.as_str() == exp.winner
            && best.quote.cohort.as_ref().is_some_and(|x| x.k == exp.cohort_k)
            && best.quote.price.to_string() == exp.price
            && best.quote.discount_bps == exp.discount_bps,
        "group unlock: 5 more verdicts reveal world_id_human, cohort price opens",
        format!("k={k}, {} at {} after {} bps", best.merchant, best.quote.price, best.quote.discount_bps),
    );

    // --- referee, as the OutLayer worker would run it ---
    let winner = merchants.iter().find(|m| m.account == best.merchant.as_str()).expect("winner in fixtures");
    let cohort_k = winner.schedule.cohort.as_ref().map_or(0, |co| c.cohort_size(e.context.clone(), co.predicate.clone()));
    let worker = |claims: &[Claim]| -> Result<bookerbob_core::WorkerResult, String> {
        let input = WorkerInput {
            salt: None,
            v: 0,
            verdict_digest: hex::encode(e.digest()),
            nullifier: e.nullifier.clone(),
            merchant: winner.account.clone(),
            schedule: winner.schedule.clone(),
            revealed: e.predicates.clone(),
            claims: claims.to_vec(),
            proofs: proofs.clone(),
            cohort_k,
            sealed_verdict: None,
        };
        let stdout = run_worker(&input, &worker_key)?;
        serde_json::from_str(&stdout).map_err(|x| x.to_string())
    };
    let honest_out = referee(&proofs, &e.predicates, &best.quote, &honest);
    r.check(honest_out.is_receipt(), "referee (core): honest cited claims get a receipt", "");
    let cheat_out = referee(&proofs, &e.predicates, &best.quote, &cheat);
    r.check(
        cheat_out == RefereeOutcome::Refused { reason: exp.cheat_refusal.clone() },
        "referee (core): injected claim refuses the receipt",
        match &cheat_out {
            RefereeOutcome::Refused { reason } => reason.clone(),
            RefereeOutcome::Receipt { .. } => "receipt issued".into(),
        },
    );
    let cheat_res = worker(&cheat).expect("worker runs");
    let cheat_len = serde_json::to_string(&cheat_res).unwrap().len();
    as_caller(&e.cnf, None);
    let stored = call(|| c.submit_referee_result(cheat_res.clone()));
    r.check(
        stored == Ok(false) && c.verdict(e.nullifier.clone()).is_some_and(|v| v.receipt.is_none()) && cheat_len <= 900,
        "worker result for the cheat: signed refusal, contract stores no receipt",
        format!("{}, {cheat_len} bytes", cheat_res.body.detail),
    );
    let blocked = call(|| drop(c.settle(e.nullifier.clone(), best.merchant.clone(), "fixture-order-1".into(), U128(best.quote.price))));
    r.check(
        blocked.as_ref().err().is_some_and(|m| m.contains("no referee receipt")),
        "settle without a referee receipt is rejected",
        "no proof, no receipt, no payment",
    );
    // --- dispute: a compromised referee key signs a receipt for the cheat ---
    {
        use ed25519_dalek::Signer;
        let mut forged = cheat_res.clone();
        forged.body.outcome = "receipt".into();
        forged.body.detail = "forged".into();
        forged.signature = hex::encode(worker_key.sign(&forged.body.signing_message()).to_bytes());
        as_caller(&e.cnf, None);
        let accepted = call(|| c.submit_referee_result(forged.clone())) == Ok(true);
        let t0 = std::time::Instant::now();
        let input = bookerbob_referee_worker::DisputeInput {
            salt: None,
            v: 0,
            verdict: v_ed.clone(),
            result: forged.clone(),
            schedule: winner.schedule.clone(),
            claims: cheat.clone(),
            proofs: proofs.clone(),
            cohort_k,
            issuer_keys: vec![v_ed.key_id()],
            referee_keys: vec![forged.worker_key.clone()],
        };
        let decision: bookerbob_core::DisputeDecision =
            serde_json::from_str(&bookerbob_referee_worker::arbitrate(&input, &arbiter_key).expect("arbiter runs")).expect("decision");
        let took = t0.elapsed();
        let overturned = call(|| c.submit_dispute_decision(decision.clone())) == Ok(true);
        let blocked = call(|| drop(c.settle(e.nullifier.clone(), best.merchant.clone(), "fixture-order-1".into(), U128(best.quote.price))));
        r.check(
            accepted
                && decision.body.decision == "overturned"
                && decision.body.reasons.iter().any(|x| x.contains(&exp.cheat_refusal))
                && overturned
                && c.verdict(e.nullifier.clone()).is_some_and(|v| v.receipt.is_none())
                && blocked.as_ref().err().is_some_and(|m| m.contains("no referee receipt")),
            "dispute: arbiter re-checks a forged receipt, signs overturned, contract clears it, settle blocked",
            format!("{}, {} us", decision.body.reasons.first().cloned().unwrap_or_default(), took.as_micros()),
        );
    }
    let honest_res = worker(&honest).expect("worker runs");
    let stored = call(|| c.submit_referee_result(honest_res.clone()));
    r.check(
        stored == Ok(true) && c.verdict(e.nullifier.clone()).and_then(|v| v.receipt).is_some(),
        "worker result for honest claims: contract checks its ed25519 signature and stores the receipt",
        &honest_res.body.detail[..16],
    );

    // --- settle ---
    as_caller(&e.cnf, None);
    // A near-sdk Promise is scheduled when dropped, as at the end of a real call.
    let settled = call(|| drop(c.settle(e.nullifier.clone(), best.merchant.clone(), "fixture-order-1".into(), U128(best.quote.price))));
    let logs = get_logs();
    let ft_receipt = near_sdk::test_utils::get_created_receipts().iter().any(|rc| {
        rc.receiver_id.as_str() == USDC
            && rc.actions.iter().any(|a| matches!(a, near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. } if method_name == b"ft_transfer"))
    });
    r.check(
        settled.is_ok()
            && c.nullifier_status(e.nullifier.clone()) == NullifierStatus::Spent
            && c.escrow_of(acc(&e.cnf)).map(|b| b.0.to_string()) == Some(exp.escrow_after.clone())
            && logs.iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"event\":\"settled\""))
            && ft_receipt,
        "settle: escrow debited, nullifier burned, NEP-297 settled event, ft_transfer scheduled",
        settled.err().unwrap_or_else(|| format!("escrow left {}", exp.escrow_after)),
    );

    // --- replay ---
    as_caller(&v_replay.envelope.cnf, Some(RECORD_DEPOSIT));
    let replay = call(|| c.submit_verdict(v_replay.clone()));
    let msg = replay.err().unwrap_or_else(|| "accepted".into());
    r.check(
        msg.contains(&exp.replay_error) && v_replay.envelope.nullifier == e.nullifier && v_replay.envelope.cnf != e.cnf,
        "same account (same nullifier) from another wallet is rejected",
        exp.replay_error.clone(),
    );
    as_caller(&e.cnf, None);
    let again = call(|| drop(c.settle(e.nullifier.clone(), best.merchant.clone(), "fixture-order-2".into(), U128(best.quote.price))));
    r.check(again.as_ref().err().is_some_and(|m| m.contains("nullifier spent")) && c.spent_count() == 1, "second settle on the same nullifier is rejected", "");

    println!();
    if r.failed == 0 {
        println!("ALL PASS ({} checks)", r.n);
        ExitCode::SUCCESS
    } else {
        println!("FAILED {} of {} checks", r.failed, r.n);
        ExitCode::FAILURE
    }
}
