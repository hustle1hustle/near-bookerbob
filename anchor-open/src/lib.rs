//! Open economy anchor: the public outcomes of an agent economy, kept on NEAR as a hash chain of
//! epoch roots that anyone can post and anyone can rebuild (docs/anchor-format.md).
//!
//! Anyone may post. Each poster has its own chain per `source`, so a post proves who sent it and
//! nothing more; a reader names the poster it trusts, and `make anchor-check` is what makes a
//! poster worth trusting. A post carries the epoch's records themselves (borsh args), and the
//! contract hashes them: the root on chain is over the bytes in the posting transaction, which
//! any archival node serves. The contract also checks each record's shape, that its block
//! timestamp falls in the epoch, and that records are in strictly increasing order, so one event
//! cannot appear twice in an epoch. Each post names the next `seq`, the current head and an epoch
//! after the last one and already closed; the new head is sha256 over (poster, source, seq, prev, root).
//!
//! No owner, no method that rewrites or deletes an entry. What it does not know: whether a record
//! is true. That is what the rebuild from the source contracts checks.
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

pub const ROOT_TAG: &[u8] = b"bookerbob-econ/epoch/v1";
pub const HEAD_TAG: &[u8] = b"bookerbob-econ/head/v1";
pub const RECORD_VERSION: u8 = 1;
/// One epoch is one hour of block time.
pub const EPOCH_NS: u64 = 3_600 * 1_000_000_000;
pub const GENESIS: [u8; 32] = [0u8; 32];
pub const MAX_SOURCE: usize = 128;
/// The fixed part of a record: version, height, timestamp, receipt id, log index, executor length, json length.
const FIXED: usize = 1 + 8 + 8 + 32 + 2 + 1 + 4;

/// The arguments of `post`, borsh-encoded (the records are binary).
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Post {
    pub source: String,
    pub seq: u64,
    pub prev: [u8; 32],
    pub epoch: u64,
    pub records: Vec<Vec<u8>>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
struct Stored {
    epoch: u64,
    n: u32,
    events: [u8; 32],
    root: [u8; 32],
    prev: [u8; 32],
    head: [u8; 32],
    block_height: u64,
    timestamp_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub epoch: u64,
    pub n: u32,
    pub events: String,
    pub root: String,
    pub prev: String,
    pub head: String,
    pub block_height: u64,
    pub timestamp_ms: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct Tip {
    len: u64,
    head: [u8; 32],
    last_epoch: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Chain {
    pub poster: AccountId,
    pub source: String,
    pub len: u64,
    pub head: String,
    pub last_epoch: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct OpenAnchor {
    tips: LookupMap<(AccountId, String), Tip>,
    entries: LookupMap<(AccountId, String, u64), Stored>,
    chains: Vector<(AccountId, String)>,
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn lp32(b: &mut Vec<u8>, s: &[u8]) {
    b.extend_from_slice(&(s.len() as u32).to_be_bytes());
    b.extend_from_slice(s);
}

/// `root = sha256(ROOT_TAG || u32 len(source) || source || u64 epoch || u32 n || events)`.
pub fn root_preimage(source: &str, epoch: u64, n: u32, events: &[u8; 32]) -> Vec<u8> {
    let mut b = ROOT_TAG.to_vec();
    lp32(&mut b, source.as_bytes());
    b.extend_from_slice(&epoch.to_be_bytes());
    b.extend_from_slice(&n.to_be_bytes());
    b.extend_from_slice(events);
    b
}

/// `head = sha256(HEAD_TAG || u32 len(poster) || poster || u32 len(source) || source || u64 seq || prev || root)`.
pub fn head_preimage(poster: &str, source: &str, seq: u64, prev: &[u8; 32], root: &[u8; 32]) -> Vec<u8> {
    let mut b = HEAD_TAG.to_vec();
    lp32(&mut b, poster.as_bytes());
    lp32(&mut b, source.as_bytes());
    b.extend_from_slice(&seq.to_be_bytes());
    b.extend_from_slice(prev);
    b.extend_from_slice(root);
    b
}

/// Checks one record's shape and epoch and returns its sort key (height, receipt id, log index).
/// Panics with the record's position on any error.
fn check_record(r: &[u8], epoch: u64, i: usize) -> [u8; 42] {
    let bad = |why: &str| -> ! { env::panic_str(&format!("record {i}: {why}")) };
    if r.len() < FIXED {
        bad("too short");
    }
    if r[0] != RECORD_VERSION {
        bad("unknown version");
    }
    let ts = u64::from_be_bytes(r[9..17].try_into().unwrap_or_else(|_| bad("timestamp")));
    if ts / EPOCH_NS != epoch {
        bad("block timestamp outside the epoch");
    }
    let el = r[51] as usize;
    if el == 0 || r.len() < FIXED + el {
        bad("executor length");
    }
    let jl_at = 52 + el;
    let jl = u32::from_be_bytes(r[jl_at..jl_at + 4].try_into().unwrap_or_else(|_| bad("json length"))) as usize;
    if r.len() != jl_at + 4 + jl {
        bad("length does not match its fields");
    }
    let mut key = [0u8; 42];
    key[..8].copy_from_slice(&r[1..9]);
    key[8..].copy_from_slice(&r[17..51]);
    key
}

/// The events hash and root of one epoch: what `post` stores, as a pure function.
pub fn epoch_root(source: &str, epoch: u64, records: &[Vec<u8>]) -> ([u8; 32], [u8; 32]) {
    let mut leaves = Vec::with_capacity(32 * records.len());
    let mut last: Option<[u8; 42]> = None;
    for (i, r) in records.iter().enumerate() {
        let key = check_record(r, epoch, i);
        if let Some(prev) = last {
            require!(key > prev, format!("record {i}: not after record {} (order is height, receipt, log index)", i - 1));
        }
        last = Some(key);
        leaves.extend_from_slice(&env::sha256_array(r));
    }
    let events = env::sha256_array(&leaves);
    let root = env::sha256_array(root_preimage(source, epoch, records.len() as u32, &events));
    (events, root)
}

#[near]
impl OpenAnchor {
    #[init]
    pub fn new() -> Self {
        Self { tips: LookupMap::new(b"t"), entries: LookupMap::new(b"e"), chains: Vector::new(b"c") }
    }

    /// Appends one epoch to the caller's chain for `source` and returns the new head (hex).
    /// `seq` is the caller's number of posts so far for this source, `prev` its current head
    /// (32 zero bytes before the first), `epoch` after its last one, `records` non-empty.
    /// The caller pays the storage: attach a deposit, the rest comes back.
    #[payable]
    pub fn post(&mut self, #[serializer(borsh)] p: Post) -> String {
        let poster = env::predecessor_account_id();
        require!(!p.source.is_empty() && p.source.len() <= MAX_SOURCE, "source must be 1 to 128 bytes");
        require!(!p.records.is_empty() && p.records.len() <= u32::MAX as usize, "an epoch needs at least one record");
        let key = (poster.clone(), p.source.clone());
        let tip = self.tips.get(&key).cloned();
        let (len, cur, last_epoch) = tip.as_ref().map_or((0, GENESIS, None), |t| (t.len, t.head, Some(t.last_epoch)));
        require!(p.seq == len, format!("seq must be {len}"));
        require!(p.prev == cur, "prev is not the current head");
        // Only a closed epoch: an open or future one could not be completed later and would
        // freeze the chain (the next post must name a later epoch).
        require!(p.epoch < env::block_timestamp() / EPOCH_NS, "epoch is not closed yet");
        if let Some(le) = last_epoch {
            require!(p.epoch > le, format!("epoch must be after {le}"));
        }
        let (events, root) = epoch_root(&p.source, p.epoch, &p.records);
        let head = env::sha256_array(head_preimage(poster.as_str(), &p.source, p.seq, &p.prev, &root));

        let before = env::storage_usage();
        let n = p.records.len() as u32;
        let s = Stored { epoch: p.epoch, n, events, root, prev: p.prev, head, block_height: env::block_height(), timestamp_ms: env::block_timestamp_ms() };
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"bookerbob-anchor-open\",\"version\":\"1.0.0\",\"event\":\"post\",\"data\":[{{\"poster\":\"{}\",\"source\":{},\"seq\":{},\"epoch\":{},\"n\":{},\"events\":\"{}\",\"root\":\"{}\",\"prev\":\"{}\",\"head\":\"{}\"}}]}}",
            poster,
            json_str(&p.source),
            p.seq,
            p.epoch,
            n,
            to_hex(&events),
            to_hex(&root),
            to_hex(&p.prev),
            to_hex(&head)
        ));
        if tip.is_none() {
            self.chains.push(key.clone());
        }
        self.entries.insert((poster.clone(), p.source.clone(), p.seq), s);
        self.tips.insert(key, Tip { len: p.seq + 1, head, last_epoch: p.epoch });
        self.entries.flush();
        self.tips.flush();
        self.chains.flush();

        let cost = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage().saturating_sub(before)));
        let paid = env::attached_deposit();
        if poster != env::current_account_id() {
            require!(paid >= cost, format!("attach at least {} yoctoNEAR for storage", cost.as_yoctonear()));
            let back = paid.saturating_sub(cost);
            if back > NearToken::from_yoctonear(0) {
                Promise::new(poster).transfer(back).detach();
            }
        }
        to_hex(&head)
    }

    /// The head of `poster`'s chain for `source`: 64 zeros before its first post.
    pub fn head(&self, poster: AccountId, source: String) -> String {
        to_hex(&self.tips.get(&(poster, source)).map_or(GENESIS, |t| t.head))
    }

    /// The number of posts; the next `seq`.
    pub fn len(&self, poster: AccountId, source: String) -> u64 {
        self.tips.get(&(poster, source)).map_or(0, |t| t.len)
    }

    pub fn get(&self, poster: AccountId, source: String, seq: u64) -> Option<Entry> {
        self.entries.get(&(poster, source, seq)).map(|s| Entry {
            epoch: s.epoch,
            n: s.n,
            events: to_hex(&s.events),
            root: to_hex(&s.root),
            prev: to_hex(&s.prev),
            head: to_hex(&s.head),
            block_height: s.block_height,
            timestamp_ms: s.timestamp_ms,
        })
    }

    /// Every chain, in the order of its first post.
    pub fn chains(&self, from: Option<u32>, limit: Option<u32>) -> Vec<Chain> {
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(200);
        (from..self.chains.len().min(from.saturating_add(limit)))
            .filter_map(|i| self.chains.get(i).cloned())
            .map(|(poster, source)| {
                let t = self.tips.get(&(poster.clone(), source.clone())).cloned().unwrap_or(Tip { len: 0, head: GENESIS, last_epoch: 0 });
                Chain { poster, source, len: t.len, head: to_hex(&t.head), last_epoch: t.last_epoch }
            })
            .collect()
    }
}

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
mod tests;
