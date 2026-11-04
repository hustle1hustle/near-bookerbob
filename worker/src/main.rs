//! OutLayer entry point: JSON input on stdin, signed JSON result on stdout.
//! The signing seed comes from the `REFEREE_SIGNING_SEED` secret (hex, 32 bytes).
use std::io::{Read, Write};

fn main() {
    let mut raw = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut raw) {
        fail(&format!("read stdin: {e}"));
    }
    let input: bookerbob_referee_worker::WorkerInput = match serde_json::from_str(&raw) {
        Ok(i) => i,
        Err(e) => fail(&format!("bad input: {e}")),
    };
    let seed = std::env::var("REFEREE_SIGNING_SEED").unwrap_or_else(|_| fail("REFEREE_SIGNING_SEED not set"));
    let key = bookerbob_referee_worker::key_from_seed_hex(&seed).unwrap_or_else(|e| fail(&e));
    match bookerbob_referee_worker::run(&input, &key) {
        Ok(out) => {
            let _ = std::io::stdout().write_all(out.as_bytes());
        }
        Err(e) => fail(&e),
    }
}

fn fail(msg: &str) -> ! {
    let _ = std::io::stdout().write_all(serde_json::json!({ "error": msg }).to_string().as_bytes());
    std::process::exit(1)
}
