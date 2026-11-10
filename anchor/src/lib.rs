//! History anchor (`bookerbob-anchor.testnet`): a market runs on another chain, its history is
//! kept here. One pinned poster appends round roots, one chain per `source` (the foreign market,
//! named by chain id and contract address). Each post names the next `seq` and the current head;
//! the new head is sha256 over (source, seq, prev, root, meta), so changing an old round changes
//! every later head, and a round cannot be skipped or posted twice.
//!
//! There is no owner and no method that rewrites or deletes an entry. What the contract does not
//! know: whether a root is true. It only keeps what the poster sent, in order (docs/anchor.md).
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

/// Domain tag of the head hash.
pub const HEAD_TAG: &[u8] = b"bookerbob-anchor/head/v1";
/// The head of a source with no posts: 32 zero bytes.
pub const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";
pub const MAX_SOURCE: usize = 128;
pub const MAX_META: usize = 512;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    /// The head before this post.
    pub prev: String,
    /// The round root, as the poster computed it from the foreign chain.
    pub root: String,
    /// Free text from the poster (the round number, its block range, its part hashes).
    pub meta: String,
    /// The head after this post.
    pub head: String,
    pub block_height: u64,
    pub timestamp_ms: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct Tip {
    len: u64,
    head: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Anchor {
    poster: AccountId,
    tips: LookupMap<String, Tip>,
    entries: LookupMap<(String, u64), Entry>,
}

fn hash32(hex: &str, what: &str) -> [u8; 32] {
    let ok = hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    require!(ok, format!("{what} must be 64 lowercase hex characters"));
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap_or_else(|_| env::panic_str("bad hex"));
    }
    out
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The canonical bytes under the head hash. Lengths are big-endian and prefix both strings, so
/// no two different posts encode to the same bytes:
/// `tag || u32(len source) || source || u64(seq) || prev(32) || root(32) || u32(len meta) || meta`.
pub fn head_preimage(source: &str, seq: u64, prev: &[u8; 32], root: &[u8; 32], meta: &str) -> Vec<u8> {
    let mut b = Vec::with_capacity(HEAD_TAG.len() + 4 + source.len() + 8 + 64 + 4 + meta.len());
    b.extend_from_slice(HEAD_TAG);
    b.extend_from_slice(&(source.len() as u32).to_be_bytes());
    b.extend_from_slice(source.as_bytes());
    b.extend_from_slice(&seq.to_be_bytes());
    b.extend_from_slice(prev);
    b.extend_from_slice(root);
    b.extend_from_slice(&(meta.len() as u32).to_be_bytes());
    b.extend_from_slice(meta.as_bytes());
    b
}

#[near]
impl Anchor {
    #[init]
    pub fn new(poster: AccountId) -> Self {
        Self { poster, tips: LookupMap::new(b"t"), entries: LookupMap::new(b"e") }
    }

    /// Appends one round root to `source`'s chain and returns the new head. Only the pinned
    /// poster; `seq` is the number of posts so far; `prev` is the current head. The poster pays
    /// the storage: an attached deposit covers it and the rest comes back, or, when the poster
    /// is this account itself, the account's own balance covers it.
    #[payable]
    pub fn post(&mut self, source: String, seq: u64, prev: String, root: String, meta: String) -> String {
        let caller = env::predecessor_account_id();
        require!(caller == self.poster, "only the pinned poster may post");
        require!(!source.is_empty() && source.len() <= MAX_SOURCE, "source must be 1 to 128 bytes");
        require!(meta.len() <= MAX_META, "meta must be at most 512 bytes");
        let tip = self.tips.get(&source).cloned().unwrap_or(Tip { len: 0, head: GENESIS.to_string() });
        require!(seq == tip.len, format!("seq must be {}", tip.len));
        require!(prev == tip.head, "prev is not the current head");
        let head = to_hex(&env::sha256(head_preimage(&source, seq, &hash32(&prev, "prev"), &hash32(&root, "root"), &meta)));

        let before = env::storage_usage();
        let entry = Entry { prev, root, meta, head: head.clone(), block_height: env::block_height(), timestamp_ms: env::block_timestamp_ms() };
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"bookerbob-anchor\",\"version\":\"1.0.0\",\"event\":\"post\",\"data\":[{{\"source\":{},\"seq\":{},\"prev\":\"{}\",\"root\":\"{}\",\"head\":\"{}\",\"meta\":{}}}]}}",
            json_str(&source),
            seq,
            entry.prev,
            entry.root,
            head,
            json_str(&entry.meta)
        ));
        self.entries.insert((source.clone(), seq), entry);
        self.tips.insert(source, Tip { len: seq + 1, head: head.clone() });
        self.entries.flush();
        self.tips.flush();

        let cost = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage().saturating_sub(before)));
        let paid = env::attached_deposit();
        if caller == env::current_account_id() {
            // The deposit came from this account's balance and is back in it; nothing to refund.
        } else {
            require!(paid >= cost, format!("attach at least {} yoctoNEAR for storage", cost.as_yoctonear()));
            let back = paid.saturating_sub(cost);
            if back > NearToken::from_yoctonear(0) {
                Promise::new(caller).transfer(back).detach();
            }
        }
        head
    }

    /// The current head of `source`: 64 zeros before its first post.
    pub fn head(&self, source: String) -> String {
        self.tips.get(&source).map_or_else(|| GENESIS.to_string(), |t| t.head.clone())
    }

    /// The number of posts for `source`; the next `seq`.
    pub fn len(&self, source: String) -> u64 {
        self.tips.get(&source).map_or(0, |t| t.len)
    }

    pub fn get(&self, source: String, seq: u64) -> Option<Entry> {
        self.entries.get(&(source, seq)).cloned()
    }

    pub fn poster(&self) -> AccountId {
        self.poster.clone()
    }
}

/// A JSON string literal (quotes, backslashes and control characters escaped).
fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    const ARC: &str = "eip155:5042002:0xcfbbe8aa3c231f3345afa7798f65b03e2738d56f";
    const OTHER: &str = "near:testnet:bookerbob.testnet";

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn as_caller(who: &str, deposit_millinear: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("anchor.test"))
            .predecessor_account_id(acc(who))
            .attached_deposit(NearToken::from_millinear(deposit_millinear))
            .build());
    }

    fn root(n: u8) -> String {
        to_hex(&[n; 32])
    }

    fn fresh() -> Anchor {
        as_caller("poster.test", 100);
        Anchor::new(acc("poster.test"))
    }

    fn refused(f: impl FnOnce() + std::panic::UnwindSafe, why: &str) {
        let err = std::panic::catch_unwind(f).expect_err("the call should be refused");
        let text = err.downcast_ref::<String>().cloned().or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
        assert!(text.contains(why), "expected `{why}`, got `{text}`");
    }

    #[test]
    fn a_post_chains_and_the_head_is_recomputable() {
        let mut a = fresh();
        assert_eq!(a.head(ARC.into()), GENESIS);
        assert_eq!(a.len(ARC.into()), 0);
        let h0 = a.post(ARC.into(), 0, GENESIS.into(), root(1), "{\"round\":7}".into());
        let h1 = a.post(ARC.into(), 1, h0.clone(), root(2), String::new());
        assert_eq!(a.len(ARC.into()), 2);
        assert_eq!(a.head(ARC.into()), h1);
        assert_eq!(a.poster(), acc("poster.test"));

        // The head from the documented bytes alone, with no call into the contract.
        let mut bytes = b"bookerbob-anchor/head/v1".to_vec();
        bytes.extend_from_slice(&(ARC.len() as u32).to_be_bytes());
        bytes.extend_from_slice(ARC.as_bytes());
        bytes.extend_from_slice(&0u64.to_be_bytes());
        bytes.extend_from_slice(&[0u8; 32]);
        bytes.extend_from_slice(&[1u8; 32]);
        bytes.extend_from_slice(&11u32.to_be_bytes());
        bytes.extend_from_slice(b"{\"round\":7}");
        assert_eq!(h0, to_hex(&env::sha256(&bytes)));
        // A vector shared with scripts/anchor.test.mjs: both sides must give these bytes' hash.
        assert_eq!(h0, "2df249c9c8fb11efc86a5dfb251df8503d3289b143bf911ddf5cbb2bee9d812f");

        let e1 = a.get(ARC.into(), 1).unwrap();
        assert_eq!((e1.prev.as_str(), e1.root.as_str(), e1.head.as_str()), (h0.as_str(), root(2).as_str(), h1.as_str()));
        assert_eq!(h1, to_hex(&env::sha256(head_preimage(ARC, 1, &hash32(&h0, "prev"), &[2u8; 32], ""))));
        assert!(a.get(ARC.into(), 2).is_none());
    }

    #[test]
    fn a_post_logs_one_nep297_event() {
        let mut a = fresh();
        let h0 = a.post(ARC.into(), 0, GENESIS.into(), root(1), "a \"quoted\" note".into());
        let logs = get_logs();
        assert_eq!(logs.len(), 1);
        let json = logs[0].strip_prefix("EVENT_JSON:").expect("a NEP-297 log");
        let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(json).expect("valid JSON");
        assert_eq!(v["standard"], "bookerbob-anchor");
        assert_eq!(v["event"], "post");
        assert_eq!(v["data"][0]["source"], ARC);
        assert_eq!(v["data"][0]["seq"], 0);
        assert_eq!(v["data"][0]["head"], h0.as_str());
        assert_eq!(v["data"][0]["meta"], "a \"quoted\" note");
    }

    #[test]
    fn another_account_cannot_post() {
        let mut a = fresh();
        as_caller("mallory.test", 100);
        refused(move || drop(a.post(ARC.into(), 0, GENESIS.into(), root(1), String::new())), "only the pinned poster");
    }

    #[test]
    fn a_wrong_seq_is_refused() {
        let mut a = fresh();
        let h0 = a.post(ARC.into(), 0, GENESIS.into(), root(1), String::new());
        // Skipping a round.
        refused(move || drop(a.post(ARC.into(), 2, h0, root(2), String::new())), "seq must be 1");
    }

    #[test]
    fn the_first_post_is_seq_zero() {
        let mut a = fresh();
        refused(move || drop(a.post(ARC.into(), 1, GENESIS.into(), root(1), String::new())), "seq must be 0");
    }

    #[test]
    fn a_wrong_prev_is_refused() {
        let mut a = fresh();
        a.post(ARC.into(), 0, GENESIS.into(), root(1), String::new());
        // The right seq on a head that is not the current one (a fork of the history).
        refused(move || drop(a.post(ARC.into(), 1, GENESIS.into(), root(2), String::new())), "prev is not the current head");
    }

    #[test]
    fn a_replay_is_refused_and_changes_nothing() {
        let mut a = fresh();
        let h0 = a.post(ARC.into(), 0, GENESIS.into(), root(1), String::new());
        let h1 = a.post(ARC.into(), 1, h0.clone(), root(2), String::new());
        // The first post again, byte for byte.
        let mut again = Anchor { poster: a.poster.clone(), tips: LookupMap::new(b"t"), entries: LookupMap::new(b"e") };
        refused(move || drop(again.post(ARC.into(), 0, GENESIS.into(), root(1), String::new())), "seq must be 2");
        // The second post again, and a rewrite of round 0 with another root.
        let mut again = Anchor { poster: a.poster.clone(), tips: LookupMap::new(b"t"), entries: LookupMap::new(b"e") };
        refused(move || drop(again.post(ARC.into(), 1, h0, root(2), String::new())), "seq must be 2");
        let mut again = Anchor { poster: a.poster.clone(), tips: LookupMap::new(b"t"), entries: LookupMap::new(b"e") };
        refused(move || drop(again.post(ARC.into(), 0, GENESIS.into(), root(9), String::new())), "seq must be 2");
        assert_eq!(a.head(ARC.into()), h1);
        assert_eq!(a.get(ARC.into(), 0).unwrap().root, root(1));
    }

    #[test]
    fn two_sources_are_independent() {
        let mut a = fresh();
        let arc0 = a.post(ARC.into(), 0, GENESIS.into(), root(1), String::new());
        // The other source starts at its own seq 0 and genesis, with the same root.
        let other0 = a.post(OTHER.into(), 0, GENESIS.into(), root(1), String::new());
        assert_ne!(arc0, other0, "the source is under the head hash");
        let arc1 = a.post(ARC.into(), 1, arc0.clone(), root(2), String::new());
        assert_eq!((a.len(ARC.into()), a.len(OTHER.into())), (2, 1));
        assert_eq!((a.head(ARC.into()), a.head(OTHER.into())), (arc1, other0.clone()));
        // One source's head does not extend the other.
        refused(move || drop(a.post(OTHER.into(), 1, arc0, root(2), String::new())), "prev is not the current head");
    }

    /// The real rounds of the Arc testnet market (fixtures/live/anchor/chain.json, computed by
    /// scripts/anchor.mjs from public logs) through this contract's code: the script and the
    /// contract must agree on every head.
    #[test]
    fn the_arc_rounds_chain_to_the_heads_the_script_computes() {
        let chain: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(include_str!("../../fixtures/live/anchor/chain.json")).unwrap();
        let source = chain["source"].as_str().unwrap();
        let links = chain["links"].as_array().unwrap();
        assert!(links.len() >= 55);
        let mut a = fresh();
        let mut prev = GENESIS.to_string();
        for (seq, l) in links.iter().enumerate() {
            let text = |k: &str| l[k].as_str().unwrap().to_string();
            assert_eq!(text("prev"), prev);
            // A new call each time, as on chain (the log limit is per call); the storage stays.
            as_caller("poster.test", 100);
            prev = a.post(source.into(), seq as u64, prev, text("root"), text("meta"));
            assert_eq!(prev, text("head"), "seq {seq}");
        }
        assert_eq!(a.len(source.into()), links.len() as u64);
        assert_eq!(a.head(source.into()), chain["head"].as_str().unwrap());
    }

    #[test]
    fn malformed_input_is_refused() {
        let mut a = fresh();
        refused(move || drop(a.post(ARC.into(), 0, GENESIS.into(), "AB".repeat(32), String::new())), "root must be 64 lowercase hex");
        let mut a = fresh();
        refused(move || drop(a.post(String::new(), 0, GENESIS.into(), root(1), String::new())), "source must be");
        let mut a = fresh();
        refused(move || drop(a.post(ARC.into(), 0, GENESIS.into(), root(1), "x".repeat(513))), "meta must be");
    }

    #[test]
    fn the_poster_pays_the_storage() {
        let mut a = fresh();
        as_caller("poster.test", 0);
        refused(move || drop(a.post(ARC.into(), 0, GENESIS.into(), root(1), String::new())), "for storage");
    }

    #[test]
    fn the_account_itself_posts_from_its_own_balance() {
        as_caller("anchor.test", 0);
        let mut a = Anchor::new(acc("anchor.test"));
        let h0 = a.post(ARC.into(), 0, GENESIS.into(), root(1), String::new());
        assert_eq!(a.head(ARC.into()), h0);
    }
}
