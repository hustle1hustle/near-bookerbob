#![no_std]
extern crate alloc;
use alloc::string::String;
use alloc::vec::Vec;
pub struct Seat { pub leg: u32, pub member: String, pub price: u128, pub delivered: Option<String> }

pub fn p01_for_iter_return(v: &[u32]) -> Result<u32, &'static str> { for x in v.iter() { if *x == 0 { return Err("zero"); } } Ok(1) }
pub fn p02_while_return(v: &[u32]) -> Result<u32, &'static str> { let mut i = 0; while i < v.len() { if v[i] == 0 { return Err("zero"); } i += 1; } Ok(1) }
pub fn p03_enumerate(v: &[u32]) -> bool { let mut ok = true; for (i, x) in v.iter().enumerate() { if *x as usize != i { ok = false; } } ok }
pub fn p04_enumerate_return(v: &[u32]) -> Result<(), &'static str> { for (i, x) in v.iter().enumerate() { if *x as usize != i { return Err("leg"); } } Ok(()) }
pub fn p05_nested_while(v: &[u32]) -> bool { let mut d = false; let mut i = 0; while i < v.len() { let mut j = 0; while j < i { if v[i] == v[j] { d = true; } j += 1; } i += 1; } d }
pub fn p06_nested_for_take(v: &[u32]) -> bool { let mut d = false; for (i, a) in v.iter().enumerate() { for b in v.iter().take(i) { if a == b { d = true; } } } d }
pub fn p07_string_eq(a: &String, b: &String) -> bool { a == b }
pub fn p08_as_bytes_len(a: &String) -> usize { a.as_bytes().len() }
pub fn p09_checked_add(x: u32) -> Result<u32, &'static str> { match x.checked_add(1) { Some(v) => Ok(v), None => Err("ovf") } }
pub fn p10_windows(v: &[u64]) -> bool { let mut ok = true; for w in v.windows(2) { if w[0] > w[1] { ok = false; } } ok }
pub fn p11_all_closure(v: &[u8]) -> bool { v.iter().all(|c| *c < 10) }
pub fn p12_u128_mul_div(a: u128, b: u128, d: u128) -> Option<u128> { a.checked_mul(b).map(|x| x / d) }
pub fn p13_vec_push(n: u32) -> Vec<u32> { let mut v = Vec::new(); let mut i = 0; while i < n { v.push(i); i += 1; } v }
pub fn p14_opt_ref(s: &Seat) -> usize { if let Some(id) = &s.delivered { id.len() } else { 0 } }
pub fn p15_break(v: &[u32]) -> usize { let mut i = 0; loop { if i >= v.len() || v[i] == 0 { break; } i += 1; } i }
pub fn p16_byte_cmp(c: u8) -> bool { (c >= b'0' && c <= b'9') || (c >= b'a' && c <= b'f') }
pub fn p17_cast(n: usize) -> u32 { n as u32 }
pub fn p18_vec_eq(a: &Vec<u128>, b: &Vec<u128>) -> bool { a == b }
pub fn p19_question(x: u32) -> Result<u32, &'static str> { let y = p09_checked_add(x)?; Ok(y) }
pub fn p20_sum_checked(v: &[u128]) -> Option<u128> { let mut s: u128 = 0; let mut i = 0; while i < v.len() { s = s.checked_add(v[i])?; i += 1; } Some(s) }
pub fn p21_for_range(n: usize) -> usize { let mut s = 0usize; for i in 0..n { s = s.wrapping_add(i); } s }
pub fn p22_while_field_return(v: &[Seat]) -> Result<u32, &'static str> { let mut d: u32 = 0; let mut i = 0; while i < v.len() { if v[i].delivered.is_some() { d = match d.checked_add(1) { Some(x) => x, None => return Err("ovf") }; } i += 1; } Ok(d) }
pub fn p23_str_bytes_index(a: &String) -> bool { let b = a.as_bytes(); let mut ok = true; let mut i = 0; while i < b.len() { if b[i] > 102 { ok = false; } i += 1; } ok }
pub fn p24_recursion(v: &[u32], i: usize) -> bool { if i >= v.len() { true } else { v[i] != 0 && p24_recursion(v, i + 1) } }
pub fn p25_two_loops_return(v: &[u32]) -> Result<u32, &'static str> { for x in v.iter() { if *x == 0 { return Err("zero"); } } for x in v.iter() { if *x == 1 { return Err("one"); } } Ok(1) }
pub fn p26_two_while_return(v: &[u32]) -> Result<u32, &'static str> { let mut i = 0; while i < v.len() { if v[i] == 0 { return Err("zero"); } i += 1; } let mut j = 0; while j < v.len() { if v[j] == 1 { return Err("one"); } j += 1; } Ok(1) }
pub fn p27_loop_then_return(v: &[u32]) -> Result<u32, &'static str> { for x in v.iter() { if *x == 0 { return Err("zero"); } } if v.len() > 3 { return Err("long"); } Ok(1) }
