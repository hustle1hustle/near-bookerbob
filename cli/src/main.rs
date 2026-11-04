//! `bookerbob` CLI.
//!
//!   bookerbob verify <fixtures-dir>         offline end-to-end, PASS/FAIL per link
//!   bookerbob gen-fixtures <dir> [--check]  write (or check) deterministic fixtures
//!
//! `verify` runs the real `bazaar` contract code natively against near-sdk's
//! MockedBlockchain, which executes host functions (ed25519_verify, p256_verify, sha256)
//! through nearcore's VM logic. No network, no keys.

mod fixtures;
mod verify;

use std::path::Path;
use std::process::ExitCode;

fn usage() -> ExitCode {
    eprintln!("usage: bookerbob verify <fixtures-dir> | bookerbob gen-fixtures <dir> [--check]");
    ExitCode::from(2)
}

fn gen_fixtures(dir: &Path, check: bool) -> ExitCode {
    let mut stale = Vec::new();
    for (name, body) in fixtures::all() {
        let path = dir.join(name);
        if check {
            if std::fs::read_to_string(&path).ok().as_deref() != Some(body.as_str()) {
                stale.push(name);
            }
        } else {
            std::fs::create_dir_all(dir).expect("create fixtures dir");
            std::fs::write(&path, body).expect("write fixture");
            println!("wrote {}", path.display());
        }
    }
    if check {
        if stale.is_empty() {
            println!("fixtures up to date");
        } else {
            eprintln!("stale fixtures (run `make fixtures`): {}", stale.join(", "));
            return ExitCode::FAILURE;
        }
    }
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("verify") => match args.get(1) {
            Some(d) => verify::run(Path::new(d)),
            None => usage(),
        },
        Some("gen-fixtures") => match args.get(1) {
            Some(d) => gen_fixtures(Path::new(d), args.iter().any(|a| a == "--check")),
            None => usage(),
        },
        _ => usage(),
    }
}
