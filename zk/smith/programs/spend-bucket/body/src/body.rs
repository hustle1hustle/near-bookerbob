use crate::types::*;
use crate::smith_std::commit;

pub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {
    // Rule 1: records_root must commit the whole private input (salt + records).
    let root = commit("bookerbob/smith/spend-records/v0", s);
    if root != p.records_root {
        return Err("records root mismatch");
    }

    // Rule 2: thresholds_cents holds 1..=8 entries, strictly increasing.
    if p.thresholds_cents.is_empty() || p.thresholds_cents.len() > 8 {
        return Err("thresholds count out of range");
    }
    for w in p.thresholds_cents.windows(2) {
        // windows(2) yields exactly-two-element slices, so these indexes are in bounds.
        if w[0] >= w[1] {
            return Err("thresholds not strictly increasing");
        }
    }

    // Rule 3: 1 <= window_days <= 3650 and window_days <= as_of_day.
    if p.window_days < 1 || p.window_days > 3650 || p.window_days > p.as_of_day {
        return Err("window_days out of range");
    }

    // Rule 4: at most 256 records; no record may be dated after as_of_day.
    if s.records.len() > 256 {
        return Err("too many records");
    }
    for r in s.records.iter() {
        if r.day > p.as_of_day {
            return Err("record day after as_of_day");
        }
    }

    // Rule 5: total over the half-open window (as_of_day - window_days, as_of_day],
    // with checked addition; overflow refuses.
    let lower = match p.as_of_day.checked_sub(p.window_days) {
        Some(d) => d,
        None => return Err("window underflow"),
    };
    let mut total: u64 = 0;
    for r in s.records.iter() {
        if r.day > lower && r.day <= p.as_of_day {
            match total.checked_add(r.amount_cents) {
                Some(t) => total = t,
                None => return Err("total overflow"),
            }
        }
    }

    // Rule 6: bucket = number of thresholds <= total (0 when total is below the first).
    // At most 8 thresholds, so this counter cannot overflow.
    let mut bucket: u32 = 0;
    for t in p.thresholds_cents.iter() {
        if *t <= total {
            bucket = bucket + 1;
        }
    }

    // Rule 7: reveal only the bucket.
    Ok(Output { bucket })
}
