//! coalition-k-of-n in the Aeneas smith dialect: same checks, same order, same refusal strings
//! as the original body.rs. Dialect rules: no String / str methods (bytes are Vec<u8>), no
//! iterator adaptors or closures, `while` index loops only, no `return` / `break` inside a loop
//! (a loop only updates locals; the decision comes after it), one loop per helper function.
use crate::commits::commit_seats;
use crate::types::*;
use alloc::vec::Vec;

/// `a == b` on 32 bytes, as an index loop.
pub fn bytes32_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut eq = true;
    let mut i: usize = 0;
    while i < 32 {
        if a[i] != b[i] {
            eq = false;
        }
        i += 1;
    }
    eq
}

/// `a == b` on byte strings (the original's `String ==`).
pub fn bytes_eq(a: &Vec<u8>, b: &Vec<u8>) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut eq = true;
    let mut i: usize = 0;
    while i < a.len() {
        if a[i] != b[i] {
            eq = false;
        }
        i += 1;
    }
    eq
}

/// Rule 3: seat i has leg i.
pub fn legs_sequential(seats: &Vec<Seat>) -> bool {
    let mut ok = true;
    let mut i: usize = 0;
    while i < seats.len() {
        if seats[i].leg as usize != i {
            ok = false;
        }
        i += 1;
    }
    ok
}

/// Rule 4, inner loop: seat i's member differs from every seat before it.
pub fn member_new(seats: &Vec<Seat>, i: usize) -> bool {
    let mut ok = true;
    let mut j: usize = 0;
    while j < i {
        if bytes_eq(&seats[i].member, &seats[j].member) {
            ok = false;
        }
        j += 1;
    }
    ok
}

/// Rule 4: no member appears twice.
pub fn members_distinct(seats: &Vec<Seat>) -> bool {
    let mut ok = true;
    let mut i: usize = 0;
    while i < seats.len() {
        if !member_new(seats, i) {
            ok = false;
        }
        i += 1;
    }
    ok
}

/// Rule 5 on one id, the bytes all lowercase hex.
pub fn all_lower_hex(id: &Vec<u8>) -> bool {
    let mut ok = true;
    let mut i: usize = 0;
    while i < id.len() {
        let c = id[i];
        let lower_hex = (c >= b'0' && c <= b'9') || (c >= b'a' && c <= b'f');
        if !lower_hex {
            ok = false;
        }
        i += 1;
    }
    ok
}

/// Rule 5 on one seat: 0 = fine (or not delivered), 1 = wrong length, 2 = not lowercase hex.
pub fn seat_id_status(seat: &Seat) -> u8 {
    match &seat.delivered {
        None => 0,
        Some(id) => {
            if id.len() != 64 {
                1
            } else if !all_lower_hex(id) {
                2
            } else {
                0
            }
        }
    }
}

/// Rules 5 and 6: the first failing seat decides the refusal, as in the original's loop.
/// `status`: 0 = ok, 1 = id length, 2 = id hex, 3 = count overflow.
pub fn count_delivered(seats: &Vec<Seat>) -> Result<u32, &'static str> {
    let mut delivered: u32 = 0;
    let mut status: u8 = 0;
    let mut i: usize = 0;
    while i < seats.len() {
        if status == 0 {
            let st = seat_id_status(&seats[i]);
            if st != 0 {
                status = st;
            } else if seats[i].delivered.is_some() {
                match delivered.checked_add(1) {
                    Some(v) => delivered = v,
                    None => status = 3,
                }
            }
        }
        i += 1;
    }
    if status == 1 {
        Err("delivery id not 64 chars")
    } else if status == 2 {
        Err("delivery id not lowercase hex")
    } else if status == 3 {
        Err("delivered count overflow")
    } else {
        Ok(delivered)
    }
}

pub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {
    // Rule 1
    let root = commit_seats("bookerbob/smith/coalition-seats/v0", &s.seats);
    if !bytes32_eq(&root, &p.seats_root) {
        return Err("seats_root mismatch");
    }
    // Rule 2
    let seats = s.seats.len();
    if seats < 1 || seats > 8 {
        return Err("seat count out of range");
    }
    // Rule 3
    if !legs_sequential(&s.seats) {
        return Err("seat legs not sequential");
    }
    // Rule 4
    if !members_distinct(&s.seats) {
        return Err("duplicate member");
    }
    // Rules 5 and 6
    let delivered = match count_delivered(&s.seats) {
        Ok(d) => d,
        Err(e) => return Err(e),
    };
    // Rule 7
    if delivered < p.k_min {
        return Err("delivered below k_min");
    }
    // Rule 8
    Ok(Output { delivered, seats: seats as u32 })
}
