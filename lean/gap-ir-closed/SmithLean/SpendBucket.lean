import SmithLean.Commit
/-!
# spend-bucket: the spec in Lean, a Lean model of body.rs, and their agreement

Source of the spec: `zk/smith/specs/spend-bucket.json`, the seven `rules`.
Source of the model: `zk/smith/programs/spend-bucket/body/src/body.rs`.

The interesting rule is 5: the Rust loop adds with `checked_add` record by record, so it refuses
as soon as a partial sum overflows u64. The spec says "overflow refuses" about the total. The two
agree because the amounts are nonnegative: a partial sum overflows iff the total does. That is
the kind of fact a test vector cannot establish and this file proves (`sumLoop_ok_iff`).
-/

namespace Smith.SpendBucket

structure Record where
  day : UInt32
  amount_cents : UInt64
  merchant : String
  deriving Repr, DecidableEq

structure Public where
  records_root : Bytes32
  as_of_day : UInt32
  window_days : UInt32
  thresholds_cents : List UInt64
  deriving Repr

/-- The whole private input is what the root commits to (salt and records). -/
structure Private where
  salt : Bytes32
  records : List Record
  deriving Repr, DecidableEq

structure Output where
  bucket : UInt32
  deriving Repr, DecidableEq

-- The commitment over the whole `Private` struct, a parameter of everything below.
variable (C : CommitFn Private)

def tag : String := "bookerbob/smith/spend-records/v0"

/-- Rule 5's window: `as_of_day - window_days < day <= as_of_day`. -/
def inWindow (lower asOf : Nat) (r : Record) : Bool :=
  lower < r.day.toNat && r.day.toNat ≤ asOf

/-- The total spend in the window, as an unbounded natural number. -/
def windowTotal (lower asOf : Nat) (records : List Record) : Nat :=
  ((records.filter (inWindow lower asOf)).map (·.amount_cents.toNat)).sum

/-- Rule 6: how many thresholds are at most the total. -/
def bucketOf (thresholds : List UInt64) (total : Nat) : Nat :=
  (thresholds.filter (·.toNat ≤ total)).length

/-- The spec: rules 1 to 7 of spend-bucket.json. -/
structure Spec (C : CommitFn Private) (p : Public) (s : Private) (o : Output) : Prop where
  /-- Rule 1: the root commits to the whole private input. -/
  root : p.records_root = C.commit tag s
  /-- Rule 2: 1 to 8 thresholds, strictly increasing. -/
  thresholds_count : 1 ≤ p.thresholds_cents.length ∧ p.thresholds_cents.length ≤ 8
  thresholds_increasing : p.thresholds_cents.Pairwise (· < ·)
  /-- Rule 3: the window is 1 to 3650 days and at most as_of_day. -/
  window : 1 ≤ p.window_days.toNat ∧ p.window_days.toNat ≤ 3650 ∧
    p.window_days.toNat ≤ p.as_of_day.toNat
  /-- Rule 4: at most 256 records, none after as_of_day. -/
  records_count : s.records.length ≤ 256
  records_days : ∀ r ∈ s.records, r.day.toNat ≤ p.as_of_day.toNat
  /-- Rule 5: the total fits u64 (overflow refuses). -/
  total_fits : windowTotal (p.as_of_day.toNat - p.window_days.toNat) p.as_of_day.toNat s.records
    < 2 ^ 64
  /-- Rules 6 and 7: the bucket, and nothing else. -/
  bucket : o.bucket.toNat = bucketOf p.thresholds_cents
    (windowTotal (p.as_of_day.toNat - p.window_days.toNat) p.as_of_day.toNat s.records)

/-! ## The model of body.rs -/

/-- Rule 2 loop: `for w in thresholds.windows(2) { if w[0] >= w[1] ... }` -/
def strictInc : List UInt64 → Bool
  | a :: b :: rest => a < b && strictInc (b :: rest)
  | _ => true

/-- `u32::checked_sub`. -/
def u32CheckedSub (a b : Nat) : Option Nat :=
  if b ≤ a then some (a - b) else none

/-- Rule 5 loop with `checked_add`; `acc` is the Nat value of the u64 accumulator. -/
def sumLoop : List Record → Nat → Nat → Nat → Except String Nat
  | [], _, _, acc => .ok acc
  | r :: rest, lower, asOf, acc =>
    if inWindow lower asOf r then
      match u64CheckedAdd acc r.amount_cents.toNat with
      | none => .error "total overflow"
      | some acc' => sumLoop rest lower asOf acc'
    else sumLoop rest lower asOf acc

/-- Rule 6 loop: `bucket = bucket + 1` is unchecked in Rust; with at most 8 thresholds a Nat
counter is faithful (the u32 cannot wrap). -/
def bucketLoop : List UInt64 → Nat → Nat → Nat
  | [], _, b => b
  | t :: rest, total, b => bucketLoop rest total (if t.toNat ≤ total then b + 1 else b)

/-- `check(p, s)` from body.rs, in order. u32 comparisons are written on `toNat`. -/
def check (p : Public) (s : Private) : Except String Output :=
  if C.commit tag s != p.records_root then .error "records root mismatch"
  else if p.thresholds_cents.length == 0 || p.thresholds_cents.length > 8 then
    .error "thresholds count out of range"
  else if !strictInc p.thresholds_cents then .error "thresholds not strictly increasing"
  else if p.window_days.toNat < 1 || p.window_days.toNat > 3650 ||
      p.window_days.toNat > p.as_of_day.toNat then .error "window_days out of range"
  else if s.records.length > 256 then .error "too many records"
  else if !(s.records.all fun r => !(r.day.toNat > p.as_of_day.toNat)) then
    .error "record day after as_of_day"
  else match u32CheckedSub p.as_of_day.toNat p.window_days.toNat with
    | none => .error "window underflow"
    | some lower =>
      match sumLoop s.records lower p.as_of_day.toNat 0 with
      | .error e => .error e
      | .ok total => .ok { bucket := (bucketLoop p.thresholds_cents total 0).toUInt32 }

/-! ## Lemmas: each loop computes its rule -/

theorem strictInc_iff : ∀ l : List UInt64, strictInc l = true ↔ l.Pairwise (· < ·)
  | [] => by simp [strictInc]
  | [_] => by simp [strictInc]
  | a :: b :: rest => by
    rw [strictInc, Bool.and_eq_true, strictInc_iff (b :: rest), List.pairwise_cons (a := a),
      decide_eq_true_eq]
    constructor
    · rintro ⟨hab, hp⟩
      refine ⟨?_, hp⟩
      intro x hx
      rcases List.mem_cons.mp hx with rfl | hx
      · exact hab
      · have hbx := (List.pairwise_cons.mp hp).1 x hx
        rw [UInt64.lt_iff_toNat_lt] at hab hbx ⊢
        omega
    · rintro ⟨h, hp⟩
      exact ⟨h b List.mem_cons_self, hp⟩

theorem sumLoop_ok_iff (l : List Record) (lower asOf acc t : Nat) (hacc : acc < 2 ^ 64) :
    sumLoop l lower asOf acc = .ok t ↔
      acc + windowTotal lower asOf l < 2 ^ 64 ∧ t = acc + windowTotal lower asOf l := by
  induction l generalizing acc with
  | nil => simp [sumLoop, windowTotal]; omega
  | cons r rest ih =>
    by_cases hw : inWindow lower asOf r = true
    · simp only [sumLoop, hw, ↓reduceIte, windowTotal, List.filter_cons, List.map_cons,
        List.sum_cons]
      cases hadd : u64CheckedAdd acc r.amount_cents.toNat with
      | none =>
        simp only [u64CheckedAdd] at hadd
        split at hadd
        · simp at hadd
        · constructor
          · intro h; simp at h
          · rintro ⟨h, -⟩; omega
      | some acc' =>
        rw [u64CheckedAdd_eq_some] at hadd
        obtain ⟨hlt, rfl⟩ := hadd
        rw [ih _ hlt]
        simp only [windowTotal]
        omega
    · have hw' : inWindow lower asOf r = false := by simpa using hw
      simp only [sumLoop, hw', Bool.false_eq_true, ↓reduceIte, windowTotal, List.filter_cons]
      rw [ih _ hacc]
      simp only [windowTotal]

theorem bucketLoop_eq (l : List UInt64) (total b : Nat) :
    bucketLoop l total b = b + bucketOf l total := by
  induction l generalizing b with
  | nil => simp [bucketLoop, bucketOf]
  | cons t rest ih =>
    simp only [bucketLoop, bucketOf, List.filter_cons]
    by_cases ht : t.toNat ≤ total
    · simp [ht, ih, bucketOf]; omega
    · simp [ht, ih, bucketOf]

theorem toNat_toUInt32_of_lt {n : Nat} (h : n < 2 ^ 32) : n.toUInt32.toNat = n := by
  simp [Nat.toUInt32, Nat.mod_eq_of_lt h]

theorem bucketOf_le (l : List UInt64) (total : Nat) : bucketOf l total ≤ l.length :=
  List.length_filter_le _ _

/-! ## The theorem: the model agrees with the spec -/

theorem check_ok_iff_spec (p : Public) (s : Private) (o : Output) :
    check C p s = .ok o ↔ Spec C p s o := by
  have hb := bucketOf_le p.thresholds_cents
    (windowTotal (p.as_of_day.toNat - p.window_days.toNat) p.as_of_day.toNat s.records)
  unfold check
  simp only [bne_iff_ne, ne_eq, ite_not, Bool.or_eq_true, decide_eq_true_eq, beq_iff_eq,
    Bool.not_eq_true']
  constructor
  · intro h
    split at h
    · rename_i hroot
      split at h
      · simp at h
      · rename_i hcount
        split at h
        · simp at h
        · rename_i hinc
          split at h
          · simp at h
          · rename_i hwin
            split at h
            · simp at h
            · rename_i hrec
              split at h
              · simp at h
              · rename_i hdays
                split at h
                · simp at h
                · rename_i lower hsub
                  split at h
                  · simp at h
                  · rename_i total hsum
                    cases h
                    have hlower : lower = p.as_of_day.toNat - p.window_days.toNat := by
                      simp only [u32CheckedSub] at hsub
                      split at hsub
                      · cases hsub; rfl
                      · simp at hsub
                    subst hlower
                    obtain ⟨hfits, rfl⟩ :=
                      (sumLoop_ok_iff s.records _ _ 0 total (by omega)).mp hsum
                    simp only [Nat.zero_add] at hfits
                    refine ⟨hroot.symm, by omega, (strictInc_iff _).mp (by simpa using hinc),
                      by omega, by omega, ?_, hfits, ?_⟩
                    · simpa using hdays
                    · simp only [bucketLoop_eq, Nat.zero_add]
                      exact toNat_toUInt32_of_lt (by omega)
    · simp at h
  · rintro ⟨hroot, hcount, hinc, hwin, hrec, hdays, hfits, hbucket⟩
    have hinc' : strictInc p.thresholds_cents = true := (strictInc_iff _).mpr hinc
    have hdays' : (s.records.all fun r => !(r.day.toNat > p.as_of_day.toNat)) = true := by
      rw [List.all_eq_true]
      intro r hr
      have := hdays r hr
      simp; omega
    have hsub : u32CheckedSub p.as_of_day.toNat p.window_days.toNat =
        some (p.as_of_day.toNat - p.window_days.toNat) := by
      simp [u32CheckedSub]; omega
    have hsum : sumLoop s.records (p.as_of_day.toNat - p.window_days.toNat) p.as_of_day.toNat 0
        = .ok (windowTotal (p.as_of_day.toNat - p.window_days.toNat) p.as_of_day.toNat
            s.records) :=
      (sumLoop_ok_iff _ _ _ 0 _ (by omega)).mpr ⟨by omega, by omega⟩
    have hcount' : ¬ (p.thresholds_cents.length = 0 ∨ p.thresholds_cents.length > 8) := by omega
    have hwin' : ¬ ((p.window_days.toNat < 1 ∨ p.window_days.toNat > 3650) ∨
        p.window_days.toNat > p.as_of_day.toNat) := by omega
    have hrec' : ¬ s.records.length > 256 := by omega
    simp only [hroot.symm, hcount', hinc', hwin', hrec', hdays', hsub, hsum, ↓reduceIte,
      Bool.true_eq_false, Except.ok.injEq]
    cases o
    simp only [Output.mk.injEq, bucketLoop_eq, Nat.zero_add]
    apply UInt32.toNat.inj
    rw [hbucket, toNat_toUInt32_of_lt (by omega)]

/-- A refusal happens exactly when no output meets the spec. -/
theorem check_error_iff_no_spec (p : Public) (s : Private) :
    (∃ e, check C p s = .error e) ↔ ¬ ∃ o, Spec C p s o := by
  constructor
  · rintro ⟨e, he⟩ ⟨o, ho⟩
    have := (check_ok_iff_spec C p s o).mpr ho
    rw [he] at this; cases this
  · intro h
    cases hc : check C p s with
    | error e => exact ⟨e, rfl⟩
    | ok o => exact absurd ⟨o, (check_ok_iff_spec C p s o).mp hc⟩ h

/-- The spec determines the output. -/
theorem spec_unique (p : Public) (s : Private) (o o' : Output)
    (h : Spec C p s o) (h' : Spec C p s o') : o = o' := by
  cases o; cases o'
  simp only [Output.mk.injEq]
  apply UInt32.toNat.inj; rw [h.bucket, h'.bucket]

/-- Rule 7 as a property: two holders with the same windowed total get the same bucket, whatever
their records, merchants and salts are. -/
theorem output_depends_only_on_total (p : Public) (s s' : Private) (o o' : Output)
    (h : Spec C p s o) (h' : Spec C p s' o')
    (ht : windowTotal (p.as_of_day.toNat - p.window_days.toNat) p.as_of_day.toNat s.records =
      windowTotal (p.as_of_day.toNat - p.window_days.toNat) p.as_of_day.toNat s'.records) :
    o = o' := by
  cases o; cases o'
  simp only [Output.mk.injEq]
  apply UInt32.toNat.inj; rw [h.bucket, h'.bucket, ht]

end Smith.SpendBucket
