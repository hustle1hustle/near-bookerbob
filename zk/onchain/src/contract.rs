//! `jolt-verifier`: a NEAR contract that verifies a Jolt proof of the BookerBob standing program
//! (a16z/jolt 997c1543e, Dory over BN254) by itself, over several transactions.
//!
//! - `submit(proof, io)` with a deposit covering the job's storage (proof <= 128 KB, io <= 8 KB):
//!   the proof is deserialized with every G1/G2 point check (GT elements are not subgroup-checked,
//!   as in upstream Jolt), shape-checked, and stored; a proof whose io says the program panicked is
//!   refused. Returns a job id.
//! - `advance(id)`, by anyone, with 1 PGas: runs as many verifier units as the gas allows and
//!   stores the checkpoint (the Fiat-Shamir transcript state and the Dory verifier state).
//!   The first advance runs Jolt stages 1-7; later ones run the Dory opening check.
//! - The job ends `verified` or `refused: <reason>`, both recorded on chain; the proof bytes are
//!   then removed and the deposit returned.
//! - `expire(id)`, by anyone, once a job has run for EXPIRY_BLOCKS without a verdict: refused,
//!   storage freed, deposit returned (a malformed proof can never hold a deposit forever).
//! - Each job carries `statement` = sha256(program_hash || len || inputs || len || outputs ||
//!   panic || proof_sha256), inputs and outputs with trailing zero bytes trimmed, so the verdict
//!   is bound to one canonical claim.
//! - `program_hash()`: sha256 of the embedded verifier preprocessing, the program hash the
//!   bazaar registers for the standing guest.
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, NearToken, Promise};

use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};

const PP: &[u8] = include_bytes!("../data/pp.dat.deflate");
const GENS: &[u8] = include_bytes!("../data/gens.unc");
const TGAS: u64 = 1_000_000_000_000;
const RESERVE: u64 = 30 * TGAS;
const MAX_PROOF_BYTES: usize = 128 * 1024;
const MAX_IO_BYTES: usize = 8 * 1024;
/// Storage reserved per job for the checkpoint (measured 18.7 KB) and the job record.
const RESERVE_BYTES: u64 = 40_000;
/// From the embedded preprocessing (checked natively against it by `jolt-onchain-native`).
pub const MAX_PADDED_TRACE_LENGTH: usize = 1 << 24;
pub const MAX_INPUT_SIZE: usize = 4096;
pub const MAX_OUTPUT_SIZE: usize = 4096;
pub const PROGRAM_HASH: &str = "c780ceabae4decfa59703a9988ab2483313c6c1d2f15c7c0ad8fc60255a5c3a5";
/// About 20 minutes of testnet blocks; an honest job ends in 8 advances.
const EXPIRY_BLOCKS: u64 = 1200;

fn no_rng(_: &mut [u8]) -> Result<(), getrandom::Error> {
    Err(getrandom::Error::UNSUPPORTED)
}
getrandom::register_custom_getrandom!(no_rng);

fn key(tag: u8, id: u64) -> Vec<u8> {
    let mut k = vec![b'j', tag];
    k.extend(id.to_le_bytes());
    k
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
/// A JSON string holding the bytes in base64 (event payloads stay under NEAR's 16 KB log cap).
fn b64(b: &[u8]) -> String {
    near_sdk::serde_json::to_string(&Base64VecU8(b.to_vec())).unwrap()
}
fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}
fn trim(b: &[u8]) -> &[u8] {
    let n = b.iter().rposition(|x| *x != 0).map(|i| i + 1).unwrap_or(0);
    &b[..n]
}
/// sha256(program_hash || u32 len || inputs || u32 len || outputs || panic || proof_sha256)
pub fn statement(inputs: &[u8], outputs: &[u8], panic: bool, proof_sha256: &[u8]) -> Vec<u8> {
    let (i, o) = (trim(inputs), trim(outputs));
    let mut m = unhex(PROGRAM_HASH);
    m.extend((i.len() as u32).to_le_bytes());
    m.extend(i);
    m.extend((o.len() as u32).to_le_bytes());
    m.extend(o);
    m.push(panic as u8);
    m.extend(proof_sha256);
    env::sha256(&m)
}
fn tgas_used() -> u64 {
    env::used_gas().as_gas() / TGAS
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Job {
    pub submitter: AccountId,
    pub deposit: U128,
    /// running | verified | refused: <reason>
    pub status: String,
    /// 0 = submitted, 1 = combining commitments, 2 = Dory rounds, 3 = done
    pub phase: u8,
    pub units_done: u32,
    pub units_left: u32,
    pub advances: u32,
    pub gas_tgas: u64,
    pub proof_sha256: String,
    pub io_sha256: String,
    /// The canonical claim the verdict is about (see the module doc).
    pub statement: String,
    pub submitted_block: u64,
    /// sha256 of the program's public inputs and outputs, trailing zero bytes trimmed. The bytes
    /// themselves are in the `submitted` event (inputs, outputs) and the final event (outputs).
    pub inputs_sha256: String,
    pub outputs_sha256: String,
    pub panic: bool,
}

#[near(contract_state)]
pub struct Verifier {
    jobs: LookupMap<u64, Job>,
    next: u64,
}

impl Default for Verifier {
    fn default() -> Self {
        Self { jobs: LookupMap::new(b"K"), next: 1 }
    }
}

#[near]
impl Verifier {
    #[payable]
    pub fn submit(&mut self, proof: Base64VecU8, io: Base64VecU8) -> u64 {
        env::setup_panic_hook();
        if proof.0.len() > MAX_PROOF_BYTES || io.0.len() > MAX_IO_BYTES {
            env::panic_str("proof over 128 KB or io over 8 KB");
        }
        let usage_before = env::storage_usage();
        let proof_sha = env::sha256(&proof.0);
        let io_sha = hex(&env::sha256(&io.0));
        // every G1/G2 point checked (on curve, in the subgroup); GT is not subgroup-checked (upstream)
        let p = crate::read_proof(&proof.0).unwrap_or_else(|e| env::panic_str(&e));
        let d = crate::read_io(&io.0).unwrap_or_else(|e| env::panic_str(&e));
        if d.panic {
            env::panic_str("the io says the program panicked: nothing to verify");
        }
        if d.inputs.len() > MAX_INPUT_SIZE || d.outputs.len() > MAX_OUTPUT_SIZE {
            env::panic_str("inputs or outputs over the program's max_input_size / max_output_size");
        }
        let tl = p.trace_length;
        if tl == 0 || !tl.is_power_of_two() || tl > MAX_PADDED_TRACE_LENGTH {
            env::panic_str("trace_length: not a power of two within the program's bound");
        }
        if p.ram_K == 0 || !p.ram_K.is_power_of_two() || p.ram_K > 1usize << 31 {
            env::panic_str("ram_K: not a power of two within bound");
        }
        let dp = &p.joint_opening_proof;
        if dp.nu > dp.sigma || dp.first_messages.len() != dp.sigma || dp.second_messages.len() != dp.sigma || dp.sigma > 14 {
            env::panic_str("dory proof shape (nu, sigma, round count)");
        }
        let mut unc = Vec::new();
        p.serialize_uncompressed(&mut unc).unwrap();
        if unc.len() > MAX_PROOF_BYTES {
            env::panic_str("proof over 128 KB uncompressed");
        }
        let id = self.next;
        self.next += 1;
        env::storage_write(&key(b'p', id), &unc);
        env::storage_write(&key(b'i', id), &io.0);
        let st = statement(&d.inputs, &d.outputs, d.panic, &proof_sha);
        let job = Job {
            submitter: env::predecessor_account_id(),
            deposit: U128(env::attached_deposit().as_yoctonear()),
            status: "running".into(),
            phase: 0,
            units_done: 0,
            units_left: 0,
            advances: 0,
            gas_tgas: 0,
            proof_sha256: hex(&proof_sha),
            io_sha256: io_sha,
            statement: hex(&st),
            submitted_block: env::block_height(),
            inputs_sha256: hex(&env::sha256(trim(&d.inputs))),
            outputs_sha256: hex(&env::sha256(trim(&d.outputs))),
            panic: d.panic,
        };
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"bookerbob-jolt\",\"version\":\"1\",\"event\":\"submitted\",\"data\":{{\"id\":{id},\"statement\":\"{}\",\"proof_sha256\":\"{}\",\"inputs_b64\":{},\"outputs_b64\":{}}}}}",
            job.statement, job.proof_sha256, b64(trim(&d.inputs)), b64(trim(&d.outputs))
        ));
        let mut job = job;
        self.jobs.insert(id, job.clone());
        self.jobs.flush();
        let need = (env::storage_usage() - usage_before + RESERVE_BYTES) as u128 * env::storage_byte_cost().as_yoctonear();
        if env::attached_deposit().as_yoctonear() < need {
            env::panic_str(&format!("attach at least {need} yoctoNEAR: this job's storage, returned at the end"));
        }
        job.gas_tgas = tgas_used();
        self.jobs.insert(id, job);
        id
    }

    /// Ends a job that has run EXPIRY_BLOCKS without a verdict: refused, storage freed, deposit returned.
    pub fn expire(&mut self, id: u64) -> Job {
        let mut job = self.jobs.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such job"));
        if job.status != "running" || env::block_height() < job.submitted_block + EXPIRY_BLOCKS {
            env::panic_str("not running, or not yet expired");
        }
        self.end(id, &mut job, "refused: expired without a verdict".into());
        self.jobs.insert(id, job.clone());
        job
    }

    pub fn advance(&mut self, id: u64) -> Job {
        env::setup_panic_hook();
        let mut job = self.jobs.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such job"));
        if job.status != "running" {
            return job;
        }
        let proof_bytes = env::storage_read(&key(b'p', id)).unwrap();
        let proof = jolt_core::zkvm::RV64IMACProof::deserialize_uncompressed_unchecked(&proof_bytes[..])
            .unwrap_or_else(|e| env::panic_str(&format!("{e:?}")));
        let before = job.units_done;
        let r: Result<bool, String> = if job.phase == 0 {
            if env::prepaid_gas().as_gas() < 950 * TGAS {
                env::panic_str("the first advance runs stages 1-7: attach 1000 Tgas");
            }
            let io = crate::read_io(&env::storage_read(&key(b'i', id)).unwrap()).unwrap();
            let pp_bytes = miniz_oxide::inflate::decompress_to_vec(PP).unwrap();
            // trusted constant (its sha256 is program_hash()), so no point checks here
            let pp = crate::Preprocessing::deserialize_compressed_unchecked(&pp_bytes[..]).unwrap();
            drop(pp_bytes);
            crate::resumable::stages(&pp, proof, io).map(|ck| {
                job.units_done += 1;
                job.units_left = ck.units_left_for(&proof_bytes) as u32;
                job.phase = ck.phase;
                env::storage_write(&key(b'c', id), &ck.to_bytes());
                false
            })
        } else {
            let mut ck = crate::resumable::Checkpoint::from_bytes(&env::storage_read(&key(b'c', id)).unwrap())
                .unwrap_or_else(|e| env::panic_str(&e));
            let setup = <jolt_core::poly::commitment::dory::ArkworksVerifierSetup as CanonicalDeserialize>::deserialize_uncompressed_unchecked(GENS)
                .unwrap()
                .into_inner();
            let limit = env::prepaid_gas().as_gas().saturating_sub(RESERVE);
            let mut n = 0u32;
            let r = crate::resumable::step(&mut ck, &proof, &setup, |bound_tgas| {
                let ok = env::used_gas().as_gas() + bound_tgas * TGAS <= limit;
                if ok { n += 1; }
                ok
            });
            job.units_done += n.saturating_sub(if r.is_err() { 1 } else { 0 }).max(0);
            job.units_left = ck.units_left(&proof) as u32;
            job.phase = ck.phase;
            if r.is_ok() {
                env::storage_write(&key(b'c', id), &ck.to_bytes());
            }
            r
        };
        job.advances += 1;
        let ran = job.units_done - before;
        let end = match r {
            Ok(true) => Some("verified".to_string()),
            Ok(false) => None,
            Err(e) => Some(format!("refused at unit {}: {e}", job.units_done + 1)),
        };
        job.gas_tgas += tgas_used();
        env::log_str(&format!("advance {id}: {ran} units, phase {}, {} units left, {} Tgas", job.phase, job.units_left, tgas_used()));
        if let Some(s) = end {
            self.end(id, &mut job, s);
        }
        self.jobs.insert(id, job.clone());
        job
    }

    /// Ends a job: removes the proof, claim and checkpoint, emits the verdict with the outputs,
    /// and returns the deposit minus the storage of the job record that stays.
    fn end(&mut self, id: u64, job: &mut Job, status: String) {
        let outputs = env::storage_read(&key(b'i', id))
            .and_then(|b| crate::read_io(&b).ok())
            .map(|d| b64(trim(&d.outputs)))
            .unwrap_or_else(|| "\"\"".into());
        job.status = status;
        job.units_left = 0;
        for t in [b'p', b'i', b'c'] {
            env::storage_remove(&key(t, id));
        }
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"bookerbob-jolt\",\"version\":\"1\",\"event\":\"{}\",\"data\":{{\"id\":{id},\"status\":\"{}\",\"statement\":\"{}\",\"proof_sha256\":\"{}\",\"outputs_b64\":{}}}}}",
            if job.status == "verified" { "verified" } else { "refused" },
            job.status.replace('"', "'"),
            job.statement,
            job.proof_sha256,
            outputs
        ));
        // the record stays: key (prefix + borsh u64) + borsh(job) + NEAR's 40-byte per-record overhead
        let record = (1 + 8 + near_sdk::borsh::to_vec(&*job).unwrap().len() + 40) as u128;
        let keep = record * env::storage_byte_cost().as_yoctonear();
        let refund = job.deposit.0.saturating_sub(keep);
        if refund > 0 {
            let _ = Promise::new(job.submitter.clone()).transfer(NearToken::from_yoctonear(refund));
        }
    }

    pub fn status(&self, id: u64) -> Option<Job> {
        self.jobs.get(&id).cloned()
    }

    pub fn jobs(&self) -> u64 {
        self.next
    }

    /// sha256 of the embedded verifier preprocessing (about 200 Tgas, fine for a view call).
    pub fn program_hash(&self) -> String {
        hex(&env::sha256(&miniz_oxide::inflate::decompress_to_vec(PP).unwrap()))
    }

    pub fn statement_of(&self, inputs: Base64VecU8, outputs: Base64VecU8, proof_sha256: String) -> String {
        hex(&statement(&inputs.0, &outputs.0, false, &unhex(&proof_sha256)))
    }

    pub fn jolt_pin(&self) -> String {
        "a16z/jolt 997c1543efd49eb193ca403bb7722fc4b2f8e65b, PCS Dory over BN254, Blake2b transcript".into()
    }
}
