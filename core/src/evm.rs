//! EVM payout transaction for the Chain Signatures leg: an EIP-1559 (type 2) USDC
//! `transfer(merchant, amount)` on Base Sepolia, its signing hash, and the signed raw
//! transaction from an MPC secp256k1 signature. Checked byte for byte against ethers 6
//! (`fixtures/evm/tx-vectors.json`).
use sha3::{Digest, Keccak256};

/// Base Sepolia.
pub const CHAIN_ID: u64 = 84_532;
/// Circle's USDC on Base Sepolia (6 decimals, same base units as NEAR USDC).
pub const USDC: [u8; 20] = [0x03, 0x6c, 0xbd, 0x53, 0x84, 0x2c, 0x54, 0x26, 0x63, 0x4e, 0x79, 0x29, 0x54, 0x1e, 0xc2, 0x31, 0x8f, 0x3d, 0xcf, 0x7e];
pub const MAX_PRIORITY_FEE: u128 = 1_000_000;
pub const MAX_FEE: u128 = 100_000_000;
pub const GAS_LIMIT: u64 = 100_000;

pub fn keccak(b: &[u8]) -> [u8; 32] {
    Keccak256::digest(b).into()
}

fn be_trimmed(n: u128) -> Vec<u8> {
    let b = n.to_be_bytes();
    let i = b.iter().position(|x| *x != 0).unwrap_or(b.len());
    b[i..].to_vec()
}

/// RLP string.
fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 0x80 {
        return b.to_vec();
    }
    let mut out = rlp_len(b.len(), 0x80);
    out.extend_from_slice(b);
    out
}

fn rlp_uint(n: u128) -> Vec<u8> {
    rlp_bytes(&be_trimmed(n))
}

fn rlp_len(len: usize, offset: u8) -> Vec<u8> {
    if len < 56 {
        vec![offset + len as u8]
    } else {
        let l = be_trimmed(len as u128);
        let mut out = vec![offset + 55 + l.len() as u8];
        out.extend(l);
        out
    }
}

fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let body: Vec<u8> = items.concat();
    let mut out = rlp_len(body.len(), 0xc0);
    out.extend(body);
    out
}

/// `transfer(address,uint256)` calldata.
pub fn transfer_data(to: &[u8; 20], amount: u128) -> Vec<u8> {
    let mut d = vec![0xa9, 0x05, 0x9c, 0xbb];
    d.extend_from_slice(&[0u8; 12]);
    d.extend_from_slice(to);
    d.extend_from_slice(&[0u8; 16]);
    d.extend_from_slice(&amount.to_be_bytes());
    d
}

fn fields(to: &[u8; 20], amount: u128, nonce: u64) -> Vec<Vec<u8>> {
    vec![
        rlp_uint(CHAIN_ID as u128),
        rlp_uint(nonce as u128),
        rlp_uint(MAX_PRIORITY_FEE),
        rlp_uint(MAX_FEE),
        rlp_uint(GAS_LIMIT as u128),
        rlp_bytes(&USDC),
        rlp_uint(0),
        rlp_bytes(&transfer_data(to, amount)),
        rlp_list(&[]),
    ]
}

/// `0x02 || rlp([chain_id, nonce, tip, fee, gas, USDC, 0, data, []])`.
pub fn unsigned_payout(to: &[u8; 20], amount: u128, nonce: u64) -> Vec<u8> {
    let mut out = vec![0x02];
    out.extend(rlp_list(&fields(to, amount, nonce)));
    out
}

/// What the MPC signer signs (domain 0, secp256k1).
pub fn payout_hash(to: &[u8; 20], amount: u128, nonce: u64) -> [u8; 32] {
    keccak(&unsigned_payout(to, amount, nonce))
}

/// The signed raw tx from the MPC answer: `big_r` (compressed point, 33 bytes; r is its x),
/// `s` (32 bytes) and the recovery id (y parity).
pub fn signed_payout(to: &[u8; 20], amount: u128, nonce: u64, big_r: &[u8; 33], s: &[u8; 32], recovery_id: u8) -> Vec<u8> {
    let mut items = fields(to, amount, nonce);
    let trim = |x: &[u8]| -> Vec<u8> { x[x.iter().position(|b| *b != 0).unwrap_or(x.len())..].to_vec() };
    items.push(rlp_uint(recovery_id as u128 & 1));
    items.push(rlp_bytes(&trim(&big_r[1..])));
    items.push(rlp_bytes(&trim(s)));
    let mut out = vec![0x02];
    out.extend(rlp_list(&items));
    out
}

/// "0x" + 40 hex, any case.
pub fn parse_address(s: &str) -> Option<[u8; 20]> {
    let h = s.strip_prefix("0x")?;
    if h.len() != 40 {
        return None;
    }
    hex::decode(h).ok()?.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTORS: &str = include_str!("../../fixtures/evm/tx-vectors.json");

    #[test]
    fn payouts_match_ethers_byte_for_byte() {
        let v: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        assert_eq!(v["chain_id"].as_u64(), Some(CHAIN_ID));
        assert_eq!(parse_address(v["usdc"].as_str().unwrap()), Some(USDC));
        for c in v["cases"].as_array().unwrap() {
            let to = parse_address(c["merchant"].as_str().unwrap()).unwrap();
            let amount: u128 = c["amount"].as_str().unwrap().parse().unwrap();
            let nonce = c["nonce"].as_u64().unwrap();
            assert_eq!(format!("0x{}", hex::encode(unsigned_payout(&to, amount, nonce))), c["unsigned_serialized"].as_str().unwrap());
            assert_eq!(format!("0x{}", hex::encode(payout_hash(&to, amount, nonce))), c["unsigned_hash"].as_str().unwrap());
        }
    }

    #[test]
    fn signed_payouts_match_ethers_from_r_s_and_parity() {
        let v: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        for c in v["cases"].as_array().unwrap() {
            let to = parse_address(c["merchant"].as_str().unwrap()).unwrap();
            let amount: u128 = c["amount"].as_str().unwrap().parse().unwrap();
            let sig = &c["test_signature"];
            let parity = sig["y_parity"].as_u64().unwrap() as u8;
            let r: [u8; 32] = hex::decode(&sig["r"].as_str().unwrap()[2..]).unwrap().try_into().unwrap();
            let s: [u8; 32] = hex::decode(&sig["s"].as_str().unwrap()[2..]).unwrap().try_into().unwrap();
            // The MPC answers with big_r as a compressed point: 02 or 03 by y parity, then r.
            let mut big_r = [0u8; 33];
            big_r[0] = 2 + parity;
            big_r[1..].copy_from_slice(&r);
            let raw = signed_payout(&to, amount, c["nonce"].as_u64().unwrap(), &big_r, &s, parity);
            assert_eq!(format!("0x{}", hex::encode(raw)), c["signed_serialized"].as_str().unwrap());
        }
    }

    /// The live MPC answer (testnet tx 4AN6Ytp4..) assembles into the committed raw payout,
    /// which ethers recovers to the MPC-derived payer 0x56AaAf0e...DF78.
    #[test]
    fn live_mpc_answer_assembles_the_committed_raw_payout() {
        let v: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/live/evm-sign.json")).unwrap();
        let p = &v["payout"];
        let to = parse_address(p["to"].as_str().unwrap()).unwrap();
        let amount: u128 = p["amount"].as_str().unwrap().parse().unwrap();
        let nonce = p["nonce"].as_u64().unwrap();
        assert_eq!(hex::encode(payout_hash(&to, amount, nonce)), v["payload"].as_str().unwrap());
        let big_r: [u8; 33] = hex::decode(v["big_r"]["affine_point"].as_str().unwrap()).unwrap().try_into().unwrap();
        let sig_s: [u8; 32] = hex::decode(v["s"]["scalar"].as_str().unwrap()).unwrap().try_into().unwrap();
        let raw = signed_payout(&to, amount, nonce, &big_r, &sig_s, v["recovery_id"].as_u64().unwrap() as u8);
        assert_eq!(format!("0x{}\n", hex::encode(raw)), include_str!("../../fixtures/live/evm-payout-raw.txt"));
    }

    #[test]
    fn bad_addresses_are_refused() {
        assert!(parse_address("0x1234").is_none());
        assert!(parse_address("1111111111111111111111111111111111111111").is_none());
        assert!(parse_address("0xzz11111111111111111111111111111111111111").is_none());
    }
}
