//! Verifies a standing proof with no server. Three byte strings in: the verifier preprocessing,
//! the proof, statement.json. The guest's input (the graph events) and the claimed output (graph
//! root, standing hash) are rebuilt from the JSON (decide_public::Standing), so a changed event or
//! claim is a different statement and is refused.
use common::jolt_device::{JoltDevice, MemoryConfig};
use decide_public::Standing;
use jolt_crypto::{Bn254G1, Pedersen};
use jolt_dory::DoryScheme;
use jolt_field::Fr;
use jolt_transcript::{Keccak, VerifierState};

type Vc = Pedersen<Bn254G1>;
type Preprocessing = jolt_verifier::JoltVerifierPreprocessing<DoryScheme, Vc>;
type Proof = jolt_verifier::JoltProof<DoryScheme, Vc>;

pub fn verify(preprocessing: &[u8], proof: &[u8], public: &[u8]) -> Result<(), String> {
    let config = bincode::config::standard();
    let (pp, _): (Preprocessing, usize) = bincode::serde::decode_from_slice(preprocessing, config).map_err(|e| format!("preprocessing: {e}"))?;
    let (proof, _): (Proof, usize) = bincode::serde::decode_from_slice(proof, config).map_err(|e| format!("proof: {e}"))?;
    let public = Standing::from_json(public)?;

    let m = pp.program.memory_layout();
    let mut io = JoltDevice::new(&MemoryConfig {
        max_input_size: m.max_input_size,
        max_output_size: m.max_output_size,
        max_untrusted_advice_size: m.max_untrusted_advice_size,
        max_trusted_advice_size: m.max_trusted_advice_size,
        stack_size: m.stack_size,
        heap_size: m.heap_size,
        program_size: Some(m.program_size),
    });
    io.inputs = public.inputs()?;
    io.outputs = public.outputs()?;
    io.panic = false;
    jolt_verifier::verify::<Fr, DoryScheme, Vc, VerifierState<'_, Keccak>>(&pp, &io, &proof, None).map_err(|e| format!("{e:?}"))
}

/// Verifying uses no randomness. If a dependency ever asks for it, the call fails and says so.
fn no_randomness(_: &mut [u8]) -> Result<(), getrandom::Error> {
    Err(getrandom::Error::UNSUPPORTED)
}
getrandom::register_custom_getrandom!(no_randomness);

static mut LAST_ERROR: Vec<u8> = Vec::new();

/// Memory for one input. The page writes into it; `bb_free` gives it back.
#[no_mangle]
pub extern "C" fn bb_alloc(len: usize) -> *mut u8 {
    let mut b = Vec::<u8>::with_capacity(len);
    let p = b.as_mut_ptr();
    std::mem::forget(b);
    p
}

/// # Safety
/// `p` and `len` must come from one `bb_alloc(len)` call.
#[no_mangle]
pub unsafe extern "C" fn bb_free(p: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(p, 0, len));
}

/// 1 for a valid proof of this statement, 0 otherwise. On 0, `bb_error_ptr` and `bb_error_len`
/// hold the verifier's reason.
///
/// # Safety
/// Each pointer must be valid for its length.
#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn bb_verify(pp: *const u8, pp_len: usize, proof: *const u8, proof_len: usize, public: *const u8, public_len: usize) -> u32 {
    let result = verify(std::slice::from_raw_parts(pp, pp_len), std::slice::from_raw_parts(proof, proof_len), std::slice::from_raw_parts(public, public_len));
    match result {
        Ok(()) => 1,
        Err(e) => {
            LAST_ERROR = e.into_bytes();
            0
        }
    }
}

#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn bb_error_ptr() -> *const u8 {
    LAST_ERROR.as_ptr()
}

#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn bb_error_len() -> usize {
    LAST_ERROR.len()
}
