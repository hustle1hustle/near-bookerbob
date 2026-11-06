//! NEAR AI verdict proof. A verdict issued by a NEAR AI model under E2EE v2 is accepted
//! only with this proof, never on the shared model key alone:
//! - the TEE signature text is `model:request_sha256:sha256(response)`; the caller hands
//!   in the exact response bytes, so the contract hashes them itself;
//! - the answer inside the response is sealed (E2EE v2); the caller discloses the 32-byte
//!   key for that one field, and the answer must open with it (XChaCha20-Poly1305);
//! - the answer must echo `Envelope::near_ai_bind` (context, nullifier, commitment, agent,
//!   cap, times) and list every predicate the envelope reveals.
//!
//! Every user of a model shares its signing key, so a valid signature proves only that the
//! model said *something*; the echoed binding proves it said it about this envelope.
//!
//! Attestation (TDX quote, report_data = key || nonce) is checked off chain and registered
//! by the owner; `nonce` here must match that registration.
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};

use crate::envelope::Envelope;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NearAiProof {
    pub chat_id: String,
    /// Hex ed25519 key the model signs with (its attested `signing_address`).
    pub signing_key: String,
    /// The nonce of the attestation report that bound `signing_key` (hex, 32 bytes).
    pub nonce: String,
    /// sha256 of the request wire bytes (the request holds the sealed facts; only its hash).
    pub request_sha256: String,
    /// The exact response wire bytes (UTF-8 JSON). Its sha256 is in the signed text.
    pub response: String,
    /// Hex 32-byte key for the sealed answer field, disclosed by the buyer.
    pub response_key: String,
    /// Hex ed25519 TEE signature over `signed_text`.
    pub signature: String,
    /// Hex ed25519 signature of the evaluator over `evaluator_message`: it built this request
    /// from the proof set the envelope names. Empty on records from before the evaluator.
    #[serde(default)]
    pub evaluator_sig: String,
}

/// What the evaluator signs: this request belongs to this envelope, so an answer about a prompt
/// the evaluator did not build, or moved to another verdict, has no signature.
pub fn evaluator_message(e: &Envelope, request_sha256: &str) -> Vec<u8> {
    format!("bookerbob/evaluator/v1|{request_sha256}|{}", hex::encode(e.digest())).into_bytes()
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Answer {
    pub predicates: Vec<String>,
    pub bind: String,
}

impl NearAiProof {
    pub fn signed_text(&self, model: &str) -> String {
        format!("{model}:{}:{}", self.request_sha256, crate::sha256_hex(self.response.as_bytes()))
    }
}

/// Open the sealed answer: content = eph_pub(32) || nonce(24) || ciphertext, hex.
pub fn open_answer(response: &str, key_hex: &str) -> Result<Answer, &'static str> {
    let body: serde_json::Value = serde_json::from_str(response).map_err(|_| "response is not json")?;
    let sealed = body["choices"][0]["message"]["content"].as_str().ok_or("no answer in response")?;
    let w = hex::decode(sealed).map_err(|_| "answer is not sealed hex")?;
    if w.len() < 32 + 24 + 16 {
        return Err("sealed answer too short");
    }
    let key: [u8; 32] = hex::decode(key_hex).ok().and_then(|k| k.try_into().ok()).ok_or("bad response key")?;
    let pt =
        XChaCha20Poly1305::new(&key.into()).decrypt(XNonce::from_slice(&w[32..56]), &w[56..]).map_err(|_| "answer does not open with the disclosed key")?;
    let text = core::str::from_utf8(&pt).map_err(|_| "answer is not utf-8")?;
    let (i, j) = (text.find('{').ok_or("answer has no json")?, text.rfind('}').ok_or("answer has no json")?);
    serde_json::from_str(&text[i..=j]).map_err(|_| "answer json is malformed")
}

/// Everything except the TEE signature and the attestation registry, which the caller
/// checks with its own primitives (the contract uses `env::ed25519_verify`).
pub fn check_binding(e: &Envelope, p: &NearAiProof) -> Result<Answer, &'static str> {
    if !crate::is_hex32(&p.request_sha256) {
        return Err("bad request hash");
    }
    let a = open_answer(&p.response, &p.response_key)?;
    if a.bind != e.near_ai_bind() {
        return Err("answer is about another envelope");
    }
    if !e.predicates.iter().all(|x| a.predicates.contains(x)) {
        return Err("envelope reveals a predicate the model did not attest");
    }
    Ok(a)
}
