//! Testnet keys for the bazaar's trust anchors. Seeds are written to a directory outside
//! the repo (default ~/.rep-secrets/bookerbob-testnet), mode 600, never printed.
//! `keys <dir>` creates missing seeds and prints public keys; `keys <dir> --pub` only prints.
use std::io::Read;
use std::path::Path;
use std::process::ExitCode;

use ed25519_dalek::SigningKey;

pub const ROLES: [&str; 4] = ["issuer", "referee", "arbiter", "world"];

fn random_seed() -> [u8; 32] {
    let mut b = [0u8; 32];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).expect("read /dev/urandom");
    b
}

pub fn run(dir: &Path, pub_only: bool) -> ExitCode {
    let mut out = serde_json::Map::new();
    for role in ROLES {
        let path = dir.join(format!("{role}.seed"));
        if !path.exists() {
            if pub_only {
                eprintln!("missing {}", path.display());
                return ExitCode::FAILURE;
            }
            std::fs::create_dir_all(dir).expect("create keys dir");
            std::fs::write(&path, hex::encode(random_seed())).expect("write seed");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("chmod");
            }
        }
        let seed = std::fs::read_to_string(&path).expect("read seed");
        let seed: [u8; 32] = hex::decode(seed.trim()).expect("hex seed").try_into().expect("32 bytes");
        let pk = hex::encode(SigningKey::from_bytes(&seed).verifying_key().to_bytes());
        out.insert(role.into(), serde_json::Value::String(pk));
    }
    println!("{}", serde_json::Value::Object(out));
    ExitCode::SUCCESS
}

fn load_seed(dir: &Path, role: &str) -> Result<SigningKey, String> {
    let path = dir.join(format!("{role}.seed"));
    let hex_seed = std::fs::read_to_string(&path).map_err(|_| format!("missing {} (run `bookerbob keys {}` first)", path.display(), dir.display()))?;
    let seed: [u8; 32] = hex::decode(hex_seed.trim()).ok().and_then(|b| b.try_into().ok()).ok_or_else(|| format!("bad seed in {}", path.display()))?;
    Ok(SigningKey::from_bytes(&seed))
}

/// A standing score update for `submit_graph_scores`, signed by the referee (worker) seed:
/// recomputes the scores from the guest input's events (the same code the Jolt guest runs),
/// signs `sha256(TAG || program_hash || root || scores_hash)` and writes the call args.
/// The seed never leaves `dir`; only the public key and the signature are written.
/// As `graph_sign`, naming the Jolt proof file whose sha256 the update carries (the file a
/// challenger re-verifies). Without it the hash is of the input (tests only).
pub fn graph_sign_with_proof(dir: &Path, program_hash: &str, input: &Path, out: &Path, proof: Option<&Path>) -> Result<String, String> {
    use ed25519_dalek::Signer;
    use sha2::{Digest, Sha256};
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(input).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let ev: Vec<bookerbob_graph::Event> = v["events"]
        .as_array()
        .ok_or("no events")?
        .iter()
        .map(|e| {
            let b: Vec<u8> = e.as_array().into_iter().flatten().filter_map(|x| x.as_u64().map(|n| n as u8)).collect();
            bookerbob_graph::Event::from_bytes(&b).ok_or_else(|| "bad event".to_string())
        })
        .collect::<Result<_, _>>()?;
    let s = bookerbob_graph::compute(&ev);
    let ph: [u8; 32] = hex::decode(program_hash).ok().and_then(|b| b.try_into().ok()).ok_or("bad program hash")?;
    let mut msg = bookerbob_bazaar::GRAPH_UPDATE_TAG.to_vec();
    msg.extend(ph);
    msg.extend(s.root);
    msg.extend(s.hash());
    let worker = load_seed(dir, "referee")?;
    let sig = worker.sign(&Sha256::digest(&msg));
    let args = serde_json::json!({
        "program_hash": program_hash,
        "root": hex::encode(s.root),
        "merchants": s.merchants,
        "standing": s.standing.iter().map(|(a, x)| (a.clone(), x.to_string())).collect::<Vec<_>>(),
        "worker_key": hex::encode(worker.verifying_key().to_bytes()),
        "signature": hex::encode(sig.to_bytes()),
        "proof_sha256": hex::encode(Sha256::digest(std::fs::read(proof.unwrap_or(input)).map_err(|e| e.to_string())?)),
    });
    std::fs::write(out, serde_json::to_string_pretty(&args).unwrap() + "\n").map_err(|e| e.to_string())?;
    Ok(hex::encode(s.root))
}

/// The fixture purchase, re-signed with the live testnet keys for `make demo-live`.
/// Writes `verdict.json` (cnf = agent), `verdict-replay.json` (same nullifier, cnf = wallet2)
/// and `world.json` (World attestation for agent and action) into `out`. Only signed public
/// artifacts are written; seeds never leave `dir`.
pub fn sign_live(dir: &Path, agent: &str, wallet2: &str, action: &str, now_ms: u64, out: &Path) -> Result<(), String> {
    sign_purchase(dir, agent, wallet2, action, now_ms, out, None, "fixture-person-1")
}

/// The arbiter's signed resolution of a challenged graph update: `valid` after the Jolt
/// verifier ran on the proof with sha256 `proof_sha256` (`make zk-verify`). Prints the
/// `resolve_graph_challenge` args; the arbiter seed stays in `dir`.
pub fn graph_resolve(dir: &Path, root: &str, scores_hash: &str, proof_sha256: &str, valid: bool) -> Result<serde_json::Value, String> {
    use ed25519_dalek::Signer;
    use sha2::{Digest, Sha256};
    let mut msg = bookerbob_bazaar::GRAPH_CHALLENGE_TAG.to_vec();
    msg.extend(serde_json::to_vec(&(root, scores_hash, proof_sha256, valid)).map_err(|e| e.to_string())?);
    let k = load_seed(dir, "arbiter")?;
    Ok(serde_json::json!({
        "proof_sha256": proof_sha256,
        "valid": valid,
        "arbiter_key": hex::encode(k.verifying_key().to_bytes()),
        "signature": hex::encode(k.sign(&Sha256::digest(&msg)).to_bytes()),
    }))
}

/// A demo tester's purchase (`make demo-tester`): the same fixture facts, but a nullifier and
/// a World person of its own (derived from the tester account), so each tester is a new buyer.
/// `replay` gets the same nullifier, for the "nullifier spent" check.
/// The device run's purchase: as `sign_tester`, over a proof set read from `proofs` (the
/// fixture set with the real fact from a notary-signed presentation in it).
pub fn sign_real(dir: &Path, agent: &str, replay: &str, action: &str, now_ms: u64, out: &Path, proofs: &Path) -> Result<String, String> {
    sign_real_as(dir, agent, replay, action, now_ms, out, proofs, false)
}

/// `sign_real`, sealed: the verdict on chain carries hashes only (no predicates, tier or cap);
/// `opening.json` (mode 600) holds what it hides, for the referee and the chosen merchant.
pub fn sign_real_sealed(dir: &Path, agent: &str, replay: &str, action: &str, now_ms: u64, out: &Path, proofs: &Path) -> Result<String, String> {
    sign_real_as(dir, agent, replay, action, now_ms, out, proofs, true)
}

#[allow(clippy::too_many_arguments)]
fn sign_real_as(dir: &Path, agent: &str, replay: &str, action: &str, now_ms: u64, out: &Path, proofs: &Path, seal: bool) -> Result<String, String> {
    let set: bookerbob_core::ProofSet = serde_json::from_str(&std::fs::read_to_string(proofs).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let n = crate::fixtures::nullifier(&format!("device-run|{agent}"));
    sign_purchase_inner(dir, agent, replay, action, now_ms, out, Some(n.clone()), &format!("device-run|{agent}"), Some(&set), seal)?;
    Ok(n)
}

/// Turn an ordinary envelope into a sealed one; returns the opening it commits to.
pub fn seal(e: &mut bookerbob_core::Envelope, salt: [u8; 32]) -> bookerbob_core::Opening {
    let o = bookerbob_core::Opening {
        predicates: std::mem::take(&mut e.predicates),
        tier: std::mem::take(&mut e.tier),
        max_spend: e.max_spend,
        salt: hex::encode(salt),
    };
    e.tier = bookerbob_core::SEALED_TIER.into();
    e.max_spend = 0;
    e.disclosure = Some(o.commitment());
    o
}

pub fn sign_tester(dir: &Path, agent: &str, replay: &str, action: &str, now_ms: u64, out: &Path) -> Result<String, String> {
    let n = crate::fixtures::nullifier(&format!("demo-tester|{agent}"));
    sign_purchase(dir, agent, replay, action, now_ms, out, Some(n.clone()), &format!("demo-tester|{agent}"))?;
    Ok(n)
}

#[allow(clippy::too_many_arguments)]
fn sign_purchase(dir: &Path, agent: &str, wallet2: &str, action: &str, now_ms: u64, out: &Path, nullifier: Option<String>, person: &str) -> Result<(), String> {
    sign_purchase_over(dir, agent, wallet2, action, now_ms, out, nullifier, person, None)
}

#[allow(clippy::too_many_arguments)]
fn sign_purchase_over(
    dir: &Path,
    agent: &str,
    wallet2: &str,
    action: &str,
    now_ms: u64,
    out: &Path,
    nullifier: Option<String>,
    person: &str,
    set: Option<&bookerbob_core::ProofSet>,
) -> Result<(), String> {
    sign_purchase_inner(dir, agent, wallet2, action, now_ms, out, nullifier, person, set, false)
}

#[allow(clippy::too_many_arguments)]
fn sign_purchase_inner(
    dir: &Path,
    agent: &str,
    wallet2: &str,
    action: &str,
    now_ms: u64,
    out: &Path,
    nullifier: Option<String>,
    person: &str,
    set: Option<&bookerbob_core::ProofSet>,
    sealed: bool,
) -> Result<(), String> {
    use ed25519_dalek::Signer;
    let salt: [u8; 32] = rand_salt()?;
    let opening = std::cell::RefCell::new(None);
    let issuer = load_seed(dir, "issuer")?;
    let world = load_seed(dir, "world")?;
    let sign = |agent: &str| {
        let mut e = match set {
            Some(p) => crate::fixtures::envelope_over(agent, p),
            None => crate::fixtures::envelope(agent),
        };
        if let Some(n) = &nullifier {
            e.nullifier = n.clone();
        }
        e.issued_at_ms = now_ms;
        e.expires_at_ms = now_ms + 7 * 24 * 3600 * 1000;
        if sealed {
            *opening.borrow_mut() = Some(seal(&mut e, salt));
        }
        let digest = e.digest();
        bookerbob_core::SignedVerdict {
            envelope: e,
            alg: bookerbob_core::SigAlg::Ed25519,
            issuer_key: hex::encode(issuer.verifying_key().to_bytes()),
            signature: hex::encode(issuer.sign(&digest).to_bytes()),
        }
    };
    let mut body = crate::fixtures::world_attestation(agent, person).body;
    body.action = action.into();
    body.issued_at_ms = now_ms;
    let att = bookerbob_core::WorldAttestation {
        verifier_key: hex::encode(world.verifying_key().to_bytes()),
        signature: hex::encode(world.sign(&body.signing_message()).to_bytes()),
        body,
    };
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    let write = |name: &str, v: String| std::fs::write(out.join(name), v + "\n").map_err(|e| e.to_string());
    write("verdict.json", serde_json::to_string_pretty(&sign(agent)).unwrap())?;
    write("verdict-replay.json", serde_json::to_string_pretty(&sign(wallet2)).unwrap())?;
    write("world.json", serde_json::to_string_pretty(&att).unwrap())?;
    if let Some(o) = opening.into_inner() {
        let p = out.join("opening.json");
        write("opening.json", serde_json::to_string_pretty(&o).unwrap())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 32 bytes from the OS (the opening's salt hides a small predicate set from guessing).
fn rand_salt() -> Result<[u8; 32], String> {
    use std::io::Read;
    let mut b = [0u8; 32];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).map_err(|e| format!("urandom: {e}"))?;
    Ok(b)
}

#[cfg(test)]
mod tests {
    #[test]
    fn graph_sign_signs_the_contract_message() {
        use ed25519_dalek::{Signature, Verifier, VerifyingKey};
        use sha2::{Digest, Sha256};
        let dir = std::env::temp_dir().join(format!("bookerbob-graph-sign-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(super::run(&dir, false), std::process::ExitCode::SUCCESS);
        let ev = vec![bookerbob_graph::Event::Hire { agent: "a.testnet".into(), sub: "b.testnet".into() }];
        let input = dir.join("in.json");
        let bytes: Vec<Vec<u8>> = ev.iter().map(|e| e.bytes()).collect();
        std::fs::write(&input, serde_json::json!({ "events": bytes }).to_string()).unwrap();
        let ph = "11".repeat(32);
        let out = dir.join("args.json");
        let root = super::graph_sign_with_proof(&dir, &ph, &input, &out, None).unwrap();
        let s = bookerbob_graph::compute(&ev);
        assert_eq!(root, hex::encode(s.root));
        let a: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        let mut msg = bookerbob_bazaar::GRAPH_UPDATE_TAG.to_vec();
        msg.extend(hex::decode(&ph).unwrap());
        msg.extend(s.root);
        msg.extend(s.hash());
        let pk = VerifyingKey::from_bytes(&hex::decode(a["worker_key"].as_str().unwrap()).unwrap().try_into().unwrap()).unwrap();
        let sig = Signature::from_bytes(&hex::decode(a["signature"].as_str().unwrap()).unwrap().try_into().unwrap());
        assert!(pk.verify(&Sha256::digest(&msg), &sig).is_ok());
        assert!(super::graph_sign_with_proof(&dir, "zz", &input, &out, None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sign_tester_gives_each_tester_its_own_nullifier_and_person() {
        let dir = std::env::temp_dir().join(format!("bookerbob-tester-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(super::run(&dir, false), std::process::ExitCode::SUCCESS);
        let (a, b) = (dir.join("a"), dir.join("b"));
        let na = super::sign_tester(&dir, "t-000001.demo.testnet", "demo.testnet", "act", 1_000, &a).unwrap();
        let nb = super::sign_tester(&dir, "t-000002.demo.testnet", "demo.testnet", "act", 1_000, &b).unwrap();
        assert_ne!(na, nb);
        let load = |p: &std::path::Path, f: &str| -> serde_json::Value { serde_json::from_str(&std::fs::read_to_string(p.join(f)).unwrap()).unwrap() };
        assert_eq!(load(&a, "verdict.json")["envelope"]["nullifier"], na.as_str());
        assert_eq!(load(&a, "verdict-replay.json")["envelope"]["nullifier"], na.as_str());
        assert_eq!(load(&a, "verdict-replay.json")["envelope"]["cnf"], "demo.testnet");
        assert_ne!(load(&a, "world.json")["body"]["world_nullifier"], load(&b, "world.json")["body"]["world_nullifier"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sign_live_verifies_with_the_seed_keys() {
        let dir = std::env::temp_dir().join(format!("bookerbob-keys-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(super::run(&dir, false), std::process::ExitCode::SUCCESS);
        let out = dir.join("live");
        super::sign_live(&dir, "agent.x.testnet", "wallet2.x.testnet", "act", 1_000, &out).unwrap();
        let v: bookerbob_core::SignedVerdict = serde_json::from_str(&std::fs::read_to_string(out.join("verdict.json")).unwrap()).unwrap();
        let r: bookerbob_core::SignedVerdict = serde_json::from_str(&std::fs::read_to_string(out.join("verdict-replay.json")).unwrap()).unwrap();
        let w: bookerbob_core::WorldAttestation = serde_json::from_str(&std::fs::read_to_string(out.join("world.json")).unwrap()).unwrap();
        use ed25519_dalek::{Signature, Verifier, VerifyingKey};
        let pk = |h: &str| VerifyingKey::from_bytes(&hex::decode(h).unwrap().try_into().unwrap()).unwrap();
        let sig = |h: &str| Signature::from_bytes(&hex::decode(h).unwrap().try_into().unwrap());
        assert!(pk(&v.issuer_key).verify(&v.envelope.digest(), &sig(&v.signature)).is_ok());
        assert_eq!((v.envelope.cnf.as_str(), r.envelope.cnf.as_str()), ("agent.x.testnet", "wallet2.x.testnet"));
        assert_eq!(v.envelope.nullifier, r.envelope.nullifier);
        assert_eq!(v.envelope.expires_at_ms, 1_000 + 7 * 24 * 3600 * 1000);
        assert!(pk(&w.verifier_key).verify(&w.body.signing_message(), &sig(&w.signature)).is_ok());
        assert_eq!((w.body.agent.as_str(), w.body.action.as_str()), ("agent.x.testnet", "act"));
        assert!(!std::fs::read_to_string(out.join("verdict.json")).unwrap().contains(&std::fs::read_to_string(dir.join("issuer.seed")).unwrap()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
