//! u128 as a decimal JSON string, the NEAR convention for token amounts.
use serde::{de::Error, Deserialize, Deserializer, Serializer};

pub fn serialize<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&v.to_string())
}

pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
    let s = String::deserialize(d)?;
    s.parse::<u128>().map_err(D::Error::custom)
}
