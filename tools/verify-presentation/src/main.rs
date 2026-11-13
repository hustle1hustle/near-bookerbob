//! verify-presentation <file> <notary_pubkey_hex>
//! Deserializes a TLSNotary presentation, checks the notary's signature and the server's
//! certificate chain (Mozilla roots), checks the notary key equals the pinned one, and prints the
//! server, the time and the revealed bytes (undisclosed bytes shown as X) as JSON.
use std::process::ExitCode;
use tlsn::attestation::{presentation::{Presentation, PresentationOutput}, CryptoProvider};
use tlsn::connection::ServerName;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 { eprintln!("usage: verify-presentation <file> <notary_pubkey_hex>"); return ExitCode::from(2); }
    let bytes = match std::fs::read(&args[1]) { Ok(b) => b, Err(e) => { eprintln!("read: {e}"); return ExitCode::from(2); } };
    let p: Presentation = match bincode::deserialize(&bytes) { Ok(p) => p, Err(e) => { eprintln!("not a presentation: {e}"); return ExitCode::from(1); } };
    let key = hex::encode(&p.verifying_key().data);
    let key_matches = key.eq_ignore_ascii_case(args[2].trim());
    let PresentationOutput { server_name, connection_info, transcript, .. } = match p.verify(&CryptoProvider::default()) {
        Ok(o) => o,
        Err(e) => { eprintln!("presentation does not verify: {e}"); return ExitCode::from(1); }
    };
    let server = match server_name { Some(ServerName::Dns(d)) => d.as_str().to_string(), _ => String::new() };
    let (sent, recv) = match transcript {
        Some(mut t) => { t.set_unauthed(b'X'); (String::from_utf8_lossy(t.sent_unsafe()).to_string(), String::from_utf8_lossy(t.received_unsafe()).to_string()) }
        None => (String::new(), String::new()),
    };
    println!("{}", serde_json::json!({ "verified": true, "notary_key": key, "key_matches": key_matches, "server_name": server, "time_secs": connection_info.time, "sent": sent, "recv": recv }));
    if key_matches { ExitCode::SUCCESS } else { eprintln!("the notary key is not the pinned one"); ExitCode::from(1) }
}
