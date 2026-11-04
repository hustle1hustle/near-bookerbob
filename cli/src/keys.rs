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
