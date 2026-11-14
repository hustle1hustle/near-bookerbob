//! Layer 2 (the v1 transcript policy) on constructed transcripts, one per audited attack, and
//! layer 3 (the verdict) for nullifier and linkability. Layer 1 (TLSNotary) is upstream code,
//! tested on the real presentations in real.rs: these transcripts stand for what it outputs.
use bookerbob_core::envelope::SignedVerdict;
use bookerbob_eval_outlayer::*;
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};

struct Mock;
fn key(path: &str) -> SigningKey {
    SigningKey::from_bytes(&Sha256::digest(format!("MOCK outlayer signing key|{path}")).into())
}
impl Keys for Mock {
    fn public_key(&self, p: &str) -> Result<[u8; 32], String> {
        Ok(key(p).verifying_key().to_bytes())
    }
    fn sign(&self, p: &str, m: &[u8]) -> Result<[u8; 64], String> {
        Ok(key(p).sign(m).to_bytes())
    }
}

const CTX: &str = "bookerbob:v0:evaltee-github";
const T: u64 = 1_794_650_000;

/// Segments: (bytes, revealed).
fn parts(segs: &[(&str, bool)]) -> (Vec<u8>, Vec<bool>) {
    let mut d = Vec::new();
    let mut m = Vec::new();
    for (s, r) in segs {
        d.extend_from_slice(s.as_bytes());
        m.extend(std::iter::repeat(*r).take(s.len()));
    }
    (d, m)
}

fn body(id: u64, created: &str) -> String {
    format!(r#"{{"login":"someone","id":{id},"node_id":"MDQ6","name":"x \"id\": 1","created_at":"{created}","plan":{{"name":"free"}}}}"#)
}
fn response(b: &str) -> String {
    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\n\r\n{b}", b.len())
}
fn request(bind: &str) -> String {
    format!("GET /user?bb={bind} HTTP/1.1\r\nHost: api.github.com\r\nAccept: application/json\r\nAuthorization: ")
}

fn honest(cnf: &str, id: u64, created: &str) -> Transcript {
    let (sent, sent_rev) = parts(&[(&request(&binding(cnf, CTX)), true), ("token ghp_SECRET", false), ("\r\n\r\n", true)]);
    let (recv, recv_rev) = parts(&[(&response(&body(id, created)), true)]);
    Transcript { server: "api.github.com".into(), time_secs: T, sent, sent_rev, recv, recv_rev }
}

fn check(t: &Transcript, cnf: &str) -> Result<Account, &'static str> {
    check_transcript(t, &binding(cnf, CTX), T + 60)
}

#[test]
fn honest_signed_in_read_gives_the_account() {
    let a = check(&honest("buyer.testnet", 583231, "2011-01-25T18:44:36Z"), "buyer.testnet").unwrap();
    assert_eq!(a, Account { id: 583231, created_secs: parse_utc(b"2011-01-25T18:44:36Z").unwrap(), time_secs: T });
}

#[test]
fn a_partly_hidden_body_is_refused() {
    let b = body(7, "2011-01-25T18:44:36Z");
    let mut t = honest("buyer.testnet", 7, "2011-01-25T18:44:36Z");
    let k = t.recv.len() - b.len() + b.find("someone").unwrap();
    t.recv_rev[k] = false;
    assert_eq!(check(&t, "buyer.testnet"), Err("response body not fully revealed"));
}

#[test]
fn a_nested_or_duplicate_id_is_not_the_account() {
    // A nested "id" (in plan) does not count; the top-level one does.
    let b = r#"{"login":"x","plan":{"id":1024025,"created_at":"2011-09-03T15:26:22Z"},"id":5,"created_at":"2024-09-18T13:33:41Z"}"#;
    let mut t = honest("buyer.testnet", 5, "2024-09-18T13:33:41Z");
    let (r, rr) = parts(&[(&response(b), true)]);
    t.recv = r;
    t.recv_rev = rr;
    assert_eq!(check(&t, "buyer.testnet").unwrap().id, 5);
    // A duplicate top-level key is refused, whichever comes last.
    let b = r#"{"id":5,"id":1024025,"created_at":"2024-09-18T13:33:41Z"}"#;
    let (r, rr) = parts(&[(&response(b), true)]);
    t.recv = r;
    t.recv_rev = rr;
    assert_eq!(check(&t, "buyer.testnet"), Err("response body is not one JSON object"));
    // Only a nested id: no account.
    let b = r#"{"plan":{"id":1024025},"created_at":"2024-09-18T13:33:41Z"}"#;
    let (r, rr) = parts(&[(&response(b), true)]);
    t.recv = r;
    t.recv_rev = rr;
    assert_eq!(check(&t, "buyer.testnet"), Err("bad id"));
}

/// CRIT 1: GET /user, then a second request hidden inside the Authorization range, revealing only
/// the first status line and the second answer's created_at and id.
#[test]
fn pipelined_second_request_is_refused() {
    let own = response(&body(1, "2024-09-18T13:33:41Z"));
    let victim = response(&body(1024025, "2011-09-03T15:26:22Z"));
    let (sent, sent_rev) = parts(&[
        (&request(&binding("buyer.testnet", CTX)), true),
        ("token ghp_SECRET\r\n\r\nGET /users/torvalds HTTP/1.1\r\nHost: api.github.com\r\nX-Pad: y", false),
        ("\r\n\r\n", true),
    ]);
    // The audit's shape: first status line revealed, the rest of the first answer hidden.
    let (recv, recv_rev) = parts(&[("HTTP/1.1 200 OK\r\n", true), (&own["HTTP/1.1 200 OK\r\n".len()..], false), (&victim, true)]);
    let t = Transcript { server: "api.github.com".into(), time_secs: T, sent: sent.clone(), sent_rev: sent_rev.clone(), recv, recv_rev };
    assert_eq!(check(&t, "buyer.testnet"), Err("response head not fully revealed"));
    // The first answer's head revealed too, its body hidden: the second answer's fields are
    // outside the first body, so nothing is read.
    let (recv, mut recv_rev) = parts(&[(&own, true), (&victim, true)]);
    let ob = own.len() - body(1, "2024-09-18T13:33:41Z").len();
    for r in recv_rev.iter_mut().take(own.len()).skip(ob) {
        *r = false;
    }
    let t = Transcript { server: "api.github.com".into(), time_secs: T, sent, sent_rev, recv, recv_rev };
    assert_eq!(check(&t, "buyer.testnet"), Err("response body not fully revealed"));
    // Fully revealed, the account read is the first answer's: the requester's own.
    let mut t2 = t.clone();
    t2.recv_rev.iter_mut().for_each(|r| *r = true);
    assert_eq!(check(&t2, "buyer.testnet").unwrap().id, 1);
}

#[test]
fn a_revealed_second_request_is_refused() {
    let mut t = honest("buyer.testnet", 1, "2024-09-18T13:33:41Z");
    let (s, r) = parts(&[(&request(&binding("buyer.testnet", CTX)), true), ("token ghp_SECRET", false), ("\r\n\r\nGET /users/torvalds HTTP/1.1\r\n\r\n", true)]);
    t.sent = s;
    t.sent_rev = r;
    assert_eq!(check(&t, "buyer.testnet"), Err("not exactly one request"));
}

#[test]
fn hiding_anything_but_the_authorization_value_is_refused() {
    let mut t = honest("buyer.testnet", 1, "2024-09-18T13:33:41Z");
    let host = t.sent.windows(4).position(|w| w == b"Host").unwrap();
    t.sent_rev[host] = false;
    assert_eq!(check(&t, "buyer.testnet"), Err("request hides more than the Authorization value"));
    // Hidden range inside a header other than Authorization, as the last header.
    let (s, r) = parts(&[(&format!("GET /user?bb={} HTTP/1.1\r\nHost: api.github.com\r\nX-Other: ", binding("buyer.testnet", CTX)), true), ("v", false), ("\r\n\r\n", true)]);
    let mut t = honest("buyer.testnet", 1, "2024-09-18T13:33:41Z");
    t.sent = s;
    t.sent_rev = r;
    assert_eq!(check(&t, "buyer.testnet"), Err("request hides more than the Authorization value"));
}

/// HIGH 2: the committed presentation replayed by another agent, or in another context.
#[test]
fn replay_under_another_agent_or_context_is_refused() {
    let t = honest("buyer.testnet", 1, "2024-09-18T13:33:41Z");
    assert_eq!(check(&t, "thief.testnet"), Err("request is not GET /user bound to this agent and context"));
    assert_eq!(check_transcript(&t, &binding("buyer.testnet", "bookerbob:v0:demo-hoodie"), T + 60), Err("request is not GET /user bound to this agent and context"));
}

#[test]
fn stale_or_future_sessions_are_refused() {
    let t = honest("buyer.testnet", 1, "2024-09-18T13:33:41Z");
    let b = binding("buyer.testnet", CTX);
    assert_eq!(check_transcript(&t, &b, T + MAX_SESSION_AGE_SECS + 1), Err("session not fresh"));
    assert_eq!(check_transcript(&t, &b, T - CLOCK_SKEW_SECS - 1), Err("session not fresh"));
    assert!(check_transcript(&t, &b, T + MAX_SESSION_AGE_SECS).is_ok());
}

#[test]
fn chunked_or_encoded_or_unbounded_bodies_are_refused() {
    let b = body(1, "2024-09-18T13:33:41Z");
    for (head, why) in [
        (format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: {}\r\n\r\n", b.len()), "encoded response body"),
        (format!("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\n\r\n", b.len()), "encoded response body"),
        ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n".to_string(), "no Content-Length"),
        (format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Length: 5\r\n\r\n", b.len()), "bad Content-Length"),
        (format!("HTTP/1.1 401 Unauthorized\r\nContent-Length: {}\r\n\r\n", b.len()), "GitHub did not answer 200 OK"),
    ] {
        let mut t = honest("buyer.testnet", 1, "2024-09-18T13:33:41Z");
        let (r, rr) = parts(&[(&format!("{head}{b}"), true)]);
        t.recv = r;
        t.recv_rev = rr;
        assert_eq!(check(&t, "buyer.testnet"), Err(why));
    }
}

#[test]
fn fields_outside_the_first_body_do_not_count() {
    // Content-Length shorter than the body: id and created_at fall outside it.
    let b = body(1, "2024-09-18T13:33:41Z");
    let mut t = honest("buyer.testnet", 1, "2024-09-18T13:33:41Z");
    let (r, rr) = parts(&[(&format!("HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\n{b}"), true)]);
    t.recv = r;
    t.recv_rev = rr;
    assert_eq!(check(&t, "buyer.testnet"), Err("response body is not one JSON object"));
}

#[test]
fn another_server_is_refused() {
    let mut t = honest("buyer.testnet", 1, "2024-09-18T13:33:41Z");
    t.server = "evil.example".into();
    assert_eq!(check(&t, "buyer.testnet"), Err("not api.github.com"));
}

fn input(cnf: &str, ctx: &str, salt: u8, preds: &[&str]) -> EvalInput {
    EvalInput { context: ctx.into(), cnf: cnf.into(), max_spend: 1, ttl_ms: 60_000, predicates: preds.iter().map(|s| s.to_string()).collect(), salt: hex::encode([salt; 32]), presentations: vec![] }
}
fn verdict(i: &EvalInput, id: u64, created: &str) -> SignedVerdict {
    let a = Account { id, created_secs: parse_utc(created.as_bytes()).unwrap(), time_secs: T };
    serde_json::from_str(&evaluate_account(&Mock, i, &a, &"ab".repeat(32), T * 1000).unwrap()).unwrap()
}

/// HIGH 3: the nullifier is the account id's, per context, whichever agent asks.
#[test]
fn one_account_id_one_nullifier_per_context() {
    let a = verdict(&input("a.testnet", CTX, 1, &[]), 42, "2024-09-18T13:33:41Z").envelope;
    let b = verdict(&input("b.testnet", CTX, 2, &[]), 42, "2024-09-18T13:33:41Z").envelope;
    let same_second = verdict(&input("a.testnet", CTX, 1, &[]), 43, "2024-09-18T13:33:41Z").envelope;
    assert_eq!(a.nullifier, b.nullifier, "a second agent with the same account gets the same nullifier");
    assert_ne!(a.nullifier, same_second.nullifier, "another account created in the same second gets its own");
}

/// HIGH 4: nothing in two verdicts of one account in two contexts is equal.
#[test]
fn two_contexts_share_nothing_linkable() {
    let x = verdict(&input("a.testnet", CTX, 1, &[]), 42, "2011-01-25T18:44:36Z").envelope;
    let y = verdict(&input("a2.testnet", "bookerbob:v0:demo-hoodie", 2, &[]), 42, "2011-01-25T18:44:36Z").envelope;
    assert_ne!(x.nullifier, y.nullifier);
    assert_ne!(x.proof_hash, y.proof_hash);
    assert_ne!(x.commitment, y.commitment);
}

#[test]
fn predicates_follow_the_rule_table() {
    let v = verdict(&input("a.testnet", CTX, 1, &["github_builder"]), 42, "2011-01-25T18:44:36Z");
    assert_eq!(v.envelope.predicates, vec!["github_builder".to_string()]);
    let i = input("a.testnet", CTX, 1, &["github_builder"]);
    let a = Account { id: 42, created_secs: parse_utc(b"2024-09-18T13:33:41Z").unwrap(), time_secs: T };
    let out: serde_json::Value = serde_json::from_str(&evaluate_account(&Mock, &i, &a, "00", T * 1000).unwrap()).unwrap();
    assert_eq!(out["refusal"]["reason"], "a requested predicate is not proven");
}

#[test]
fn dates() {
    assert_eq!(parse_utc(b"1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(parse_utc(b"2024-09-18T13:33:41Z"), Some(1726666421));
    assert_eq!(parse_utc(b"2024-13-18T13:33:41Z"), None);
    let y = |d: u64| whole_years(0, d * 86_400);
    assert_eq!((y(365), y(366), y(1096), y(1095)), (0, 1, 3, 2));
}
