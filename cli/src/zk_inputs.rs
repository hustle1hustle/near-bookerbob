//! `bookerbob zk-inputs <fixtures-dir> [--check]`: the Jolt guests' inputs, from the
//! contract's own data, written to (or checked against) `fixtures/zk/`. Each file also
//! carries `expected`, the native output of the same shared code, for reading.
use std::path::Path;
use std::process::ExitCode;

use bookerbob_bazaar::Bazaar;
use near_sdk::AccountId;
use serde_json::{json, Value};

use crate::fixtures::{self, AGENT, CONTEXT, NOW_MS, OWNER, USDC};
use crate::reviews::{at, call};

fn acc(s: &str) -> AccountId {
    s.parse().expect("account id")
}

fn hx(b: [u8; 32]) -> String {
    hex::encode(b)
}

pub fn build(dir: &Path) -> Result<Vec<(&'static str, Value)>, String> {
    std::panic::set_hook(Box::new(|_| {}));
    let mut out = Vec::new();

    // standing: the graph events the contract logged (fixtures/graph, checked by `reviews`).
    let events: Vec<String> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("graph/standing-events.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let bytes: Vec<Vec<u8>> = events.iter().map(|h| hex::decode(h).expect("hex")).collect();
    let ev: Vec<bookerbob_graph::Event> = bytes.iter().map(|b| bookerbob_graph::Event::from_bytes(b).expect("event")).collect();
    let s = bookerbob_graph::compute(&ev);
    out.push(("standing-input.json", json!({ "events": bytes, "expected": { "root": hx(s.root), "scores_hash": hx(s.hash()) } })));

    // A fresh chain with the buyer and the five cohort peers, as `make verify` has them.
    at(OWNER, NOW_MS);
    let mut c = Bazaar::new(acc(OWNER), acc(USDC));
    let v = fixtures::sign_ed(fixtures::envelope(AGENT));
    c.register_issuer(v.key_id(), "fixture issuer".into());
    let w0 = fixtures::world_attestation(AGENT, "fixture-person-1");
    c.register_world_verifier(w0.verifier_key.clone(), w0.body.action.clone(), "fixture".into());
    let m01 = &fixtures::merchants()[0];
    at(&m01.account, NOW_MS);
    c.register_merchant(m01.schedule.clone(), m01.category.clone(), None);
    at(OWNER, NOW_MS);
    c.approve_merchant(acc(&m01.account));
    let mut buyers = vec![(v.clone(), w0)];
    buyers.extend(fixtures::cohort_verdicts().into_iter().zip(fixtures::world_attestations().into_iter().skip(1)));
    for (sv, w) in &buyers {
        at(&sv.envelope.cnf, NOW_MS);
        call(|| c.attest_human(w.clone()))?;
        at(&sv.envelope.cnf, NOW_MS);
        call(|| c.submit_verdict(sv.clone()))?;
    }
    let e = &v.envelope;

    // price: m01's schedule for the buyer, at the cohort size the contract counts.
    let cohort_pred = m01.schedule.cohort.as_ref().map(|co| co.predicate.clone()).unwrap_or_default();
    let k = c.cohort_size(e.context.clone(), cohort_pred.clone());
    let zs = m01.schedule.to_zk();
    let zq = bookerbob_zkcore::price::quote_in_cohort(&zs, &e.predicates, |_| k);
    let onchain = c.quote(acc(&m01.account), e.nullifier.clone());
    if onchain.price != zq.price {
        return Err(format!("contract quote {} differs from zkcore {}", onchain.price, zq.price));
    }
    out.push((
        "price-input.json",
        json!({
            "base_price": zs.base_price, "rules": zs.rules, "cap_bps": zs.cap_bps, "cohort": zs.cohort,
            "revealed": e.predicates, "cohort_k": k,
            "expected": { "price": zq.price.to_string(), "discount_bps": zq.discount_bps, "input_hash": hx(bookerbob_zkcore::price::input_hash(&zs, &e.predicates, k)), "contract_quote": onchain.price.to_string() }
        }),
    ));

    // referee: the honest claims and the injected cheat, against that quote.
    let lines: Vec<String> = onchain.lines.iter().map(|l| l.predicate.clone()).collect();
    let cohort_line = onchain.cohort.as_ref().map(|x| x.predicate.clone());
    for (name, claims) in [("referee-input.json", fixtures::honest_claims()), ("referee-cheat-input.json", fixtures::cheat_claims())] {
        let (facts, zc) = bookerbob_core::referee::to_zk(&fixtures::proofs(), &claims);
        let ok = bookerbob_zkcore::referee::check(&facts, &e.predicates, &lines, cohort_line.as_deref(), &zc);
        out.push((
            name,
            json!({
                "facts": facts.iter().map(|f| (f.id.clone(), f.platform.clone(), f.field.clone(), f.value)).collect::<Vec<_>>(),
                "revealed": e.predicates, "lines": lines, "cohort_line": cohort_line,
                "claims": zc.iter().map(|c| (c.line.clone(), c.text.clone(), c.citations.iter().map(|x| (x.fact.clone(), x.field.clone(), x.value)).collect::<Vec<_>>())).collect::<Vec<_>>(),
                "expected": { "receipt": ok.is_ok(), "reason": ok.err(), "input_hash": hx(bookerbob_zkcore::referee::input_hash(&facts, &e.predicates, &lines, cohort_line.as_deref(), &zc)) }
            }),
        ));
    }

    // cohort: the six verdicts that revealed world_id_human, in the contract's order.
    let pred = "world_id_human";
    let nulls: Vec<String> =
        buyers.iter().filter(|(sv, _)| sv.envelope.predicates.iter().any(|p| p == pred)).map(|(sv, _)| sv.envelope.nullifier.clone()).collect();
    let refs: Vec<&str> = nulls.iter().map(String::as_str).collect();
    let (root, k) = bookerbob_zkcore::cohort::check(CONTEXT, pred, &refs).map_err(|e| e.to_string())?;
    let (onchain_root, onchain_k) = c.cohort_root(CONTEXT.into(), pred.into());
    if onchain_root != hx(root) || onchain_k != k {
        return Err(format!("contract cohort root {onchain_root} (k={onchain_k}) differs from zkcore (k={k})"));
    }
    out.push((
        "cohort-input.json",
        json!({ "context": CONTEXT, "predicate": pred, "nullifiers": nulls, "expected": { "root": hx(root), "k": k, "contract_cohort_root": onchain_root } }),
    ));
    Ok(out)
}

pub fn run(dir: &Path, check: bool) -> ExitCode {
    let files = match build(dir) {
        Ok(f) => f,
        Err(e) => {
            println!("FAIL  zk inputs  ({e})");
            return ExitCode::FAILURE;
        }
    };
    let zk = dir.join("zk");
    let mut stale = vec![];
    for (name, v) in &files {
        let body = serde_json::to_string_pretty(v).unwrap() + "\n";
        if check {
            if std::fs::read_to_string(zk.join(name)).ok().as_deref() != Some(body.as_str()) {
                stale.push(*name);
            }
        } else {
            std::fs::create_dir_all(&zk).expect("zk dir");
            std::fs::write(zk.join(name), body).expect("write");
        }
    }
    if check {
        if stale.is_empty() {
            println!("PASS  Jolt guest inputs match the contract (standing root, price quote, referee, cohort root): fixtures/zk up to date");
            ExitCode::SUCCESS
        } else {
            println!("FAIL  stale fixtures/zk: {} (run make zk-inputs)", stale.join(", "));
            ExitCode::FAILURE
        }
    } else {
        println!("wrote {} files to {}", files.len(), zk.display());
        ExitCode::SUCCESS
    }
}
