//! vecgate runner protocol (one JSON line in, one out). For coalition-k-of-n it runs BOTH the
//! dialect and the original body.rs and aborts on any difference in bytes or refusal string;
//! it answers with the dialect's result, so vecgate.mjs then also compares dialect vs Lean.
use std::io::BufRead;
fn main() {
    let mut n = 0u64;
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("stdin");
        if line.trim().is_empty() { continue }
        let v: serde_json::Value = serde_json::from_str(&line).expect("json");
        let public = hex::decode(v["public"].as_str().unwrap_or("")).expect("hex");
        let private = hex::decode(v["private"].as_str().unwrap_or("")).expect("hex");
        let d = dialect::run(&public, &private);
        let o = original::run(&public, &private);
        if d != o { eprintln!("DIALECT DIFFERS: dialect {:?} original {:?} on {}", d, o, line); std::process::exit(3) }
        n += 1;
        println!("{}", match d {
            Ok(out) => serde_json::json!({ "ok": hex::encode(out) }),
            Err(e) => serde_json::json!({ "refuse": e }),
        });
    }
    eprintln!("gap-runner: dialect == original on {} inputs", n);
}
