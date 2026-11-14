//! The Jolt verifier split into units that fit NEAR's per-receipt gas, with a checkpoint
//! between them. Nothing here is a new check: every unit runs the pinned verifier's own code
//! (jolt-core stages 1-7 and the stage-8 prefix; dory-pcs `DoryVerifierState::process_round`
//! and `verify_final`), in the same order, on the same Fiat-Shamir transcript, which is carried
//! across transactions as its 32-byte state and round counter.
//!
//! Units: `stages` (load + stages 1-7 + stage-8 prefix), then one unit per commitment in the
//! random linear combination, then `dory_init`, one unit per Dory round, and `dory_final`.
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use dory::backends::arkworks::{ArkFr, ArkG1, ArkG2, ArkGT, BN254};
use dory::primitives::transcript::Transcript as DoryTranscriptT;
use dory::{DoryVerifierState, VerifierSetup};
use jolt_core::ark_bn254::{Fq12, Fr, G1Projective, G2Projective};
use jolt_core::poly::commitment::dory::wrappers::{jolt_to_ark, JoltToDoryTranscript};
use jolt_core::transcripts::Blake2bTranscript;
use jolt_core::zkvm::{RV64IMACProof, RV64IMACVerifier};

use crate::{JoltDevice, Preprocessing};

/// Everything the verifier carries from one transaction to the next.
#[derive(CanonicalSerialize, CanonicalDeserialize, Clone, Debug, PartialEq)]
pub struct Checkpoint {
    /// 1 = combining commitments, 2 = Dory rounds, 3 = verified.
    pub phase: u8,
    pub transcript_state: [u8; 32],
    pub transcript_rounds: u32,
    /// Opening point in Dory's order, and the joint claim.
    pub point: Vec<Fr>,
    pub eval: Fr,
    /// The random linear combination: coefficients, commitments, progress, accumulator.
    pub rlc_coeffs: Vec<Fr>,
    pub rlc_commitments: Vec<Fq12>,
    pub rlc_next: u32,
    pub rlc_acc: Fq12,
    /// Dory verifier state (phase 2).
    pub dory_round: u32,
    pub dory: Vec<DoryCk>,
}

#[derive(CanonicalSerialize, CanonicalDeserialize, Clone, Debug, PartialEq)]
pub struct DoryCk {
    pub c: Fq12,
    pub d1: Fq12,
    pub d2: Fq12,
    pub d2_init: Fq12,
    pub e1: G1Projective,
    pub e1_init: G1Projective,
    pub e2: G2Projective,
    pub s1_acc: Fr,
    pub s2_acc: Fr,
    pub s1_coords: Vec<Fr>,
    pub s2_coords: Vec<Fr>,
    pub num_rounds: u64,
}

impl DoryCk {
    fn save(s: &DoryVerifierState<BN254>) -> Self {
        DoryCk {
            c: s.c.0, d1: s.d1.0, d2: s.d2.0, d2_init: s.d2_init.0,
            e1: s.e1.0, e1_init: s.e1_init.0, e2: s.e2.0,
            s1_acc: s.s1_acc.0, s2_acc: s.s2_acc.0,
            s1_coords: s.s1_coords.iter().map(|x| x.0).collect(),
            s2_coords: s.s2_coords.iter().map(|x| x.0).collect(),
            num_rounds: s.num_rounds as u64,
        }
    }
    fn load(&self, setup: &VerifierSetup<BN254>) -> DoryVerifierState<BN254> {
        DoryVerifierState {
            c: ArkGT(self.c), d1: ArkGT(self.d1), d2: ArkGT(self.d2), d2_init: ArkGT(self.d2_init),
            e1: ArkG1(self.e1), e1_init: ArkG1(self.e1_init), e2: ArkG2(self.e2),
            s1_acc: ArkFr(self.s1_acc), s2_acc: ArkFr(self.s2_acc),
            s1_coords: self.s1_coords.iter().map(|x| ArkFr(*x)).collect(),
            s2_coords: self.s2_coords.iter().map(|x| ArkFr(*x)).collect(),
            num_rounds: self.num_rounds as usize,
            setup: setup.clone(),
        }
    }
}

impl Checkpoint {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = Vec::new();
        self.serialize_uncompressed(&mut b).unwrap();
        b
    }
    pub fn from_bytes(b: &[u8]) -> Result<Self, String> {
        Self::deserialize_uncompressed_unchecked(b).map_err(|e| format!("checkpoint: {e:?}"))
    }
    fn transcript(&self) -> Blake2bTranscript {
        Blake2bTranscript { state: self.transcript_state, n_rounds: self.transcript_rounds }
    }
    fn keep(&mut self, t: &Blake2bTranscript) {
        self.transcript_state = t.state;
        self.transcript_rounds = t.n_rounds;
    }
    /// Same as `units_left`, from the proof's serialized bytes (uncompressed).
    pub fn units_left_for(&self, proof_unc: &[u8]) -> usize {
        RV64IMACProof::deserialize_uncompressed_unchecked(proof_unc).map(|p| self.units_left(&p)).unwrap_or(0)
    }
    /// Units still to run: one per commitment, dory_init, one per round, dory_final.
    pub fn units_left(&self, proof: &RV64IMACProof) -> usize {
        let rounds = proof.joint_opening_proof.first_messages.len();
        match self.phase {
            1 => (self.rlc_commitments.len() - self.rlc_next as usize) + 1 + rounds + 1,
            2 => rounds - self.dory_round as usize + 1,
            _ => 0,
        }
    }
}

/// Unit 0: stages 1-7 and the stage-8 prefix. Returns the first checkpoint.
pub fn stages(pp: &Preprocessing, proof: RV64IMACProof, io: JoltDevice) -> Result<Checkpoint, String> {
    let mut v = RV64IMACVerifier::new(pp, proof, io, None, None).map_err(|e| format!("new: {e:?}"))?;
    v.verify_preamble();
    v.verify_stage1().map_err(|e| format!("stage 1: {e:?}"))?;
    v.verify_stage2().map_err(|e| format!("stage 2: {e:?}"))?;
    v.verify_stage3().map_err(|e| format!("stage 3: {e:?}"))?;
    v.verify_stage4().map_err(|e| format!("stage 4: {e:?}"))?;
    v.verify_stage5().map_err(|e| format!("stage 5: {e:?}"))?;
    v.verify_stage6().map_err(|e| format!("stage 6: {e:?}"))?;
    v.verify_stage7().map_err(|e| format!("stage 7: {e:?}"))?;
    let (point, eval, pairs) = v.verify_stage8_prefix().map_err(|e| format!("stage 8 prefix: {e:?}"))?;
    // exactly as DoryCommitmentScheme::verify: reversed (Dory's endianness), as Fr
    let point: Vec<Fr> = point.iter().rev().map(|p| { let f: Fr = (*p).into(); f }).collect();
    Ok(Checkpoint {
        phase: 1,
        transcript_state: v.transcript.state,
        transcript_rounds: v.transcript.n_rounds,
        point,
        eval,
        rlc_coeffs: pairs.iter().map(|(c, _)| *c).collect(),
        rlc_commitments: pairs.iter().map(|(_, g)| g.0).collect(),
        rlc_next: 0,
        rlc_acc: ArkGT::identity_fq12(),
        dory_round: 0,
        dory: vec![],
    })
}

trait IdentityFq12 { fn identity_fq12() -> Fq12; }
impl IdentityFq12 for ArkGT {
    fn identity_fq12() -> Fq12 { <ArkGT as dory::primitives::arithmetic::Group>::identity().0 }
}

/// Upper bounds, in Tgas, on one unit of each kind as measured on NEAR testnet (protocol 88):
/// a commitment term ~18, the Dory setup ~20, a Dory round or the final check ~300.
pub const UNIT_TGAS_RLC: u64 = 30;
pub const UNIT_TGAS_INIT: u64 = 60;
pub const UNIT_TGAS_ROUND: u64 = 330;

impl Checkpoint {
    /// Gas bound (Tgas) of the next unit.
    pub fn next_unit_tgas(&self) -> u64 {
        match self.phase {
            1 if (self.rlc_next as usize) < self.rlc_commitments.len() => UNIT_TGAS_RLC,
            1 => UNIT_TGAS_INIT,
            _ => UNIT_TGAS_ROUND,
        }
    }
}

/// Runs units while `more(bound_tgas)` says there is gas for the next one. Ok(true) once verified.
pub fn step(
    ck: &mut Checkpoint,
    proof: &RV64IMACProof,
    setup: &VerifierSetup<BN254>,
    mut more: impl FnMut(u64) -> bool,
) -> Result<bool, String> {
    let dp = &proof.joint_opening_proof;
    // shape checks first, so a malformed proof is refused instead of panicking forever
    if dp.nu > dp.sigma
        || dp.first_messages.len() != dp.sigma
        || dp.second_messages.len() != dp.sigma
        || dp.sigma > setup.max_log_n / 2
    {
        return Err("dory: proof shape (nu, sigma, round count)".into());
    }
    while ck.phase != 3 && more(ck.next_unit_tgas()) {
        match ck.phase {
            1 if (ck.rlc_next as usize) < ck.rlc_commitments.len() => {
                // DoryCommitmentScheme::combine_commitments, one term
                let i = ck.rlc_next as usize;
                let term = jolt_to_ark(&ck.rlc_coeffs[i]) * ArkGT(ck.rlc_commitments[i]);
                ck.rlc_acc = (ArkGT(ck.rlc_acc) + term).0;
                ck.rlc_next += 1;
            }
            1 => {
                // dory::evaluation_proof::verify_evaluation_proof, up to the round loop
                let (nu, sigma) = (dp.nu, dp.sigma);
                if ck.point.len() != nu + sigma {
                    return Err("dory: point dimension".into());
                }
                let max_rounds = setup.max_log_n / 2;
                if sigma > max_rounds || dp.first_messages.len() != sigma || dp.second_messages.len() != sigma {
                    return Err("dory: round count".into());
                }
                let mut t = ck.transcript();
                {
                    let mut tr = JoltToDoryTranscript::new(&mut t);
                    let vmv = &dp.vmv_message;
                    tr.append_serde(b"vmv_c", &vmv.c);
                    tr.append_serde(b"vmv_d2", &vmv.d2);
                    tr.append_serde(b"vmv_e1", &vmv.e1);
                }
                let e2 = dory::primitives::arithmetic::Group::scale(&setup.g2_0, &ArkFr(ck.eval));
                let point: Vec<ArkFr> = ck.point.iter().map(|x| ArkFr(*x)).collect();
                let s1_coords: Vec<ArkFr> = point[..sigma].to_vec();
                let mut s2_coords: Vec<ArkFr> = vec![<ArkFr as dory::primitives::arithmetic::Field>::zero(); sigma];
                s2_coords[..nu].copy_from_slice(&point[sigma..sigma + nu]);
                let st = DoryVerifierState::<BN254>::new(
                    dp.vmv_message.c, ArkGT(ck.rlc_acc), dp.vmv_message.d2, dp.vmv_message.e1, e2,
                    s1_coords, s2_coords, sigma, setup.clone(),
                );
                ck.dory = vec![DoryCk::save(&st)];
                ck.keep(&t);
                ck.phase = 2;
            }
            2 => {
                let mut st = ck.dory[0].load(setup);
                let mut t = ck.transcript();
                let r = ck.dory_round as usize;
                let done = {
                    let mut tr = JoltToDoryTranscript::new(&mut t);
                    if r < dp.first_messages.len() {
                        let first = &dp.first_messages[r];
                        let second = &dp.second_messages[r];
                        tr.append_serde(b"d1_left", &first.d1_left);
                        tr.append_serde(b"d1_right", &first.d1_right);
                        tr.append_serde(b"d2_left", &first.d2_left);
                        tr.append_serde(b"d2_right", &first.d2_right);
                        tr.append_serde(b"e1_beta", &first.e1_beta);
                        tr.append_serde(b"e2_beta", &first.e2_beta);
                        let beta = tr.challenge_scalar(b"beta");
                        tr.append_serde(b"c_plus", &second.c_plus);
                        tr.append_serde(b"c_minus", &second.c_minus);
                        tr.append_serde(b"e1_plus", &second.e1_plus);
                        tr.append_serde(b"e1_minus", &second.e1_minus);
                        tr.append_serde(b"e2_plus", &second.e2_plus);
                        tr.append_serde(b"e2_minus", &second.e2_minus);
                        let alpha = tr.challenge_scalar(b"alpha");
                        st.process_round(first, second, &alpha, &beta).map_err(|e| format!("dory round {r}: {e:?}"))?;
                        false
                    } else {
                        let gamma = tr.challenge_scalar(b"gamma");
                        tr.append_serde(b"final_e1", &dp.final_message.e1);
                        tr.append_serde(b"final_e2", &dp.final_message.e2);
                        let d = tr.challenge_scalar(b"d");
                        st.verify_final(&dp.final_message, &gamma, &d, None).map_err(|e| format!("dory final: {e:?}"))?;
                        true
                    }
                };
                ck.dory = vec![DoryCk::save(&st)];
                ck.keep(&t);
                if done {
                    ck.phase = 3;
                } else {
                    ck.dory_round += 1;
                }
            }
            _ => unreachable!(),
        }
    }
    Ok(ck.phase == 3)
}
