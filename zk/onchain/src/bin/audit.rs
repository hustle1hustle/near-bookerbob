//! Forgery harness from the soundness audit (coordinating session, 2026-11-14): six Dory-targeted
//! forgeries, the shape attacks (trace0, tracehuge, nusigma) and io malleability.
//! `cargo run --release --features native --bin audit -- ../out/standing-testnet-3 [trace0|tracehuge|nusigma]`
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use bookerbob_jolt_onchain::resumable::{stages, step, Checkpoint};
use bookerbob_jolt_onchain::*;
use jolt_core::ark_bn254::{G1Projective, G2Projective};
use ark_ec::PrimeGroup;

fn run_res(pp: &Preprocessing, proof_c: &[u8], io: &JoltDevice) -> Result<(usize, usize), String> {
    let setup = <jolt_core::poly::commitment::dory::ArkworksVerifierSetup as CanonicalDeserialize>::deserialize_uncompressed_unchecked(&include_bytes!("../../data/gens.unc")[..]).unwrap().into_inner();
    let proof = read_proof(proof_c)?;
    let mut bytes = stages(pp, proof, io.clone())?.to_bytes();
    let cksz = bytes.len();
    let proof = read_proof(proof_c)?;
    let mut n = 1;
    loop {
        let mut ck = Checkpoint::from_bytes(&bytes)?;
        let mut once = true;
        let done = step(&mut ck, &proof, &setup, |_| std::mem::take(&mut once)).map_err(|e| format!("unit {}: {e}", n + 1))?;
        n += 1;
        bytes = ck.to_bytes();
        if done { return Ok((n, cksz)); }
    }
}
fn ser(p: &jolt_core::zkvm::RV64IMACProof) -> Vec<u8> { let mut b = Vec::new(); p.serialize_compressed(&mut b).unwrap(); b }

fn main() {
    let dir = std::env::args().nth(1).unwrap();
    let rd = |f: &str| std::fs::read(format!("{dir}/{f}")).unwrap();
    let ppb = rd("jolt_verifier_preprocessing.dat");
    let pp = read_pp(&ppb).unwrap();
    let mut g = Vec::new(); pp.generators.serialize_uncompressed(&mut g).unwrap();
    let gens = include_bytes!("../../data/gens.unc");
    println!("gens.unc == pp.generators (uncompressed): {} ({} vs {} bytes)", &g[..] == &gens[..], g.len(), gens.len());
    let good = rd("proof.bin");
    let io = read_io(&rd("io_device.bin")).unwrap();
    println!("io panic={} inputs={}B outputs={}B max_out={}", io.panic, io.inputs.len(), io.outputs.len(), io.memory_layout.max_output_size);
    println!("honest: {:?}", run_res(&pp, &good, &io));
    let base = read_proof(&good).unwrap();
    let fresh = || read_proof(&good).unwrap();
    let g1 = G1Projective::generator(); let g2 = G2Projective::generator();
    let mut cases: Vec<(&str, jolt_core::zkvm::RV64IMACProof)> = vec![];
    let mut p = fresh(); p.joint_opening_proof.final_message.e1.0 += g1; cases.push(("dory final e1 += G1", p));
    let mut p = fresh(); p.joint_opening_proof.final_message.e2.0 += g2; cases.push(("dory final e2 += G2", p));
    let last = base.joint_opening_proof.first_messages.len() - 1;
    let mut p = fresh(); p.joint_opening_proof.first_messages[last].e1_beta.0 += g1; cases.push(("dory last round e1_beta += G1", p));
    let mut p = fresh(); p.joint_opening_proof.second_messages[0].c_plus.0 = p.joint_opening_proof.second_messages[0].c_plus.0 * p.joint_opening_proof.second_messages[0].c_plus.0; cases.push(("dory round0 c_plus squared", p));
    let mut p = fresh(); p.joint_opening_proof.vmv_message.e1.0 += g1; cases.push(("dory vmv e1 += G1", p));
    let mut p = fresh(); p.joint_opening_proof.vmv_message.d2.0 = p.joint_opening_proof.vmv_message.d2.0 * p.joint_opening_proof.vmv_message.d2.0; cases.push(("dory vmv d2 squared", p));
    for (what, p) in cases {
        let b = ser(&p);
        let full = { let pr = read_proof(&b).unwrap(); run(&pp, pr, io.clone(), 8, |_| {}) };
        println!("{what}: resumable={:?} | upstream-full={:?}", run_res(&pp, &b, &io), full);
    }
    if let Some(m) = std::env::args().nth(2) {
        let mut p = fresh();
        match m.as_str() {
            "trace0" => p.trace_length = 0,
            "tracehuge" => p.trace_length = usize::MAX,
            "nusigma" => { let d = &mut p.joint_opening_proof; let (n, s) = (d.nu, d.sigma); println!("orig nu {n} sigma {s}"); d.nu = s + 1; d.sigma = n - 1; d.first_messages.truncate(n - 1); d.second_messages.truncate(n - 1); }
            _ => {}
        }
        let b = ser(&p);
        if let Ok(out) = std::env::var("AUDIT_OUT") { std::fs::write(format!("{out}/{m}.bin"), &b).unwrap(); }
        println!("{m}: deserialize(checked) ok={}", read_proof(&b).is_ok());
        println!("{m}: resumable={:?}", run_res(&pp, &b, &io));
        return;
    }
    // the shipped main.rs byte flips
    for at in [good.len() / 2, good.len() - 40] {
        let mut bad = good.clone(); bad[at] ^= 1;
        println!("byte flip {at}/{}: {:?}", good.len(), run_res(&pp, &bad, &io));
    }
    // io malleability: trailing zero output bytes
    let mut io2 = io.clone(); io2.outputs.extend([0u8; 4]);
    println!("io outputs + 4 zero bytes: {:?}", run_res(&pp, &good, &io2));
    if let Ok(out) = std::env::var("AUDIT_OUT") {
        let w = |name: &str, d: &JoltDevice| { let mut b = Vec::new(); d.serialize_compressed(&mut b).unwrap(); std::fs::write(format!("{out}/{name}"), b).unwrap(); };
        let mut a = io.clone(); a.panic = true; w("io-panic.bin", &a);
        let mut a = io.clone(); a.outputs.resize(5000, 7); w("io-outputs-5000.bin", &a);
    }
    let mut io3 = io.clone(); io3.panic = !io3.panic;
    println!("io panic flipped: {:?}", run_res(&pp, &good, &io3));
}
