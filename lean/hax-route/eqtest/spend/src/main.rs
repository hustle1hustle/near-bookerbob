//! Differential test: original spend-bucket body.rs vs the hax-dialect rewrite, same inputs.
extern crate alloc;
#[path = "../../../spend/src/types.rs"] mod types;
#[path = "../../../spend/src/smith_std.rs"] mod smith_std;
#[path = "../../../spend/src/body_orig.rs.txt"] mod body_orig;
#[path = "../../../spend/src/body.rs"] mod body;
use types::*;
struct R(u64);
impl R { fn n(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 } fn b(&mut self, k: u64) -> u64 { self.n() % k } }
fn main() {
    let mut r = R(0x2545f4914f6cdd1d); let n: usize = std::env::args().nth(1).map(|a| a.parse().unwrap()).unwrap_or(200000);
    let (mut ok, mut errs) = (0usize, std::collections::BTreeMap::new());
    for _ in 0..n {
        let tn = r.b(11) as usize; let mut t = 0u64;
        let thresholds: Vec<u64> = (0..tn).map(|_| { if r.b(12) == 0 { t = t.saturating_sub(r.b(3)) } else { t += r.b(5000) + 1 }; t }).collect();
        let as_of = match r.b(6) { 0 => 0, 1 => u32::MAX, _ => r.b(5000) as u32 };
        let window = match r.b(8) { 0 => 0, 1 => 3651, 2 => as_of.wrapping_add(1), _ => r.b(4000) as u32 };
        let rn = if r.b(30) == 0 { 257 } else { r.b(12) as usize };
        let records: Vec<Record> = (0..rn).map(|_| Record {
            day: if r.b(20) == 0 { as_of.wrapping_add(1 + r.b(3) as u32) } else { (as_of as u64).saturating_sub(r.b(5000)) as u32 },
            amount_cents: if r.b(10) == 0 { u64::MAX - r.b(10) } else { r.b(3000) },
            merchant: "x".into(),
        }).collect();
        let s = Private { salt: [7; 32], records };
        let root = if r.b(20) == 0 { [1; 32] } else { smith_std::commit("bookerbob/smith/spend-records/v0", &s) };
        let p = Public { records_root: root, as_of_day: as_of, window_days: window, thresholds_cents: thresholds };
        let a = body_orig::check(&p, &s); let b = body::check(&p, &s);
        assert_eq!(a, b, "DISAGREE");
        match a { Ok(o) => { ok += 1; let _ = o.bucket; } Err(e) => *errs.entry(e).or_insert(0usize) += 1 }
    }
    println!("spend-bucket: {n} cases, all agree. ok={ok} refusals={errs:?}");
}
