use crate::types::*;
use crate::smith_std::commit;

pub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {
    // Rule 1: the public root must commit to exactly these private seat records.
    let root = commit("bookerbob/smith/coalition-seats/v0", &s.seats);
    if root != p.seats_root {
        return Err("seats_root mismatch");
    }

    // Rule 2: between 1 and 8 seats.
    let seats = s.seats.len();
    if seats < 1 || seats > 8 {
        return Err("seat count out of range");
    }

    // Rule 3: seat i must have leg i (0, 1, 2, ... in order).
    legs_sequential(&s.seats)?;

    // Rule 4: no member may appear twice (compare each seat against prior seats).
    no_duplicate_member(&s.seats)?;

    // Rules 5 and 6: validate delivery ids and count delivered seats.
    let delivered = count_delivered(&s.seats)?;

    // Rule 7: threshold; k_min = 0 passes even with zero deliveries.
    if delivered < p.k_min {
        return Err("delivered below k_min");
    }

    // Rule 8: reveal only the two counts, never which members delivered.
    Ok(Output {
        delivered,
        seats: seats as u32,
    })
}

fn legs_sequential(seats: &[Seat]) -> Result<(), &'static str> {
    for (i, seat) in seats.iter().enumerate() {
        if seat.leg as usize != i {
            return Err("seat legs not sequential");
        }
    }
    Ok(())
}

fn no_duplicate_member(seats: &[Seat]) -> Result<(), &'static str> {
    let mut dup = false;
    let mut i = 0;
    while i < seats.len() {
        let mut j = 0;
        while j < i {
            if seats[i].member == seats[j].member {
                dup = true;
            }
            j += 1;
        }
        i += 1;
    }
    if dup {
        return Err("duplicate member");
    }
    Ok(())
}

fn count_delivered(seats: &[Seat]) -> Result<u32, &'static str> {
    let mut delivered: u32 = 0;
    for seat in seats.iter() {
        if let Some(id) = &seat.delivered {
            let bytes = id.as_bytes();
            if bytes.len() != 64 {
                return Err("delivery id not 64 chars");
            }
            if !all_lower_hex(bytes) {
                return Err("delivery id not lowercase hex");
            }
            delivered = match delivered.checked_add(1) {
                Some(v) => v,
                None => return Err("delivered count overflow"),
            };
        }
    }
    Ok(delivered)
}

fn all_lower_hex(bytes: &[u8]) -> bool {
    let mut hex_ok = true;
    for c in bytes.iter() {
        let lower_hex = (*c >= b'0' && *c <= b'9') || (*c >= b'a' && *c <= b'f');
        if !lower_hex {
            hex_ok = false;
        }
    }
    hex_ok
}
