//! VOPRF account nullifiers (RFC 9497, ristretto255-SHA512, mode 0x01), replacing the HMAC under
//! a REP key. The roles are kept apart in code and only exchange the protocol messages:
//!
//! - the **buyer** picks a fresh input `x = context || 32 random bytes` for one purchase, blinds it
//!   and sends only the blinded element;
//! - the **evaluator** (REP's VOPRF key: one holder today, a TDX enclave and a committee later)
//!   sees the requester and the blinded element, evaluates at most once per (requester, context),
//!   and returns the evaluation with a DLEQ proof;
//! - the buyer checks the proof against the public key anchored on the bazaar (`voprf_key`), so the
//!   evaluator cannot tag one buyer with a key of its own, and unblinds: `N = sha256(TAG || F_k(x))`.
//!
//! What it changes: today REP can recompute the HMAC nullifier of any person it knows in any
//! context. Here REP never sees `x` at evaluation (only a blinded element, uniformly random), so it
//! cannot tie an evaluation to the nullifier that later appears on chain, and two contexts' inputs
//! are unrelated random strings, so their nullifiers are unrelated.
//!
//! Public verifiability: the purchase record carries `x`, a fresh blind `r` and the evaluation and
//! proof for `r * H(x)` (a second evaluation, made at redemption). Anyone re-derives `N` from them
//! and the anchored public key; that second blinded element was never sent by the requester, so it
//! links nothing.
use rand_core::OsRng;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::process::ExitCode;
use voprf::{BlindedElement, EvaluationElement, Group, Proof, Ristretto255, VoprfClient, VoprfServer};

type Cs = Ristretto255;
pub const TAG: &[u8] = b"bookerbob voprf nullifier v1";

fn hx(b: impl AsRef<[u8]>) -> String {
    hex::encode(b.as_ref())
}
fn unhex(s: &str, what: &str) -> Result<Vec<u8>, String> {
    hex::decode(s).map_err(|_| format!("bad {what} hex"))
}

/// The nullifier from a VOPRF output.
pub fn nullifier(output: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(TAG);
    h.update(output);
    hx(h.finalize())
}

/// The evaluator's key from a 32-byte seed (RFC 9497 DeriveKeyPair, info "bookerbob/voprf/v1").
pub fn server(seed: &[u8]) -> Result<VoprfServer<Cs>, String> {
    VoprfServer::<Cs>::new_from_seed(seed, b"bookerbob/voprf/v1").map_err(|e| format!("voprf key: {e:?}"))
}

pub fn public_key_hex(s: &VoprfServer<Cs>) -> String {
    hx(<Cs as Group>::serialize_elem(s.get_public_key()))
}

fn public_key(pk_hex: &str) -> Result<<Cs as Group>::Elem, String> {
    <Cs as Group>::deserialize_elem(&unhex(pk_hex, "public key")?).map_err(|_| "bad public key".into())
}

/// The buyer's purchase input: the context, then 32 fresh random bytes.
pub fn fresh_input(context: &str) -> Vec<u8> {
    let mut r = [0u8; 32];
    rand_core::RngCore::fill_bytes(&mut OsRng, &mut r);
    [context.as_bytes(), b"|", &r].concat()
}

/// Buyer, step 1: blind. Returns the client state (kept) and the blinded element (sent).
pub fn blind(input: &[u8]) -> Result<(VoprfClient<Cs>, String), String> {
    let r = VoprfClient::<Cs>::blind(input, &mut OsRng).map_err(|e| format!("blind: {e:?}"))?;
    Ok((r.state, hx(r.message.serialize())))
}

/// Evaluator: one blinded element in, its evaluation and DLEQ proof out (hex).
pub fn evaluate(s: &VoprfServer<Cs>, blinded_hex: &str) -> Result<(String, String), String> {
    let b = BlindedElement::<Cs>::deserialize(&unhex(blinded_hex, "blinded element")?).map_err(|_| "bad blinded element")?;
    let r = s.blind_evaluate(&mut OsRng, &b);
    Ok((hx(r.message.serialize()), hx(r.proof.serialize())))
}

/// Buyer, step 3: check the proof against the anchored key and unblind into the nullifier.
pub fn finalize(state: &VoprfClient<Cs>, input: &[u8], evaluated_hex: &str, proof_hex: &str, pk_hex: &str) -> Result<String, String> {
    let e = EvaluationElement::<Cs>::deserialize(&unhex(evaluated_hex, "evaluation")?).map_err(|_| "bad evaluation")?;
    let p = Proof::<Cs>::deserialize(&unhex(proof_hex, "proof")?).map_err(|_| "bad proof")?;
    let out = state.finalize(input, &e, &p, public_key(pk_hex)?).map_err(|_| "the evaluator's proof does not verify under the anchored key".to_string())?;
    Ok(nullifier(&out))
}

/// The public redemption record: a fresh blind of `x`, evaluated with a proof.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Redemption {
    pub input_hex: String,
    pub blind_hex: String,
    pub evaluated_hex: String,
    pub proof_hex: String,
    pub public_key_hex: String,
    pub nullifier: String,
}

pub fn redemption(s: &VoprfServer<Cs>, input: &[u8]) -> Result<Redemption, String> {
    let r = <Cs as Group>::random_scalar(&mut OsRng);
    let c = VoprfClient::<Cs>::deterministic_blind_unchecked(input, r).map_err(|e| format!("blind: {e:?}"))?;
    let (evaluated_hex, proof_hex) = evaluate(s, &hx(c.message.serialize()))?;
    let pk = public_key_hex(s);
    let n = finalize(&c.state, input, &evaluated_hex, &proof_hex, &pk)?;
    Ok(Redemption { input_hex: hx(input), blind_hex: hx(<Cs as Group>::serialize_scalar(r)), evaluated_hex, proof_hex, public_key_hex: pk, nullifier: n })
}

/// Anyone: re-derive the nullifier from a redemption record and check it under `pk_hex`.
pub fn verify_redemption(rd: &Redemption, pk_hex: &str) -> Result<(), String> {
    if rd.public_key_hex != pk_hex {
        return Err("the record names another VOPRF key".into());
    }
    let input = unhex(&rd.input_hex, "input")?;
    let r = <Cs as Group>::deserialize_scalar(&unhex(&rd.blind_hex, "blind")?).map_err(|_| "bad blind")?;
    let c = VoprfClient::<Cs>::deterministic_blind_unchecked(&input, r).map_err(|e| format!("blind: {e:?}"))?;
    let n = finalize(&c.state, &input, &rd.evaluated_hex, &rd.proof_hex, pk_hex)?;
    if n != rd.nullifier {
        return Err("the nullifier is not the VOPRF output of this input".into());
    }
    Ok(())
}

// ---------- commands ----------

fn seed_of(keys_dir: &Path) -> Result<Vec<u8>, String> {
    let p = keys_dir.join("voprf.seed");
    let s = std::fs::read_to_string(&p).map_err(|_| format!("no VOPRF key at {} (run voprf-keygen)", p.display()))?;
    unhex(s.trim(), "voprf seed")
}

/// The evaluator's policy: at most one evaluation per (requester, context). The log keeps the
/// requester, the context and the blinded element's hash: never an input or a nullifier.
fn evaluate_once(keys_dir: &Path, requester: &str, context: &str, blinded_hex: &str) -> Result<(String, String), String> {
    let dir = keys_dir.join("voprf");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let log = dir.join("evaluations.jsonl");
    let seen = std::fs::read_to_string(&log).unwrap_or_default();
    let key = serde_json::json!({ "requester": requester, "context": context }).to_string();
    if seen.lines().any(|l| serde_json::from_str::<serde_json::Value>(l).is_ok_and(|v| v["requester"] == requester && v["context"] == context)) {
        return Err(format!("the evaluator already evaluated for {key}: one nullifier per requester per context"));
    }
    let out = evaluate(&server(&seed_of(keys_dir)?)?, blinded_hex)?;
    let line =
        serde_json::json!({ "requester": requester, "context": context, "blinded_sha256": hx(Sha256::digest(unhex(blinded_hex, "blinded")?)) }).to_string();
    std::fs::write(&log, format!("{seen}{line}\n")).map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn run(args: &[String]) -> ExitCode {
    let r = (|| -> Result<String, String> {
        match args.first().map(String::as_str) {
            // voprf-keygen <keys_dir>: a fresh evaluator key (mode 600); prints the public key.
            Some("voprf-keygen") if args.len() >= 2 => {
                let p = Path::new(&args[1]).join("voprf.seed");
                if p.exists() {
                    return Err(format!("{} exists", p.display()));
                }
                let mut s = [0u8; 32];
                rand_core::RngCore::fill_bytes(&mut OsRng, &mut s);
                std::fs::write(&p, hx(s) + "\n").map_err(|e| e.to_string())?;
                #[cfg(unix)]
                std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o600)).map_err(|e| e.to_string())?;
                Ok(public_key_hex(&server(&s)?))
            }
            Some("voprf-pub") if args.len() >= 2 => Ok(public_key_hex(&server(&seed_of(Path::new(&args[1]))?)?)),
            // voprf-nullifier <keys_dir> <requester> <context> <anchored_pk_hex> <out.json>: the buyer
            // blinds a fresh input, the evaluator evaluates once for (requester, context), the buyer
            // checks the proof under the anchored key and unblinds; then the public redemption record.
            // out.json (mode 600) keeps the input; stdout is the public record.
            Some("voprf-nullifier") if args.len() >= 6 => {
                let keys = Path::new(&args[1]);
                let (requester, context, pk) = (&args[2], &args[3], &args[4]);
                let x = fresh_input(context);
                let (state, blinded) = blind(&x)?;
                let (e, p) = evaluate_once(keys, requester, context, &blinded)?;
                let n = finalize(&state, &x, &e, &p, pk)?;
                let rd = redemption(&server(&seed_of(keys)?)?, &x)?;
                if rd.nullifier != n {
                    return Err("redemption and issuance disagree".into());
                }
                let out = serde_json::to_string_pretty(&rd).unwrap();
                std::fs::write(&args[5], out.clone() + "\n").map_err(|e| e.to_string())?;
                Ok(out)
            }
            // voprf-verify <redemption.json> <pk_hex>: anyone; no key.
            Some("voprf-verify") if args.len() >= 3 => {
                let rd: Redemption = serde_json::from_str(&std::fs::read_to_string(&args[1]).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                verify_redemption(&rd, &args[2])?;
                Ok(format!("PASS  VOPRF nullifier {}.. is F_k(x) under the anchored key {}..", &rd.nullifier[..12], &args[2][..12]))
            }
            _ => Err("usage: voprf-keygen <keys_dir> | voprf-pub <keys_dir> | voprf-nullifier <keys_dir> <requester> <context> <pk_hex> <out.json> | voprf-verify <redemption.json> <pk_hex>".into()),
        }
    })();
    match r {
        Ok(s) => {
            println!("{s}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("voprf: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEED: [u8; 32] = [7u8; 32];

    fn issue(s: &VoprfServer<Cs>, input: &[u8]) -> String {
        let (state, blinded) = blind(input).unwrap();
        let (e, p) = evaluate(s, &blinded).unwrap();
        finalize(&state, input, &e, &p, &public_key_hex(s)).unwrap()
    }

    #[test]
    fn blinded_issuance_equals_the_direct_evaluation() {
        let s = server(&SEED).unwrap();
        let x = fresh_input("bookerbob-demo");
        assert_eq!(issue(&s, &x), nullifier(&s.evaluate(&x).unwrap()));
    }

    #[test]
    fn the_evaluator_sees_a_different_blinded_element_each_time() {
        let x = fresh_input("bookerbob-demo");
        let (_, a) = blind(&x).unwrap();
        let (_, b) = blind(&x).unwrap();
        assert_ne!(a, b, "the same input blinds to unrelated elements");
    }

    #[test]
    fn another_key_fails_the_proof_check() {
        let s = server(&SEED).unwrap();
        let other = server(&[8u8; 32]).unwrap();
        let x = fresh_input("bookerbob-demo");
        let (state, blinded) = blind(&x).unwrap();
        let (e, p) = evaluate(&other, &blinded).unwrap();
        assert!(finalize(&state, &x, &e, &p, &public_key_hex(&s)).unwrap_err().contains("does not verify"));
    }

    #[test]
    fn a_redemption_record_verifies_and_a_tampered_one_does_not() {
        let s = server(&SEED).unwrap();
        let x = fresh_input("bookerbob-demo");
        let rd = redemption(&s, &x).unwrap();
        assert_eq!(rd.nullifier, issue(&s, &x));
        verify_redemption(&rd, &public_key_hex(&s)).unwrap();
        let mut bad = rd.clone();
        bad.nullifier = "00".repeat(32);
        assert!(verify_redemption(&bad, &public_key_hex(&s)).is_err());
        let mut other_input = rd.clone();
        other_input.input_hex = hx(fresh_input("bookerbob-demo"));
        assert!(verify_redemption(&other_input, &public_key_hex(&s)).is_err());
        assert!(verify_redemption(&rd, &public_key_hex(&server(&[9u8; 32]).unwrap())).is_err());
    }

    #[test]
    fn two_contexts_give_unrelated_nullifiers() {
        let s = server(&SEED).unwrap();
        let a = issue(&s, &fresh_input("context-a"));
        let b = issue(&s, &fresh_input("context-b"));
        assert_ne!(a, b);
    }
}
