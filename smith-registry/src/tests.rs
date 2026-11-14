//! The registry's rules on near-sdk's mocked chain. The TEE signature is the real one from the
//! smith's first authorship chat for coalition-k-of-n (zk/smith/programs/.../attempt-1/capture.json).
use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const MODEL: &str = "z-ai/glm-5.3-flash";
const REQ: &str = "e529f052a3bf67eaf5b736d51ae7454cacc42b2b13717a69e82e5946975da359";
const RES: &str = "63b3d7f55e6547a43a4d56844a7048462dc122a30f7f412592c7a1c6f6c52b3b";
const SIG: &str = "8b6286cc11e34a6f1e5270aa153fd509d127297f1d7f15ae96e6f4362c40480910a60801f148feb5b29da3c532fe2baf5f4e9b13ca4709f09775587ad077cf0c";
const KEY: &str = "5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff";
const PH: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const WINDOW: u64 = 60_000;
const RESOLVE: u64 = 120_000;

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(who: &str, ms: u64, deposit: NearToken) {
    testing_env!(VMContextBuilder::new().predecessor_account_id(acct(who)).block_timestamp(ms * 1_000_000).attached_deposit(deposit).build());
}

fn setup() -> Registry {
    ctx("owner.testnet", 1_000, NearToken::from_near(0));
    let mut r = Registry::new(acct("owner.testnet"), acct("smith.testnet"), WINDOW, RESOLVE, NearToken::from_millinear(100));
    r.set_model_key(KEY.into(), MODEL.into());
    ctx("lead.testnet", 1_000, NearToken::from_near(0));
    r.post_request("coalition-k-of-n".into(), "7d92675f839e4acd5b305440d30e2e0e258e70294c050d51bc5b2a0b837d7fc9".into(), None);
    r
}

fn register(r: &mut Registry, signature: &str, response: &str) {
    ctx("smith.testnet", 2_000, NearToken::from_near(0));
    r.register_program("coalition-k-of-n".into(), "22".repeat(32), PH.into(), "33".repeat(32), MODEL.into(), KEY.into(), format!("{MODEL}:{REQ}:{RES}"), signature.into(), response.into());
}

#[test]
fn registers_with_the_real_tee_signature_then_usable_after_accept_and_window() {
    let mut r = setup();
    register(&mut r, SIG, RES);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"register\"")));
    assert_eq!(r.status("coalition-k-of-n".into()), "pending");
    assert_eq!(r.by_program_hash(PH.into()).as_deref(), Some("coalition-k-of-n"));
    ctx("lead.testnet", 3_000, NearToken::from_near(0));
    r.accept("coalition-k-of-n".into(), PH.into());
    assert_eq!(r.status("coalition-k-of-n".into()), "pending", "window still open");
    ctx("anyone.testnet", 2_000 + WINDOW, NearToken::from_near(0));
    assert_eq!(r.status("coalition-k-of-n".into()), "usable");
}

#[test]
#[should_panic(expected = "the TEE signature does not verify")]
fn refuses_a_changed_signature() {
    let mut r = setup();
    let mut bad = SIG.to_string();
    bad.replace_range(0..2, "8c");
    register(&mut r, &bad, RES);
}

#[test]
#[should_panic(expected = "signed text is not")]
fn refuses_a_response_hash_the_key_did_not_sign() {
    let mut r = setup();
    register(&mut r, SIG, &"44".repeat(32));
}

#[test]
#[should_panic(expected = "only the requester accepts")]
fn only_the_requester_accepts() {
    let mut r = setup();
    register(&mut r, SIG, RES);
    ctx("smith.testnet", 3_000, NearToken::from_near(0));
    r.accept("coalition-k-of-n".into(), PH.into());
}

#[test]
fn a_challenge_blocks_use_and_an_upheld_one_rejects() {
    let mut r = setup();
    register(&mut r, SIG, RES);
    ctx("lead.testnet", 3_000, NearToken::from_near(0));
    r.accept("coalition-k-of-n".into(), PH.into());
    ctx("watcher.testnet", 4_000, NearToken::from_millinear(100));
    r.challenge("coalition-k-of-n".into(), "rule 4 not enforced".into());
    ctx("anyone.testnet", 2_000 + WINDOW, NearToken::from_near(0));
    assert_eq!(r.status("coalition-k-of-n".into()), "challenged");
    ctx("owner.testnet", 2_000 + WINDOW, NearToken::from_near(0));
    let _ = r.resolve("coalition-k-of-n".into(), true);
    assert_eq!(r.status("coalition-k-of-n".into()), "rejected");
}

#[test]
#[should_panic(expected = "the challenge window is over")]
fn no_challenge_after_the_window() {
    let mut r = setup();
    register(&mut r, SIG, RES);
    ctx("watcher.testnet", 2_000 + WINDOW, NearToken::from_millinear(100));
    r.challenge("coalition-k-of-n".into(), "late".into());
}

fn usable() -> (Registry, SigningKey) {
    let mut r = setup();
    register(&mut r, SIG, RES);
    ctx("lead.testnet", 3_000, NearToken::from_near(0));
    r.accept("coalition-k-of-n".into(), PH.into());
    let sk = SigningKey::from_bytes(&[7u8; 32]);
    ctx("owner.testnet", 3_000, NearToken::from_near(0));
    r.set_verifier_key("outlayer".into(), hex(sk.verifying_key().as_bytes()));
    ctx("anyone.testnet", 2_000 + WINDOW, NearToken::from_near(0));
    (r, sk)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn signed(sk: &SigningKey, statement: &str) -> String {
    let mut m = STATEMENT_TAG.to_vec();
    m.extend_from_slice(statement.as_bytes());
    hex(&sk.sign(&m).to_bytes())
}

#[test]
fn a_verifier_signed_accept_is_recorded() {
    let (mut r, sk) = usable();
    let st = format!(r#"{{"inputs_sha256":"{}","output_sha256":"{}","panic":false,"program_hash":"{PH}","verdict":"accept"}}"#, "55".repeat(32), "66".repeat(32));
    assert_eq!(r.attest_use("coalition-k-of-n".into(), "outlayer".into(), st.clone(), signed(&sk, &st)), 0);
    assert_eq!(r.get_program("coalition-k-of-n".into()).unwrap().uses, 1);
}

#[test]
#[should_panic(expected = "statement is for another program")]
fn a_verifier_accept_for_another_program_is_refused() {
    let (mut r, sk) = usable();
    let st = format!(r#"{{"output_sha256":"{}","panic":false,"program_hash":"{}","verdict":"accept"}}"#, "66".repeat(32), "77".repeat(32));
    r.attest_use("coalition-k-of-n".into(), "outlayer".into(), st.clone(), signed(&sk, &st));
}

#[test]
#[should_panic(expected = "not an accept")]
fn a_reject_is_not_recorded_as_use() {
    let (mut r, sk) = usable();
    let st = format!(r#"{{"output_sha256":"{}","panic":false,"program_hash":"{PH}","verdict":"reject"}}"#, "66".repeat(32));
    r.attest_use("coalition-k-of-n".into(), "outlayer".into(), st.clone(), signed(&sk, &st));
}

#[test]
#[should_panic(expected = "program is not usable")]
fn no_use_before_the_program_is_usable() {
    let mut r = setup();
    register(&mut r, SIG, RES);
    let sk = SigningKey::from_bytes(&[7u8; 32]);
    ctx("owner.testnet", 3_000, NearToken::from_near(0));
    r.set_verifier_key("outlayer".into(), hex(sk.verifying_key().as_bytes()));
    let st = format!(r#"{{"output_sha256":"{}","panic":false,"program_hash":"{PH}","verdict":"accept"}}"#, "66".repeat(32));
    r.attest_use("coalition-k-of-n".into(), "outlayer".into(), st.clone(), signed(&sk, &st));
}

#[test]
fn the_outlayer_statement_shape_is_recorded_whole() {
    let (mut r, sk) = usable();
    let st = format!(r#"{{"inputs_sha256":"{}","output_sha256":"{}","panic":false,"program_hash":"{PH}","proof_sha256":"{}","verdict":"accept"}}"#, "55".repeat(32), "66".repeat(32), "88".repeat(32));
    let n = r.attest_use("coalition-k-of-n".into(), "outlayer".into(), st.clone(), signed(&sk, &st));
    assert_eq!(r.uses()[n as usize].1.statement, st);
}

#[test]
fn the_owner_pins_a_hand_written_program() {
    let mut r = setup();
    ctx("owner.testnet", 2_000, NearToken::from_near(0));
    r.pin_program("standing-graph".into(), "aa".repeat(32), "bb".repeat(32), "cc".repeat(32), "dd".repeat(32), "zk/guests/standing, Jolt 997c1543".into());
    let p = r.get_program("standing-graph".into()).unwrap();
    assert!(p.model.starts_with("hand-written: ") && p.signature.is_empty() && p.accepted);
    assert_eq!(r.status("standing-graph".into()), "pending");
    ctx("anyone.testnet", 2_000 + WINDOW, NearToken::from_near(0));
    assert_eq!(r.status("standing-graph".into()), "usable");
}

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_pins() {
    let mut r = setup();
    ctx("smith.testnet", 2_000, NearToken::from_near(0));
    r.pin_program("standing-graph".into(), "aa".repeat(32), "bb".repeat(32), "cc".repeat(32), "dd".repeat(32), "x".into());
}

#[test]
#[should_panic(expected = "only the registrar the requester named registers")]
fn a_stranger_cannot_register_first() {
    let mut r = setup();
    ctx("squatter.testnet", 2_000, NearToken::from_near(0));
    r.register_program("coalition-k-of-n".into(), "22".repeat(32), PH.into(), "33".repeat(32), MODEL.into(), KEY.into(), format!("{MODEL}:{REQ}:{RES}"), SIG.into(), RES.into());
}

#[test]
#[should_panic(expected = "the signing key is not an attested key of this model")]
fn a_self_made_key_is_refused() {
    let mut r = setup();
    let sk = SigningKey::from_bytes(&[9u8; 32]);
    let text = format!("{MODEL}:{REQ}:{RES}");
    let sig = hex(&sk.sign(text.as_bytes()).to_bytes());
    ctx("smith.testnet", 2_000, NearToken::from_near(0));
    r.register_program("coalition-k-of-n".into(), "22".repeat(32), PH.into(), "33".repeat(32), MODEL.into(), hex(sk.verifying_key().as_bytes()), text, sig, RES.into());
}

#[test]
fn a_named_registrar_registers() {
    ctx("owner.testnet", 1_000, NearToken::from_near(0));
    let mut r = Registry::new(acct("owner.testnet"), acct("smith.testnet"), WINDOW, RESOLVE, NearToken::from_millinear(100));
    r.set_model_key(KEY.into(), MODEL.into());
    ctx("lead.testnet", 1_000, NearToken::from_near(0));
    r.post_request("coalition-k-of-n".into(), "aa".repeat(32), Some(acct("other-smith.testnet")));
    ctx("other-smith.testnet", 2_000, NearToken::from_near(0));
    r.register_program("coalition-k-of-n".into(), "22".repeat(32), PH.into(), "33".repeat(32), MODEL.into(), KEY.into(), format!("{MODEL}:{REQ}:{RES}"), SIG.into(), RES.into());
    assert_eq!(r.get_program("coalition-k-of-n".into()).unwrap().registrar, acct("other-smith.testnet"));
}

#[test]
fn an_unresolved_challenge_expires_upheld() {
    let mut r = setup();
    register(&mut r, SIG, RES);
    ctx("watcher.testnet", 4_000, NearToken::from_millinear(100));
    r.challenge("coalition-k-of-n".into(), "rule 4".into());
    ctx("anyone.testnet", 4_000 + RESOLVE, NearToken::from_near(0));
    let _ = r.expire("coalition-k-of-n".into());
    assert_eq!(r.status("coalition-k-of-n".into()), "rejected");
}

#[test]
#[should_panic(expected = "past the deadline")]
fn the_owner_cannot_resolve_after_the_deadline() {
    let mut r = setup();
    register(&mut r, SIG, RES);
    ctx("watcher.testnet", 4_000, NearToken::from_millinear(100));
    r.challenge("coalition-k-of-n".into(), "rule 4".into());
    ctx("owner.testnet", 4_000 + RESOLVE, NearToken::from_near(0));
    let _ = r.resolve("coalition-k-of-n".into(), false);
}

#[test]
#[should_panic(expected = "already recorded")]
fn the_same_statement_is_recorded_once() {
    let (mut r, sk) = usable();
    let st = format!(r#"{{"inputs_sha256":"{}","output_sha256":"{}","panic":false,"program_hash":"{PH}","proof_sha256":"{}","verdict":"accept"}}"#, "55".repeat(32), "66".repeat(32), "88".repeat(32));
    r.attest_use("coalition-k-of-n".into(), "outlayer".into(), st.clone(), signed(&sk, &st));
    r.attest_use("coalition-k-of-n".into(), "outlayer".into(), st.clone(), signed(&sk, &st));
}

#[test]
fn the_registrar_supersedes_with_the_same_source_and_the_requester_accepts_again() {
    let mut r = setup();
    register(&mut r, SIG, RES);
    ctx("lead.testnet", 3_000, NearToken::from_near(0));
    r.accept("coalition-k-of-n".into(), PH.into());
    ctx("smith.testnet", 4_000, NearToken::from_near(0));
    r.supersede("coalition-k-of-n".into(), "99".repeat(32), "88".repeat(32), "pinned URS".into());
    let p = r.get_program("coalition-k-of-n".into()).unwrap();
    assert_eq!(p.program_hash, "99".repeat(32));
    assert_eq!(p.elf_hash, "88".repeat(32));
    assert!(!p.accepted);
    assert_eq!(r.by_program_hash(PH.into()), None);
    assert_eq!(r.by_program_hash("99".repeat(32)).as_deref(), Some("coalition-k-of-n"));
    ctx("anyone.testnet", 4_000 + WINDOW, NearToken::from_near(0));
    assert_eq!(r.status("coalition-k-of-n".into()), "pending", "not usable before the requester accepts again");
}

#[test]
#[should_panic(expected = "only the registrar supersedes")]
fn only_the_registrar_supersedes() {
    let mut r = setup();
    register(&mut r, SIG, RES);
    ctx("lead.testnet", 4_000, NearToken::from_near(0));
    r.supersede("coalition-k-of-n".into(), "99".repeat(32), "88".repeat(32), "x".into());
}

#[test]
#[should_panic(expected = "that is not the current program hash")]
fn an_accept_names_the_current_program_hash() {
    let mut r = setup();
    register(&mut r, SIG, RES);
    ctx("smith.testnet", 3_000, NearToken::from_near(0));
    r.supersede("coalition-k-of-n".into(), "99".repeat(32), "88".repeat(32), "re-preprocessed".into());
    ctx("lead.testnet", 4_000, NearToken::from_near(0));
    r.accept("coalition-k-of-n".into(), PH.into());
}

#[test]
#[should_panic(expected = "this authorship response already backs another request")]
fn one_authorship_response_backs_one_request() {
    let mut r = setup();
    register(&mut r, SIG, RES);
    ctx("lead.testnet", 5_000, NearToken::from_near(0));
    r.post_request("another".into(), "bb".repeat(32), None);
    ctx("smith.testnet", 6_000, NearToken::from_near(0));
    r.register_program("another".into(), "22".repeat(32), "aa".repeat(32), "33".repeat(32), MODEL.into(), KEY.into(), format!("{MODEL}:{REQ}:{RES}"), SIG.into(), RES.into());
}

#[test]
fn the_zk_build_of_a_request_may_reuse_its_response() {
    let mut r = setup();
    register(&mut r, SIG, RES);
    ctx("lead.testnet", 5_000, NearToken::from_near(0));
    r.post_request("coalition-k-of-n-zk".into(), "7d92675f839e4acd5b305440d30e2e0e258e70294c050d51bc5b2a0b837d7fc9".into(), None);
    ctx("smith.testnet", 6_000, NearToken::from_near(0));
    r.register_program("coalition-k-of-n-zk".into(), "22".repeat(32), "aa".repeat(32), "33".repeat(32), MODEL.into(), KEY.into(), format!("{MODEL}:{REQ}:{RES}"), SIG.into(), RES.into());
    assert_eq!(r.status("coalition-k-of-n-zk".into()), "pending");
}

#[test]
#[should_panic(expected = "a -zk request must have its base request's requester, registrar and spec")]
fn a_stranger_cannot_post_the_zk_request_of_another() {
    let mut r = setup();
    register(&mut r, SIG, RES);
    ctx("squatter.testnet", 5_000, NearToken::from_near(0));
    r.post_request("coalition-k-of-n-zk".into(), "7d92675f839e4acd5b305440d30e2e0e258e70294c050d51bc5b2a0b837d7fc9".into(), None);
}

#[test]
#[should_panic(expected = "a -zk request needs its base request")]
fn a_zk_request_needs_its_base() {
    let mut r = setup();
    ctx("squatter.testnet", 5_000, NearToken::from_near(0));
    r.post_request("coalition-split-zk".into(), "aa".repeat(32), None);
}

#[test]
#[should_panic(expected = "a -zk program must have its base program's source and authorship")]
fn a_zk_program_has_its_base_source() {
    let mut r = setup();
    register(&mut r, SIG, RES);
    ctx("lead.testnet", 5_000, NearToken::from_near(0));
    r.post_request("coalition-k-of-n-zk".into(), "7d92675f839e4acd5b305440d30e2e0e258e70294c050d51bc5b2a0b837d7fc9".into(), None);
    ctx("smith.testnet", 6_000, NearToken::from_near(0));
    r.register_program("coalition-k-of-n-zk".into(), "ee".repeat(32), "aa".repeat(32), "33".repeat(32), MODEL.into(), KEY.into(), format!("{MODEL}:{REQ}:{RES}"), SIG.into(), RES.into());
}
