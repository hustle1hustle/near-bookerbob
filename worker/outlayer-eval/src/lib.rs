//! The evaluator, run inside OutLayer's TEE, so no BookerBob party sees the buyer's facts. v1.
//!
//! Input (stdin): `{"cmd":"pubkey"}`, or `{"sealed": SealedInput}` (X25519, `worker/src/sealed.rs`
//! v0, sealed to `seal_x25519`) whose plaintext is an [`EvalInput`].
//!
//! Three layers, each tested on its own:
//! 1. [`verify_presentation`]: upstream TLSNotary (`v0.1.0-alpha.15`) checks the notary's signature
//!    and the server certificate chain (Mozilla roots); the notary key must be pinned. The result
//!    is the transcript with a mask of which bytes the notary signed and the prover revealed.
//! 2. [`check_transcript`]: the policy, a pure function of that transcript, the binding and the
//!    OutLayer worker's system clock (which TDX does not attest) (v1 rules below). It returns the GitHub account `id`, `created_at` and the
//!    session time, or one fixed refusal reason.
//! 3. [`evaluate_account`]: facts, predicates, nullifier, commitment, the signed envelope.
//!
//! v1 transcript rules (each one closes an audited attack on v0, docs/outlayer-eval.md):
//! - the request is fully revealed except one contiguous range inside the value of an
//!   `Authorization` header, which is the last header; the request line is exactly
//!   `GET /user?bb=<binding> HTTP/1.1`, `binding = sha256("bookerbob/eval-bind/v1|" cnf "|" context)`,
//!   so a presentation is good for one agent in one context; the only revealed `\r\n\r\n` ends the
//!   sent data;
//! - the facts come from the FIRST response only: its head fully revealed, `200 OK`, one
//!   `Content-Length`, no `Transfer-Encoding` or `Content-Encoding`, the whole body revealed and
//!   parsed as one JSON object (duplicate top-level keys refused), its top-level `id` and
//!   `created_at` read. A request pipelined inside the
//!   hidden Authorization range is answered after the first response, so nothing of its answer can
//!   be read as the account;
//! - the session is fresh: notarized at most [`MAX_SESSION_AGE_SECS`] before the OutLayer worker's system clock (which TDX does not attest) and
//!   not after it (with [`CLOCK_SKEW_SECS`]); no clock, no verdict;
//! - the context is one of [`CONTEXTS`] and `cnf` a NEAR account id, or nothing is signed;
//! - the nullifier is a PRF of the account `id` under a TEE key, per context;
//! - `proof_hash` is salted with the buyer's salt, so it differs across contexts; a refusal names
//!   no presentation; errors carry no input bytes.
use base64::Engine as _;
use bookerbob_core::envelope::{commitment, Attestation, Envelope, SigAlg, SignedVerdict};
use bookerbob_core::tier::{derive, Fact, ProofSet};
use bookerbob_referee_worker::sealed;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tlsn_attestation::presentation::{Presentation, PresentationOutput};
use tlsn_attestation::CryptoProvider;

/// Pinned TLSNotary notary keys (secp256k1, compressed): REP's notary inside an Intel TDX enclave
/// on Phala (`rep-notary-ext`, key 1) and REP's Fly notary.
pub const NOTARY_KEYS: [(&str, &str); 2] = [
    ("0307293878f0133efed565f3aa39963d7362f7adab8b2b172d1ff3bf7908aaed32", "rep-notary-ext (TDX, Phala)"),
    ("02114d7e15cb2a93ad88997af3394d00008dae381b601f31379d638de492ab25ef", "rep-notary (Fly)"),
];

/// The purchase contexts this evaluator issues for. A context outside the list gets no verdict,
/// so a buyer cannot mint a fresh nullifier by naming a new context.
pub const CONTEXTS: [&str; 2] = ["bookerbob:v0:demo-hoodie", "bookerbob:v0:evaltee-github"];

pub const EVALUATOR: &str = "evaluator";
pub const NULLIFIER: &str = "nullifier";
pub const SEAL: &str = "seal";
pub const MODEL: &str = "outlayer:bookerbob-evaluator/v1";
pub const MAX_SESSION_AGE_SECS: u64 = 6 * 3600;
pub const CLOCK_SKEW_SECS: u64 = 300;
/// A verdict lives at most an hour.
pub const MAX_TTL_MS: u64 = 3_600_000;
/// Clocks earlier than this are treated as absent.
const CLOCK_FLOOR_MS: u64 = 1_735_689_600_000; // 2025-01-01
const MAX_PRESENTATION_BYTES: usize = 64 * 1024;
const KEYS_TAG: &[u8] = b"bookerbob/eval-keys/v1\x00";
const REFUSAL_TAG: &[u8] = b"bookerbob/eval-refusal/v1\x00";
const BIND_TAG: &str = "bookerbob/eval-bind/v1";
const NULLIFIER_MSG: &str = "bookerbob/eval-nullifier-msg/v1";
const NULLIFIER_TAG: &[u8] = b"bookerbob/eval-nullifier/v1\x00";
const PROOF_TAG: &[u8] = b"bookerbob/eval-proof-hash/v1\x00";
const SEAL_MSG: &[u8] = b"bookerbob/eval-seal-seed-msg/v1";
const SEAL_TAG: &[u8] = b"bookerbob/eval-seal-seed/v1\x00";

/// The host's keys: OutLayer's `signing-keys` in the component, fixed test keys in tests.
pub trait Keys {
    fn public_key(&self, path: &str) -> Result<[u8; 32], String>;
    fn sign(&self, path: &str, message: &[u8]) -> Result<[u8; 64], String>;
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvalInput {
    pub context: String,
    /// The NEAR account allowed to submit and use the verdict; bound into the request.
    pub cnf: String,
    #[serde(with = "bookerbob_core::u128_str")]
    pub max_spend: u128,
    pub ttl_ms: u64,
    /// Predicates to reveal: sorted, unique, each one the presentation must prove.
    pub predicates: Vec<String>,
    /// 32 bytes, hex: salts the commitment and the proof hash. The buyer keeps it.
    pub salt: String,
    /// One TLSNotary presentation (bincode), base64.
    pub presentations: Vec<String>,
}

/// A verified transcript: bytes plus which of them are revealed (signed and disclosed).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transcript {
    pub server: String,
    pub time_secs: u64,
    pub sent: Vec<u8>,
    pub sent_rev: Vec<bool>,
    pub recv: Vec<u8>,
    pub recv_rev: Vec<bool>,
}

/// What the policy reads from a transcript.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub id: u64,
    pub created_secs: u64,
    pub time_secs: u64,
}

/// The request-line binding: one agent, one context.
pub fn binding(cnf: &str, context: &str) -> String {
    hex::encode(Sha256::digest(format!("{BIND_TAG}|{cnf}|{context}")))
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// `YYYY-MM-DDTHH:MM:SSZ` to unix seconds.
pub fn parse_utc(s: &[u8]) -> Option<u64> {
    let ok = s.len() == 20 && s[4] == b'-' && s[7] == b'-' && s[10] == b'T' && s[13] == b':' && s[16] == b':' && s[19] == b'Z';
    if !ok {
        return None;
    }
    let n = |r: std::ops::Range<usize>| std::str::from_utf8(&s[r]).ok().filter(|x| x.bytes().all(|b| b.is_ascii_digit())).and_then(|x| x.parse::<i64>().ok());
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    u64::try_from(days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se).ok()
}

/// Whole years between two instants (365.2425-day years).
pub fn whole_years(from_secs: u64, to_secs: u64) -> u64 {
    to_secs.saturating_sub(from_secs) / 31_556_952
}

/// Layer 1: verify a presentation with upstream TLSNotary and the pinned notary keys.
pub fn verify_presentation(bytes: &[u8]) -> Result<Transcript, &'static str> {
    if bytes.len() > MAX_PRESENTATION_BYTES {
        return Err("presentation too large");
    }
    let p: Presentation = bincode::deserialize(bytes).map_err(|_| "not a TLSNotary presentation")?;
    let notary_key = hex::encode(&p.verifying_key().data);
    if !NOTARY_KEYS.iter().any(|(k, _)| *k == notary_key) {
        return Err("notary key not pinned");
    }
    let PresentationOutput { server_name, connection_info, transcript, .. } = p.verify(&CryptoProvider::default()).map_err(|_| "presentation does not verify")?;
    let server = match server_name {
        Some(tlsn_core::connection::ServerName::Dns(d)) => d.as_str().to_string(),
        _ => String::new(),
    };
    let t = transcript.ok_or("presentation reveals no transcript")?;
    // Which bytes are revealed: fill the hidden ones with 0 and with 1; a byte that reads the same
    // both ways is revealed.
    let (mut a, mut b) = (t.clone(), t);
    a.set_unauthed(0);
    b.set_unauthed(1);
    let mask = |x: &[u8], y: &[u8]| x.iter().zip(y).map(|(p, q)| p == q).collect::<Vec<bool>>();
    Ok(Transcript {
        server,
        time_secs: connection_info.time,
        sent_rev: mask(a.sent_unsafe(), b.sent_unsafe()),
        recv_rev: mask(a.received_unsafe(), b.received_unsafe()),
        sent: a.sent_unsafe().to_vec(),
        recv: a.received_unsafe().to_vec(),
    })
}

/// Start offsets of `pat` where every byte of the match is revealed.
fn revealed_hits(data: &[u8], rev: &[bool], pat: &[u8], within: std::ops::Range<usize>) -> Vec<usize> {
    if within.end > data.len() || within.end < within.start || within.end - within.start < pat.len() {
        return Vec::new();
    }
    (within.start..=within.end - pat.len()).filter(|&i| &data[i..i + pat.len()] == pat && rev[i..i + pat.len()].iter().all(|r| *r)).collect()
}

fn all_revealed(rev: &[bool], r: std::ops::Range<usize>) -> bool {
    r.end <= rev.len() && rev[r].iter().all(|x| *x)
}

/// Layer 2: the v1 transcript policy. `now_secs` is the OutLayer worker's system clock (which TDX does not attest).
pub fn check_transcript(t: &Transcript, bind: &str, now_secs: u64) -> Result<Account, &'static str> {
    if t.server != "api.github.com" {
        return Err("not api.github.com");
    }
    if t.time_secs > now_secs + CLOCK_SKEW_SECS || now_secs > t.time_secs + MAX_SESSION_AGE_SECS {
        return Err("session not fresh");
    }
    // ---- the request ----
    let (s, sr) = (&t.sent, &t.sent_rev);
    let line = format!("GET /user?bb={bind} HTTP/1.1\r\n").into_bytes();
    if !s.starts_with(&line) || !all_revealed(sr, 0..line.len()) {
        return Err("request is not GET /user bound to this agent and context");
    }
    let n = s.len();
    let ends = revealed_hits(s, sr, b"\r\n\r\n", 0..n);
    if n < 4 || ends != [n - 4] {
        return Err("not exactly one request");
    }
    let mut hidden: Vec<(usize, usize)> = Vec::new();
    for (i, r) in sr.iter().enumerate() {
        if !*r {
            match hidden.last_mut() {
                Some((_, e)) if *e == i => *e = i + 1,
                _ => hidden.push((i, i + 1)),
            }
        }
    }
    if hidden.len() > 1 {
        return Err("request hides more than the Authorization value");
    }
    if let Some(&(hs, he)) = hidden.first() {
        // The hidden range sits inside the value of the last header, `Authorization: `: its line
        // starts after a revealed "\r\n", and the range runs up to the final "\r\n\r\n".
        let start = s[..hs].windows(2).rposition(|w| w == b"\r\n").map(|i| i + 2).ok_or("bad request head")?;
        if !all_revealed(sr, start - 2..hs) {
            return Err("bad request head");
        }
        const AUTH: &[u8] = b"authorization: ";
        let name_ok = s.len() >= start + AUTH.len() && s[start..start + AUTH.len()].eq_ignore_ascii_case(AUTH);
        if !name_ok || hs < start + AUTH.len() || he != n - 4 {
            return Err("request hides more than the Authorization value");
        }
    }
    // ---- the first response ----
    let (r, rr) = (&t.recv, &t.recv_rev);
    let head_end = r.windows(4).position(|w| w == b"\r\n\r\n").ok_or("no response head")?;
    if !all_revealed(rr, 0..head_end + 4) {
        return Err("response head not fully revealed");
    }
    let head = std::str::from_utf8(&r[..head_end]).map_err(|_| "bad response head")?;
    let mut lines = head.split("\r\n");
    if lines.next() != Some("HTTP/1.1 200 OK") {
        return Err("GitHub did not answer 200 OK");
    }
    let mut cl: Option<usize> = None;
    for l in lines {
        let (k, v) = l.split_once(':').ok_or("bad response head")?;
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
        match k.as_str() {
            "content-length" => {
                if cl.is_some() || v.is_empty() || v.len() > 9 || !v.bytes().all(|b| b.is_ascii_digit()) {
                    return Err("bad Content-Length");
                }
                cl = Some(v.parse().map_err(|_| "bad Content-Length")?);
            }
            "transfer-encoding" | "content-encoding" => return Err("encoded response body"),
            _ => {}
        }
    }
    let body = head_end + 4..head_end + 4 + cl.ok_or("no Content-Length")?;
    if body.end > r.len() {
        return Err("response body cut off");
    }
    // The whole first body is revealed and parsed as one JSON object; its top-level `id` and
    // `created_at` are read, and a duplicate top-level key is refused.
    if !all_revealed(rr, body.clone()) {
        return Err("response body not fully revealed");
    }
    let obj: TopLevel = serde_json::from_slice(&r[body]).map_err(|_| "response body is not one JSON object")?;
    let id = obj.0.get("id").and_then(|v| v.as_u64()).ok_or("bad id")?;
    let created = obj.0.get("created_at").and_then(|v| v.as_str()).ok_or("bad created_at")?;
    let created_secs = parse_utc(created.as_bytes()).ok_or("bad created_at")?;
    if created_secs > t.time_secs {
        return Err("bad created_at");
    }
    Ok(Account { id, created_secs, time_secs: t.time_secs })
}

/// A JSON object whose top-level keys are unique (serde_json would keep the last of two).
struct TopLevel(serde_json::Map<String, serde_json::Value>);

impl<'de> Deserialize<'de> for TopLevel {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = TopLevel;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(self, mut m: M) -> Result<TopLevel, M::Error> {
                let mut out = serde_json::Map::new();
                while let Some((k, v)) = m.next_entry::<String, serde_json::Value>()? {
                    if out.insert(k, v).is_some() {
                        return Err(serde::de::Error::custom("duplicate key"));
                    }
                }
                Ok(TopLevel(out))
            }
        }
        d.deserialize_map(V)
    }
}

/// A NEAR account id: 2 to 64 of `a-z 0-9 . - _`.
fn is_account_id(s: &str) -> bool {
    (2..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

fn sha_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

/// The seed of the X25519 key buyers seal to: a PRF of a TEE key, never printed, never signed.
pub fn seal_seed(k: &dyn Keys) -> Result<[u8; 32], String> {
    let s = k.sign(SEAL, SEAL_MSG)?;
    let mut b = SEAL_TAG.to_vec();
    b.extend_from_slice(&s);
    Ok(Sha256::digest(&b).into())
}

/// `{"cmd":"pubkey"}`: the evaluator key, the seal key, the pinned notaries and contexts, signed.
pub fn pubkey(k: &dyn Keys) -> Result<String, String> {
    let body = serde_json::json!({
        "contexts": CONTEXTS,
        "evaluator_key": hex::encode(k.public_key(EVALUATOR)?),
        "model": MODEL,
        "notary_keys": NOTARY_KEYS.iter().map(|(key, _)| *key).collect::<Vec<_>>(),
        "seal_x25519": sealed::public_hex(&seal_seed(k)?),
    });
    let mut msg = KEYS_TAG.to_vec();
    msg.extend(serde_json::to_vec(&body).expect("serializes"));
    Ok(serde_json::json!({ "keys": body, "signature": hex::encode(k.sign(EVALUATOR, &msg)?) }).to_string())
}

/// A signed refusal. It names the context and the agent, never the presentation; `reason` is one
/// of the fixed strings of this file, never input bytes.
pub fn refusal(k: &dyn Keys, input: &EvalInput, reason: &str) -> Result<String, String> {
    let body = serde_json::json!({ "cnf": input.cnf, "context": input.context, "reason": reason, "verdict": "refuse" });
    let mut msg = REFUSAL_TAG.to_vec();
    msg.extend(serde_json::to_vec(&body).expect("serializes"));
    Ok(serde_json::json!({ "key": hex::encode(k.public_key(EVALUATOR)?), "refusal": body, "signature": hex::encode(k.sign(EVALUATOR, &msg)?) }).to_string())
}

/// Layer 3: the verdict for a checked account.
pub fn evaluate_account(k: &dyn Keys, input: &EvalInput, acct: &Account, presentation_sha256: &str, now_ms: u64) -> Result<String, String> {
    let salt: [u8; 32] = hex::decode(&input.salt).ok().and_then(|b| b.try_into().ok()).ok_or("bad salt")?;
    let set = ProofSet {
        facts: vec![Fact {
            id: "G1".into(),
            platform: "github".into(),
            field: "account_age_years".into(),
            value: whole_years(acct.created_secs, acct.time_secs),
            proof_ref: presentation_sha256.into(),
        }],
    };
    let derived = derive(&set);
    let all = derived.predicates();
    if input.predicates.iter().any(|p| !all.contains(p)) {
        return refusal(k, input, "a requested predicate is not proven");
    }
    let nmsg = format!("{NULLIFIER_MSG}|{}|github-id|{}", input.context, acct.id);
    let mut nb = NULLIFIER_TAG.to_vec();
    nb.extend_from_slice(&k.sign(NULLIFIER, nmsg.as_bytes())?);
    let mut pb = PROOF_TAG.to_vec();
    pb.extend_from_slice(&salt);
    pb.extend(serde_json::to_vec(&set).expect("serializes"));
    let envelope = Envelope {
        v: 0,
        context: input.context.clone(),
        nullifier: sha_hex(&nb),
        commitment: commitment(&salt, &all),
        proof_hash: sha_hex(&pb),
        predicates: input.predicates.clone(),
        tier: derived.tier.as_str().into(),
        attestation: Attestation { model: MODEL.into(), tcb_status: "fixture".into(), report_hash: sha_hex(MODEL.as_bytes()) },
        cnf: input.cnf.clone(),
        max_spend: input.max_spend,
        issued_at_ms: now_ms,
        expires_at_ms: now_ms + input.ttl_ms,
        disclosure: None,
    };
    if envelope.validate().is_err() {
        return refusal(k, input, "the envelope does not validate");
    }
    let digest: [u8; 32] = Sha256::digest(envelope.signing_message()).into();
    let v = SignedVerdict { envelope, alg: SigAlg::Ed25519, issuer_key: hex::encode(k.public_key(EVALUATOR)?), signature: hex::encode(k.sign(EVALUATOR, &digest)?) };
    Ok(serde_json::to_string(&v).expect("serializes"))
}

/// An opened input, end to end. `now_ms` is the TEE's wall clock; without one there is no verdict.
pub fn evaluate(k: &dyn Keys, input: &EvalInput, now_ms: Option<u64>) -> Result<String, String> {
    let now_ms = now_ms.filter(|t| *t >= CLOCK_FLOOR_MS).ok_or("no clock")?;
    // Nothing is signed over an agent id that is not one, or over a context outside the list.
    if !is_account_id(&input.cnf) || !CONTEXTS.contains(&input.context.as_str()) {
        return Err("bad input".into());
    }
    if input.presentations.len() != 1 || input.ttl_ms == 0 || input.ttl_ms > MAX_TTL_MS || hex::decode(&input.salt).map(|s| s.len()) != Ok(32) {
        return Err("bad input".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(&input.presentations[0]).map_err(|_| "bad input")?;
    let t = match verify_presentation(&bytes) {
        Ok(t) => t,
        Err(reason) => return refusal(k, input, reason),
    };
    match check_transcript(&t, &binding(&input.cnf, &input.context), now_ms / 1000) {
        Ok(acct) => evaluate_account(k, input, &acct, &sha_hex(&bytes), now_ms),
        Err(reason) => refusal(k, input, reason),
    }
}

/// One run: the raw stdin to the output line. Errors are fixed strings.
pub fn answer(k: &dyn Keys, raw: &str, now_ms: Option<u64>) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|_| "bad input")?;
    match value.get("cmd").and_then(|c| c.as_str()) {
        Some("pubkey") => return pubkey(k),
        Some(_) => return Err("unknown cmd".into()),
        None => {}
    }
    let s = value.get("sealed").cloned().ok_or("input must be sealed")?;
    let s: sealed::SealedInput = serde_json::from_value(s).map_err(|_| "bad sealed input")?;
    if s.v != 0 {
        return Err("sealed v0 (X25519) only".into());
    }
    let pt = sealed::open(&s, &seal_seed(k)?).map_err(|_| "sealed input does not open")?;
    let input: EvalInput = serde_json::from_slice(&pt).map_err(|_| "bad sealed plaintext")?;
    evaluate(k, &input, now_ms)
}
