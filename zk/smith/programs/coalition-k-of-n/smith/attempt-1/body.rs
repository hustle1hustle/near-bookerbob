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
    for (i, seat) in s.seats.iter().enumerate() {
        if seat.leg as usize != i {
            return Err("seat legs not sequential");
        }
    }

    // Rule 4: no member may appear twice (compare each seat against prior seats).
    for (i, a) in s.seats.iter().enumerate() {
        for b in s.seats.iter().take(i) {
            if a.member == b.member {
                return Err("duplicate member");
            }
        }
    }

    // Rules 5 and 6: validate delivery ids and count delivered seats.
    let mut delivered: u32 = 0;
    for seat in s.seats.iter() {
        if let Some(id) = &seat.delivered {
            let bytes = id.as_bytes();
            if bytes.len() != 64 {
                return Err("delivery id not 64 chars");
            }
            let mut hex_ok = true;
            for c in bytes.iter() {
                let lower_hex = (*c >= b'0' && *c <= b'9') || (*c >= b'a' && *c <= b'f');
                if !lower_hex {
                    hex_ok = false;
                }
            }
            if !hex_ok {
                return Err("delivery id not lowercase hex");
            }
            delivered = match delivered.checked_add(1) {
                Some(v) => v,
                None => return Err("delivered count overflow"),
            };
        }
    }

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
