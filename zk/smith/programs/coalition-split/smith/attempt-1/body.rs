use crate::types::*;
use crate::smith_std::commit;
use alloc::vec::Vec;
use alloc::string::String;

pub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {
    let seats = &s.seats;

    // Rule 1: the commitment must match the private seat records.
    if p.seats_root != commit("bookerbob/smith/coalition-seats/v0", seats) {
        return Err("seats_root mismatch");
    }

    // Rule 1: between 1 and 8 seats, seat i has leg i, no member twice.
    let n = seats.len();
    if n < 1 || n > 8 {
        return Err("seat count out of range");
    }
    for (i, seat) in seats.iter().enumerate() {
        if seat.leg != i as u32 {
            return Err("leg out of order");
        }
    }
    for i in 0..n {
        for j in (i + 1)..n {
            if seats[i].member == seats[j].member {
                return Err("duplicate member");
            }
        }
    }

    // Rule 2: P = sum of all prices, D = sum of delivered prices.
    let mut total_price: u128 = 0;
    let mut delivered_price: u128 = 0;
    let mut undelivered: Vec<usize> = Vec::new();
    for (i, seat) in seats.iter().enumerate() {
        total_price = match total_price.checked_add(seat.price) {
            Some(v) => v,
            None => return Err("price sum overflow"),
        };
        if seat.delivered.is_some() {
            delivered_price = match delivered_price.checked_add(seat.price) {
                Some(v) => v,
                None => return Err("delivered price sum overflow"),
            };
        } else {
            undelivered.push(i);
        }
    }
    if total_price == 0 {
        return Err("total price is zero");
    }

    // Rule 3: slashed bonds and the deliverers' half.
    let missed = undelivered.len() as u128;
    let slashed_total = match p.bond.checked_mul(missed) {
        Some(v) => v,
        None => return Err("slashed total overflow"),
    };
    let to_deliverers = if delivered_price > 0 {
        slashed_total - slashed_total / 2
    } else {
        0
    };

    // Rules 4-6: recompute every deliverer line and the slashed list in seat order.
    let mut expect_delivered: Vec<Payout> = Vec::new();
    let mut expect_slashed: Vec<String> = Vec::new();
    let mut paid_out: u128 = 0;
    for seat in seats.iter() {
        if seat.delivered.is_some() {
            let bond_back = p.bond;
            let share_num = match p.budget.checked_mul(seat.price) {
                Some(v) => v,
                None => return Err("budget share overflow"),
            };
            let share = share_num / total_price;
            let from_slashed = if delivered_price > 0 {
                let slashed_num = match to_deliverers.checked_mul(seat.price) {
                    Some(v) => v,
                    None => return Err("slashed share overflow"),
                };
                slashed_num / delivered_price
            } else {
                0
            };
            let line_total = match bond_back.checked_add(share) {
                Some(v) => match v.checked_add(from_slashed) {
                    Some(w) => w,
                    None => return Err("payout line overflow"),
                },
                None => return Err("payout line overflow"),
            };
            paid_out = match paid_out.checked_add(line_total) {
                Some(v) => v,
                None => return Err("paid out overflow"),
            };
            let line = Payout {
                member: seat.member.clone(),
                bond_back,
                share,
                from_slashed,
            };
            expect_delivered.push(line);
        } else {
            expect_slashed.push(seat.member.clone());
        }
    }

    // Rule 5: buyer's remainder.
    let bond_pool = match p.bond.checked_mul(n as u128) {
        Some(v) => v,
        None => return Err("bond pool overflow"),
    };
    let pool = match p.budget.checked_add(bond_pool) {
        Some(v) => v,
        None => return Err("pool overflow"),
    };
    let to_buyer = match pool.checked_sub(paid_out) {
        Some(v) => v,
        None => return Err("to_buyer underflow"),
    };

    // Rule 6: the announced payouts must match exactly.
    if expect_delivered != p.delivered {
        return Err("delivered payouts mismatch");
    }
    if expect_slashed != p.slashed {
        return Err("slashed members mismatch");
    }
    if to_buyer != p.to_buyer {
        return Err("to_buyer mismatch");
    }

    // Rule 8: output counts and total paid.
    Ok(Output {
        deliverers: expect_delivered.len() as u32,
        slashed: expect_slashed.len() as u32,
        paid_out,
    })
}
