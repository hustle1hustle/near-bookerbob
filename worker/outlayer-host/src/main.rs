//! `make outlayer-local`: the OutLayer referee component, run locally, end to end.
//!
//!   bookerbob-outlayer-host <component.wasm> <worker-input.json> <claims-cheat.json>
//!
//! The component (`worker/outlayer`, wasm32-wasip2) runs in wasmtime, the runtime OutLayer's
//! worker uses, with stdin and stdout as OutLayer gives them. The two host interfaces it imports
//! (`outlayer:signing-keys`, `outlayer:encryption-keys`) are answered by a MOCK in this file:
//! fixed test keys, not a TEE, not OutLayer's keystore. What the mock shares with the real host
//! is the interface (the WIT files are OutLayer's) and the rules a module can observe: only a
//! path the manifest declares answers, ed25519 signs the raw message.
//!
//! Each signed result then goes to the real bazaar contract code (`submit_referee_result`, on
//! near-sdk's MockedBlockchain, whose `ed25519_verify` is nearcore's), with the mock key
//! registered as the referee. Nothing here talks to OutLayer or to a chain.
use std::panic::{catch_unwind, AssertUnwindSafe};

use bookerbob_bazaar::{Bazaar, ESCROW_STORAGE_DEPOSIT, RECORD_DEPOSIT};
use bookerbob_core::{
    Attestation, Citation, Claim, Envelope, Fact, ProofSet, Rule, Schedule, SigAlg, SignedVerdict, WorkerResult, WorldAttestation, WorldBody,
};
use bookerbob_referee_worker::{arbitrate, run as run_native, sealed, DisputeDecision, DisputeInput, WorkerInput, MAX_OUTPUT};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hmac::{Hmac, Mac};
use near_sdk::json_types::U128;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId};
use sha2::{Digest, Sha256};
use wasmtime::component::{Component, HasSelf, Linker, ResourceTable};
use wasmtime::{Engine, Store};
use wasmtime_wasi::p2::bindings::sync::Command;
use wasmtime_wasi::p2::pipe::{MemoryInputPipe, MemoryOutputPipe};
use wasmtime_wasi::{I32Exit, WasiCtx, WasiCtxView, WasiView};

wasmtime::component::bindgen!({ world: "referee", path: "../outlayer/wit" });
use outlayer::encryption_keys::api as enc;
use outlayer::signing_keys::api as sig;

const MANIFEST: &str = include_str!("../../outlayer/manifest.json");
const BAZAAR: &str = "bazaar.testnet";
const MARKET: &str = "market.testnet";

// ---------- the mock host ----------

/// The mock's key for a declared signing path. A real key is derived by OutLayer's keystore
/// inside the TEE; this one is a hash of a label, so the native worker can sign with the same
/// key and the two outputs can be compared byte for byte.
fn mock_signing_key(path: &str) -> SigningKey {
    SigningKey::from_bytes(&Sha256::digest(format!("MOCK outlayer signing key|{path}")).into())
}

struct Host {
    wasi: WasiCtx,
    table: ResourceTable,
    signing_paths: Vec<String>,
    encryption_paths: Vec<String>,
    /// The account that called OutLayer: part of every `caller: "predecessor"` key.
    predecessor: String,
}

impl WasiView for Host {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView { ctx: &mut self.wasi, table: &mut self.table }
    }
}

impl Host {
    fn signing(&self, path: &str, vault: &Option<String>) -> Result<SigningKey, String> {
        if vault.is_some() || !self.signing_paths.iter().any(|p| p == path) {
            return Err(format!("signing key {path:?} is not declared in the manifest"));
        }
        Ok(mock_signing_key(path))
    }
}

impl sig::Host for Host {
    fn public_key(&mut self, path: String, vault: Option<String>) -> Result<Vec<u8>, String> {
        Ok(self.signing(&path, &vault)?.verifying_key().to_bytes().to_vec())
    }
    fn sign(&mut self, path: String, vault: Option<String>, message: Vec<u8>) -> Result<Vec<u8>, String> {
        Ok(self.signing(&path, &vault)?.sign(&message).to_bytes().to_vec())
    }
    fn sign_nep413(&mut self, _: String, _: Option<String>, _: String, _: String, _: Vec<u8>, _: Option<String>) -> Result<sig::Nep413Signature, String> {
        Err("sign-nep413 is not in the mock (the real host refuses it for a `none` key)".into())
    }
}

impl enc::Host for Host {
    fn encrypt(&mut self, _: String, _: Option<String>, _: Vec<u8>, _: Vec<u8>) -> Result<Vec<u8>, String> {
        Err("encrypt is not in the mock: the referee uses mac only".into())
    }
    fn decrypt(&mut self, _: String, _: Option<String>, _: Vec<u8>, _: Vec<u8>) -> Result<Vec<u8>, String> {
        Err("decrypt is not in the mock: the referee uses mac only".into())
    }
    fn mac(&mut self, path: String, vault: Option<String>, data: Vec<u8>) -> Result<Vec<u8>, String> {
        if vault.is_some() || !self.encryption_paths.iter().any(|p| *p == path) {
            return Err(format!("encryption key {path:?} is not declared in the manifest"));
        }
        let key = Sha256::digest(format!("MOCK outlayer encryption key|{}|{path}", self.predecessor));
        let mut m = Hmac::<Sha256>::new_from_slice(&key).expect("any key length");
        m.update(&data);
        Ok(m.finalize().into_bytes().to_vec())
    }
}

struct Runner {
    engine: Engine,
    component: Component,
    linker: Linker<Host>,
    manifest: serde_json::Value,
}

impl Runner {
    fn new(wasm: &[u8]) -> anyhow::Result<Self> {
        let engine = Engine::default();
        let component = Component::new(&engine, wasm)?;
        let mut linker = Linker::<Host>::new(&engine);
        wasmtime_wasi::p2::add_to_linker_sync(&mut linker)?;
        Referee::add_to_linker::<_, HasSelf<_>>(&mut linker, |h| h)?;
        Ok(Self { engine, component, linker, manifest: serde_json::from_str(MANIFEST)? })
    }

    fn paths(&self, family: &str) -> Vec<String> {
        self.manifest[family].as_array().into_iter().flatten().filter_map(|k| k["path"].as_str().map(String::from)).collect()
    }

    /// One run: `input` on stdin, the predecessor in the environment as OutLayer sets it.
    /// Returns the exit status (0 for a return from main) and stdout.
    fn run(&self, input: &str, predecessor: &str) -> anyhow::Result<(i32, String)> {
        let stdout = MemoryOutputPipe::new(64 * 1024);
        let mut b = WasiCtx::builder();
        b.stdin(MemoryInputPipe::new(input.as_bytes().to_vec())).stdout(stdout.clone()).env("NEAR_PREDECESSOR_ID", predecessor);
        let host = Host {
            wasi: b.build(),
            table: ResourceTable::new(),
            signing_paths: self.paths("signing_keys"),
            encryption_paths: self.paths("encryption_keys"),
            predecessor: predecessor.into(),
        };
        let mut store = Store::new(&self.engine, host);
        let command = Command::instantiate(&mut store, &self.component, &self.linker)?;
        let status = match command.wasi_cli_run().call_run(&mut store) {
            Ok(Ok(())) => 0,
            Ok(Err(())) => 1,
            Err(e) => e.downcast_ref::<I32Exit>().map(|x| x.0).ok_or(e)?,
        };
        drop(store);
        Ok((status, String::from_utf8(stdout.contents().to_vec())?))
    }

    fn ok(&self, input: &str, predecessor: &str) -> Result<String, String> {
        match self.run(input, predecessor).map_err(|e| format!("{e:#}"))? {
            (0, out) => Ok(out),
            (s, out) => Err(format!("exit {s}: {out}")),
        }
    }
}

// ---------- the bazaar on the mocked chain (the fixtures of contract/src/tests.rs) ----------

const NOW_MS: u64 = 1_793_000_000_000;
const USDC: &str = "usdc.testnet";
const AGENT: &str = "agent.testnet";
const MERCHANT: &str = "m01.bazaar.testnet";
const WORLD_ACTION: &str = "bookerbob-fixture-action";

fn acc(s: &str) -> AccountId {
    s.parse().expect("account id")
}

fn set(predecessor: &str, deposit: near_sdk::NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(BAZAAR)).predecessor_account_id(acc(predecessor)).block_timestamp(NOW_MS * 1_000_000).attached_deposit(deposit);
    testing_env!(b.build());
}

fn envelope() -> Envelope {
    Envelope {
        v: 0,
        context: "bookerbob:v0:test".into(),
        nullifier: hex::encode([1u8; 32]),
        commitment: "22".repeat(32),
        proof_hash: "33".repeat(32),
        predicates: vec!["airbnb_frequent".into(), "world_id_human".into()],
        tier: "silver".into(),
        attestation: Attestation { model: "test".into(), tcb_status: "fixture".into(), report_hash: "44".repeat(32) },
        cnf: AGENT.into(),
        max_spend: 200_000_000,
        issued_at_ms: NOW_MS - 1000,
        expires_at_ms: NOW_MS + 3_600_000,
        disclosure: None,
    }
}

fn verdict() -> SignedVerdict {
    let e = envelope();
    let k = SigningKey::from_bytes(&[7u8; 32]);
    SignedVerdict { alg: SigAlg::Ed25519, issuer_key: hex::encode(k.verifying_key().to_bytes()), signature: hex::encode(k.sign(&e.digest()).to_bytes()), envelope: e }
}

fn schedule() -> Schedule {
    Schedule {
        base_price: 189_000_000,
        rules: vec![Rule { predicate: "airbnb_frequent".into(), bps: 1200 }, Rule { predicate: "world_id_human".into(), bps: 800 }],
        cap_bps: 2500,
        cohort: None,
    }
}

fn proofs() -> ProofSet {
    let f = |id: &str, platform: &str, field: &str, value: u64| Fact { id: id.into(), platform: platform.into(), field: field.into(), value, proof_ref: "cc".repeat(32) };
    ProofSet { facts: vec![f("F1", "airbnb", "trips_12m", 7), f("F5", "world_id", "verified", 1)] }
}

fn cite(fact: &str, field: &str, value: u64) -> Citation {
    Citation { fact: fact.into(), field: field.into(), value }
}

fn honest_claims() -> Vec<Claim> {
    vec![
        Claim { line: "airbnb_frequent".into(), text: "frequent".into(), citations: vec![cite("F1", "trips_12m", 7)] },
        Claim { line: "world_id_human".into(), text: "human".into(), citations: vec![cite("F5", "verified", 1)] },
    ]
}

fn cheat_claims() -> Vec<Claim> {
    let mut c = honest_claims();
    c.push(Claim { line: "airbnb_frequent".into(), text: "guest is marriott platinum".into(), citations: vec![cite("F9", "trips_12m", 7)] });
    c
}

fn worker_input(claims: Vec<Claim>) -> WorkerInput {
    let e = envelope();
    WorkerInput {
        salt: None,
        v: 0,
        verdict_digest: hex::encode(e.digest()),
        nullifier: e.nullifier.clone(),
        merchant: MERCHANT.into(),
        schedule: schedule(),
        revealed: e.predicates,
        claims,
        proofs: proofs(),
        cohort_k: 0,
        sealed_verdict: None,
    }
}

/// A bazaar with a pending verdict for the fixture agent. `referee`: the key registered as the
/// trust anchor (none: no referee registered).
fn bazaar(referee: Option<&str>) -> Bazaar {
    // A fresh chain for each case: `testing_env!` carries the storage of the one before.
    set("owner.testnet", RECORD_DEPOSIT);
    drop(near_sdk::mock::with_mocked_blockchain(|b| b.take_storage()));
    set("owner.testnet", RECORD_DEPOSIT);
    let mut c = Bazaar::new(acc("owner.testnet"), acc(USDC));
    let v = verdict();
    c.register_issuer(v.key_id(), "fixture ed25519 issuer".into());
    if let Some(key) = referee {
        c.register_referee(key.into(), "MOCK OutLayer host key (make outlayer-local)".into());
    }
    let world = SigningKey::from_bytes(&[4u8; 32]);
    c.register_world_verifier(hex::encode(world.verifying_key().to_bytes()), WORLD_ACTION.into(), "fixture world verifier".into());
    let body = WorldBody { v: 0, action: WORLD_ACTION.into(), world_nullifier: hex::encode([200u8; 32]), agent: AGENT.into(), issued_at_ms: NOW_MS };
    set(AGENT, RECORD_DEPOSIT);
    c.attest_human(WorldAttestation {
        verifier_key: hex::encode(world.verifying_key().to_bytes()),
        signature: hex::encode(world.sign(&body.signing_message()).to_bytes()),
        body,
    });
    set(MERCHANT, RECORD_DEPOSIT);
    c.register_merchant(schedule(), "hoodie".into(), None);
    set("owner.testnet", near_sdk::NearToken::from_yoctonear(0));
    c.approve_merchant(acc(MERCHANT));
    set(AGENT, ESCROW_STORAGE_DEPOSIT);
    c.storage_deposit(None);
    set(USDC, RECORD_DEPOSIT);
    let _ = c.ft_on_transfer(acc(AGENT), U128(200_000_000), String::new());
    set(AGENT, RECORD_DEPOSIT);
    c.submit_verdict(v);
    set(AGENT, RECORD_DEPOSIT);
    c
}

/// `submit_referee_result` on the contract: Ok(stored) or the contract's panic message.
fn submit(c: &mut Bazaar, result: WorkerResult) -> Result<bool, String> {
    catch_unwind(AssertUnwindSafe(|| c.submit_referee_result(result)))
        .map_err(|p| p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "panic".into()))
}

// ---------- checks ----------

struct Checks(usize);

impl Checks {
    fn pass(&mut self, what: &str, detail: String) {
        self.0 += 1;
        println!("PASS  {what}: {detail}");
    }
}

fn ensure(cond: bool, what: impl FnOnce() -> String) -> Result<(), String> {
    if cond {
        Ok(())
    } else {
        Err(what())
    }
}

fn ed_ok(key_hex: &str, sig_hex: &str, msg: &[u8]) -> bool {
    let (Ok(k), Ok(s)) = (hex::decode(key_hex), hex::decode(sig_hex)) else { return false };
    let (Ok(k), Ok(s)) = (<[u8; 32]>::try_from(k), <[u8; 64]>::try_from(s)) else { return false };
    VerifyingKey::from_bytes(&k).is_ok_and(|vk| vk.verify(msg, &Signature::from_bytes(&s)).is_ok())
}

fn checks(wasm_path: &str, fixture_input: &str, fixture_cheat: &str) -> Result<usize, String> {
    let mut n = Checks(0);
    let wasm = std::fs::read(wasm_path).map_err(|e| format!("read {wasm_path}: {e}"))?;
    let r = Runner::new(&wasm).map_err(|e| format!("load component: {e:#}"))?;
    let json = |s: &str| serde_json::to_string(&serde_json::from_str::<serde_json::Value>(s).expect("json")).expect("json");
    let referee = mock_signing_key("referee");
    let referee_hex = hex::encode(referee.verifying_key().to_bytes());

    // 1. The artefact: the manifest OutLayer reads is in it, and it imports nothing of OutLayer's
    //    but the two interfaces.
    ensure(wasm.windows(MANIFEST.len()).any(|w| w == MANIFEST.as_bytes()) && wasm.windows(17).any(|w| w == b"outlayer.manifest"), || {
        "the outlayer.manifest custom section is not in the wasm".into()
    })?;
    let imports: Vec<String> = r.component.component_type().imports(&r.engine).map(|(name, _)| name.to_string()).collect();
    let ours: Vec<&String> = imports.iter().filter(|i| !i.starts_with("wasi:")).collect();
    ensure(ours.len() == 2 && ours.iter().any(|i| *i == "outlayer:signing-keys/api@0.1.0") && ours.iter().any(|i| *i == "outlayer:encryption-keys/api@0.1.0"), || {
        format!("unexpected imports {ours:?}")
    })?;
    n.pass(
        "component",
        format!(
            "{} bytes, sha256 {}, manifest section present (signing {:?} caller none, encryption {:?} caller predecessor), imports wasi and {}",
            wasm.len(),
            hex::encode(Sha256::digest(&wasm)),
            r.paths("signing_keys"),
            r.paths("encryption_keys"),
            ours.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
        ),
    );

    // 2. {"cmd":"pubkey"}: the host key's public key, in a statement the key signs.
    let out = r.ok(r#"{"cmd":"pubkey"}"#, BAZAAR)?;
    let keys: serde_json::Value = serde_json::from_str(&out).map_err(|e| format!("pubkey output: {e}"))?;
    let mut msg = b"bookerbob/referee-keys/v0\x00".to_vec();
    msg.extend(serde_json::to_vec(&keys["keys"]).expect("json"));
    ensure(keys["keys"]["referee_key"] == referee_hex.as_str(), || format!("pubkey says {}, the mock host key is {referee_hex}", keys["keys"]["referee_key"]))?;
    ensure(ed_ok(&referee_hex, keys["signature"].as_str().unwrap_or_default(), &msg), || "the key statement is not signed by the referee key".into())?;
    ensure(out.len() <= MAX_OUTPUT && keys["keys"]["seal_for"] == BAZAAR, || format!("pubkey output {} bytes, seal_for {}", out.len(), keys["keys"]["seal_for"]))?;
    n.pass("pubkey", format!("referee key {referee_hex} (the MOCK host key), statement signed by it, {} bytes", out.len()));

    // 3. An honest receipt, signed through the host interface, accepted by the contract.
    let honest_in = serde_json::to_string(&worker_input(honest_claims())).expect("json");
    let honest_out = r.ok(&honest_in, BAZAAR)?;
    let honest: WorkerResult = serde_json::from_str(&honest_out).map_err(|e| format!("result: {e}"))?;
    ensure(honest_out == run_native(&worker_input(honest_claims()), &referee)?, || "wasm and native outputs differ for the same input and key".into())?;
    let mut c = bazaar(Some(&referee_hex));
    ensure(submit(&mut c, honest.clone()) == Ok(true), || "the contract did not store the receipt".into())?;
    ensure(c.verdict(honest.body.nullifier.clone()).is_some_and(|v| v.receipt.is_some()), || "no receipt on the verdict".into())?;
    ensure(honest_out.len() <= MAX_OUTPUT, || format!("{} bytes over the cap", honest_out.len()))?;
    n.pass(
        "receipt",
        format!("submit_referee_result stored it (env::ed25519_verify, MockedBlockchain), price {}, {} of {MAX_OUTPUT} bytes, byte-identical to the native worker", honest.body.price, honest_out.len()),
    );

    // 4. The injected claim: a signed refusal, which the contract logs and does not store.
    let cheat_out = r.ok(&serde_json::to_string(&worker_input(cheat_claims())).expect("json"), BAZAAR)?;
    let cheat: WorkerResult = serde_json::from_str(&cheat_out).map_err(|e| format!("result: {e}"))?;
    let mut c = bazaar(Some(&referee_hex));
    ensure(submit(&mut c, cheat.clone()) == Ok(false), || "the contract stored a receipt for the cheat".into())?;
    ensure(get_logs().iter().any(|l| l.contains("receipt_refused") && l.contains("F9 not in proof set")), || "no receipt_refused event".into())?;
    ensure(c.verdict(cheat.body.nullifier.clone()).is_some_and(|v| v.receipt.is_none()), || "a receipt was stored".into())?;
    n.pass("refusal", format!("'{}' signed by the host key, contract emits receipt_refused and stores no receipt", cheat.body.detail));

    // 5. What the contract refuses: a changed body under the host signature, a key it never registered.
    let mut forged = cheat.clone();
    forged.body.outcome = "receipt".into();
    let mut c = bazaar(Some(&referee_hex));
    let tampered = submit(&mut c, forged);
    ensure(tampered.as_ref().is_err_and(|m| m.contains("bad referee signature")), || format!("tampered result: {tampered:?}"))?;
    let mut c = bazaar(None);
    let unknown = submit(&mut c, honest.clone());
    ensure(unknown.as_ref().is_err_and(|m| m.contains("unknown referee key")), || format!("unregistered key: {unknown:?}"))?;
    n.pass("contract refuses", "a refusal rewritten to a receipt (bad referee signature), a host key not registered (unknown referee key)".into());

    // 6. The fixture input of `bookerbob worker-input fixtures`, and its cheat.
    let fixture = std::fs::read_to_string(fixture_input).map_err(|e| format!("read {fixture_input}: {e}"))?;
    let input: WorkerInput = serde_json::from_str(&fixture).map_err(|e| format!("fixture input: {e}"))?;
    let out = r.ok(&json(&fixture), BAZAAR)?;
    let res: WorkerResult = serde_json::from_str(&out).map_err(|e| format!("result: {e}"))?;
    ensure(out == run_native(&input, &referee)? && res.body.outcome == "receipt", || "fixture: wasm and native differ, or no receipt".into())?;
    ensure(ed_ok(&res.worker_key, &res.signature, &res.body.signing_message()) && out.len() <= MAX_OUTPUT, || "fixture: signature or size".into())?;
    let mut cheat_input = input.clone();
    cheat_input.claims = serde_json::from_str(&std::fs::read_to_string(fixture_cheat).map_err(|e| format!("read {fixture_cheat}: {e}"))?).map_err(|e| format!("cheat claims: {e}"))?;
    let cheat_fx = r.ok(&serde_json::to_string(&cheat_input).expect("json"), BAZAAR)?;
    let cheat_res: WorkerResult = serde_json::from_str(&cheat_fx).map_err(|e| format!("result: {e}"))?;
    ensure(cheat_fx == run_native(&cheat_input, &referee)? && cheat_res.body.outcome == "refused", || "fixture cheat: wasm and native differ, or not refused".into())?;
    n.pass(
        "fixtures",
        format!("fixtures/ worker input: receipt at {} ({} bytes); with claims-cheat.json: refused, '{}'; both byte-identical to the native worker", res.body.price, out.len(), cheat_res.body.detail),
    );

    // 7. Sealed input: the key comes from the host's mac, a buyer seals to it, only this caller's runs open it.
    let seal_out = r.ok(r#"{"cmd":"sealkey"}"#, BAZAAR)?;
    let pq1 = serde_json::from_str::<serde_json::Value>(&seal_out).ok().and_then(|v| v["seal_key"].as_str().map(String::from)).ok_or("no seal_key")?;
    ensure(keys["keys"]["seal_pq1_sha256"] == hex::encode(Sha256::digest(pq1.as_bytes())).as_str(), || "sealkey is not the key the signed statement names".into())?;
    let s = sealed::seal_v1(&pq1, honest_in.as_bytes(), [9u8; 32], [3u8; 32], [1u8; 24])?;
    let sealed_in = serde_json::json!({ "sealed": s }).to_string();
    ensure(!sealed_in.contains("trips_12m") && s.kem_ct.as_ref().is_some_and(|k| k.len() == 2 * 1088), || "sealed input carries plaintext or no ML-KEM ciphertext".into())?;
    ensure(r.ok(&sealed_in, BAZAAR)? == honest_out, || "the sealed input did not give the receipt of its plaintext".into())?;
    let other = r.run(&sealed_in, MARKET).map_err(|e| format!("{e:#}"))?;
    ensure(other.0 == 1 && other.1.contains("does not open"), || format!("another caller opened it: {other:?}"))?;
    let asked = r.ok(r#"{"sealed":{"epk":"00","nonce":"00","ct":"00","commitment":"00"}}"#, BAZAAR)?;
    ensure(asked == seal_out && r.ok(r#"{"cmd":"sealkey"}"#, MARKET)? != seal_out, || "the sealed-shaped key query, or the per-caller key, is wrong".into())?;
    n.pass(
        "sealed input",
        format!("X25519 + ML-KEM-768 key from the host mac ({} hex chars), a v1 sealed input gives the same receipt, a run called by another account cannot open it", pq1.len()),
    );

    // 8. A dispute is signed by the second host key.
    let v = verdict();
    let d = DisputeInput {
        v: 0,
        issuer_keys: vec![v.key_id()],
        verdict: v,
        result: honest,
        schedule: schedule(),
        claims: honest_claims(),
        proofs: proofs(),
        cohort_k: 0,
        referee_keys: vec![referee_hex.clone()],
        salt: None,
    };
    let out = r.ok(&serde_json::to_string(&d).expect("json"), BAZAAR)?;
    let dec: DisputeDecision = serde_json::from_str(&out).map_err(|e| format!("decision: {e}"))?;
    ensure(out == arbitrate(&d, &mock_signing_key("arbiter"))? && dec.body.decision == "upheld" && dec.arbiter_key != referee_hex, || "dispute: wasm and native differ".into())?;
    n.pass("dispute", format!("upheld, signed by the arbiter host key {} (not the referee key)", dec.arbiter_key));

    // 9. Errors are an answer and a non-zero exit, as in the native worker.
    let bad = r.run(r#"{"cmd":"sign","message":"00"}"#, BAZAAR).map_err(|e| format!("{e:#}"))?;
    ensure(bad.0 == 1 && bad.1.contains("unknown cmd"), || format!("an unknown cmd: {bad:?}"))?;
    n.pass("errors", "an unknown cmd is refused with exit 1; no input can ask for a signature over its own bytes".into());
    Ok(n.0)
}

fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [wasm, input, cheat] = args.as_slice() else {
        eprintln!("usage: bookerbob-outlayer-host <component.wasm> <worker-input.json> <claims-cheat.json>");
        return std::process::ExitCode::from(2);
    };
    println!("outlayer-local: the referee component in wasmtime; the host interfaces are a MOCK (fixed test keys, no TEE, no OutLayer)\n");
    if std::env::var_os("OUTLAYER_LOCAL_DEBUG").is_none() {
        std::panic::set_hook(Box::new(|_| {}));
    }
    match checks(wasm, input, cheat) {
        Ok(n) => {
            println!("\nPASS  outlayer-local: {n} checks. The host key is a MOCK; nothing was sent to OutLayer or to a chain.");
            std::process::ExitCode::SUCCESS
        }
        Err(e) => {
            println!("\nFAIL  outlayer-local: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}
