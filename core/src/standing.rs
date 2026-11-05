//! A committed standing list: the chain holds one root per context, not the scores. Each leaf
//! is `(context, merchant, rank, n, sha256(score || salt))`; a merchant (or anyone it gives its
//! leaf and path to) proves "rank r of n in context C" against the root, so "is X in the top N%"
//! is answerable while the scores and the rest of the list stay off chain. The salted score
//! commitment means the leaf does not reveal the score.

pub const LEAF_TAG: &[u8] = b"bookerbob/standing-leaf/v1\x00";
pub const NODE_TAG: &[u8] = b"bookerbob/standing-node/v1\x00";
pub const SCORE_TAG: &[u8] = b"bookerbob/standing-score/v1\x00";

fn h(parts: &[&[u8]]) -> [u8; 32] {
    let mut b = Vec::new();
    for p in parts {
        b.extend_from_slice(p);
    }
    crate::sha256(&b)
}

pub fn score_commit(score: u64, salt: &[u8; 32]) -> [u8; 32] {
    h(&[SCORE_TAG, &score.to_le_bytes(), salt])
}

pub fn leaf(context: &str, merchant: &str, rank: u32, n: u32, score_commit: &[u8; 32]) -> [u8; 32] {
    h(&[LEAF_TAG, context.as_bytes(), &[0], merchant.as_bytes(), &[0], &rank.to_le_bytes(), &n.to_le_bytes(), score_commit])
}

fn node(l: &[u8; 32], r: &[u8; 32]) -> [u8; 32] {
    h(&[NODE_TAG, l, r])
}

/// One merchant's opening: its rank, the list size, its score commitment and the Merkle path
/// (sibling, sibling-is-on-the-left), leaf to root.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TopProof {
    pub merchant: String,
    pub rank: u32,
    pub n: u32,
    pub score_commit: String,
    pub path: Vec<(String, bool)>,
}

/// Rank by score (high first, ties by account), build the tree; the root and every proof.
pub fn build(context: &str, entries: &[(String, u64, [u8; 32])]) -> ([u8; 32], Vec<TopProof>) {
    let mut e: Vec<&(String, u64, [u8; 32])> = entries.iter().collect();
    e.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let n = e.len() as u32;
    let commits: Vec<[u8; 32]> = e.iter().map(|(_, s, salt)| score_commit(*s, salt)).collect();
    let mut level: Vec<[u8; 32]> = e.iter().zip(&commits).enumerate().map(|(i, ((m, _, _), c))| leaf(context, m, i as u32 + 1, n, c)).collect();
    let mut paths: Vec<Vec<(String, bool)>> = vec![Vec::new(); e.len()];
    let mut idx: Vec<usize> = (0..e.len()).collect();
    if level.is_empty() {
        return (h(&[NODE_TAG]), Vec::new());
    }
    while level.len() > 1 {
        if level.len() % 2 == 1 {
            level.push(*level.last().expect("nonempty"));
        }
        for (k, pos) in idx.iter_mut().enumerate() {
            let sib = *pos ^ 1;
            paths[k].push((hex::encode(level[sib]), sib < *pos));
            *pos /= 2;
        }
        level = level.chunks(2).map(|p| node(&p[0], &p[1])).collect();
    }
    let proofs = e
        .iter()
        .zip(&commits)
        .zip(paths)
        .enumerate()
        .map(|(i, (((m, _, _), c), path))| TopProof { merchant: m.clone(), rank: i as u32 + 1, n, score_commit: hex::encode(c), path })
        .collect();
    (level[0], proofs)
}

/// The path leads from this leaf to `root`.
pub fn opens(root: &[u8; 32], context: &str, p: &TopProof) -> bool {
    let Some(c) = hex::decode(&p.score_commit).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()) else { return false };
    if p.rank == 0 || p.rank > p.n {
        return false;
    }
    let mut cur = leaf(context, &p.merchant, p.rank, p.n, &c);
    for (sib, left) in &p.path {
        let Some(s) = hex::decode(sib).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()) else { return false };
        cur = if *left { node(&s, &cur) } else { node(&cur, &s) };
    }
    &cur == root
}

/// "In the top `pct`%": rank r of n with r <= ceil(pct * n / 100), and the path opens to the root.
pub fn in_top(root: &[u8; 32], context: &str, p: &TopProof, pct: u8) -> bool {
    pct <= 100 && (p.rank as u64) * 100 <= (pct as u64) * (p.n as u64) + 99 && opens(root, context, p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list() -> Vec<(String, u64, [u8; 32])> {
        (0..7u64).map(|i| (format!("m{i}.testnet"), 100 - i * 10, [i as u8 + 1; 32])).collect()
    }

    #[test]
    fn every_merchant_opens_its_rank_and_the_top_query_follows_the_rank() {
        let (root, proofs) = build("ctx", &list());
        assert_eq!(proofs.len(), 7);
        for p in &proofs {
            assert!(opens(&root, "ctx", p), "{} opens", p.merchant);
        }
        let first = proofs.iter().find(|p| p.merchant == "m0.testnet").unwrap();
        assert_eq!(first.rank, 1);
        assert!(in_top(&root, "ctx", first, 20));
        let last = proofs.iter().find(|p| p.merchant == "m6.testnet").unwrap();
        assert_eq!(last.rank, 7);
        assert!(!in_top(&root, "ctx", last, 50) && in_top(&root, "ctx", last, 100));
    }

    #[test]
    fn a_claimed_better_rank_another_context_or_a_forged_path_does_not_open() {
        let (root, proofs) = build("ctx", &list());
        let mut p = proofs.iter().find(|p| p.merchant == "m6.testnet").unwrap().clone();
        assert!(!opens(&root, "other", &p));
        p.rank = 1;
        assert!(!opens(&root, "ctx", &p), "a rank the list did not give is refused");
        let mut q = proofs[0].clone();
        q.path[0].0 = "00".repeat(32);
        assert!(!opens(&root, "ctx", &q));
        q = proofs[0].clone();
        q.merchant = "m9.testnet".to_string();
        assert!(!opens(&root, "ctx", &q));
    }

    #[test]
    fn the_leaf_does_not_show_the_score() {
        let (_, proofs) = build("ctx", &list());
        let p = &proofs[0];
        // Without the salt, trying every score 0..10,000 finds no match for the commitment.
        assert!(!(0..10_000u64).any(|s| hex::encode(score_commit(s, &[0u8; 32])) == p.score_commit));
        assert_eq!(p.score_commit, hex::encode(score_commit(100, &[1u8; 32])), "it opens with its own salt");
    }
}
