//! The referee's checks: structured claims against the proof set, plus the text
//! tripwires. Returns the refusal reason, or Ok. (core wraps this into a receipt.)
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

/// Coarse predicates a verdict may reveal.
pub const KNOWN_PREDICATES: &[&str] = &["airbnb_frequent", "booking_genius", "claude_spender", "steam_veteran", "uber_regular", "world_id_human"];

/// (platform, field, minimum value, predicate). The whole rule table.
pub const RULES: &[(&str, &str, u64, &str)] = &[
    ("airbnb", "trips_12m", 3, "airbnb_frequent"),
    ("booking", "genius_level", 2, "booking_genius"),
    ("anthropic", "monthly_spend_usd", 20, "claude_spender"),
    ("steam", "account_age_years", 5, "steam_veteran"),
    ("uber", "trips_90d", 10, "uber_regular"),
    ("world_id", "verified", 1, "world_id_human"),
];

/// Status words no fact in this system can prove.
pub const UNPROVEN_STATUS: &[&str] = &[
    "platinum",
    "diamond",
    "titanium",
    "gold",
    "silver",
    "elite",
    "vip",
    "ambassador",
    "superhost",
    "premier",
    "executive",
    "centurion",
    "marriott",
    "hilton",
    "hyatt",
    "ihg",
    "accor",
    "bonvoy",
    "amex",
    "loyalty",
];

/// Words that name a platform, and the predicate whose facts come from it.
const PLATFORM_WORDS: &[(&str, &str)] = &[
    ("airbnb", "airbnb_frequent"),
    ("booking", "booking_genius"),
    ("genius", "booking_genius"),
    ("anthropic", "claude_spender"),
    ("claude", "claude_spender"),
    ("steam", "steam_veteran"),
    ("uber", "uber_regular"),
    ("world", "world_id_human"),
];

pub fn is_known_predicate(p: &str) -> bool {
    KNOWN_PREDICATES.contains(&p)
}

pub fn predicate_for(platform: &str, field: &str, value: u64) -> Option<&'static str> {
    RULES.iter().find(|(p, f, min, _)| *p == platform && *f == field && value >= *min).map(|(_, _, _, pred)| *pred)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fact {
    pub id: String,
    pub platform: String,
    pub field: String,
    pub value: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Citation {
    pub fact: String,
    pub field: String,
    pub value: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    pub line: String,
    pub text: String,
    pub citations: Vec<Citation>,
}

fn words(text: &str) -> Vec<String> {
    text.to_lowercase().split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).map(String::from).collect()
}

/// Numbers that are part of a field name for this line, like the 12 in `trips_12m`.
fn window_numbers(line: &str) -> Vec<u64> {
    RULES.iter().filter(|r| r.3 == line).flat_map(|r| r.1.split(|c: char| !c.is_ascii_digit()).filter_map(|d| d.parse().ok()).collect::<Vec<u64>>()).collect()
}

fn check_text(c: &Claim) -> Option<String> {
    // Homoglyphs and zero-width characters would slip past the word checks.
    if !c.text.chars().all(|ch| ch == ' ' || ch.is_ascii_graphic()) {
        return Some("claim text must be plain ascii".into());
    }
    if c.text.len() > 280 {
        return Some("claim text over 280 characters".into());
    }
    let w = words(&c.text);
    if let Some(bad) = w.iter().find(|x| UNPROVEN_STATUS.contains(&x.as_str())) {
        return Some(format!("claim text names unproven status: {bad}"));
    }
    if let Some((word, _)) = PLATFORM_WORDS.iter().find(|(word, pred)| *pred != c.line && w.iter().any(|x| x == word)) {
        return Some(format!("claim text names {word}, which the {} claim does not prove", c.line));
    }
    let allowed: Vec<u64> = c.citations.iter().map(|x| x.value).chain(window_numbers(&c.line)).collect();
    if let Some(n) = w.iter().filter_map(|x| x.parse::<u64>().ok()).find(|n| !allowed.contains(n)) {
        return Some(format!("claim text states {n}, not an asserted value"));
    }
    None
}

/// `lines`: the quote's discount line predicates; `cohort_line`: its group line, if open.
pub fn check(facts: &[Fact], revealed: &[String], lines: &[String], cohort_line: Option<&str>, claims: &[Claim]) -> Result<(), String> {
    // A citation must name exactly one fact.
    for (i, f) in facts.iter().enumerate() {
        if facts[..i].iter().any(|g| g.id == f.id) {
            return Err(format!("duplicate fact id {} in proof set", f.id));
        }
    }
    for c in claims {
        if !is_known_predicate(&c.line) {
            return Err(format!("{} is not a known predicate", c.line));
        }
        if !revealed.iter().any(|p| p == &c.line) {
            return Err(format!("{} not revealed", c.line));
        }
        if c.citations.is_empty() {
            return Err(format!("claim for {} cites no fact", c.line));
        }
        for cit in &c.citations {
            let Some(fact) = facts.iter().find(|f| f.id == cit.fact) else {
                return Err(format!("{} not in proof set", cit.fact));
            };
            if fact.field != cit.field || fact.value != cit.value {
                return Err(format!("{} asserted {}={}, proven {}={}", cit.fact, cit.field, cit.value, fact.field, fact.value));
            }
            if predicate_for(&fact.platform, &fact.field, fact.value) != Some(c.line.as_str()) {
                return Err(format!("{} does not prove {}", cit.fact, c.line));
            }
        }
        if let Some(reason) = check_text(c) {
            return Err(reason);
        }
    }
    for line in lines {
        if !claims.iter().any(|c| &c.line == line) {
            return Err(format!("discount line {line} has no cited claim"));
        }
    }
    if let Some(p) = cohort_line {
        if !claims.iter().any(|cl| cl.line == p) {
            return Err(format!("cohort line {p} has no cited claim"));
        }
    }
    Ok(())
}

pub const REFEREE_TAG: &[u8] = b"bookerbob/referee-input/v0\x00";

/// Canonical hash of everything a referee decision depends on, so a proven decision is
/// bound to its inputs.
pub fn input_hash(facts: &[Fact], revealed: &[String], lines: &[String], cohort_line: Option<&str>, claims: &[Claim]) -> [u8; 32] {
    let mut b = Vec::new();
    let put = |b: &mut Vec<u8>, s: &str| crate::put_str(b, s);
    b.extend_from_slice(&(facts.len() as u32).to_le_bytes());
    for f in facts {
        put(&mut b, &f.id);
        put(&mut b, &f.platform);
        put(&mut b, &f.field);
        b.extend_from_slice(&f.value.to_le_bytes());
    }
    for list in [revealed, lines] {
        b.extend_from_slice(&(list.len() as u32).to_le_bytes());
        for x in list {
            put(&mut b, x);
        }
    }
    match cohort_line {
        None => b.push(0),
        Some(p) => {
            b.push(1);
            put(&mut b, p);
        }
    }
    b.extend_from_slice(&(claims.len() as u32).to_le_bytes());
    for c in claims {
        put(&mut b, &c.line);
        put(&mut b, &c.text);
        b.extend_from_slice(&(c.citations.len() as u32).to_le_bytes());
        for x in &c.citations {
            put(&mut b, &x.fact);
            put(&mut b, &x.field);
            b.extend_from_slice(&x.value.to_le_bytes());
        }
    }
    crate::sha256(&[REFEREE_TAG, &b])
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn facts() -> Vec<Fact> {
        vec![Fact { id: "F1".into(), platform: "airbnb".into(), field: "trips_12m".into(), value: 7 }]
    }

    fn honest() -> Claim {
        Claim {
            line: "airbnb_frequent".into(),
            text: "7 airbnb trips".into(),
            citations: vec![Citation { fact: "F1".into(), field: "trips_12m".into(), value: 7 }],
        }
    }

    #[test]
    fn honest_claims_pass_and_the_marriott_attack_does_not() {
        let r = vec![String::from("airbnb_frequent")];
        assert_eq!(check(&facts(), &r, &r, None, &[honest()]), Ok(()));
        let mut cheat = honest();
        cheat.text = "guest is marriott platinum".into();
        assert_eq!(check(&facts(), &r, &r, None, &[cheat]), Err("claim text names unproven status: marriott".into()));
    }

    #[test]
    fn the_input_hash_binds_claims_and_facts() {
        let r = vec![String::from("airbnb_frequent")];
        let h = input_hash(&facts(), &r, &r, None, &[honest()]);
        let mut c = honest();
        c.citations[0].value = 8;
        assert_ne!(h, input_hash(&facts(), &r, &r, None, &[c]));
        assert_ne!(h, input_hash(&facts(), &r, &[], None, &[honest()]));
        assert_ne!(h, input_hash(&facts(), &r, &r, Some("airbnb_frequent"), &[honest()]));
    }
}
