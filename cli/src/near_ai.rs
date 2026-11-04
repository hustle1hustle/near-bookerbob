//! `bookerbob near-ai <dir>`: offline check of a NEAR AI verdict captured by
//! `scripts/near-ai-verdict.mjs`. Every check uses committed bytes only; the TDX quote is
//! checked against committed Intel PCS collateral at the time it was fetched.
//! Not checked offline: the NVIDIA GPU evidence (NRAS is an online service).
use std::path::Path;
use std::process::ExitCode;

use bookerbob_core::{derive, Envelope, ProofSet};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use curve25519_dalek::montgomery::MontgomeryPoint;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
struct Capture {
    model: String,
    nonce: String,
    chat_id: String,
    signing_address: String,
    client_x25519_secret: String,
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

/// E2EE v2: wire = eph_pub(32) || nonce(24) || xchacha20poly1305 ; key = HKDF-SHA256(X25519).
fn open(wire_hex: &str, x_secret: [u8; 32]) -> Result<String, String> {
    let w = hex::decode(wire_hex).map_err(|_| "sealed field is not hex")?;
    if w.len() < 32 + 24 + 16 {
        return Err("sealed field too short".into());
    }
    let eph: [u8; 32] = w[..32].try_into().unwrap();
    let shared = MontgomeryPoint(eph).mul_clamped(x_secret).to_bytes();
    let mut key = [0u8; 32];
    hkdf::Hkdf::<Sha256>::new(None, &shared).expand(b"ed25519_encryption", &mut key).map_err(|_| "hkdf")?;
    let pt = XChaCha20Poly1305::new(&key.into()).decrypt(XNonce::from_slice(&w[32..56]), &w[56..]).map_err(|_| "does not open with the disclosed key")?;
    String::from_utf8(pt).map_err(|_| "not utf-8".into())
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
    // 5. Open the sealed answer with the disclosed one-time client key.
    let body: serde_json::Value = serde_json::from_slice(&resp).expect("parse response");
    let x: [u8; 32] = hex::decode(&cap.client_x25519_secret).ok().and_then(|b| b.try_into().ok()).unwrap_or([0; 32]);
    let answer = open(body["choices"][0]["message"]["content"].as_str().unwrap_or_default(), x);
    check(
        "the answer was sealed and opens with the disclosed one-time client key",
        answer.as_ref().map(|a| format!("{} bytes", a.len())).map_err(|e| e.clone()),
    );
    let parsed: Option<serde_json::Value> = answer.ok().and_then(|a| a.find('{').and_then(|i| a.rfind('}').and_then(|j| serde_json::from_str(&a[i..=j]).ok())));
    let attested: Vec<String> =
        parsed.as_ref().and_then(|p| p["predicates"].as_array()).map(|v| v.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    // 6. The model computed what the code computes.
    let by_code = derive(&proofs).predicates();
    check(
        "the attested predicates equal what core/src/tier.rs derives from the proof set",
        if attested == by_code { Ok(attested.join(",")) } else { Err(format!("model {attested:?}, code {by_code:?}")) },
    );
    // 7. The answer binds this envelope, and the envelope binds this chat.
    let e = &cap.envelope;
    let echoed = parsed.as_ref().and_then(|p| p["bind"].as_str().map(String::from)).unwrap_or_default();
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

    let passed = checks.iter().filter(|(_, r)| r.is_ok()).count();
    if print {
        println!("bookerbob near-ai {}", dir.display());
        for (i, (name, r)) in checks.iter().enumerate() {
            match r {
                Ok(d) => println!("PASS  N{}  {name}  ({d})", i + 1),
                Err(d) => println!("FAIL  N{}  {name}  ({d})", i + 1),
            }
        }
        println!("NOTE  NVIDIA GPU evidence is not checked offline (NRAS is online); on-chain acceptance of this verdict is not built");
    }
    (passed, checks.len())
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
            std::fs::copy(f.path(), dst.join(f.file_name())).unwrap();
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
        assert_eq!(super::check_dir(&d, &proofs(), false), (7, 8));
    }

    #[test]
    fn another_nullifier_breaks_the_binding() {
        let d = copy("bind");
        let mut c: serde_json::Value = serde_json::from_slice(&std::fs::read(d.join("capture.json")).unwrap()).unwrap();
        c["envelope"]["nullifier"] = "00".repeat(32).into();
        std::fs::write(d.join("capture.json"), serde_json::to_vec(&c).unwrap()).unwrap();
        assert_eq!(super::check_dir(&d, &proofs(), false), (7, 8));
    }

    #[test]
    fn a_wrong_disclosed_key_does_not_open_the_answer() {
        let d = copy("key");
        let mut c: serde_json::Value = serde_json::from_slice(&std::fs::read(d.join("capture.json")).unwrap()).unwrap();
        c["client_x25519_secret"] = "11".repeat(32).into();
        std::fs::write(d.join("capture.json"), serde_json::to_vec(&c).unwrap()).unwrap();
        let (p, t) = super::check_dir(&d, &proofs(), false);
        assert!(p <= t - 3, "open, predicates and binding all fail");
    }
}
