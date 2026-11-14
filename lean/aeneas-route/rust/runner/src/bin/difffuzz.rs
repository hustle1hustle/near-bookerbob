//! Direct differential fuzz: dialect body vs original body.rs on N random inputs whose root is
//! always recommitted (so every rule is reached). Inputs are built with the ORIGINAL types
//! (String), encoded with postcard, and the same bytes go to both `run`s. Also checks that the
//! dialect types re-encode to the same bytes (wire identity). Exit 3 on any difference.
use original::types as o;
fn main() {
    let n: u64 = std::env::args().nth(1).map(|s| s.parse().unwrap()).unwrap_or(100_000);
    let mut seed: u64 = std::env::args().nth(2).map(|s| s.parse().unwrap()).unwrap_or(1);
    let mut r = move || { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; seed };
    let mut hist = std::collections::BTreeMap::<String, u64>::new();
    for _ in 0..n {
        let k = (r() % 11) as usize; // 0..10 seats: out of range both sides
        let mut seats = Vec::new();
        for i in 0..k {
            let leg = if r() % 20 == 0 { (r() % 12) as u32 } else { i as u32 };
            let member = ["a", "b", "c", "d", "e", "f", "g", "h", "", "é", "ab"][(r() % 11) as usize].to_string();
            let delivered = if r() % 3 == 0 { None } else {
                let len = match r() % 8 { 0 => 63, 1 => 65, 2 => 0, _ => 64 };
                let alpha: &[u8] = if r() % 6 == 0 { b"0123456789abcdefABCDEFgz/:`@" } else { b"0123456789abcdef" };
                let s: String = (0..len).map(|_| alpha[(r() as usize) % alpha.len()] as char).collect();
                Some(s)
            };
            seats.push(o::Seat { leg, member, price: (r() as u128) << (r() % 64), delivered });
        }
        let root = original::smith_std::commit("bookerbob/smith/coalition-seats/v0", &seats);
        let mut seats_root = root;
        if r() % 50 == 0 { seats_root[(r() % 32) as usize] ^= 1 }
        let p = o::Public { coalition: "c".into(), job: r(), seats_root, k_min: (r() % 6) as u32 };
        let s = o::Private { seats };
        let pb = postcard::to_allocvec(&p).unwrap();
        let sb = postcard::to_allocvec(&s).unwrap();
        // wire identity: dialect types decode and re-encode to the same bytes
        let dp: dialect::types::Public = postcard::from_bytes(&pb).unwrap();
        let ds: dialect::types::Private = postcard::from_bytes(&sb).unwrap();
        assert_eq!(postcard::to_allocvec(&dp).unwrap(), pb, "public wire differs");
        assert_eq!(postcard::to_allocvec(&ds).unwrap(), sb, "private wire differs");
        let a = dialect::run(&pb, &sb);
        let b = original::run(&pb, &sb);
        if a != b { eprintln!("DIFFER {:?} vs {:?} on {:?} {:?}", a, b, p, s); std::process::exit(3) }
        *hist.entry(match &b { Ok(_) => "ok".into(), Err(e) => e.to_string() }).or_default() += 1;
    }
    println!("dialect == original on {} inputs; outcomes: {:?}", n, hist);
}
