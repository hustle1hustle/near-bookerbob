//! The evaluator as an OutLayer component: stdin JSON, stdout JSON. The logic is `src/lib.rs`;
//! this file binds it to OutLayer's `outlayer:signing-keys` host interface (ed25519, RFC 8032,
//! over the raw message). The keys are declared in `manifest.json`, all `caller: "none"` and
//! bound to the project: one evaluator key for every caller, the one `register_issuer` pins.

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!("bookerbob-eval-outlayer builds for wasm32-wasip2 only (tests: cargo test)");
    std::process::exit(2)
}

#[cfg(target_arch = "wasm32")]
fn main() {
    component::main()
}

#[cfg(target_arch = "wasm32")]
mod component {
    use std::io::{Read, Write};

    wit_bindgen::generate!({ world: "referee", path: "wit", generate_all });
    use outlayer::signing_keys::api as sig;

    /// The project manifest, in the custom section the OutLayer worker reads.
    #[used]
    #[link_section = "outlayer.manifest"]
    static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");

    struct Host;

    impl bookerbob_eval_outlayer::Keys for Host {
        fn public_key(&self, path: &str) -> Result<[u8; 32], String> {
            sig::public_key(path, None)?.try_into().map_err(|_| "host key is not 32 bytes".to_string())
        }
        fn sign(&self, path: &str, message: &[u8]) -> Result<[u8; 64], String> {
            sig::sign(path, None, message)?.try_into().map_err(|_| "host signature is not 64 bytes".to_string())
        }
    }

    pub fn main() {
        let mut raw = String::new();
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as u64);
        let out = match std::io::stdin().read_to_string(&mut raw) {
            Ok(_) => bookerbob_eval_outlayer::answer(&Host, &raw, now_ms),
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
