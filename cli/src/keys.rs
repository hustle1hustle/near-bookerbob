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

/// The fixture purchase, re-signed with the live testnet keys for `make demo-live`.
/// Writes `verdict.json` (cnf = agent), `verdict-replay.json` (same nullifier, cnf = wallet2)
/// and `world.json` (World attestation for agent and action) into `out`. Only signed public
/// artifacts are written; seeds never leave `dir`.
pub fn sign_live(dir: &Path, agent: &str, wallet2: &str, action: &str, now_ms: u64, out: &Path) -> Result<(), String> {
    use ed25519_dalek::Signer;
    let issuer = load_seed(dir, "issuer")?;
    let world = load_seed(dir, "world")?;
    let sign = |agent: &str| {
        let mut e = crate::fixtures::envelope(agent);
        e.issued_at_ms = now_ms;
        e.expires_at_ms = now_ms + 7 * 24 * 3600 * 1000;
        let digest = e.digest();
        bookerbob_core::SignedVerdict {
            envelope: e,
            alg: bookerbob_core::SigAlg::Ed25519,
            issuer_key: hex::encode(issuer.verifying_key().to_bytes()),
            signature: hex::encode(issuer.sign(&digest).to_bytes()),
        }
    };
    let mut body = crate::fixtures::world_attestation(agent, "fixture-person-1").body;
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
    Ok(())
}

#[cfg(test)]
mod tests {
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
