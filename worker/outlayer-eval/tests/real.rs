//! Layer 1 on the real TLSNotary presentations committed in fixtures/, and v1's answer to them.
use base64::Engine as _;
use bookerbob_eval_outlayer::*;
use bookerbob_referee_worker::sealed;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier};
use sha2::{Digest, Sha256};

pub struct Mock;
fn key(path: &str) -> SigningKey {
    SigningKey::from_bytes(&Sha256::digest(format!("MOCK outlayer signing key|{path}")).into())
}
impl Keys for Mock {
    fn public_key(&self, path: &str) -> Result<[u8; 32], String> {
        Ok(key(path).verifying_key().to_bytes())
    }
    fn sign(&self, path: &str, m: &[u8]) -> Result<[u8; 64], String> {
        Ok(key(path).sign(m).to_bytes())
    }
}

const OWNER: &str = "../../fixtures/live/prove-me/founder-github-owner.presentation";
const PUBLIC_TDX: &str = "../../fixtures/live/tee-notary/octocat-mpc.presentation";
const CTX: &str = "bookerbob:v0:evaltee-github";

fn input(file: &str, cnf: &str) -> EvalInput {
    EvalInput {
        context: CTX.into(),
        cnf: cnf.into(),
        max_spend: 50_000_000,
        ttl_ms: 1_800_000,
        predicates: vec![],
        salt: "11".repeat(32),
        presentations: vec![base64::engine::general_purpose::STANDARD.encode(std::fs::read(file).unwrap())],
    }
}

fn run_sealed(i: &EvalInput, now_ms: Option<u64>) -> Result<serde_json::Value, String> {
    let seed = seal_seed(&Mock).unwrap();
    let s = sealed::seal(&sealed::public_hex(&seed), &serde_json::to_vec(i).unwrap(), [7; 32], [9; 24]).unwrap();
    answer(&Mock, &serde_json::json!({ "sealed": s }).to_string(), now_ms).map(|o| serde_json::from_str(&o).unwrap())
}

fn refusal_reason(out: &serde_json::Value) -> String {
    let mut m = b"bookerbob/eval-refusal/v1\x00".to_vec();
    m.extend(serde_json::to_vec(&out["refusal"]).unwrap());
    let sig = Signature::from_slice(&hex::decode(out["signature"].as_str().unwrap()).unwrap()).unwrap();
    key(EVALUATOR).verifying_key().verify(&m, &sig).expect("refusal signature");
    assert!(!out.to_string().contains("presentation_sha") && out["refusal"].get("proofs").is_none(), "a refusal names no presentation");
    out["refusal"]["reason"].as_str().unwrap().to_string()
}

#[test]
fn the_founder_presentation_verifies_and_shows_what_it_reveals() {
    let t = verify_presentation(&std::fs::read(OWNER).unwrap()).unwrap();
    assert_eq!(t.server, "api.github.com");
    assert!(t.sent.starts_with(b"GET /user HTTP/1.1"));
    // Everything after the request line is hidden: v1 needs the request revealed.
    assert!(t.sent_rev.iter().skip(20).any(|r| !r));
    assert!(t.recv_rev.iter().any(|r| !r));
}

#[test]
fn v1_refuses_the_v0_era_presentation() {
    // Notarized 2026-11-13: refused as not fresh at that time + 7 h, and, when fresh, as unbound.
    let t = verify_presentation(&std::fs::read(OWNER).unwrap()).unwrap();
    assert_eq!(check_transcript(&t, &binding("buyer.testnet", CTX), t.time_secs + 7 * 3600), Err("session not fresh"));
    assert_eq!(check_transcript(&t, &binding("buyer.testnet", CTX), t.time_secs + 60), Err("request is not GET /user bound to this agent and context"));
    let out = run_sealed(&input(OWNER, "buyer.testnet"), Some((t.time_secs + 60) * 1000)).unwrap();
    assert_eq!(refusal_reason(&out), "request is not GET /user bound to this agent and context");
}

#[test]
fn a_public_profile_from_the_tdx_notary_is_refused() {
    let t = verify_presentation(&std::fs::read(PUBLIC_TDX).unwrap()).unwrap();
    assert_eq!(check_transcript(&t, &binding("b.testnet", CTX), t.time_secs + 60), Err("request is not GET /user bound to this agent and context"));
}

#[test]
fn a_tampered_presentation_is_refused_without_echo() {
    let mut b = std::fs::read(OWNER).unwrap();
    let n = b.len();
    b[n - 40] ^= 1;
    let mut i = input(OWNER, "buyer.testnet");
    i.presentations = vec![base64::engine::general_purpose::STANDARD.encode(&b)];
    let r = refusal_reason(&run_sealed(&i, Some(1_794_600_000_000)).unwrap());
    assert!(["presentation does not verify", "not a TLSNotary presentation", "notary key not pinned"].contains(&r.as_str()), "{r}");
}

#[test]
fn no_clock_no_verdict_and_errors_carry_no_input() {
    assert_eq!(run_sealed(&input(OWNER, "buyer.testnet"), None).unwrap_err(), "no clock");
    assert_eq!(run_sealed(&input(OWNER, "buyer.testnet"), Some(1000)).unwrap_err(), "no clock");
    let raw = serde_json::to_string(&input(OWNER, "b.testnet")).unwrap();
    assert_eq!(answer(&Mock, &raw, Some(1_794_600_000_000)).unwrap_err(), "input must be sealed");
    let e = answer(&Mock, r#"{"sealed":{"v":0,"epk":"zz SECRET","nonce":"","ct":"","commitment":""}}"#, None).unwrap_err();
    assert!(!e.contains("SECRET"), "{e}");
    let e = answer(&Mock, "{not json SECRET", None).unwrap_err();
    assert_eq!(e, "bad input");
}

#[test]
fn a_context_outside_the_list_or_a_bad_cnf_gets_nothing_signed() {
    let mut i = input(OWNER, "buyer.testnet");
    i.context = "bookerbob:v0:fresh-context-for-a-new-nullifier".into();
    assert_eq!(run_sealed(&i, Some(1_794_600_000_000)).unwrap_err(), "bad input");
    for cnf in ["Bad.Testnet", "x", "a\"b", &"a".repeat(65)] {
        assert_eq!(run_sealed(&input(OWNER, cnf), Some(1_794_600_000_000)).unwrap_err(), "bad input", "{cnf}");
    }
}

#[test]
fn pubkey_is_signed_and_small() {
    let p: serde_json::Value = serde_json::from_str(&answer(&Mock, r#"{"cmd":"pubkey"}"#, None).unwrap()).unwrap();
    let mut m = b"bookerbob/eval-keys/v1\x00".to_vec();
    m.extend(serde_json::to_vec(&p["keys"]).unwrap());
    let sig = Signature::from_slice(&hex::decode(p["signature"].as_str().unwrap()).unwrap()).unwrap();
    key(EVALUATOR).verifying_key().verify(&m, &sig).unwrap();
    assert!(p.to_string().len() <= 1024);
}
