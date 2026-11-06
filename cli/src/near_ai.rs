//! `bookerbob near-ai <dir>`: offline check of a NEAR AI verdict captured by
//! `scripts/near-ai-verdict.mjs`. Every check uses committed bytes only; the TDX quote is
//! checked against committed Intel PCS collateral at the time it was fetched.
//! Not checked offline: the NVIDIA GPU evidence (NRAS is an online service).
use std::path::Path;
use std::process::ExitCode;

use bookerbob_core::{derive, Envelope, ProofSet};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
struct Capture {
    model: String,
    nonce: String,
    chat_id: String,
    signing_address: String,
    /// The key for the sealed answer field only; the client secret is never kept.
    response_key: String,
    bind: String,
    envelope: Envelope,
}

#[derive(Deserialize)]
struct Sig {
    text: String,
    signature: String,
    signing_address: String,
}

#[derive(Deserialize)]
struct Collateral {
    checked_at_secs: u64,
    collateral: dcap_qvl::QuoteCollateralV3,
}

fn sha_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

/// The on-chain proof for `submit_near_ai_verdict`, built from the capture: the exact
/// response bytes and the disclosed key for its sealed answer field.
pub fn proof(dir: &Path) -> (Envelope, bookerbob_core::near_ai::NearAiProof) {
    let read = |n: &str| std::fs::read(dir.join(n)).unwrap_or_else(|e| panic!("read {n}: {e}"));
    let cap: Capture = serde_json::from_slice(&read("capture.json")).expect("parse capture");
    let sig: Sig = serde_json::from_slice(&read("signature.json")).expect("parse signature");
    let response = String::from_utf8(read("response.json")).expect("utf-8 response");
    let p = bookerbob_core::near_ai::NearAiProof {
        chat_id: cap.chat_id,
        signing_key: cap.signing_address,
        nonce: cap.nonce,
        request_sha256: sha_hex(&read("request.json")),
        response,
        response_key: cap.response_key,
        signature: sig.signature,
        evaluator_sig: String::new(),
    };
    (cap.envelope, p)
}

pub fn run(dir: &Path, proofs_path: &Path) -> ExitCode {
    let (passed, total) = check_dir(dir, proofs_path, true);
    if passed == total {
        println!("PASS  NEAR AI verdict: {total} checks");
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// Runs every check; returns (passed, total). Prints when `print`.
/// RTMR replay as dstack extends it: rtmr = sha384(rtmr || digest). Boot measurements
/// (RTMR0-2) carry only a digest. Runtime events (RTMR3) are recomputed from their payload,
/// sha384(event_type u32 LE || ":" || event || ":" || payload), and a logged digest must equal
/// it, so a payload (the compose hash, the app id) cannot differ from what was measured.
/// None when a logged RTMR3 digest disagrees with its payload.
fn replay_rtmr(events: &[serde_json::Value], imr: u64) -> Option<[u8; 48]> {
    use sha2::{Digest, Sha384};
    let mut acc = [0u8; 48];
    for e in events.iter().filter(|e| e["imr"].as_u64() == Some(imr)) {
        let logged = e["digest"].as_str().filter(|d| !d.is_empty()).map(|d| hex::decode(d).unwrap_or_default());
        let digest: Vec<u8> = if imr == 3 {
            let p = e["event_payload"].as_str().unwrap_or_default();
            let payload = hex::decode(p).unwrap_or_else(|_| p.as_bytes().to_vec());
            let mut h = Sha384::new();
            h.update((e["event_type"].as_u64().unwrap_or(0) as u32).to_le_bytes());
            h.update(b":");
            h.update(e["event"].as_str().unwrap_or_default().as_bytes());
            h.update(b":");
            h.update(&payload);
            let d = h.finalize().to_vec();
            if logged.as_ref().is_some_and(|l| *l != d) {
                return None;
            }
            d
        } else {
            logged?
        };
        let mut h = Sha384::new();
        h.update(acc);
        h.update(&digest);
        acc = h.finalize().into();
    }
    Some(acc)
}

fn measurements_match(ti: &serde_json::Value, mrtd: &[u8; 48], rtmr: &[[u8; 48]; 4]) -> Result<String, String> {
    if ti["mrtd"].as_str() != Some(hex::encode(mrtd).as_str()) {
        return Err("MRTD in the quote differs from the report".into());
    }
    let events: Vec<serde_json::Value> = ti["event_log"].as_array().cloned().unwrap_or_default();
    for (i, r) in rtmr.iter().enumerate() {
        if ti[format!("rtmr{i}")].as_str() != Some(hex::encode(r).as_str()) {
            return Err(format!("RTMR{i} in the quote differs from the report"));
        }
        if replay_rtmr(&events, i as u64) != Some(*r) {
            return Err(format!("RTMR{i} does not replay from the event log"));
        }
    }
    Ok(format!("{} events replay to all four RTMRs", events.len()))
}

fn compose_bound(ti: &serde_json::Value) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let compose = ti["app_compose"].as_str().ok_or("no app_compose")?;
    let h = hex::encode(Sha256::digest(compose.as_bytes()));
    if ti["compose_hash"].as_str() != Some(h.as_str()) {
        return Err("app_compose does not hash to compose_hash".into());
    }
    let in_rtmr3 = ti["event_log"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|e| e["imr"].as_u64() == Some(3) && e["event"] == "compose-hash" && e["event_payload"].as_str() == Some(h.as_str()));
    if !in_rtmr3 {
        return Err("compose hash is not in the RTMR3 event log".into());
    }
    Ok(format!("compose {}..", &h[..12]))
}

pub fn check_dir(dir: &Path, proofs_path: &Path, print: bool) -> (usize, usize) {
    let read = |n: &str| std::fs::read(dir.join(n)).unwrap_or_else(|e| panic!("read {n}: {e}"));
    let cap: Capture = serde_json::from_slice(&read("capture.json")).expect("parse capture");
    let sig: Sig = serde_json::from_slice(&read("signature.json")).expect("parse signature");
    let col: Collateral = serde_json::from_slice(&read("collateral.json")).expect("parse collateral");
    let report_bytes = read("report.json");
    let report: serde_json::Value = serde_json::from_slice(&report_bytes).expect("parse report");
    let (req, resp) = (read("request.json"), read("response.json"));
    let proofs: ProofSet = serde_json::from_str(&std::fs::read_to_string(proofs_path).expect("read proofs")).expect("parse proofs");
    let ma = &report["model_attestations"][0];
    let mut checks: Vec<(String, Result<String, String>)> = Vec::new();
    let mut check = |name: &str, r: Result<String, String>| checks.push((name.to_string(), r));

    // 1-2. TDX quote and its report_data.
    let quote = hex::decode(ma["intel_quote"].as_str().unwrap_or_default()).unwrap_or_default();
    let verified = dcap_qvl::verify::rustcrypto::verify(&quote, &col.collateral, col.checked_at_secs);
    check(
        "TDX quote verifies to Intel's root CA with the committed PCS collateral (dcap-qvl)",
        verified.as_ref().map(|v| format!("status {}, advisories {}", v.status, v.advisory_ids.len())).map_err(|e| e.to_string()),
    );
    let rd = verified.as_ref().ok().and_then(|v| v.report.as_td10().map(|t| t.report_data));
    check(
        "report_data binds the model's signing key and our nonce",
        match rd {
            Some(rd) => {
                let mut addr = hex::decode(&cap.signing_address).unwrap_or_default();
                addr.resize(32, 0);
                let nonce = hex::decode(&cap.nonce).unwrap_or_default();
                if rd[..32] == addr[..] && rd[32..] == nonce[..] && ma["signing_address"].as_str() == Some(cap.signing_address.as_str()) {
                    Ok(format!("key {}.., nonce {}..", &cap.signing_address[..12], &cap.nonce[..12]))
                } else {
                    Err("report_data does not match key and nonce".into())
                }
            }
            None => Err("no TD report".into()),
        },
    );
    // 2b. The quote's measurements: equal to what the report claims, reproduced by replaying
    // the event log (RTMR extend with sha384), the compose file hashing to compose_hash and
    // extended into RTMR3, and pinned against fixtures/live/near-ai/measurements.json.
    let td = verified.as_ref().ok().and_then(|v| v.report.as_td10()).map(|t| (t.mr_td, [t.rt_mr0, t.rt_mr1, t.rt_mr2, t.rt_mr3]));
    let ti = &ma["info"]["tcb_info"];
    check(
        "the quote's MRTD and RTMR0-3 equal the report's tcb_info and replay from its event log",
        match &td {
            Some((mrtd, rtmr)) => measurements_match(ti, mrtd, rtmr),
            None => Err("no TD report".into()),
        },
    );
    check("the compose file hashes to compose_hash, which is extended into RTMR3", compose_bound(ti));
    let pin: serde_json::Value = serde_json::from_slice(&read("measurements.json")).unwrap_or_default();
    check(
        "measurements pinned (MRTD, RTMR0-2, compose hash): an unknown image is refused",
        match &td {
            Some((mrtd, rtmr)) => {
                let want = |k: &str| pin[k].as_str().unwrap_or_default().to_string();
                let got = [
                    hex::encode(mrtd),
                    hex::encode(rtmr[0]),
                    hex::encode(rtmr[1]),
                    hex::encode(rtmr[2]),
                    ti["compose_hash"].as_str().unwrap_or_default().to_string(),
                ];
                let keys = ["mrtd", "rtmr0", "rtmr1", "rtmr2", "compose_hash"];
                match keys.iter().zip(got.iter()).find(|(k, g)| want(k) != **g) {
                    None => Ok(format!("mrtd {}.., compose {}.. (observed values, not yet NEAR AI's published build)", &got[0][..12], &got[4][..12])),
                    Some((k, _)) => Err(format!("{k} differs from the pinned value")),
                }
            }
            None => Err("no TD report".into()),
        },
    );
    // 3-4. TEE signature over the exact wire bytes.
    let parts: Vec<&str> = sig.text.split(':').collect();
    let sig_ok = (|| {
        let pk = VerifyingKey::from_bytes(&hex::decode(&sig.signing_address).ok()?.try_into().ok()?).ok()?;
        let s = Signature::from_bytes(&hex::decode(&sig.signature).ok()?.try_into().ok()?);
        pk.verify(sig.text.as_bytes(), &s).ok()
    })()
    .is_some();
    check(
        "TEE ed25519 signature is valid and made by the attested key",
        if sig_ok && sig.signing_address == cap.signing_address { Ok(format!("chat {}", cap.chat_id)) } else { Err("bad signature or other key".into()) },
    );
    check(
        "the signature covers sha256 of the committed request and response wire bytes",
        if parts.len() == 3 && parts[0] == cap.model && parts[1] == sha_hex(&req) && parts[2] == sha_hex(&resp) {
            Ok(format!("{}, request {}.., response {}..", cap.model, &parts[1][..12], &parts[2][..12]))
        } else {
            Err("hash mismatch".into())
        },
    );
    // 5. Open the sealed answer with its disclosed per-field key. The reasoning stays sealed.
    let answer = bookerbob_core::near_ai::open_answer(std::str::from_utf8(&resp).unwrap_or_default(), &cap.response_key);
    check(
        "the answer was sealed and opens with the disclosed per-field key",
        answer.as_ref().map(|a| format!("{} predicates", a.predicates.len())).map_err(|e| e.to_string()),
    );
    let attested: Vec<String> = answer.as_ref().map(|a| a.predicates.clone()).unwrap_or_default();
    // 6. The model computed what the code computes.
    let by_code = derive(&proofs).predicates();
    check(
        "the attested predicates equal what core/src/tier.rs derives from the proof set",
        if attested == by_code { Ok(attested.join(",")) } else { Err(format!("model {attested:?}, code {by_code:?}")) },
    );
    // 7. The answer binds this envelope, and the envelope binds this chat.
    let e = &cap.envelope;
    let echoed = answer.as_ref().map(|a| a.bind.clone()).unwrap_or_default();
    check(
        "the sealed answer echoes the envelope binding (context, nullifier, commitment, agent, cap, times)",
        if echoed == e.near_ai_bind() && echoed == cap.bind { Ok(format!("{}..", &echoed[..16])) } else { Err("binding differs".into()) },
    );
    check(
        "envelope reveals a subset of the attested predicates and names this model and report",
        if e.predicates.iter().all(|p| attested.contains(p))
            && e.attestation.model == cap.model
            && e.attestation.report_hash == sha_hex(&report_bytes)
            && verified.as_ref().is_ok_and(|v| v.status == e.attestation.tcb_status)
        {
            Ok(format!("revealed {} of {}, tcb_status {}", e.predicates.len(), attested.len(), e.attestation.tcb_status))
        } else {
            Err("envelope does not match the attestation".into())
        },
    );

    // The committed on-chain proof (used by the contract's unit tests) is this capture's.
    let committed: Option<bookerbob_core::near_ai::NearAiProof> = std::fs::read(dir.join("proof.json")).ok().and_then(|b| serde_json::from_slice(&b).ok());
    check(
        "proof.json is exactly the proof built from this capture",
        if committed.as_ref() == Some(&proof(dir).1) { Ok("ok".into()) } else { Err("stale or missing proof.json (run bookerbob near-ai-proof)".into()) },
    );
    // 10-14. The contract: accepts this verdict with the proof, refuses it without.
    let report_hash = sha_hex(&report_bytes);
    let tcb = verified.as_ref().map(|v| v.status.clone()).unwrap_or_default();
    let (env0, proof0) = proof(dir);
    let run_chain = |e: Envelope, p: bookerbob_core::near_ai::NearAiProof, nonce: String| {
        let (rh, tcb) = (report_hash.clone(), tcb.clone());
        std::thread::spawn(move || chain_case(e, p, nonce, rh, tcb)).join().unwrap_or_else(|_| Err("panicked".into()))
    };
    check(
        "the bazaar contract accepts the verdict with the proof (submit_near_ai_verdict)",
        run_chain(env0.clone(), proof0.clone(), proof0.nonce.clone()).map(|n| format!("record for nullifier {}..", &n[..12])),
    );
    let refused = |r: Result<String, String>, want: &str| match r {
        Err(m) if m.contains(want) => Ok(format!("refused: {want}")),
        Err(m) => Err(format!("refused for another reason: {m}")),
        Ok(_) => Err("accepted".into()),
    };
    let mut other = env0.clone();
    other.nullifier = "00".repeat(32);
    check(
        "same model key and signature, another envelope: refused",
        refused(run_chain(other, proof0.clone(), proof0.nonce.clone()), "answer is about another envelope"),
    );
    let mut p2 = proof0.clone();
    p2.response = p2.response.replacen("\"id\"", "\"id\" ", 1);
    check("one changed response byte: refused", refused(run_chain(env0.clone(), p2, proof0.nonce.clone()), "bad TEE signature"));
    check(
        "model key registered with another attestation nonce: refused",
        refused(run_chain(env0.clone(), proof0.clone(), "11".repeat(32)), "attestation nonce mismatch"),
    );
    let mut p3 = proof0.clone();
    p3.response_key = "22".repeat(32);
    check("wrong disclosed answer key: refused", refused(run_chain(env0.clone(), p3, proof0.nonce.clone()), "does not open"));

    let passed = checks.iter().filter(|(_, r)| r.is_ok()).count();
    if print {
        println!("bookerbob near-ai {}", dir.display());
        for (i, (name, r)) in checks.iter().enumerate() {
            match r {
                Ok(d) => println!("PASS  N{}  {name}  ({d})", i + 1),
                Err(d) => println!("FAIL  N{}  {name}  ({d})", i + 1),
            }
        }
        println!("NOTE  the NVIDIA GPU evidence is checked next, from NVIDIA's saved NRAS reply (scripts/nras.mjs); the TDX quote is checked here, and on chain by the quote verifier the bazaar requires (tools/dcap-spike)");
    }
    (passed, checks.len())
}

/// One fresh bazaar on the mocked chain: owner registers the model attestation with
/// `registered_nonce`, the agent binds its World ID, then submits the NEAR AI verdict.
fn chain_case(e: Envelope, mut p: bookerbob_core::near_ai::NearAiProof, registered_nonce: String, report_hash: String, tcb: String) -> Result<String, String> {
    use bookerbob_bazaar::{Bazaar, ModelAttestation, RECORD_DEPOSIT};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;
    std::panic::set_hook(Box::new(|_| {}));
    let acc = |s: &str| s.parse::<near_sdk::AccountId>().unwrap();
    let at = |who: &str| {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc(crate::fixtures::OWNER))
            .predecessor_account_id(acc(who))
            .block_timestamp(crate::fixtures::NOW_MS * 1_000_000)
            .attached_deposit(RECORD_DEPOSIT);
        testing_env!(b.build());
    };
    at(crate::fixtures::OWNER);
    let mut c = Bazaar::new(acc(crate::fixtures::OWNER), acc(crate::fixtures::USDC));
    let w = crate::fixtures::world_attestation(&e.cnf, "fixture-person-1");
    c.register_world_verifier(w.verifier_key.clone(), w.body.action.clone(), "fixture".into());
    c.register_model_attestation(
        p.signing_key.clone(),
        ModelAttestation { model: e.attestation.model.clone(), nonce: registered_nonce, report_hash, tcb_status: tcb },
    );
    // The fixture evaluator: the capture predates it, so its signature is made here.
    let evaluator = ed25519_dalek::SigningKey::from_bytes(&[8u8; 32]);
    c.set_evaluator_key(hex::encode(evaluator.verifying_key().to_bytes()));
    p.evaluator_sig = hex::encode(ed25519_dalek::Signer::sign(&evaluator, &bookerbob_core::near_ai::evaluator_message(&e, &p.request_sha256)).to_bytes());
    at(&e.cnf);
    c.attest_human(w);
    let n = e.nullifier.clone();
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.submit_near_ai_verdict(e, p)))
        .map_err(|x| x.downcast_ref::<String>().cloned().or_else(|| x.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default())?;
    c.verdict(n.clone()).map(|_| n).ok_or_else(|| "no record".to_string())
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    fn copy(tag: &str) -> PathBuf {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/live/near-ai");
        let dst = std::env::temp_dir().join(format!("bookerbob-near-ai-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dst);
        std::fs::create_dir_all(&dst).unwrap();
        for f in std::fs::read_dir(&src).unwrap() {
            let f = f.unwrap();
            // models/ holds other models' reports; check_dir reads only the files at the top.
            if f.file_type().unwrap().is_file() {
                std::fs::copy(f.path(), dst.join(f.file_name())).unwrap();
            }
        }
        dst
    }

    fn proofs() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/proofs.json")
    }

    #[test]
    fn committed_capture_passes() {
        let (p, t) = super::check_dir(&copy("ok"), &proofs(), false);
        assert_eq!(p, t);
    }

    #[test]
    fn one_changed_response_byte_breaks_the_signature_binding() {
        let d = copy("resp");
        let mut r = std::fs::read(d.join("response.json")).unwrap();
        let i = r.iter().position(|b| *b == b'"').unwrap();
        r.insert(i, b' ');
        std::fs::write(d.join("response.json"), r).unwrap();
        let (p, t) = super::check_dir(&d, &proofs(), false);
        assert!(p < t);
    }

    #[test]
    fn a_raised_predicate_set_is_refused() {
        // The buyer edits the envelope to reveal a predicate the model did not attest.
        let d = copy("pred");
        let mut c: serde_json::Value = serde_json::from_slice(&std::fs::read(d.join("capture.json")).unwrap()).unwrap();
        c["envelope"]["predicates"].as_array_mut().unwrap().push("steam_veteran".into());
        std::fs::write(d.join("capture.json"), serde_json::to_vec(&c).unwrap()).unwrap();
        let (p, t) = super::check_dir(&d, &proofs(), false);
        assert!(t - p >= 2, "N8 and the contract acceptance fail");
    }

    #[test]
    fn another_nullifier_breaks_the_binding() {
        let d = copy("bind");
        let mut c: serde_json::Value = serde_json::from_slice(&std::fs::read(d.join("capture.json")).unwrap()).unwrap();
        c["envelope"]["nullifier"] = "11".repeat(32).into();
        std::fs::write(d.join("capture.json"), serde_json::to_vec(&c).unwrap()).unwrap();
        let (p, t) = super::check_dir(&d, &proofs(), false);
        assert!(p < t, "binding and contract acceptance fail");
    }

    #[test]
    fn a_wrong_disclosed_key_does_not_open_the_answer() {
        let d = copy("key");
        let mut c: serde_json::Value = serde_json::from_slice(&std::fs::read(d.join("capture.json")).unwrap()).unwrap();
        c["response_key"] = "11".repeat(32).into();
        std::fs::write(d.join("capture.json"), serde_json::to_vec(&c).unwrap()).unwrap();
        let (p, t) = super::check_dir(&d, &proofs(), false);
        assert!(p <= t - 3, "open, predicates and binding all fail");
    }
}

#[cfg(test)]
mod measurement_tests {
    use super::*;

    fn tcb() -> serde_json::Value {
        let r: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/live/near-ai/report.json")).unwrap();
        r["model_attestations"][0]["info"]["tcb_info"].clone()
    }

    fn parts(ti: &serde_json::Value) -> ([u8; 48], [[u8; 48]; 4]) {
        let h = |k: &str| -> [u8; 48] { hex::decode(ti[k].as_str().unwrap()).unwrap().try_into().unwrap() };
        (h("mrtd"), [h("rtmr0"), h("rtmr1"), h("rtmr2"), h("rtmr3")])
    }

    #[test]
    fn the_capture_replays_and_binds_its_compose_file() {
        let ti = tcb();
        let (m, r) = parts(&ti);
        assert!(measurements_match(&ti, &m, &r).is_ok());
        assert!(compose_bound(&ti).is_ok());
    }

    #[test]
    fn a_changed_measurement_or_event_is_refused() {
        let ti = tcb();
        let (mut m, r) = parts(&ti);
        m[0] ^= 1;
        assert!(measurements_match(&ti, &m, &r).unwrap_err().contains("MRTD"));
        let mut t2 = ti.clone();
        let ev = t2["event_log"].as_array_mut().unwrap();
        let i = ev.iter().position(|e| e["imr"] == 3).unwrap();
        ev[i]["event_payload"] = serde_json::json!("00");
        let (m, r) = parts(&ti);
        assert!(measurements_match(&t2, &m, &r).unwrap_err().contains("does not replay"));
    }

    #[test]
    fn a_changed_compose_file_is_refused() {
        let mut ti = tcb();
        ti["app_compose"] = serde_json::json!(ti["app_compose"].as_str().unwrap().replace("manifest_version", "manifest_versioN"));
        assert!(compose_bound(&ti).unwrap_err().contains("does not hash"));
    }
}
