import SmithLean.CoalitionKofN
import SmithLean.SpendBucket
/-!
# The specs' own test vectors, run through the Lean models

The commitment is a parameter; here it is `CommitFn.table`, which returns a fixed root for the
vector's own private value, so the root check passes for that value and fails for any other.
-/
open Smith

namespace Smith.Coalition.Vectors

def jobC : List Seat := [
  { leg := 0, member := "m01.bookerbob.testnet", price := 48000000,
    delivered := some "63957149e4f0d670da818c778b9395a1dcfdfd2b0426ae0f37a422e0e55bcedd" },
  { leg := 1, member := "h05.bookerbob.testnet", price := 450000000, delivered := none },
  { leg := 2, member := "m02.bookerbob.testnet", price := 45000000,
    delivered := some "94102e551365daa87d9f114fa47296d40f1e246b2de8acd912baaedd520d902a" } ]

def root : Bytes32 := List.replicate 32 7
def C (seats : List Seat) : CommitFn (List Seat) := CommitFn.table [(seats, root)]
def pub (k : UInt32) (_seats : List Seat) : Public :=
  { coalition := "coalition.bookerbob-demo.testnet", job := 2, seats_root := root, k_min := k }

-- vector 1: k_min 2, expect delivered 2, seats 3
#eval check (C jobC) (pub 2 jobC) ⟨jobC⟩
-- vector 2: k_min 3, expect refuse
#eval check (C jobC) (pub 3 jobC) ⟨jobC⟩
-- smith-style adversarial: uppercase hex id
def upper : List Seat := [
  { leg := 0, member := "a", price := 1,
    delivered := some "63957149E4F0D670DA818C778B9395A1DCFDFD2B0426AE0F37A422E0E55BCEDD" } ]
#eval check (C upper) (pub 0 upper) ⟨upper⟩
-- adversarial: legs out of order
def badLeg : List Seat := [{ leg := 1, member := "a", price := 1, delivered := none }]
#eval check (C badLeg) (pub 0 badLeg) ⟨badLeg⟩
-- adversarial: duplicate member
def dup : List Seat := [
  { leg := 0, member := "a", price := 1, delivered := none },
  { leg := 1, member := "a", price := 1, delivered := none } ]
#eval check (C dup) (pub 0 dup) ⟨dup⟩
-- adversarial: 9 seats
def nine : List Seat := (List.range 9).map fun i =>
  { leg := i.toUInt32, member := toString i, price := 1, delivered := none }
#eval check (C nine) (pub 0 nine) ⟨nine⟩

end Smith.Coalition.Vectors

namespace Smith.SpendBucket.Vectors

def recs : List Record := [
  { day := 20310, amount_cents := 99900, merchant := "m03.bookerbob.testnet" },
  { day := 20320, amount_cents := 4800, merchant := "m01.bookerbob.testnet" },
  { day := 20350, amount_cents := 40800, merchant := "h05.bookerbob.testnet" },
  { day := 20391, amount_cents := 4500, merchant := "m02.bookerbob.testnet" },
  { day := 20400, amount_cents := 11140, merchant := "m07.bookerbob.testnet" } ]

def priv : Private := { salt := List.replicate 32 0, records := recs }

def root : Bytes32 := List.replicate 32 9
instance : DecidableEq Private := fun a b => by
  cases a; cases b; simp only [Private.mk.injEq]; exact inferInstance
def C (s : Private) : CommitFn Private := CommitFn.table [(s, root)]
def pub (_s : Private) : Public :=
  { records_root := root, as_of_day := 20406, window_days := 90,
    thresholds_cents := [10000, 50000, 100000] }

-- vector 1: 612.40 USD in 90 days (the day-20310 record is outside), expect bucket 2
#eval check (C priv) (pub priv) priv
-- vector 2: the same records against another root, expect refuse
#eval check (C priv) { pub priv with records_root := List.replicate 32 0 } priv
-- adversarial: thresholds not strictly increasing
#eval check (C priv) { pub priv with thresholds_cents := [10000, 10000] } priv
-- adversarial: window larger than as_of_day
#eval check (C priv) { pub priv with as_of_day := 10, window_days := 90 } priv
-- adversarial: a record after as_of_day
#eval let s : Private := { priv with records := recs ++ [{ day := 20407, amount_cents := 1, merchant := "x" }] }
  check (C s) (pub s) s
-- adversarial: u64 overflow across two records (each fits, the sum does not)
#eval let s : Private := { priv with records := [
    { day := 20400, amount_cents := 0xFFFFFFFFFFFFFFFF, merchant := "x" },
    { day := 20401, amount_cents := 1, merchant := "y" }] }
  check (C s) (pub s) s

end Smith.SpendBucket.Vectors
