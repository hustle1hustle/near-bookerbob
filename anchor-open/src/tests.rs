use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const SRC: &str = "near:testnet:bookerbob";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn as_caller(who: &str, deposit_millinear: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("anchor.test"))
        .predecessor_account_id(acc(who))
        .attached_deposit(NearToken::from_millinear(deposit_millinear))
        .block_timestamp(NOW)
        .build());
}

fn fresh() -> OpenAnchor {
    as_caller("p.test", 100);
    OpenAnchor::new()
}

fn refused(f: impl FnOnce() + std::panic::UnwindSafe, why: &str) {
    let err = std::panic::catch_unwind(f).expect_err("the call should be refused");
    let text = err.downcast_ref::<String>().cloned().or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
    assert!(text.contains(why), "expected `{why}`, got `{text}`");
}

/// One record by the documented layout (docs/anchor-format.md).
fn rec(height: u64, ts: u64, receipt: u8, index: u16, executor: &str, json: &str) -> Vec<u8> {
    let mut b = vec![RECORD_VERSION];
    b.extend_from_slice(&height.to_be_bytes());
    b.extend_from_slice(&ts.to_be_bytes());
    b.extend_from_slice(&[receipt; 32]);
    b.extend_from_slice(&index.to_be_bytes());
    b.push(executor.len() as u8);
    b.extend_from_slice(executor.as_bytes());
    b.extend_from_slice(&(json.len() as u32).to_be_bytes());
    b.extend_from_slice(json.as_bytes());
    b
}

fn post(src: &str, seq: u64, prev: [u8; 32], epoch: u64, records: Vec<Vec<u8>>) -> Post {
    Post { source: src.into(), seq, prev, epoch, records }
}

fn unhex(h: &str) -> [u8; 32] {
    let mut o = [0u8; 32];
    for i in 0..32 {
        o[i] = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap();
    }
    o
}

const T5: u64 = 5 * EPOCH_NS + 1;
/// Block time in the tests: well after every epoch used (the real ones are about 498,500).
const NOW: u64 = 600_000 * EPOCH_NS;

#[test]
fn the_shared_vector_matches_the_script() {
    // Same inputs as scripts/econ/anchor.test.mjs: both sides must give these hashes.
    let recs = vec![rec(100, T5, 7, 0, "a.test", "{}"), rec(100, T5, 7, 1, "a.test", "{\"x\":1}")];
    assert_eq!(
        to_hex(&recs[0]),
        "0100000000000000640000105ef39b20010707070707070707070707070707070707070707070707070707070707070707000006612e74657374000000027b7d"
    );
    let (events, root) = epoch_root("s", 5, &recs);
    assert_eq!(to_hex(&events), "ede4c4ace28a90713e9538c2169437a56db939e371df29812d4175abafbccf2f");
    assert_eq!(to_hex(&root), "d21237daccafdd75cdc9be0ca26ab1137cab97fc702ec53272e003891a857a25");
    let mut a = fresh();
    let h = a.post(post("s", 0, GENESIS, 5, recs));
    assert_eq!(h, "e40b3efb65bdd1dadea051c0a0d7323b3d29729dd297db26b10599097055a4ec");
    let e = a.get(acc("p.test"), "s".into(), 0).unwrap();
    assert_eq!((e.epoch, e.n, e.root.as_str(), e.head.as_str()), (5, 2, to_hex(&root).as_str(), h.as_str()));
}

#[test]
fn a_post_chains_and_logs_one_event() {
    let mut a = fresh();
    let h0 = a.post(post(SRC, 0, GENESIS, 5, vec![rec(1, T5, 1, 0, "b.test", "{}")]));
    let h1 = a.post(post(SRC, 1, unhex(&h0), 9, vec![rec(2, 9 * EPOCH_NS, 1, 0, "b.test", "{}")]));
    assert_eq!(a.len(acc("p.test"), SRC.into()), 2);
    assert_eq!(a.head(acc("p.test"), SRC.into()), h1);
    let logs = get_logs();
    let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(logs.last().unwrap().strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(v["standard"], "bookerbob-anchor-open");
    assert_eq!(v["data"][0]["seq"], 1);
    assert_eq!(v["data"][0]["epoch"], 9);
    assert_eq!(v["data"][0]["head"], h1.as_str());
    assert_eq!(v["data"][0]["prev"], h0.as_str());
    let c = a.chains(None, None);
    assert_eq!(c.len(), 1);
    assert_eq!((c[0].poster.as_str(), c[0].len, c[0].last_epoch), ("p.test", 2, 9));
}

#[test]
fn anyone_posts_and_each_poster_has_its_own_chain() {
    let mut a = fresh();
    let r = || vec![rec(1, T5, 1, 0, "b.test", "{}")];
    let mine = a.post(post(SRC, 0, GENESIS, 5, r()));
    as_caller("other.test", 100);
    // Same source, same records: another chain, another head (the poster is under the hash).
    let theirs = a.post(post(SRC, 0, GENESIS, 5, r()));
    assert_ne!(mine, theirs);
    assert_eq!(a.head(acc("p.test"), SRC.into()), mine);
    assert_eq!(a.head(acc("other.test"), SRC.into()), theirs);
    assert_eq!(a.get(acc("p.test"), SRC.into(), 0).unwrap().root, a.get(acc("other.test"), SRC.into(), 0).unwrap().root);
    assert_eq!(a.chains(None, None).len(), 2);
}

#[test]
fn wrong_seq_prev_or_epoch_is_refused() {
    // The mocked storage persists across contexts: each case uses its own source.
    let r = |e: u64| vec![rec(1, e * EPOCH_NS, 1, 0, "b.test", "{}")];
    let mut a = fresh();
    let h0 = unhex(&a.post(post("s1", 0, GENESIS, 5, r(5))));
    let a1 = OpenAnchor { tips: LookupMap::new(b"t"), entries: LookupMap::new(b"e"), chains: Vector::new(b"c") };
    let mut b = a1;
    refused(move || drop(b.post(post("s1", 2, h0, 6, r(6)))), "seq must be 1");
    let mut c = OpenAnchor { tips: LookupMap::new(b"t"), entries: LookupMap::new(b"e"), chains: Vector::new(b"c") };
    refused(move || drop(c.post(post("s1", 1, GENESIS, 6, r(6)))), "prev is not the current head");
    let mut d = OpenAnchor { tips: LookupMap::new(b"t"), entries: LookupMap::new(b"e"), chains: Vector::new(b"c") };
    refused(move || drop(d.post(post("s1", 1, h0, 5, r(5)))), "epoch must be after 5");
    let mut e = OpenAnchor { tips: LookupMap::new(b"t"), entries: LookupMap::new(b"e"), chains: Vector::new(b"c") };
    refused(move || drop(e.post(post("s2", 0, GENESIS, 5, vec![]))), "at least one record");
    // A replay of seq 0, byte for byte.
    let mut f = OpenAnchor { tips: LookupMap::new(b"t"), entries: LookupMap::new(b"e"), chains: Vector::new(b"c") };
    refused(move || drop(f.post(post("s1", 0, GENESIS, 5, r(5)))), "seq must be 1");
    assert_eq!(a.len(acc("p.test"), "s1".into()), 1);
}

#[test]
fn an_open_or_future_epoch_is_refused() {
    let mut a = fresh();
    let open = NOW / EPOCH_NS;
    refused(move || drop(a.post(post("s9", 0, GENESIS, open, vec![rec(1, open * EPOCH_NS, 1, 0, "b.test", "{}")]))), "epoch is not closed yet");
    let mut b = OpenAnchor { tips: LookupMap::new(b"t"), entries: LookupMap::new(b"e"), chains: Vector::new(b"c") };
    refused(move || drop(b.post(post("s9", 0, GENESIS, open + 5, vec![rec(1, (open + 5) * EPOCH_NS, 1, 0, "b.test", "{}")]))), "epoch is not closed yet");
    let mut c = OpenAnchor { tips: LookupMap::new(b"t"), entries: LookupMap::new(b"e"), chains: Vector::new(b"c") };
    c.post(post("s9", 0, GENESIS, open - 1, vec![rec(1, (open - 1) * EPOCH_NS, 1, 0, "b.test", "{}")]));
}

#[test]
fn records_out_of_order_duplicated_or_outside_the_epoch_are_refused() {
    let mut a = fresh();
    refused(
        move || drop(a.post(post(SRC, 0, GENESIS, 5, vec![rec(2, T5, 1, 0, "b.test", "{}"), rec(1, T5, 1, 0, "b.test", "{}")]))),
        "record 1: not after record 0",
    );
    let mut a = fresh();
    let same = rec(1, T5, 1, 0, "b.test", "{}");
    refused(move || drop(a.post(post(SRC, 0, GENESIS, 5, vec![same.clone(), same]))), "record 1: not after record 0");
    let mut a = fresh();
    refused(move || drop(a.post(post(SRC, 0, GENESIS, 5, vec![rec(1, 6 * EPOCH_NS, 1, 0, "b.test", "{}")]))), "outside the epoch");
    let mut a = fresh();
    let mut long = rec(1, T5, 1, 0, "b.test", "{}");
    long.push(0);
    refused(move || drop(a.post(post(SRC, 0, GENESIS, 5, vec![long]))), "length does not match");
    let mut a = fresh();
    let mut v2 = rec(1, T5, 1, 0, "b.test", "{}");
    v2[0] = 2;
    refused(move || drop(a.post(post(SRC, 0, GENESIS, 5, vec![v2]))), "unknown version");
}

#[test]
fn a_poster_without_a_deposit_is_refused_and_the_rest_comes_back() {
    let mut a = fresh();
    as_caller("other.test", 0);
    refused(move || drop(a.post(post(SRC, 0, GENESIS, 5, vec![rec(1, T5, 1, 0, "b.test", "{}")]))), "attach at least");
    // The anchor account itself posts from its own balance (its post-only key carries no deposit).
    let mut b = fresh();
    as_caller("anchor.test", 0);
    b.post(post(SRC, 0, GENESIS, 5, vec![rec(1, T5, 1, 0, "b.test", "{}")]));
    assert_eq!(b.len(acc("anchor.test"), SRC.into()), 1);
}

/// The real economy (fixtures/live/econ/epochs.json, computed by scripts/econ/anchor.mjs from
/// the testnet contracts' public txs) through this contract's code: every root and head the
/// script computed is what the contract computes.
#[test]
fn the_real_epochs_through_the_contract() {
    use near_sdk::base64::Engine;
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/live/econ/epochs.json");
    let Ok(text) = std::fs::read_to_string(path) else { return };
    let eps: Vec<near_sdk::serde_json::Value> = near_sdk::serde_json::from_str(&text).unwrap();
    let chain: near_sdk::serde_json::Value =
        near_sdk::serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/live/econ/chain.json")).unwrap()).unwrap();
    let poster = chain["poster"].as_str().unwrap();
    let mut cfg = near_sdk::test_vm_config();
    cfg.limit_config.max_total_log_length = u64::MAX / 2;
    testing_env!(VMContextBuilder::new().current_account_id(acc(poster)).predecessor_account_id(acc(poster)).block_timestamp(NOW).build(), cfg);
    let mut a = OpenAnchor::new();
    let mut prev = GENESIS;
    for (seq, e) in eps.iter().enumerate() {
        let records: Vec<Vec<u8>> =
            e["records"].as_array().unwrap().iter().map(|r| near_sdk::base64::engine::general_purpose::STANDARD.decode(r.as_str().unwrap()).unwrap()).collect();
        let h = a.post(post(chain["source"].as_str().unwrap(), seq as u64, prev, e["epoch"].as_u64().unwrap(), records));
        assert_eq!(h, e["head"].as_str().unwrap(), "seq {seq}");
        assert_eq!(a.get(acc(poster), chain["source"].as_str().unwrap().into(), seq as u64).unwrap().root, e["root"].as_str().unwrap());
        prev = unhex(&h);
    }
    assert!(eps.len() > 10);
}
