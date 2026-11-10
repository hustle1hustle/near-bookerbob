//! The referee worker as an OutLayer component: JSON on stdin, JSON on stdout, like the native
//! binary (`worker/src/main.rs`), with two differences.
//!
//! 1. It holds no key. A result is signed by `outlayer:signing-keys` `sign("referee", none, msg)`:
//!    ed25519 (RFC 8032) over the raw message, the check `submit_referee_result` runs with
//!    `env::ed25519_verify`. The key is declared in `manifest.json` (`caller: "none"`, bound to
//!    the project): one key for every caller, the one `register_referee` pins. A dispute is
//!    signed by the second key, `arbiter`.
//! 2. A sealed input (`{"sealed": ..}`, `worker/src/sealed.rs`) is opened with a seed the module
//!    gets from `outlayer:encryption-keys` `mac("sealed-input", none, SEAL_SEED_LABEL)`: 32 bytes
//!    the keystore derives inside the TEE for this project and the account that called OutLayer
//!    (`caller: "predecessor"`: the bazaar on `request_referee`). The X25519 and ML-KEM-768 keys
//!    come from that seed exactly as the native worker derives them from `REFEREE_SIGNING_SEED`.
//!
//! Commands: `{"cmd":"pubkey"}` (the keys, signed by the referee key) and `{"cmd":"sealkey"}`
//! (the full `pq1:` key a buyer seals to). The module signs only messages it composes under its
//! own fixed prefixes, never bytes taken from the input.
//!
//! Interface: `wit/` (copies of fastnear/near-outlayer `worker/wit/deps/` at e954d4a). Not run
//! on OutLayer yet: `make outlayer-local` runs this component in wasmtime with a mock host.

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!("bookerbob-referee-outlayer builds for wasm32-wasip2 only (the native worker is bookerbob-referee)");
    std::process::exit(2)
}

#[cfg(target_arch = "wasm32")]
fn main() {
    component::main()
}

#[cfg(target_arch = "wasm32")]
mod component {
    use bookerbob_referee_worker::{sealed, DisputeInput, ResultSigner, WorkerInput};
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};

    wit_bindgen::generate!({ world: "referee", path: "wit", generate_all });
    use outlayer::encryption_keys::api as enc;
    use outlayer::signing_keys::api as sig;

    /// The project manifest, in the custom section the OutLayer worker reads (and the wasm's
    /// sha256 covers): which keys this module may ask the host for.
    #[used]
    #[link_section = "outlayer.manifest"]
    static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");

    const REFEREE: &str = "referee";
    const ARBITER: &str = "arbiter";
    const SEAL: &str = "sealed-input";
    const SEAL_SEED_LABEL: &[u8] = b"bookerbob/referee-seal-seed/v1";
    const KEYS_TAG: &[u8] = b"bookerbob/referee-keys/v0\x00";

    /// A declared host key, named by its manifest path.
    struct HostKey(&'static str);

    impl ResultSigner for HostKey {
        fn result_key(&self) -> Result<[u8; 32], String> {
            sig::public_key(self.0, None)?.try_into().map_err(|_| "host key is not a 32-byte ed25519 key".to_string())
        }
        fn sign_result(&self, message: &[u8]) -> Result<[u8; 64], String> {
            sig::sign(self.0, None, message)?.try_into().map_err(|_| "host signature is not 64 bytes".to_string())
        }
    }

    /// The seed of the sealed-input keys: never printed, never signed.
    fn seal_seed() -> Result<[u8; 32], String> {
        enc::mac(SEAL, None, SEAL_SEED_LABEL)?.try_into().map_err(|_| "host mac is not 32 bytes".to_string())
    }

    fn keys() -> Result<String, String> {
        let pq1 = sealed::public_hex_v1(&seal_seed()?);
        let body = serde_json::json!({
            "referee_key": hex::encode(HostKey(REFEREE).result_key()?),
            "arbiter_key": hex::encode(HostKey(ARBITER).result_key()?),
            "seal_x25519": sealed::public_hex(&seal_seed()?),
            "seal_pq1_sha256": hex::encode(Sha256::digest(pq1.as_bytes())),
            // Whom the seal key belongs to: the account that called OutLayer, from the host.
            "seal_for": std::env::var("NEAR_PREDECESSOR_ID").unwrap_or_default(),
        });
        let mut msg = KEYS_TAG.to_vec();
        msg.extend(serde_json::to_vec(&body).expect("serializes"));
        let signature = hex::encode(HostKey(REFEREE).sign_result(&msg)?);
        Ok(serde_json::json!({ "keys": body, "signature": signature }).to_string())
    }

    fn answer(raw: &str) -> Result<String, String> {
        let mut value: serde_json::Value = serde_json::from_str(raw).map_err(|e| format!("bad input: {e}"))?;
        match value.get("cmd").and_then(|c| c.as_str()) {
            Some("pubkey") => return keys(),
            Some("sealkey") => return Ok(serde_json::json!({ "seal_key": sealed::public_hex_v1(&seal_seed()?) }).to_string()),
            Some(other) => return Err(format!("unknown cmd {other:?}")),
            None => {}
        }
        if let Some(s) = value.get("sealed").cloned() {
            // `request_referee` lets only sealed-shaped input through, so the key a buyer seals
            // to is asked for in that shape as well: a one-byte `ct` cannot be a ciphertext.
            if s["ct"].as_str() == Some("00") {
                return Ok(serde_json::json!({ "seal_key": sealed::public_hex_v1(&seal_seed()?) }).to_string());
            }
            let s: sealed::SealedInput = serde_json::from_value(s).map_err(|e| format!("bad sealed input: {e}"))?;
            let pt = sealed::open(&s, &seal_seed()?)?;
            value = serde_json::from_slice(&pt).map_err(|e| format!("bad sealed plaintext: {e}"))?;
        }
        // A dispute input carries the contested `result`; anything else is a referee run.
        if value.get("result").is_some() {
            let d: DisputeInput = serde_json::from_value(value).map_err(|e| format!("bad dispute input: {e}"))?;
            bookerbob_referee_worker::arbitrate_with(&d, &HostKey(ARBITER))
        } else {
            let input: WorkerInput = serde_json::from_value(value).map_err(|e| format!("bad input: {e}"))?;
            bookerbob_referee_worker::run_with(&input, &HostKey(REFEREE))
        }
    }

    pub fn main() {
        let mut raw = String::new();
        let out = match std::io::stdin().read_to_string(&mut raw) {
            Ok(_) => answer(&raw),
            Err(e) => Err(format!("read stdin: {e}")),
        };
        let mut stdout = std::io::stdout();
        match out {
            Ok(out) => {
                let _ = stdout.write_all(out.as_bytes());
                let _ = stdout.flush();
            }
            Err(e) => {
                let _ = stdout.write_all(serde_json::json!({ "error": e }).to_string().as_bytes());
                let _ = stdout.flush();
                std::process::exit(1)
            }
        }
    }
}
