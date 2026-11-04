#!/usr/bin/env python3
"""Manual mutation pass on the referee and the nullifier checks.

cargo-mutants is not installed on the build machine, so each mutant is a hand-picked
flip of one condition: apply it, run the tests that should catch it, restore the file.
A mutant is "killed" when at least one test fails. Results go to docs/audit.md by hand.

    python3 scripts/mutate.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
REF = "core/src/referee.rs"
LIB = "contract/src/lib.rs"

# (id, what it breaks, file, exact old text, new text, cargo package to test)
MUTANTS = [
    ("M1", "referee: claims on unrevealed lines accepted", REF,
     "if !revealed.iter().any(|p| p == &c.line) {", "if revealed.iter().any(|p| p == &c.line) {", "bookerbob-core"),
    ("M2", "referee: a claim with no citation accepted", REF,
     "if c.citations.is_empty() {", "if false {", "bookerbob-core"),
    ("M3", "referee: asserted value not compared", REF,
     "if fact.field != cit.field || fact.value != cit.value {", "if fact.field != cit.field {", "bookerbob-core"),
    ("M4", "referee: a fact that proves another line accepted", REF,
     "if predicate_for(fact) != Some(c.line.as_str()) {", "if predicate_for(fact).is_none() {", "bookerbob-core"),
    ("M5", "referee: text tripwires off", REF,
     "if let Some(reason) = check_text(c) {", "if let Some(reason) = None::<String> {", "bookerbob-core"),
    ("M6", "referee: a discount line without a claim accepted", REF,
     "if !claims.iter().any(|c| c.line == line.predicate) {", "if false {", "bookerbob-core"),
    ("M7", "referee: duplicate fact ids accepted", REF,
     "if proofs.facts[..i].iter().any(|g| g.id == f.id) {", "if false {", "bookerbob-core"),
    ("M8", "nullifier: a pending or spent nullifier accepted again", LIB,
     'env::panic_str(if existing.spent { "nullifier spent" } else { "nullifier pending" });', "let _ = existing;", "bookerbob-bazaar"),
    ("M9", "nullifier: settle on a spent nullifier", LIB,
     'require!(!record.spent, "nullifier spent");\n        require!(record.agent == agent, "agent mismatch");',
     'require!(record.agent == agent, "agent mismatch");', "bookerbob-bazaar"),
    ("M10", "review nullifier: a second rating in the round accepted", LIB,
     'require!(!self.review_nullifiers.contains_key(&key), "already rated this round");', "", "bookerbob-bazaar"),
]


def run(pkg):
    r = subprocess.run(["cargo", "test", "-q", "-j6", "-p", pkg], cwd=ROOT, capture_output=True, text=True)
    out = r.stdout + r.stderr
    failed = [l.split()[1] for l in out.splitlines() if l.startswith("---- ") and l.rstrip().endswith("stdout ----")]
    return r.returncode, failed


def main():
    rows = []
    for mid, what, rel, old, new, pkg in MUTANTS:
        path = ROOT / rel
        src = path.read_text()
        if src.count(old) != 1:
            rows.append((mid, what, "SKIPPED: pattern not found once"))
            continue
        path.write_text(src.replace(old, new, 1))
        try:
            code, failed = run(pkg)
        finally:
            path.write_text(src)
        verdict = f"killed by {len(failed)} test(s), e.g. {failed[0]}" if code != 0 and failed else ("killed (a test run failed)" if code != 0 else "SURVIVED")
        rows.append((mid, what, verdict))
        print(f"{mid}  {what}: {verdict}", flush=True)
    # proptest saves failing inputs from mutants; they are not regressions of the real code.
    subprocess.run(["git", "checkout", "--", "core/tests/props.proptest-regressions"], cwd=ROOT, capture_output=True)
    killed = sum(1 for r in rows if r[2].startswith("killed"))
    print(f"\n{killed}/{len(rows)} mutants killed")
    return 0 if killed == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
