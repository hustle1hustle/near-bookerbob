//! The evaluator, run inside OutLayer's TEE, so no BookerBob party sees the buyer's facts.
//!
//! Input (stdin): `{"cmd":"pubkey"}`, or `{"sealed": SealedInput}` (X25519, `worker/src/sealed.rs`
//! v0, sealed to `seal_x25519`) whose plaintext is an [`EvalInput`]: the buyer's TLSNotary
//! presentations, the envelope fields the buyer chooses (context, agent, cap, lifetime, which
//! predicates to reveal) and the commitment salt.
//!
//! What the module does, all inside the run:
//! 1. Each presentation is verified with upstream TLSNotary (`v0.1.0-alpha.15`, the tag
//!    `tools/verify-presentation` uses): the notary's signature, the server certificate chain
//!    (Mozilla roots), and the notary key must be one of [`NOTARY_KEYS`].
//! 2. The transcript must be a signed-in GitHub account read: server `api.github.com`, request
//!    line `GET /user HTTP/1.1`, response `HTTP/1.1 200 OK`, exactly one revealed
//!    `"created_at":"..."`. A public `/users/<login>` profile is refused: anyone can notarize a
//!    stranger's public profile, so it says nothing about the buyer.
//! 3. The fact is `github.account_age_years` at the notary's time; the predicates and tier come
//!    from the workspace rule table (`bookerbob_core::tier::derive`), the same table every other
//!    issuer path uses.
//! 4. The nullifier is `sha256(NULLIFIER_TAG || sign("nullifier", context || account))`, an
//!    ed25519 signature under a project key with `caller: "none"` (RFC 8032 signatures are
//!    deterministic, so it is a PRF only the TEE can evaluate). One GitHub account gives one
//!    nullifier per context, whichever NEAR account asks; nobody outside the TEE can link two.
//! 5. Every predicate the buyer asks to reveal must be derived, or the run signs a refusal.
//!    Otherwise it signs the envelope as an issuer: ed25519 over sha256(`signing_message`), the
//!    exact check `submit_verdict` runs.
//!
//! The output carries hashes and the revealed predicates only; the facts never leave the run.
use base64::Engine as _;
use bookerbob_core::envelope::{commitment, Attestation, Envelope, SigAlg, SignedVerdict};
use bookerbob_core::tier::{derive, Fact, ProofSet};
use bookerbob_referee_worker::sealed;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tlsn_attestation::presentation::{Presentation, PresentationOutput};
use tlsn_attestation::CryptoProvider;

/// Pinned TLSNotary notary keys (secp256k1, compressed): REP's notary inside an Intel TDX enclave
/// on Phala (`rep-notary-ext`, key 1) and REP's Fly notary. A presentation signed by any other
/// key is refused.
pub const NOTARY_KEYS: [(&str, &str); 2] = [
    ("0307293878f0133efed565f3aa39963d7362f7adab8b2b172d1ff3bf7908aaed32", "rep-notary-ext (TDX, Phala)"),
    ("02114d7e15cb2a93ad88997af3394d00008dae381b601f31379d638de492ab25ef", "rep-notary (Fly)"),
];

pub const EVALUATOR: &str = "evaluator";
pub const NULLIFIER: &str = "nullifier";
pub const SEAL: &str = "seal";
pub const MODEL: &str = "outlayer:bookerbob-evaluator/v0";
const KEYS_TAG: &[u8] = b"bookerbob/eval-keys/v0\x00";
const REFUSAL_TAG: &[u8] = b"bookerbob/eval-refusal/v0\x00";
const NULLIFIER_MSG: &str = "bookerbob/eval-nullifier-msg/v0";
const NULLIFIER_TAG: &[u8] = b"bookerbob/eval-nullifier/v0\x00";
const SEAL_MSG: &[u8] = b"bookerbob/eval-seal-seed-msg/v0";
const SEAL_TAG: &[u8] = b"bookerbob/eval-seal-seed/v0\x00";
/// A verdict lives at most an hour.
pub const MAX_TTL_MS: u64 = 3_600_000;
/// Clocks earlier than this are treated as absent (a TEE that gives no wall clock).
const CLOCK_FLOOR_MS: u64 = 1_735_689_600_000; // 2025-01-01
const MAX_PRESENTATION_BYTES: usize = 64 * 1024;

/// The host's keys: OutLayer's `signing-keys` in the component, fixed test keys in tests.
pub trait Keys {
    fn public_key(&self, path: &str) -> Result<[u8; 32], String>;
    fn sign(&self, path: &str, message: &[u8]) -> Result<[u8; 64], String>;
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvalInput {
    pub context: String,
    /// The NEAR account allowed to submit and use the verdict.
    pub cnf: String,
    #[serde(with = "bookerbob_core::u128_str")]
    pub max_spend: u128,
    /// Used only when the TEE has no wall clock.
    pub issued_at_ms: u64,
    pub ttl_ms: u64,
    /// Predicates to reveal: sorted, unique, each one the presentations must prove.
    pub predicates: Vec<String>,
    /// 32 bytes, hex: the salt of the commitment to the full derived set. The buyer keeps it.
    pub salt: String,
    /// TLSNotary presentations (bincode), base64. One today.
    pub presentations: Vec<String>,
}

/// What one presentation proves, read inside the run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GithubAccount {
    pub notary_key: String,
    pub time_secs: u64,
    pub created_at: String,
    pub created_secs: u64,
    pub presentation_sha256: String,
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// `YYYY-MM-DDTHH:MM:SSZ` to unix seconds.
pub fn parse_utc(s: &str) -> Result<u64, String> {
    let b = s.as_bytes();
    let ok = b.len() == 20 && b[4] == b'-' && b[7] == b'-' && b[10] == b'T' && b[13] == b':' && b[16] == b':' && b[19] == b'Z';
    let n = |r: std::ops::Range<usize>| s.get(r).and_then(|x| x.parse::<i64>().ok()).filter(|v| *v >= 0);
    let (Some(y), Some(mo), Some(d), Some(h), Some(mi), Some(se)) = (n(0..4), n(5..7), n(8..10), n(11..13), n(14..16), n(17..19)) else {
        return Err("bad created_at".into());
    };
    if !ok || !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return Err("bad created_at".into());
    }
    let t = days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se;
    u64::try_from(t).map_err(|_| "created_at before 1970".to_string())
}

/// Whole years between two instants (365.2425-day years).
pub fn whole_years(from_secs: u64, to_secs: u64) -> u64 {
    to_secs.saturating_sub(from_secs) / 31_556_952
}

/// Verify one presentation and read the signed-in GitHub account it shows.
pub fn read_github(bytes: &[u8]) -> Result<GithubAccount, String> {
    if bytes.len() > MAX_PRESENTATION_BYTES {
        return Err("presentation too large".into());
    }
    let p: Presentation = bincode::deserialize(bytes).map_err(|_| "not a TLSNotary presentation".to_string())?;
    let notary_key = hex::encode(&p.verifying_key().data);
    if !NOTARY_KEYS.iter().any(|(k, _)| *k == notary_key) {
        return Err(format!("notary key {}.. is not pinned", &notary_key[..notary_key.len().min(12)]));
    }
    let PresentationOutput { server_name, connection_info, transcript, .. } =
        p.verify(&CryptoProvider::default()).map_err(|e| format!("presentation does not verify: {e}"))?;
    let server = match server_name {
        Some(tlsn_core::connection::ServerName::Dns(d)) => d.as_str().to_string(),
        _ => String::new(),
    };
    if server != "api.github.com" {
        return Err(format!("server {server:?} is not api.github.com"));
    }
    let mut t = transcript.ok_or("presentation reveals no transcript")?;
    // Undisclosed bytes become 0x00, which never occurs in an HTTP/1.1 head or in GitHub's JSON,
    // so a pattern below can match only inside bytes the notary signed and the prover revealed.
    t.set_unauthed(0);
    let sent = t.sent_unsafe();
    let recv = t.received_unsafe();
    if sent.starts_with(b"GET /users/") {
        return Err("a public profile (/users/<login>): anyone can notarize it, so it shows nothing about the buyer".into());
    }
    // The request line, revealed. The prover may hide everything after it (headers, the token);
    // the byte after `HTTP/1.1` is then hidden or `\r`. Any other request line would not get
    // GitHub's `200 OK` below.
    const LINE: &[u8] = b"GET /user HTTP/1.1";
    if !sent.starts_with(LINE) || !matches!(sent.get(LINE.len()), Some(0) | Some(b'\r')) {
        return Err("not a signed-in account read (GET /user)".into());
    }
    const STATUS: &[u8] = b"HTTP/1.1 200 OK";
    if !recv.starts_with(STATUS) || !matches!(recv.get(STATUS.len()), Some(0) | Some(b'\r')) {
        return Err("GitHub did not answer 200 OK".into());
    }
    // `"created_at":"` with bare quotes cannot occur inside a JSON string value (quotes there are
    // escaped), so a revealed match is the key itself. Exactly one.
    const KEY: &[u8] = b"\"created_at\":\"";
    let hits: Vec<usize> = recv.windows(KEY.len()).enumerate().filter(|(_, w)| *w == KEY).map(|(i, _)| i).collect();
    let [at] = hits.as_slice() else {
        return Err(format!("{} revealed created_at keys, expected 1", hits.len()));
    };
    let start = at + KEY.len();
    let value = recv.get(start..start + 21).ok_or("created_at is cut off")?;
    if value[20] != b'"' {
        return Err("created_at is not a revealed timestamp".into());
    }
    let created_at = std::str::from_utf8(&value[..20]).map_err(|_| "created_at is not utf-8")?.to_string();
    let created_secs = parse_utc(&created_at)?;
    let time_secs = connection_info.time;
    if created_secs > time_secs {
        return Err("account created after the notarized session".into());
    }
    Ok(GithubAccount { notary_key, time_secs, created_at, created_secs, presentation_sha256: hex::encode(Sha256::digest(bytes)) })
}

fn sha_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

/// The seed of the X25519 key buyers seal to: a PRF of a project key, the same for every caller,
/// never printed, never signed.
pub fn seal_seed(k: &dyn Keys) -> Result<[u8; 32], String> {
    let s = k.sign(SEAL, SEAL_MSG)?;
    let mut b = SEAL_TAG.to_vec();
    b.extend_from_slice(&s);
    Ok(Sha256::digest(&b).into())
}

/// `{"cmd":"pubkey"}`: the evaluator key, the seal key and the pinned notaries, signed.
pub fn pubkey(k: &dyn Keys) -> Result<String, String> {
    let body = serde_json::json!({
        "evaluator_key": hex::encode(k.public_key(EVALUATOR)?),
        "model": MODEL,
        "notary_keys": NOTARY_KEYS.iter().map(|(key, _)| *key).collect::<Vec<_>>(),
        "seal_x25519": sealed::public_hex(&seal_seed(k)?),
    });
    let mut msg = KEYS_TAG.to_vec();
    msg.extend(serde_json::to_vec(&body).expect("serializes"));
    Ok(serde_json::json!({ "keys": body, "signature": hex::encode(k.sign(EVALUATOR, &msg)?) }).to_string())
}

fn refusal(k: &dyn Keys, input: Option<&EvalInput>, proofs: &[String], reason: &str) -> Result<String, String> {
    let body = serde_json::json!({
        "verdict": "refuse",
        "reason": reason,
        "context": input.map(|i| i.context.as_str()).unwrap_or(""),
        "cnf": input.map(|i| i.cnf.as_str()).unwrap_or(""),
        "proofs": proofs,
    });
    let mut msg = REFUSAL_TAG.to_vec();
    msg.extend(serde_json::to_vec(&body).expect("serializes"));
    Ok(serde_json::json!({ "refusal": body, "key": hex::encode(k.public_key(EVALUATOR)?), "signature": hex::encode(k.sign(EVALUATOR, &msg)?) }).to_string())
}

/// Evaluate an opened input. `now_ms` is the TEE's wall clock, if it has one.
pub fn evaluate(k: &dyn Keys, input: &EvalInput, now_ms: Option<u64>) -> Result<String, String> {
    let salt: [u8; 32] = hex::decode(&input.salt).ok().and_then(|b| b.try_into().ok()).ok_or("bad salt")?;
    if input.presentations.len() != 1 {
        return Err("exactly one presentation".into());
    }
    if input.ttl_ms == 0 || input.ttl_ms > MAX_TTL_MS {
        return Err("ttl out of range".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(&input.presentations[0]).map_err(|_| "presentation is not base64")?;
    let proof_sha = sha_hex(&bytes);
    let acct = match read_github(&bytes) {
        Ok(a) => a,
        Err(reason) => return refusal(k, Some(input), &[proof_sha], &reason),
    };
    let set = ProofSet {
        facts: vec![Fact {
            id: "G1".into(),
            platform: "github".into(),
            field: "account_age_years".into(),
            value: whole_years(acct.created_secs, acct.time_secs),
            proof_ref: acct.presentation_sha256.clone(),
        }],
    };
    let derived = derive(&set);
    let all = derived.predicates();
    if let Some(p) = input.predicates.iter().find(|p| !all.contains(p)) {
        return refusal(k, Some(input), &[proof_sha], &format!("{p} is not proven by the presentation"));
    }
    let mut nmsg = format!("{NULLIFIER_MSG}|{}|github|{}", input.context, acct.created_at).into_bytes();
    nmsg.shrink_to_fit();
    let mut nb = NULLIFIER_TAG.to_vec();
    nb.extend_from_slice(&k.sign(NULLIFIER, &nmsg)?);
    let issued_at_ms = now_ms.filter(|t| *t >= CLOCK_FLOOR_MS).unwrap_or(input.issued_at_ms);
    let envelope = Envelope {
        v: 0,
        context: input.context.clone(),
        nullifier: sha_hex(&nb),
        commitment: commitment(&salt, &all),
        proof_hash: sha_hex(&serde_json::to_vec(&set).expect("serializes")),
        predicates: input.predicates.clone(),
        tier: derived.tier.as_str().into(),
        attestation: Attestation { model: MODEL.into(), tcb_status: "fixture".into(), report_hash: sha_hex(acct.notary_key.as_bytes()) },
        cnf: input.cnf.clone(),
        max_spend: input.max_spend,
        issued_at_ms,
        expires_at_ms: issued_at_ms + input.ttl_ms,
        disclosure: None,
    };
    if let Err(e) = envelope.validate() {
        return refusal(k, Some(input), &[proof_sha], e);
    }
    let digest: [u8; 32] = Sha256::digest(envelope.signing_message()).into();
    let v = SignedVerdict { envelope, alg: SigAlg::Ed25519, issuer_key: hex::encode(k.public_key(EVALUATOR)?), signature: hex::encode(k.sign(EVALUATOR, &digest)?) };
    Ok(serde_json::to_string(&v).expect("serializes"))
}

/// One run: the raw stdin to the output line.
pub fn answer(k: &dyn Keys, raw: &str, now_ms: Option<u64>) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|e| format!("bad input: {e}"))?;
    match value.get("cmd").and_then(|c| c.as_str()) {
        Some("pubkey") => return pubkey(k),
        Some(other) => return Err(format!("unknown cmd {other:?}")),
        None => {}
    }
    // Plaintext input is refused: the facts travel sealed or not at all (OutLayer's input is
    // public on chain).
    let s = value.get("sealed").cloned().ok_or("input must be sealed")?;
    let s: sealed::SealedInput = serde_json::from_value(s).map_err(|e| format!("bad sealed input: {e}"))?;
    if s.v != 0 {
        return Err("sealed v0 (X25519) only".into());
    }
    let pt = sealed::open(&s, &seal_seed(k)?)?;
    let input: EvalInput = serde_json::from_slice(&pt).map_err(|e| format!("bad sealed plaintext: {e}"))?;
    evaluate(k, &input, now_ms)
}
