// The embedded verifier preprocessing must be the standing program's (its sha256 is the program
// hash the bazaar registers). Fails the build otherwise.
use sha2::{Digest, Sha256};
fn main() {
    println!("cargo:rerun-if-changed=data/pp.dat.deflate");
    let z = std::fs::read("data/pp.dat.deflate").expect("data/pp.dat.deflate");
    let pp = miniz_oxide::inflate::decompress_to_vec(&z).expect("inflate");
    let h: String = Sha256::digest(&pp).iter().map(|b| format!("{b:02x}")).collect();
    let g = std::fs::read("data/gens.unc").expect("data/gens.unc");
    let gh: String = Sha256::digest(&g).iter().map(|b| format!("{b:02x}")).collect();
    // the Dory verifier setup of that preprocessing, uncompressed (checked equal to it by `audit`)
    assert_eq!(gh, "425f802465d9cbc9e54c07abed4615b25f1e3a67ad1faf79bd76646e9577c7c3", "embedded Dory setup changed");
    println!("cargo:rerun-if-changed=data/gens.unc");
    assert_eq!(h, "c780ceabae4decfa59703a9988ab2483313c6c1d2f15c7c0ad8fc60255a5c3a5", "embedded preprocessing is not the standing program");
}
