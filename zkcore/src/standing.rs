//! The committed standing tree, written once (no_std): leaves `(context, merchant, rank, n,
//! sha256(score || salt))`, sha256 nodes, ranks by score high first, ties by account. The bazaar
//! builds the graph's tree from a Jolt-proven score list; `bookerbob-core::standing` makes the
//! openings. A root gives a compact rank check; it does not hide scores that public events
//! already determine.
use alloc::string::String;
use alloc::vec::Vec;

pub const LEAF_TAG: &[u8] = b"bookerbob/standing-leaf/v1\x00";
pub const NODE_TAG: &[u8] = b"bookerbob/standing-node/v1\x00";
pub const SCORE_TAG: &[u8] = b"bookerbob/standing-score/v1\x00";
pub const SALT_TAG: &[u8] = b"bookerbob/standing-salt/v1\x00";
/// The context of the tree built from the standing graph's proven scores.
pub const GRAPH_CONTEXT: &str = "graph";

pub fn score_commit(score: u64, salt: &[u8; 32]) -> [u8; 32] {
    crate::sha256(&[SCORE_TAG, &score.to_le_bytes(), salt])
}

pub fn leaf(context: &str, merchant: &str, rank: u32, n: u32, score_commit: &[u8; 32]) -> [u8; 32] {
    crate::sha256(&[LEAF_TAG, context.as_bytes(), &[0], merchant.as_bytes(), &[0], &rank.to_le_bytes(), &n.to_le_bytes(), score_commit])
}

pub fn node(l: &[u8; 32], r: &[u8; 32]) -> [u8; 32] {
    crate::sha256(&[NODE_TAG, l, r])
}

/// The graph tree's salt: public (from the graph root), because the scores are public anyway.
pub fn graph_salt(graph_root: &[u8; 32], merchant: &str) -> [u8; 32] {
    crate::sha256(&[SALT_TAG, graph_root, merchant.as_bytes()])
}

/// One leaf's opening: merchant, rank, n, score commitment, path (sibling, sibling-is-left).
pub type Opening = (String, u32, u32, [u8; 32], Vec<([u8; 32], bool)>);

/// The root and every opening, ranking `entries` (merchant, score, salt).
pub fn tree(context: &str, entries: &[(String, u64, [u8; 32])]) -> ([u8; 32], Vec<Opening>) {
    let mut e: Vec<&(String, u64, [u8; 32])> = entries.iter().collect();
    e.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let n = e.len() as u32;
    if e.is_empty() {
        return (crate::sha256(&[NODE_TAG]), Vec::new());
    }
    let commits: Vec<[u8; 32]> = e.iter().map(|(_, s, salt)| score_commit(*s, salt)).collect();
    let mut level: Vec<[u8; 32]> = e.iter().zip(&commits).enumerate().map(|(i, ((m, _, _), c))| leaf(context, m, i as u32 + 1, n, c)).collect();
    let mut paths: Vec<Vec<([u8; 32], bool)>> = alloc::vec![Vec::new(); e.len()];
    let mut idx: Vec<usize> = (0..e.len()).collect();
    while level.len() > 1 {
        if level.len() % 2 == 1 {
            level.push(*level.last().expect("nonempty"));
        }
        for (k, pos) in idx.iter_mut().enumerate() {
            let sib = *pos ^ 1;
            paths[k].push((level[sib], sib < *pos));
            *pos /= 2;
        }
        level = level.chunks(2).map(|p| node(&p[0], &p[1])).collect();
    }
    let openings = e.iter().zip(&commits).zip(paths).enumerate().map(|(i, (((m, _, _), c), path))| (m.clone(), i as u32 + 1, n, *c, path)).collect();
    (level[0], openings)
}

/// The tree of a standing graph's merchant scores: (merchant, ratings, score x 100) as the
/// graph computes them, salted from the graph root.
pub fn graph_tree(graph_root: &[u8; 32], merchants: &[(String, u64, u64)]) -> ([u8; 32], Vec<Opening>) {
    let entries: Vec<(String, u64, [u8; 32])> = merchants.iter().map(|(m, _, s)| (m.clone(), *s, graph_salt(graph_root, m))).collect();
    tree(GRAPH_CONTEXT, &entries)
}

/// The path leads from this leaf to `root`.
pub fn opens(root: &[u8; 32], context: &str, merchant: &str, rank: u32, n: u32, commit: &[u8; 32], path: &[([u8; 32], bool)]) -> bool {
    if rank == 0 || rank > n {
        return false;
    }
    let mut cur = leaf(context, merchant, rank, n, commit);
    for (sib, left) in path {
        cur = if *left { node(sib, &cur) } else { node(&cur, sib) };
    }
    &cur == root
}
