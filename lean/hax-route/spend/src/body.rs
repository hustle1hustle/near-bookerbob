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
    strictly_increasing(&p.thresholds_cents)?;

    // Rule 3: 1 <= window_days <= 3650 and window_days <= as_of_day.
    if p.window_days < 1 || p.window_days > 3650 || p.window_days > p.as_of_day {
        return Err("window_days out of range");
    }

    // Rule 4: at most 256 records; no record may be dated after as_of_day.
    if s.records.len() > 256 {
        return Err("too many records");
    }
    no_record_after(&s.records, p.as_of_day)?;

    // Rule 5: total over the half-open window (as_of_day - window_days, as_of_day],
    // with checked addition; overflow refuses.
    let lower = match p.as_of_day.checked_sub(p.window_days) {
        Some(d) => d,
        None => return Err("window underflow"),
    };
    let total = window_total(&s.records, lower, p.as_of_day)?;

    // Rule 6: bucket = number of thresholds <= total (0 when total is below the first).
    let bucket = bucket_of(&p.thresholds_cents, total);

    // Rule 7: reveal only the bucket.
    Ok(Output { bucket })
}

fn strictly_increasing(thresholds: &[u64]) -> Result<(), &'static str> {
    for w in thresholds.windows(2) {
        // windows(2) yields exactly-two-element slices, so these indexes are in bounds.
        if w[0] >= w[1] {
            return Err("thresholds not strictly increasing");
        }
    }
    Ok(())
}

fn no_record_after(records: &[Record], as_of_day: u32) -> Result<(), &'static str> {
    for r in records.iter() {
        if r.day > as_of_day {
            return Err("record day after as_of_day");
        }
    }
    Ok(())
}

fn window_total(records: &[Record], lower: u32, as_of_day: u32) -> Result<u64, &'static str> {
    let mut total: u64 = 0;
    for r in records.iter() {
        if r.day > lower && r.day <= as_of_day {
            match total.checked_add(r.amount_cents) {
                Some(t) => total = t,
                None => return Err("total overflow"),
            }
        }
    }
    Ok(total)
}

fn bucket_of(thresholds: &[u64], total: u64) -> u32 {
    // At most 8 thresholds, so this counter cannot overflow.
    let mut bucket: u32 = 0;
    for t in thresholds.iter() {
        if *t <= total {
            bucket = bucket + 1;
        }
    }
    bucket
}
