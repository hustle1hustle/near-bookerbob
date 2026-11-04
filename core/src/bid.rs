//! Blind bid commitment for a round: `sha256("bookerbob/bid/v0\0" || account || 0 ||
//! json(schedule) || salt)`. Shared by the contract (`commit_bid`, `reveal_bid`), the CLI
//! board and the JS merchant SDK, which must all produce the same bytes.
use crate::price::Schedule;

pub const BID_TAG: &[u8] = b"bookerbob/bid/v0\x00";

pub fn bid_commitment(account: &str, schedule: &Schedule, salt: &[u8; 32]) -> String {
    let mut b = BID_TAG.to_vec();
    b.extend_from_slice(account.as_bytes());
    b.push(0);
    b.extend(serde_json::to_vec(schedule).expect("serializes"));
    b.extend_from_slice(salt);
    crate::sha256_hex(&b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::price::Rule;

    #[test]
    fn commitment_binds_account_schedule_and_salt() {
        let s = Schedule { base_price: 48_000_000, rules: vec![Rule { predicate: "world_id_human".into(), bps: 1000 }], cap_bps: 2000, cohort: None };
        let c = bid_commitment("m01.x.testnet", &s, &[1; 32]);
        assert_eq!(c.len(), 64);
        assert_ne!(c, bid_commitment("m02.x.testnet", &s, &[1; 32]));
        assert_ne!(c, bid_commitment("m01.x.testnet", &s, &[2; 32]));
        let mut s2 = s.clone();
        s2.cap_bps = 2001;
        assert_ne!(c, bid_commitment("m01.x.testnet", &s2, &[1; 32]));
    }
}
