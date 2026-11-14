//! The pinned Jolt verifier (a16z/jolt 997c1543e) run stage by stage, so each stage can be
//! measured, and later checkpointed between NEAR transactions.
use ark_serialize::CanonicalDeserialize;
use jolt_core::zkvm::verifier::JoltVerifierPreprocessing;
use jolt_core::zkvm::{RV64IMACProof, RV64IMACVerifier};
use jolt_core::ark_bn254::Fr;
use jolt_core::curve::Bn254Curve;
use jolt_core::poly::commitment::dory::DoryCommitmentScheme;
pub use tracer::JoltDevice;

pub type Preprocessing = JoltVerifierPreprocessing<Fr, Bn254Curve, DoryCommitmentScheme>;

pub fn read_pp(b: &[u8]) -> Result<Preprocessing, String> {
    Preprocessing::deserialize_compressed(b).map_err(|e| format!("preprocessing: {e:?}"))
}
pub fn read_proof(b: &[u8]) -> Result<RV64IMACProof, String> {
    RV64IMACProof::deserialize_compressed(b).map_err(|e| format!("proof: {e:?}"))
}
pub fn read_io(b: &[u8]) -> Result<JoltDevice, String> {
    JoltDevice::deserialize_compressed(b).map_err(|e| format!("io: {e:?}"))
}

/// Runs the verifier up to and including stage `upto` (0 = preamble only, 8 = everything).
/// `tick(stage)` is called after each stage (the contract reads its gas meter there).
pub fn run(
    pp: &Preprocessing,
    proof: RV64IMACProof,
    io: JoltDevice,
    upto: u8,
    mut tick: impl FnMut(u8),
) -> Result<(), String> {
    let mut v = RV64IMACVerifier::new(pp, proof, io, None, None).map_err(|e| format!("new: {e:?}"))?;
    tick(100);
    v.verify_preamble();
    tick(0);
    macro_rules! st {
        ($n:expr, $f:ident) => {
            if upto >= $n {
                v.$f().map_err(|e| format!("stage {}: {e:?}", $n))?;
                tick($n);
            }
        };
    }
    st!(1, verify_stage1);
    st!(2, verify_stage2);
    st!(3, verify_stage3);
    st!(4, verify_stage4);
    st!(5, verify_stage5);
    st!(6, verify_stage6);
    st!(7, verify_stage7);
    st!(8, verify_stage8);
    Ok(())
}

pub mod resumable;

#[cfg(target_arch = "wasm32")]
mod contract;
