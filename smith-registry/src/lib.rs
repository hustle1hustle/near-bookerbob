//! The smith registry (docs/smith.md): Jolt programs written by the smith on a swarm agent's
//! request. A separate contract on its own account, so the bazaar's code hash is unchanged.
//!
//! 1. `post_request`: an agent posts a request id and the sha256 of its spec (types, rules, test
//!    vectors). The caller is the requester.
//! 2. `register_program`: only the registrar the requester named (by default the smith account)
//!    registers the program it built: sha256 of the source files, the program hash (sha256 of the
//!    Jolt verifier preprocessing, what a proof is checked against), sha256 of the guest ELF, and
//!    the NEAR AI TEE signature over the authorship chat. The registrar's transaction signature
//!    covers those hashes. The contract checks the TEE signature with `ed25519_verify`, that the
//!    signed text names the registered response hash, and that the key is on the owner's list of
//!    attested model keys. Status `pending` for the challenge window.
//! 3. `accept`: the requester says the program passed its own spec tests. `challenge`: anyone, with
//!    a bond, during the window. `resolve`: the owner rules on a challenge before its deadline
//!    (REP holds this key today); after the deadline anyone may `expire` it, which upholds it.
//! 4. A program is usable when the requester accepted it, its window is over, and no challenge is open
//!    or upheld. Any agent verifies a proof off chain against the registered program hash; a
//!    registered verifier key (an OutLayer TEE worker) may record a signed accept with `attest_use`.
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

pub const STATEMENT_TAG: &[u8] = b"bookerbob/jolt-verify/v0\0";

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub id: String,
    pub requester: AccountId,
    /// The only account that may register a program for this request.
    pub registrar: AccountId,
    pub spec_hash: String,
    pub posted_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Program {
    pub request_id: String,
    pub registrar: AccountId,
    pub source_hash: String,
    pub program_hash: String,
    pub elf_hash: String,
    /// The NEAR AI model and its attested ed25519 key that wrote the source.
    pub model: String,
    pub signing_address: String,
    /// "<model>:<sha256 request wire>:<sha256 response wire>", signed by `signing_address`.
    pub signed_text: String,
    pub signature: String,
    pub response_hash: String,
    pub registered_ms: u64,
    pub usable_after_ms: u64,
    pub accepted: bool,
    /// "pending", "challenged", "rejected"; usability is computed (see `status`).
    pub state: String,
    pub challenger: Option<AccountId>,
    pub challenge_reason: Option<String>,
    /// The owner rules before this; after it, `expire` upholds the challenge.
    pub resolve_by_ms: Option<u64>,
    pub uses: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Use {
    pub request_id: String,
    pub verifier_key: String,
    pub statement: String,
    pub at_ms: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    owner: AccountId,
    /// The default registrar: the smith agent's account.
    smith: AccountId,
    window_ms: u64,
    resolve_ms: u64,
    bond: NearToken,
    /// ed25519 keys (hex) of attested NEAR AI models -> model name, set by the owner after it
    /// checks the model's attestation report.
    model_keys: IterableMap<String, String>,
    used_statements: LookupSet<String>,
    requests: IterableMap<String, Request>,
    programs: IterableMap<String, Program>,
    by_hash: LookupMap<String, String>,
    verifier_keys: IterableMap<String, String>,
    uses: IterableMap<u64, Use>,
    next_use: u64,
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "bookerbob-smith", "version": "1.0.0", "event": event, "data": [data] })));
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn unhex<const N: usize>(s: &str) -> [u8; N] {
    require!(is_hex(s, 2 * N), "bad hex");
    let mut out = [0u8; N];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

#[near]
impl Registry {
    #[init]
    pub fn new(owner: AccountId, smith: AccountId, window_ms: u64, resolve_ms: u64, bond: NearToken) -> Self {
        Self {
            owner,
            smith,
            window_ms,
            resolve_ms,
            bond,
            model_keys: IterableMap::new(b"k"),
            used_statements: LookupSet::new(b"s"),
            requests: IterableMap::new(b"r"),
            programs: IterableMap::new(b"p"),
            by_hash: LookupMap::new(b"h"),
            verifier_keys: IterableMap::new(b"v"),
            uses: IterableMap::new(b"u"),
            next_use: 0,
        }
    }

    /// `registrar`: who may register the program; the smith account when None.
    pub fn post_request(&mut self, id: String, spec_hash: String, registrar: Option<AccountId>) {
        require!(id_ok(&id), "request id: lowercase, digits and '-', at most 64");
        require!(is_hex(&spec_hash, 64), "spec_hash: 64 lowercase hex");
        require!(self.requests.get(&id).is_none(), "request id taken");
        let r = Request { id: id.clone(), requester: env::predecessor_account_id(), registrar: registrar.unwrap_or_else(|| self.smith.clone()), spec_hash, posted_ms: env::block_timestamp_ms() };
        // "<id>-zk" is the zk build of request <id>: only its requester posts it, with the same
        // registrar and spec.
        if let Some(base) = id.strip_suffix("-zk") {
            let b = self.requests.get(base).expect("a -zk request needs its base request");
            require!(b.requester == r.requester && b.registrar == r.registrar && b.spec_hash == r.spec_hash, "a -zk request must have its base request's requester, registrar and spec");
        }
        emit("request", json!(r));
        self.requests.insert(id, r);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn register_program(&mut self, request_id: String, source_hash: String, program_hash: String, elf_hash: String, model: String, signing_address: String, signed_text: String, signature: String, response_hash: String) {
        let req = self.requests.get(&request_id).expect("no such request");
        require!(env::predecessor_account_id() == req.registrar, "only the registrar the requester named registers");
        require!(self.programs.get(&request_id).is_none(), "a program is registered for this request");
        require!(self.model_keys.get(&signing_address).is_some_and(|m| *m == model), "the signing key is not an attested key of this model");
        for (h, what) in [(&source_hash, "source_hash"), (&program_hash, "program_hash"), (&elf_hash, "elf_hash"), (&response_hash, "response_hash"), (&signing_address, "signing_address")] {
            require!(is_hex(h, 64), format!("{what}: 64 lowercase hex"));
        }
        require!(self.by_hash.get(&program_hash).is_none(), "program hash already registered");
        // One authorship chat backs one request (the zk build of the same request is the one
        // exception: its id is the request's id plus "-zk").
        if let Some(base) = request_id.strip_suffix("-zk") {
            let bp = self.programs.get(base).expect("a -zk program needs its base program");
            require!(bp.source_hash == source_hash && bp.response_hash == response_hash, "a -zk program must have its base program's source and authorship");
        }
        let response_key = format!("response:{response_hash}");
        if let Some(other) = self.by_hash.get(&response_key) {
            require!(request_id == format!("{other}-zk"), "this authorship response already backs another request");
        }
        require!(model.len() <= 128 && signed_text.len() <= 256, "too long");
        // The TEE signature: this key signed "<model>:<request sha256>:<response sha256>".
        let parts: Vec<&str> = signed_text.split(':').collect();
        require!(parts.len() == 3 && parts[0] == model && is_hex(parts[1], 64) && parts[2] == response_hash, "signed text is not <model>:<request sha256>:<response sha256>");
        let sig: [u8; 64] = unhex(&signature);
        let key: [u8; 32] = unhex(&signing_address);
        require!(env::ed25519_verify(&sig, signed_text.as_bytes(), &key), "the TEE signature does not verify");
        let now = env::block_timestamp_ms();
        let p = Program {
            request_id: request_id.clone(),
            registrar: env::predecessor_account_id(),
            source_hash,
            program_hash: program_hash.clone(),
            elf_hash,
            model,
            signing_address,
            signed_text,
            signature,
            response_hash,
            registered_ms: now,
            usable_after_ms: now + self.window_ms,
            accepted: false,
            state: "pending".into(),
            challenger: None,
            challenge_reason: None,
            resolve_by_ms: None,
            uses: 0,
        };
        emit("register", json!(p));
        if self.by_hash.get(&response_key).is_none() {
            self.by_hash.insert(response_key, request_id.clone());
        }
        self.by_hash.insert(program_hash, request_id.clone());
        self.programs.insert(request_id, p);
    }

    /// The registrar replaces a program's hash (and its ELF hash) when the same source was built
    /// or preprocessed again (a pinned Dory URS, vendored dependency paths). The source hash
    /// stays; that the new build comes from that source is checked off chain (smith-check, the
    /// rebuild). The program starts a fresh window and needs the requester's accept of the new
    /// hash.
    pub fn supersede(&mut self, request_id: String, program_hash: String, elf_hash: String, reason: String) {
        require!(is_hex(&program_hash, 64) && is_hex(&elf_hash, 64), "program_hash, elf_hash: 64 lowercase hex");
        require!(reason.len() <= 256, "reason too long");
        require!(self.by_hash.get(&program_hash).is_none(), "program hash already registered");
        let (now, window) = (env::block_timestamp_ms(), self.window_ms);
        let p = self.programs.get_mut(&request_id).expect("no program");
        require!(env::predecessor_account_id() == p.registrar, "only the registrar supersedes");
        require!(p.state != "rejected" && p.state != "challenged", "not while challenged or rejected");
        let old = core::mem::replace(&mut p.program_hash, program_hash.clone());
        let old_elf = core::mem::replace(&mut p.elf_hash, elf_hash);
        p.accepted = false;
        p.state = "pending".into();
        p.usable_after_ms = now + window;
        emit("supersede", json!({ "request_id": request_id, "old_program_hash": old, "program_hash": program_hash, "old_elf_hash": old_elf, "elf_hash": p.elf_hash, "source_hash": p.source_hash, "reason": reason }));
        self.by_hash.remove(&old);
        self.by_hash.insert(program_hash, request_id);
    }

    /// The owner pins a program written by hand, outside the smith (the bazaar's standing guest):
    /// same record and window, `model` = "hand-written: <note>", no TEE signature, accepted by the
    /// owner as its requester. Its source is public in the repo; the program hash is what counts.
    pub fn pin_program(&mut self, request_id: String, spec_hash: String, source_hash: String, program_hash: String, elf_hash: String, note: String) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(id_ok(&request_id), "request id: lowercase, digits and '-', at most 64");
        require!(self.requests.get(&request_id).is_none(), "request id taken");
        for (h, what) in [(&spec_hash, "spec_hash"), (&source_hash, "source_hash"), (&program_hash, "program_hash"), (&elf_hash, "elf_hash")] {
            require!(is_hex(h, 64), format!("{what}: 64 lowercase hex"));
        }
        require!(note.len() <= 100, "note too long");
        require!(self.by_hash.get(&program_hash).is_none(), "program hash already registered");
        let now = env::block_timestamp_ms();
        let r = Request { id: request_id.clone(), requester: self.owner.clone(), registrar: self.owner.clone(), spec_hash, posted_ms: now };
        let p = Program {
            request_id: request_id.clone(),
            registrar: self.owner.clone(),
            source_hash,
            program_hash: program_hash.clone(),
            elf_hash,
            model: format!("hand-written: {note}"),
            signing_address: String::new(),
            signed_text: String::new(),
            signature: String::new(),
            response_hash: String::new(),
            registered_ms: now,
            usable_after_ms: now + self.window_ms,
            accepted: true,
            state: "pending".into(),
            challenger: None,
            challenge_reason: None,
            resolve_by_ms: None,
            uses: 0,
        };
        emit("request", json!(r));
        emit("pin", json!(p));
        self.requests.insert(request_id.clone(), r);
        self.by_hash.insert(program_hash, request_id.clone());
        self.programs.insert(request_id, p);
    }

    /// The requester: the program with this hash passed my spec tests. The hash must be the
    /// current one, so an accept cannot carry over to a program superseded after it was read.
    pub fn accept(&mut self, request_id: String, program_hash: String) {
        let r = self.requests.get(&request_id).expect("no such request").clone();
        require!(env::predecessor_account_id() == r.requester, "only the requester accepts");
        let p = self.programs.get_mut(&request_id).expect("no program");
        require!(p.state != "rejected", "rejected");
        require!(p.program_hash == program_hash, "that is not the current program hash");
        p.accepted = true;
        emit("accept", json!({ "request_id": request_id, "program_hash": p.program_hash }));
    }

    /// Anyone, with the bond, inside the window. Anything over the bond is refunded.
    #[payable]
    pub fn challenge(&mut self, request_id: String, reason: String) {
        let paid = env::attached_deposit();
        require!(paid >= self.bond, "attach the challenge bond");
        require!(reason.len() <= 512, "reason too long");
        let now = env::block_timestamp_ms();
        let resolve_ms = self.resolve_ms;
        let p = self.programs.get_mut(&request_id).expect("no program");
        require!(p.state == "pending", "not open to challenge");
        require!(now < p.usable_after_ms, "the challenge window is over");
        p.state = "challenged".into();
        p.challenger = Some(env::predecessor_account_id());
        p.challenge_reason = Some(reason.clone());
        p.resolve_by_ms = Some(now + resolve_ms);
        emit("challenge", json!({ "request_id": request_id, "challenger": env::predecessor_account_id(), "reason": reason, "resolve_by_ms": now + resolve_ms }));
        let over = paid.saturating_sub(self.bond);
        if !over.is_zero() {
            let _ = Promise::new(env::predecessor_account_id()).transfer(over);
        }
    }

    /// The owner rules before the deadline: upheld rejects the program and returns the bond;
    /// dismissed reopens the program (a fresh window) and pays the bond to its registrar.
    pub fn resolve(&mut self, request_id: String, upheld: bool) -> Promise {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        let (bond, window) = (self.bond, self.window_ms);
        let now = env::block_timestamp_ms();
        let p = self.programs.get_mut(&request_id).expect("no program");
        require!(p.state == "challenged", "not challenged");
        require!(now < p.resolve_by_ms.unwrap_or(0), "past the deadline: expire upholds it");
        let challenger = p.challenger.clone().unwrap();
        let to = if upheld {
            p.state = "rejected".into();
            challenger
        } else {
            p.state = "pending".into();
            p.usable_after_ms = now + window;
            p.registrar.clone()
        };
        emit("resolve", json!({ "request_id": request_id, "upheld": upheld, "bond_to": to }));
        Promise::new(to).transfer(bond)
    }

    /// Anyone, after the owner's deadline: an unresolved challenge is upheld (the program is
    /// rejected) and the bond goes back to the challenger.
    pub fn expire(&mut self, request_id: String) -> Promise {
        let bond = self.bond;
        let p = self.programs.get_mut(&request_id).expect("no program");
        require!(p.state == "challenged", "not challenged");
        require!(env::block_timestamp_ms() >= p.resolve_by_ms.unwrap_or(u64::MAX), "the owner's deadline has not passed");
        p.state = "rejected".into();
        let to = p.challenger.clone().unwrap();
        emit("resolve", json!({ "request_id": request_id, "upheld": true, "bond_to": to, "by": "expire" }));
        Promise::new(to).transfer(bond)
    }

    /// The owner lists an attested model key after checking its attestation report.
    pub fn set_model_key(&mut self, key: String, model: String) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(is_hex(&key, 64), "key: 64 lowercase hex (ed25519)");
        require!(model.len() <= 128, "model too long");
        emit("model_key", json!({ "key": key, "model": model }));
        self.model_keys.insert(key, model);
    }

    pub fn set_verifier_key(&mut self, name: String, key: String) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(is_hex(&key, 64), "key: 64 lowercase hex (ed25519)");
        emit("verifier_key", json!({ "name": name, "key": key }));
        self.verifier_keys.insert(name, key);
    }

    /// A registered verifier (an OutLayer TEE worker) signed an accept for a proof of this
    /// program: ed25519 over "bookerbob/jolt-verify/v0\0" || statement, statement a JSON object
    /// with program_hash, verdict "accept", panic false (and inputs_sha256, output_sha256).
    pub fn attest_use(&mut self, request_id: String, verifier: String, statement: String, signature: String) -> u64 {
        require!(statement.len() <= 1024, "statement too long");
        let digest: String = env::sha256(statement.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        require!(!self.used_statements.contains(&digest), "this statement is already recorded");
        let key = self.verifier_keys.get(&verifier).expect("no such verifier").clone();
        let mut msg = STATEMENT_TAG.to_vec();
        msg.extend_from_slice(statement.as_bytes());
        require!(env::ed25519_verify(&unhex::<64>(&signature), &msg, &unhex::<32>(&key)), "the verifier's signature does not verify");
        let v: Value = serde_json::from_str(&statement).expect("statement is not JSON");
        require!(v["verdict"] == "accept" && v["panic"] == false, "not an accept");
        require!(v["output_sha256"].as_str().is_some_and(|h| is_hex(h, 64)), "output_sha256 missing");
        let usable = self.status(request_id.clone()) == "usable";
        let p = self.programs.get_mut(&request_id).expect("no program");
        require!(v["program_hash"] == p.program_hash.as_str(), "statement is for another program");
        require!(usable, "program is not usable");
        p.uses += 1;
        self.used_statements.insert(digest);
        let n = self.next_use;
        self.next_use += 1;
        let u = Use { request_id, verifier_key: key, statement, at_ms: env::block_timestamp_ms() };
        emit("use", json!({ "n": n, "use": u }));
        self.uses.insert(n, u);
        n
    }

    // ---------- views ----------

    /// "none", "pending" (window open or not yet accepted), "challenged", "rejected", "usable".
    pub fn status(&self, request_id: String) -> String {
        match self.programs.get(&request_id) {
            None => "none".into(),
            Some(p) if p.state != "pending" => p.state.clone(),
            Some(p) if p.accepted && env::block_timestamp_ms() >= p.usable_after_ms => "usable".into(),
            Some(_) => "pending".into(),
        }
    }

    pub fn get_request(&self, id: String) -> Option<Request> {
        self.requests.get(&id).cloned()
    }

    pub fn get_program(&self, request_id: String) -> Option<Program> {
        self.programs.get(&request_id).cloned()
    }

    pub fn by_program_hash(&self, program_hash: String) -> Option<String> {
        self.by_hash.get(&program_hash).cloned()
    }

    pub fn list(&self) -> Vec<Value> {
        self.requests
            .values()
            .map(|r| json!({ "request": r, "program": self.programs.get(&r.id), "status": self.status(r.id.clone()) }))
            .collect()
    }

    pub fn uses(&self) -> Vec<(u64, Use)> {
        self.uses.iter().map(|(k, v)| (*k, v.clone())).collect()
    }

    pub fn config(&self) -> Value {
        json!({ "owner": self.owner, "smith": self.smith, "window_ms": self.window_ms, "resolve_ms": self.resolve_ms, "bond": self.bond, "model_keys": self.model_keys.iter().collect::<Vec<_>>(), "verifier_keys": self.verifier_keys.iter().collect::<Vec<_>>() })
    }
}

#[cfg(test)]
mod tests;
