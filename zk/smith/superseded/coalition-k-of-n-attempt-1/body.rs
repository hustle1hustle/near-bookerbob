use crate::types::*;
use crate::smith_std::commit;

pub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {
    // Rule 1: the public root must be the commitment to exactly this seat list.
    if commit("bookerbob/smith/coalition-seats/v0", &s.seats) != p.seats_root {
        return Err("seats_root mismatch");
    }

    // Rule 2: between 1 and 8 seats.
    let n = s.seats.len();
    if n < 1 || n > 8 {
        return Err("seat count out of 1..=8");
    }

    // Rules 3, 4, 5 in one bounded pass (n <= 8, so all loops here are tiny).
    let mut delivered: u32 = 0;
    for (i, seat) in s.seats.iter().enumerate() {
        // Rule 3: seat i must have leg i. i <= 7 here, so the cast is exact.
        if seat.leg != i as u32 {
            return Err("legs not 0,1,2,.. in order");
        }
        // Rule 4: no member may appear twice; compare only against earlier seats.
        for earlier in s.seats.iter().take(i) {
            if earlier.member == seat.member {
                return Err("member appears twice");
            }
        }
        // Rule 5: a delivered seat carries exactly 64 lowercase hex characters.
        if let Some(hex) = &seat.delivered {
            let bytes = hex.as_bytes();
            if bytes.len() != 64 {
                return Err("delivery id not 64 chars");
            }
            for &c in bytes {
                let digit = (c >= b'0' && c <= b'9') || (c >= b'a' && c <= b'f');
                if !digit {
                    return Err("delivery id not lowercase hex");
                }
            }
            // Cannot overflow in practice (n <= 8), but stay checked anyway.
            delivered = match delivered.checked_add(1) {
                Some(d) => d,
                None => return Err("delivered count overflow"),
            };
        }
    }

    // Rule 7: threshold; k_min = 0 passes even with zero deliveries.
    if delivered < p.k_min {
        return Err("delivered below k_min");
    }

    // Rules 6 and 8: reveal only the two counts, never which members delivered.
    Ok(Output {
        delivered,
        seats: n as u32,
    })
}
