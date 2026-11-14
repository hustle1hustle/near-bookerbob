//! Differential test: original coalition body.rs vs the hax-dialect rewrite, same inputs.
extern crate alloc;
#[path = "../../../coalition/src/types.rs"] mod types;
#[path = "../../../coalition/src/smith_std.rs"] mod smith_std;
#[path = "../../../coalition/src/body_orig.rs.txt"] mod body_orig;
#[path = "../../../coalition/src/body.rs"] mod body;
use types::*;
struct R(u64);
impl R { fn n(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 } fn b(&mut self, k: u64) -> u64 { self.n() % k } }
fn id(r: &mut R) -> String {
    let hex = b"0123456789abcdef"; let len = match r.b(10) { 0 => 63, 1 => 65, 2 => 0, _ => 64 };
    let mut s: String = (0..len).map(|_| hex[r.b(16) as usize] as char).collect();
    if len > 0 && r.b(6) == 0 { let c = ['A', 'g', 'F', ' ', 'é'][r.b(5) as usize]; s.pop(); s.push(c); }
    s
}
fn main() {
    let mut r = R(0x9e3779b97f4a7c15); let n: usize = std::env::args().nth(1).map(|a| a.parse().unwrap()).unwrap_or(200000);
    let (mut ok, mut errs) = (0usize, std::collections::BTreeMap::new());
    for _ in 0..n {
        let k = r.b(11) as usize;
        let seats: Vec<Seat> = (0..k).map(|i| Seat {
            leg: if r.b(15) == 0 { r.b(10) as u32 } else { i as u32 },
            member: { let m = if r.b(3) == 0 { 4 } else { 1000 }; format!("m{}", r.b(m)) },
            price: r.n() as u128,
            delivered: if r.b(3) == 0 { None } else { Some(id(&mut r)) },
        }).collect();
        let s = Private { seats };
        let root = if r.b(20) == 0 { [r.b(256) as u8; 32] } else { smith_std::commit("bookerbob/smith/coalition-seats/v0", &s.seats) };
        let p = Public { coalition: "c".into(), job: r.n(), seats_root: root, k_min: if r.b(10) == 0 { u32::MAX } else { r.b(10) as u32 } };
        let a = body_orig::check(&p, &s); let b = body::check(&p, &s);
        assert_eq!(a, b, "DISAGREE on {:?} {:?}", p.k_min, s.seats.len());
        match a { Ok(_) => ok += 1, Err(e) => *errs.entry(e).or_insert(0usize) += 1 }
    }
    println!("coalition: {n} cases, all agree. ok={ok} refusals={errs:?}");
}
