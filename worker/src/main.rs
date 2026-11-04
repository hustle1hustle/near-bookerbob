//! OutLayer entry point: JSON input on stdin, signed JSON result on stdout.
//! The signing seed comes from the `REFEREE_SIGNING_SEED` secret (hex, 32 bytes).
use std::io::{Read, Write};

fn main() {
    let mut raw = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut raw) {
        fail(&format!("read stdin: {e}"));
    }
    let seed = std::env::var("REFEREE_SIGNING_SEED").unwrap_or_else(|_| fail("REFEREE_SIGNING_SEED not set"));
    let key = bookerbob_referee_worker::key_from_seed_hex(&seed).unwrap_or_else(|e| fail(&e));
    // A dispute input carries the contested `result`; anything else is a referee run.
    let mut value: serde_json::Value = serde_json::from_str(&raw).unwrap_or_else(|e| fail(&format!("bad input: {e}")));
    // Sealed input (the on-chain path): open it with the worker's key, check its commitment.
    if let Some(s) = value.get("sealed").cloned() {
        let sealed: bookerbob_referee_worker::sealed::SealedInput = serde_json::from_value(s).unwrap_or_else(|e| fail(&format!("bad sealed input: {e}")));
        let seed_bytes: [u8; 32] = hex::decode(seed.trim()).ok().and_then(|b| b.try_into().ok()).unwrap_or_else(|| fail("bad seed"));
        let pt = bookerbob_referee_worker::sealed::open(&sealed, &seed_bytes).unwrap_or_else(|e| fail(&e));
        value = serde_json::from_slice(&pt).unwrap_or_else(|e| fail(&format!("bad sealed plaintext: {e}")));
    }
    let out = if value.get("result").is_some() {
        let d: bookerbob_referee_worker::DisputeInput = serde_json::from_value(value).unwrap_or_else(|e| fail(&format!("bad dispute input: {e}")));
        bookerbob_referee_worker::arbitrate(&d, &key)
    } else {
        let input: bookerbob_referee_worker::WorkerInput = serde_json::from_value(value).unwrap_or_else(|e| fail(&format!("bad input: {e}")));
        bookerbob_referee_worker::run(&input, &key)
    };
    match out {
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
