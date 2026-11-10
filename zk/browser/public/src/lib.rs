//! The public statement of a decide proof. `public.json` is what a person reads; `inputs` and
//! `outputs` are the bytes the guest reads and writes (postcard, in the guest's argument
//! order). The prover and both verifiers build those bytes from the JSON with this one file,
//! so changing a number in the JSON changes what the proof is checked against.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    pub predicate: String,
    pub bps: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cohort {
    pub predicate: String,
    pub k_min: u32,
    pub bps: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Offer {
    pub merchant: String,
    /// Token base units (6 decimals), a decimal string.
    pub base_price: String,
    pub rules: Vec<Rule>,
    pub cap_bps: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cohort: Option<Cohort>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Public {
    #[serde(default)]
    pub note: String,
    /// Token base units, a decimal string.
    pub budget: String,
    pub revealed: Vec<String>,
    pub cohort_k: u32,
    pub offers: Vec<Offer>,
    /// The claim: this merchant, at this price.
    pub choice: String,
    pub price: String,
}

/// The guest's offer argument.
pub type GuestOffer = (String, u128, Vec<(String, u16)>, u16, Option<(String, u32, u16)>);

fn num(s: &str, what: &str) -> Result<u128, String> {
    s.parse().map_err(|_| format!("{what} is not a number"))
}

impl Public {
    pub fn from_json(bytes: &[u8]) -> Result<Self, String> {
        serde_json::from_slice(bytes).map_err(|e| format!("public.json: {e}"))
    }

    pub fn budget(&self) -> Result<u128, String> {
        num(&self.budget, "budget")
    }

    pub fn price(&self) -> Result<u128, String> {
        num(&self.price, "price")
    }

    pub fn guest_offers(&self) -> Result<Vec<GuestOffer>, String> {
        self.offers
            .iter()
            .map(|o| {
                Ok((
                    o.merchant.clone(),
                    num(&o.base_price, "base_price")?,
                    o.rules.iter().map(|r| (r.predicate.clone(), r.bps)).collect(),
                    o.cap_bps,
                    o.cohort.as_ref().map(|c| (c.predicate.clone(), c.k_min, c.bps)),
                ))
            })
            .collect()
    }

    /// The guest's input bytes: each argument in order, postcard.
    pub fn inputs(&self) -> Result<Vec<u8>, String> {
        let e = |e: postcard::Error| e.to_string();
        let mut b = Vec::new();
        b.extend(postcard::to_stdvec(&self.budget()?).map_err(e)?);
        b.extend(postcard::to_stdvec(&self.revealed).map_err(e)?);
        b.extend(postcard::to_stdvec(&self.cohort_k).map_err(e)?);
        b.extend(postcard::to_stdvec(&self.guest_offers()?).map_err(e)?);
        b.extend(postcard::to_stdvec(&self.choice).map_err(e)?);
        b.extend(postcard::to_stdvec(&self.price()?).map_err(e)?);
        Ok(b)
    }

    /// The guest's output bytes for this claim: (merchant, price), postcard.
    pub fn outputs(&self) -> Result<Vec<u8>, String> {
        postcard::to_stdvec(&(self.choice.clone(), self.price()?)).map_err(|e| e.to_string())
    }
}

/// Jolt's device pads the output with zero bytes and its verifier drops trailing zeros before
/// it compares, so two outputs are the same statement when they agree up to trailing zeros.
pub fn same_output(a: &[u8], b: &[u8]) -> bool {
    let trim = |x: &[u8]| x.iter().rposition(|byte| *byte != 0).map_or(0, |i| i + 1);
    a[..trim(a)] == b[..trim(b)]
}
