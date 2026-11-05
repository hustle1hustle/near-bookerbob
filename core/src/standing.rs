//! Openings of the committed standing tree (`bookerbob_zkcore::standing`, one implementation)
//! in a JSON-friendly form. A merchant proves "rank r of n in context C" against the root, so
//! "is X in the top N%" is answered on chain without the list. The graph's tree is built by the
//! bazaar from a Jolt-proven score list; its salts come from the graph root because the scores
//! are recomputable from public events: the root is a compact rank check, not score privacy.
pub use bookerbob_zkcore::standing::{graph_salt, score_commit, GRAPH_CONTEXT};

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TopProof {
    pub merchant: String,
    pub rank: u32,
    pub n: u32,
    pub score_commit: String,
    pub path: Vec<(String, bool)>,
}

fn to_proofs(openings: Vec<bookerbob_zkcore::standing::Opening>) -> Vec<TopProof> {
    openings
        .into_iter()
        .map(|(merchant, rank, n, c, path)| TopProof {
            merchant,
            rank,
            n,
            score_commit: hex::encode(c),
            path: path.into_iter().map(|(s, l)| (hex::encode(s), l)).collect(),
        })
        .collect()
}

/// Rank by score (high first, ties by account), build the tree; the root and every proof.
pub fn build(context: &str, entries: &[(String, u64, [u8; 32])]) -> ([u8; 32], Vec<TopProof>) {
    let (root, o) = bookerbob_zkcore::standing::tree(context, entries);
    (root, to_proofs(o))
}

/// The graph's tree from its score list (merchant, ratings, score x 100).
pub fn graph(graph_root: &[u8; 32], merchants: &[(String, u64, u64)]) -> ([u8; 32], Vec<TopProof>) {
    let (root, o) = bookerbob_zkcore::standing::graph_tree(graph_root, merchants);
    (root, to_proofs(o))
}

pub fn opens(root: &[u8; 32], context: &str, p: &TopProof) -> bool {
    let Some(c) = hex::decode(&p.score_commit).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()) else { return false };
    let mut path = Vec::new();
    for (s, l) in &p.path {
        let Some(s) = hex::decode(s).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()) else { return false };
        path.push((s, *l));
    }
    bookerbob_zkcore::standing::opens(root, context, &p.merchant, p.rank, p.n, &c, &path)
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
        assert!(proofs.iter().all(|p| opens(&root, "ctx", p)));
        let first = proofs.iter().find(|p| p.merchant == "m0.testnet").unwrap();
        assert_eq!(first.rank, 1);
        assert!(in_top(&root, "ctx", first, 20));
        let last = proofs.iter().find(|p| p.merchant == "m6.testnet").unwrap();
        assert!(!in_top(&root, "ctx", last, 50) && in_top(&root, "ctx", last, 100));
    }

    #[test]
    fn a_claimed_better_rank_another_context_or_a_forged_path_does_not_open() {
        let (root, proofs) = build("ctx", &list());
        let mut p = proofs.iter().find(|p| p.merchant == "m6.testnet").unwrap().clone();
        assert!(!opens(&root, "other", &p));
        p.rank = 1;
        assert!(!opens(&root, "ctx", &p));
        let mut q = proofs[0].clone();
        q.path[0].0 = "00".repeat(32);
        assert!(!opens(&root, "ctx", &q));
    }

    #[test]
    fn the_graph_tree_is_salted_from_the_graph_root_and_ranks_by_score() {
        let ms = vec![("a.testnet".to_string(), 6, 300), ("b.testnet".to_string(), 12, 420), ("c.testnet".to_string(), 0, 0)];
        let (root, proofs) = graph(&[9u8; 32], &ms);
        let b = proofs.iter().find(|p| p.merchant == "b.testnet").unwrap();
        assert_eq!((b.rank, b.n), (1, 3));
        assert_eq!(b.score_commit, hex::encode(score_commit(420, &graph_salt(&[9u8; 32], "b.testnet"))));
        assert!(in_top(&root, GRAPH_CONTEXT, b, 34));
        assert_ne!(graph(&[8u8; 32], &ms).0, root, "another graph root, another tree");
    }
}
