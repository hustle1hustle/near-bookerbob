//! Grading for REP Eval, inside the worker: exact-answer grading, the floored score bucket the
//! contract checks, and a bootstrap 95% confidence interval. Deterministic (a fixed-seed
//! xorshift), so anyone re-running `bookerbob eval-grade` on the same answers gets the same CI.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GradeInput {
    /// The expected answer of each item, as a decimal string (answers can exceed u64).
    pub expected: Vec<String>,
    /// The model's reply text for each item, same order.
    pub replies: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Grade {
    pub correct: Vec<bool>,
    pub n: u32,
    pub n_correct: u32,
    /// floor(100 * correct / n) floored to 10: the contract's `score_bucket`.
    pub score_bucket: u8,
    /// Percent, bootstrap 95% interval over items (2,000 resamples).
    pub ci95: (f64, f64),
}

/// The last integer in a reply (commas ignored), as a string; None when there is none.
pub fn parse_answer(reply: &str) -> Option<String> {
    let t: String = reply.chars().filter(|c| *c != ',').collect();
    let mut last = None;
    let mut cur = String::new();
    for ch in t.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_digit() || (ch == '-' && cur.is_empty()) {
            cur.push(ch);
        } else {
            if cur.chars().any(|c| c.is_ascii_digit()) {
                last = Some(cur.trim_start_matches('+').to_string());
            }
            cur.clear();
        }
    }
    last.map(|s| {
        let neg = s.starts_with('-');
        let d = s.trim_start_matches('-').trim_start_matches('0');
        let d = if d.is_empty() { "0" } else { d };
        if neg && d != "0" {
            format!("-{d}")
        } else {
            d.to_string()
        }
    })
}

fn xorshift(s: &mut u64) -> u64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    *s
}

/// Percentile bootstrap over items: resample n items with replacement, 2,000 times.
pub fn bootstrap_ci95(correct: &[bool]) -> (f64, f64) {
    let n = correct.len();
    if n == 0 {
        return (0.0, 0.0);
    }
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut means: Vec<f64> = (0..2000)
        .map(|_| {
            let k = (0..n).filter(|_| correct[(xorshift(&mut seed) % n as u64) as usize]).count();
            100.0 * k as f64 / n as f64
        })
        .collect();
    means.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    (means[49], means[1949])
}

pub fn grade(input: &GradeInput) -> Result<Grade, String> {
    if input.expected.len() != input.replies.len() || input.expected.is_empty() {
        return Err("expected and replies must be the same nonzero length".into());
    }
    let correct: Vec<bool> = input.expected.iter().zip(&input.replies).map(|(e, r)| parse_answer(r).as_deref() == Some(e.trim())).collect();
    let n = correct.len() as u32;
    let k = correct.iter().filter(|c| **c).count() as u32;
    let pct = (k as u64 * 100 / n as u64) as u8;
    Ok(Grade { ci95: bootstrap_ci95(&correct), correct, n, n_correct: k, score_bucket: pct / 10 * 10 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_integer_is_the_answer_and_big_numbers_compare_as_text() {
        assert_eq!(parse_answer("so 4821 * 3967 = 19,124,907").as_deref(), Some("19124907"));
        assert_eq!(parse_answer("\n\n836123456789012").as_deref(), Some("836123456789012"));
        assert_eq!(parse_answer("no number here"), None);
        assert_eq!(parse_answer("-0042").as_deref(), Some("-42"));
    }

    #[test]
    fn the_bucket_is_floored_and_the_ci_brackets_the_score() {
        let g = grade(&GradeInput {
            expected: (0..10).map(|i| i.to_string()).collect(),
            replies: (0..10).map(|i| if i < 7 { i.to_string() } else { "x".into() }).collect(),
        })
        .unwrap();
        assert_eq!((g.n_correct, g.score_bucket), (7, 70));
        assert!(g.ci95.0 <= 70.0 && 70.0 <= g.ci95.1 && g.ci95.0 < g.ci95.1);
        assert_eq!(g.ci95, bootstrap_ci95(&g.correct), "deterministic");
    }

    #[test]
    fn mismatched_lengths_are_refused() {
        assert!(grade(&GradeInput { expected: vec!["1".into()], replies: vec![] }).is_err());
    }
}
