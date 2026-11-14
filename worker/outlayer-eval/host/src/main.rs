//! The evaluator component (worker/outlayer-eval) run in wasmtime with a MOCK of OutLayer's
//! signing host: fixed test keys derived from a label, not a TEE, not OutLayer's keystore. Each
//! case seals a real committed presentation to the component's seal key, runs the wasm, and checks
//! the signed output the way `submit_verdict` would (ed25519 over sha256(signing_message)).
use base64::Engine as _;
use bookerbob_core::envelope::SignedVerdict;
use bookerbob_eval_outlayer::{EvalInput, Keys};
use bookerbob_referee_worker::sealed;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier};
use sha2::{Digest, Sha256};
use bookerbob_bazaar::{Bazaar, RECORD_DEPOSIT};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId};
use std::panic::{catch_unwind, AssertUnwindSafe};
use wasmtime::component::{Component, HasSelf, Linker, ResourceTable};
use wasmtime::{Engine, Store};
use wasmtime_wasi::p2::bindings::sync::Command;
use wasmtime_wasi::p2::pipe::{MemoryInputPipe, MemoryOutputPipe};
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};

wasmtime::component::bindgen!({ world: "referee", path: "../wit" });
use outlayer::encryption_keys::api as enc;
use outlayer::signing_keys::api as sig;

const MANIFEST: &str = include_str!("../../manifest.json");

fn mock(path: &str) -> SigningKey {
    SigningKey::from_bytes(&Sha256::digest(format!("MOCK outlayer signing key|{path}")).into())
}

struct Host {
    wasi: WasiCtx,
    table: ResourceTable,
    paths: Vec<String>,
}
impl WasiView for Host {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView { ctx: &mut self.wasi, table: &mut self.table }
    }
}
impl Host {
    fn key(&self, path: &str, vault: &Option<String>) -> Result<SigningKey, String> {
        if vault.is_some() || !self.paths.iter().any(|p| p == path) {
            return Err(format!("signing key {path:?} is not declared in the manifest"));
        }
        Ok(mock(path))
    }
}
impl sig::Host for Host {
    fn public_key(&mut self, path: String, vault: Option<String>) -> Result<Vec<u8>, String> {
        Ok(self.key(&path, &vault)?.verifying_key().to_bytes().to_vec())
    }
    fn sign(&mut self, path: String, vault: Option<String>, message: Vec<u8>) -> Result<Vec<u8>, String> {
        Ok(self.key(&path, &vault)?.sign(&message).to_bytes().to_vec())
    }
    fn sign_nep413(&mut self, _: String, _: Option<String>, _: String, _: String, _: Vec<u8>, _: Option<String>) -> Result<sig::Nep413Signature, String> {
        Err("not in the mock".into())
    }
}
impl enc::Host for Host {
    fn encrypt(&mut self, _: String, _: Option<String>, _: Vec<u8>, _: Vec<u8>) -> Result<Vec<u8>, String> {
        Err("the evaluator declares no encryption key".into())
    }
    fn decrypt(&mut self, _: String, _: Option<String>, _: Vec<u8>, _: Vec<u8>) -> Result<Vec<u8>, String> {
        Err("the evaluator declares no encryption key".into())
    }
    fn mac(&mut self, _: String, _: Option<String>, _: Vec<u8>) -> Result<Vec<u8>, String> {
        Err("the evaluator declares no encryption key".into())
    }
}

/// The real bazaar code on near-sdk's MockedBlockchain: a fresh chain, the evaluator key
/// registered as an issuer when `register`, then each (caller, verdict) through `submit_verdict`.
fn on_chain(register: bool, subs: &[(&str, &SignedVerdict)]) -> Vec<Result<String, String>> {
    let set = |who: &str, now_ms: u64| {
        let mut b = VMContextBuilder::new();
        let acc: AccountId = who.parse().unwrap();
        b.current_account_id("bazaar.testnet".parse().unwrap()).predecessor_account_id(acc).block_timestamp(now_ms * 1_000_000).attached_deposit(RECORD_DEPOSIT);
        testing_env!(b.build());
    };
    let t = subs[0].1.envelope.issued_at_ms + 1000;
    set("owner.testnet", t);
    drop(near_sdk::mock::with_mocked_blockchain(|b| b.take_storage()));
    set("owner.testnet", t);
    let mut c = Bazaar::new("owner.testnet".parse().unwrap(), "usdc.testnet".parse().unwrap());
    if register {
        c.register_issuer(subs[0].1.key_id(), "MOCK OutLayer evaluator key".into());
    }
    subs.iter()
        .map(|(who, v)| {
            set(who, t);
            catch_unwind(AssertUnwindSafe(|| c.submit_verdict((*v).clone())))
                .map(|_| c.verdict(v.envelope.nullifier.clone()).map(|r| r.issuer).unwrap_or_default())
                .map_err(|p| p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "panic".into()))
                .map_err(|m| m.split("panic_msg: \"").nth(1).and_then(|x| x.split('"').next()).map(str::to_string).unwrap_or(m))
        })
        .collect()
}

struct MockKeys;
impl Keys for MockKeys {
    fn public_key(&self, p: &str) -> Result<[u8; 32], String> {
        Ok(mock(p).verifying_key().to_bytes())
    }
    fn sign(&self, p: &str, m: &[u8]) -> Result<[u8; 64], String> {
        Ok(mock(p).sign(m).to_bytes())
    }
}

fn run(engine: &Engine, component: &Component, linker: &Linker<Host>, input: &str) -> anyhow::Result<(bool, String)> {
    let manifest: serde_json::Value = serde_json::from_str(MANIFEST)?;
    let paths = manifest["signing_keys"].as_array().unwrap().iter().map(|k| k["path"].as_str().unwrap().to_string()).collect();
    let stdout = MemoryOutputPipe::new(1 << 20);
    let wasi = wasmtime_wasi::WasiCtxBuilder::new().stdin(MemoryInputPipe::new(input.as_bytes().to_vec())).stdout(stdout.clone()).build();
    let mut store = Store::new(engine, Host { wasi, table: ResourceTable::new(), paths });
    let cmd = Command::instantiate(&mut store, component, linker)?;
    let ok = matches!(cmd.wasi_cli_run().call_run(&mut store), Ok(Ok(())));
    drop(store);
    Ok((ok, String::from_utf8(stdout.contents().to_vec())?))
}

fn main() -> anyhow::Result<()> {
    // The contract's expected refusals are panics; keep their default messages off the screen.
    std::panic::set_hook(Box::new(|_| {}));
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("raw") && args.len() == 3 {
        // `raw <component.wasm> <stdin file>`: one run, the output printed.
        let engine = Engine::default();
        let component = Component::new(&engine, std::fs::read(&args[1])?)?;
        let mut linker = Linker::<Host>::new(&engine);
        wasmtime_wasi::p2::add_to_linker_sync(&mut linker)?;
        Referee::add_to_linker::<_, HasSelf<_>>(&mut linker, |h| h)?;
        let (ok, out) = run(&engine, &component, &linker, &std::fs::read_to_string(&args[2])?)?;
        println!("{} {out}", if ok { "OK" } else { "FAILED" });
        return Ok(());
    }
    let [wasm, owner, public] = args.as_slice() else { anyhow::bail!("usage: bookerbob-eval-host <component.wasm> <owner.presentation> <public.presentation>") };
    let engine = Engine::default();
    let component = Component::new(&engine, std::fs::read(wasm)?)?;
    let mut linker = Linker::<Host>::new(&engine);
    wasmtime_wasi::p2::add_to_linker_sync(&mut linker)?;
    Referee::add_to_linker::<_, HasSelf<_>>(&mut linker, |h| h)?;
    let ek = mock("evaluator").verifying_key();
    let mut n = 0;
    let mut pass = |name: &str, what: String| {
        n += 1;
        println!("PASS  {name}: {what}");
    };

    // 1. pubkey from the wasm: signed, and byte-identical to the native library's.
    let (ok, out) = run(&engine, &component, &linker, r#"{"cmd":"pubkey"}"#)?;
    let p: serde_json::Value = serde_json::from_str(&out)?;
    let mut m = b"bookerbob/eval-keys/v1\x00".to_vec();
    m.extend(serde_json::to_vec(&p["keys"])?);
    anyhow::ensure!(ok && ek.verify(&m, &Signature::from_slice(&hex::decode(p["signature"].as_str().unwrap())?)?).is_ok(), "pubkey statement");
    anyhow::ensure!(out == bookerbob_eval_outlayer::pubkey(&MockKeys).unwrap(), "wasm pubkey differs from native");
    let seal = p["keys"]["seal_x25519"].as_str().unwrap().to_string();
    pass("pubkey", format!("evaluator {}.., seal {}.., contexts {}, {} bytes, identical to the native library", &p["keys"]["evaluator_key"].as_str().unwrap()[..12], &seal[..12], p["keys"]["contexts"], out.len()));

    // 2. The wasm on the real presentations: verified by TLSNotary inside the component, then
    //    refused by the v1 policy (notarized 2026-11-13 under v0's request shape).
    let b64 = |f: &str| -> anyhow::Result<String> { Ok(base64::engine::general_purpose::STANDARD.encode(std::fs::read(f)?)) };
    let case = |file: &str, cnf: &str| -> anyhow::Result<(bool, String)> {
        let i = EvalInput { context: "bookerbob:v0:evaltee-github".into(), cnf: cnf.into(), max_spend: 50_000_000, ttl_ms: 1_800_000, predicates: vec![], salt: "11".repeat(32), presentations: vec![b64(file)?] };
        let s = sealed::seal(&seal, &serde_json::to_vec(&i)?, [7; 32], [9; 24]).map_err(anyhow::Error::msg)?;
        run(&engine, &component, &linker, &serde_json::json!({ "sealed": s }).to_string())
    };
    let refusal = |out: &str| -> anyhow::Result<String> {
        let r: serde_json::Value = serde_json::from_str(out)?;
        let mut m = b"bookerbob/eval-refusal/v1\x00".to_vec();
        m.extend(serde_json::to_vec(&r["refusal"])?);
        ek.verify(&m, &Signature::from_slice(&hex::decode(r["signature"].as_str().unwrap_or(""))?)?)?;
        Ok(r["refusal"]["reason"].as_str().unwrap_or("").to_string())
    };
    for (f, what) in [(owner, "the founder's signed-in v0-era presentation"), (public, "the TDX-notarized public octocat profile")] {
        let t = std::time::Instant::now();
        let (_, out) = case(f, "buyer.testnet")?;
        let r = refusal(&out)?;
        anyhow::ensure!(r == "session not fresh", "{what}: {r}");
        pass("v1 refuses", format!("{what}: verified inside the component, refused as \"{r}\" (signed, names no presentation), {} ms", t.elapsed().as_millis()));
    }
    let (ok, out) = run(&engine, &component, &linker, r#"{"context":"x SECRET"}"#)?;
    anyhow::ensure!(!ok && out.contains("input must be sealed") && !out.contains("SECRET"), "plaintext: {out}");
    pass("plaintext refused", "an unsealed input is an error, nothing signed, nothing echoed".into());

    // 3. The verdict layer (the same library the wasm runs) into the real bazaar code.
    let i = |cnf: &str| EvalInput { context: "bookerbob:v0:evaltee-github".into(), cnf: cnf.into(), max_spend: 50_000_000, ttl_ms: 1_800_000, predicates: vec![], salt: "22".repeat(32), presentations: vec![] };
    let acct = bookerbob_eval_outlayer::Account { id: 583231, created_secs: 1_296_000_000, time_secs: 1_794_650_000 };
    let mk = |cnf: &str| -> anyhow::Result<SignedVerdict> { Ok(serde_json::from_str(&bookerbob_eval_outlayer::evaluate_account(&MockKeys, &i(cnf), &acct, &"ab".repeat(32), 1_794_650_000_000).map_err(anyhow::Error::msg)?)?) };
    let (v, v2) = (mk("buyer.testnet")?, mk("sybil.testnet")?);
    let r = on_chain(true, &[("buyer.testnet", &v), ("sybil.testnet", &v2)]);
    anyhow::ensure!(r[0].as_deref() == Ok(&format!("ed25519:{}", hex::encode(ek.to_bytes()))[..]), "submit_verdict: {:?}", r[0]);
    pass("bazaar accepts", format!("submit_verdict records the v1 verdict under the evaluator key {}..", &r[0].as_ref().unwrap()[..20]));
    anyhow::ensure!(matches!(&r[1], Err(e) if e.contains("nullifier pending")), "sybil: {:?}", r[1]);
    pass("bazaar refuses the sybil", format!("the same GitHub id under a second agent: {}", r[1].as_ref().unwrap_err()));
    let r = on_chain(false, &[("buyer.testnet", &v)]);
    anyhow::ensure!(matches!(&r[0], Err(e) if e.contains("unknown enclave key")), "unregistered: {:?}", r[0]);
    pass("unregistered key refused", "a bazaar that does not list the key refuses the verdict".into());
    let mut forged = v.clone();
    forged.envelope.predicates = vec!["github_builder".into()];
    let r = on_chain(true, &[("buyer.testnet", &forged)]);
    anyhow::ensure!(matches!(&r[0], Err(e) if e.contains("bad signature")), "forged: {:?}", r[0]);
    pass("forged predicate refused", "github_builder added to the signed envelope breaks the signature".into());
    println!("\nPASS  outlayer-eval local: {n} checks. The host keys are a MOCK; nothing was sent to OutLayer or to a chain.");
    Ok(())
}
