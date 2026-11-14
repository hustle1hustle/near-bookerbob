//! Native: sizes of the preprocessing parts and time per verifier stage.
use ark_serialize::CanonicalSerialize;
use std::time::Instant;
fn main() {
    let dir = std::env::args().nth(1).expect("dir with proof.bin, io_device.bin, jolt_verifier_preprocessing.dat");
    let rd = |f: &str| std::fs::read(format!("{dir}/{f}")).unwrap();
    let t = Instant::now();
    let pp = bookerbob_jolt_onchain::read_pp(&rd("jolt_verifier_preprocessing.dat")).unwrap();
    println!("deserialize preprocessing: {:?}", t.elapsed());
    println!("max_padded_trace_length {} max_input {} max_output {} max_log_n {}", pp.shared.max_padded_trace_length, pp.shared.memory_layout.max_input_size, pp.shared.memory_layout.max_output_size, pp.generators.max_log_n);
    assert_eq!(pp.shared.max_padded_trace_length, 1 << 24, "contract.rs MAX_PADDED_TRACE_LENGTH");
    assert_eq!(pp.shared.memory_layout.max_input_size, 4096, "contract.rs MAX_INPUT_SIZE");
    assert_eq!(pp.shared.memory_layout.max_output_size, 4096, "contract.rs MAX_OUTPUT_SIZE");
    println!("pp.generators bytes: {}", pp.generators.compressed_size());
    println!("pp.shared bytes: {}", pp.shared.compressed_size());
    println!("  bytecode: {}", pp.shared.bytecode.compressed_size());
    println!("  ram: {}", pp.shared.ram.compressed_size());
    let proof = bookerbob_jolt_onchain::read_proof(&rd("proof.bin")).unwrap();
    if let Some(out) = std::env::args().nth(2).filter(|s| !s.is_empty()) {
        // uncompressed copies, for unchecked loading in the contract
        let mut b = Vec::new(); pp.serialize_uncompressed(&mut b).unwrap();
        std::fs::write(format!("{out}/pp.unc"), &b).unwrap(); println!("pp.unc {}", b.len());
        let mut b = Vec::new(); pp.generators.serialize_uncompressed(&mut b).unwrap();
        std::fs::write(format!("{out}/gens.unc"), &b).unwrap(); println!("gens.unc {}", b.len());
        let mut b = Vec::new(); proof.serialize_uncompressed(&mut b).unwrap();
        std::fs::write(format!("{out}/proof.unc"), &b).unwrap(); println!("proof.unc {}", b.len());
    }
    let io = bookerbob_jolt_onchain::read_io(&rd("io_device.bin")).unwrap();
    println!("dory nu {} sigma {} rounds {}", proof.joint_opening_proof.nu, proof.joint_opening_proof.sigma, proof.joint_opening_proof.first_messages.len());
    println!("trace_length {} ram_K {} commitments {}", proof.trace_length, proof.ram_K, proof.commitments.len());
    let mut last = Instant::now();
    let r = bookerbob_jolt_onchain::run(&pp, proof, io, 8, |s| {
        println!("stage {s}: {:?}", last.elapsed());
        last = Instant::now();
    });
    println!("result: {r:?}");
    let good = rd("proof.bin");
    if let Some(out) = std::env::args().nth(3) {
        // forged-dory.bin: the honest proof with the final Dory message's E1 moved by the G1
        // generator (still a valid point, so it passes submit's checks and stages 1-7).
        use ark_ec::PrimeGroup;
        let mut p = bookerbob_jolt_onchain::read_proof(&good).unwrap();
        let g = jolt_core::ark_bn254::G1Projective::generator();
        p.joint_opening_proof.final_message.e1 = dory::backends::arkworks::ArkG1(p.joint_opening_proof.final_message.e1.0 + g);
        let mut b = Vec::new(); p.serialize_compressed(&mut b).unwrap();
        std::fs::write(format!("{out}/forged-dory.bin"), &b).unwrap();
        println!("resumable, forged Dory final message: {:?}", resumable(&dir, &b));
        // forged-io.bin: the honest io with the last output byte changed (a different claim)
        let mut io = bookerbob_jolt_onchain::read_io(&rd("io_device.bin")).unwrap();
        let n = io.outputs.len(); io.outputs[n - 1] ^= 1;
        let mut b = Vec::new(); io.serialize_compressed(&mut b).unwrap();
        std::fs::write(format!("{out}/forged-io.bin"), &b).unwrap();
    }
    println!("resumable, honest proof: {:?}", resumable(&dir, &good));
    // forged: one byte changed in a sumcheck message, and one in the last Dory round message
    for (what, at) in [("sumcheck area", good.len() / 2), ("dory final message", good.len() - 40)] {
        let mut bad = good.clone();
        bad[at] ^= 1;
        println!("resumable, forged ({what}, byte {at}): {:?}", resumable(&dir, &bad));
    }
}

/// Resumable flow, natively: every unit starts from checkpoint bytes, as on chain.
#[allow(dead_code)]
pub fn resumable(dir: &str, proof_bytes: &[u8]) -> Result<usize, String> {
    use bookerbob_jolt_onchain::resumable::{stages, step, Checkpoint};
    let rd = |f: &str| std::fs::read(format!("{dir}/{f}")).unwrap();
    let pp = bookerbob_jolt_onchain::read_pp(&rd("jolt_verifier_preprocessing.dat"))?;
    let setup = pp.generators.clone().into_inner();
    let proof = bookerbob_jolt_onchain::read_proof(proof_bytes)?;
    let io = bookerbob_jolt_onchain::read_io(&rd("io_device.bin"))?;
    let t = Instant::now();
    let mut bytes = stages(&pp, proof, io)?.to_bytes();
    println!("  unit stages: {:?}, checkpoint {} bytes", t.elapsed(), bytes.len());
    let proof = bookerbob_jolt_onchain::read_proof(proof_bytes)?;
    let mut n = 1;
    loop {
        let mut ck = Checkpoint::from_bytes(&bytes)?;
        let t = Instant::now();
        let (phase, rlc, round) = (ck.phase, ck.rlc_next, ck.dory_round);
        let mut once = true;
        let done = step(&mut ck, &proof, &setup, |_| std::mem::take(&mut once))?;
        n += 1;
        if n <= 3 || phase == 2 && (round == 0 || done) || rlc == 0 && phase == 1 && n > 3 {
            println!("  unit {n}: phase {phase} rlc {rlc} round {round}: {:?}", t.elapsed());
        }
        bytes = ck.to_bytes();
        if done {
            return Ok(n);
        }
    }
}
