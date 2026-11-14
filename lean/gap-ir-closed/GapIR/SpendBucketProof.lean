import GapIR.IR
import GapIR.SpendBucket
import GapIR.CoalitionProof
import SmithLean.SpendBucket
/-!
# The spend-bucket IR program meets the existing `Smith.SpendBucket.Spec`
-/

namespace GapIR.SpendBucketProof
open GapIR GapIR.SpendBucket Smith
open GapIR.CoalitionProof (embStr embBytes embBytes_eqv restore_self restore_cons1 restore_cons2
  restore_len1 restore_len2 R.bind_ite)

theorem restore_eq_len (e e' : Env) (h : e'.length = e.length) : restore e e' = e' := by
  simp [restore, h]

def embRec (r : Smith.SpendBucket.Record) : V :=
  .struct [("day", .int .u32 r.day.toNat), ("amount_cents", .int .u64 r.amount_cents.toNat),
    ("merchant", embStr r.merchant)]
def embTh (t : UInt64) : V := .int .u64 t.toNat
def embP (p : Smith.SpendBucket.Public) : V :=
  .struct [("records_root", embBytes p.records_root), ("as_of_day", .int .u32 p.as_of_day.toNat),
    ("window_days", .int .u32 p.window_days.toNat), ("thresholds_cents", .list (p.thresholds_cents.map embTh))]
def embS (s : Smith.SpendBucket.Private) : V :=
  .struct [("salt", embBytes s.salt), ("records", .list (s.records.map embRec))]
def embO (o : Smith.SpendBucket.Output) : V := .struct [("bucket", .int .u32 o.bucket.toNat)]

def CommitAgrees (cm : CommitV) (C : CommitFn Smith.SpendBucket.Private) : Prop :=
  ∀ s, cm Smith.SpendBucket.tag (embS s) = embBytes (C.commit Smith.SpendBucket.tag s)

def toR : Except String Smith.SpendBucket.Output → R V
  | .ok o => .ok (embO o)
  | .error e => .err e

/-! ## Rule 2: strictly increasing, with the previous threshold carried in `prev` -/

/-- What the loop checks from index `k` with `pv` the previous threshold. -/
def incFrom : Nat → Nat → List UInt64 → Bool
  | _, _, [] => true
  | k, pv, t :: r => (k == 0 || decide (pv < t.toNat)) && incFrom (k + 1) t.toNat r

theorem incFrom_strictInc (l : List UInt64) : ∀ pv k, k ≠ 0 → (incFrom k pv l = true ↔
    (∀ t ∈ l.head?, pv < t.toNat) ∧ Smith.SpendBucket.strictInc l = true) := by
  induction l with
  | nil => simp [incFrom, Smith.SpendBucket.strictInc]
  | cons t r ih =>
    intro pv k hk
    have := ih t.toNat (k + 1) (by omega)
    cases r with
    | nil => simp [incFrom, Smith.SpendBucket.strictInc, hk]
    | cons u r' =>
      simp only [incFrom] at this ⊢
      simp only [Smith.SpendBucket.strictInc, Bool.and_eq_true, Bool.or_eq_true, beq_iff_eq, hk,
        false_or, decide_eq_true_eq, List.head?_cons, Option.mem_def, Option.some.injEq,
        forall_eq'] at this ⊢
      rw [this, UInt64.lt_iff_toNat_lt]

theorem incFrom_zero (l : List UInt64) (pv : Nat) :
    incFrom 0 pv l = Smith.SpendBucket.strictInc l := by
  cases l with
  | nil => simp [incFrom, Smith.SpendBucket.strictInc]
  | cons t r =>
    have := incFrom_strictInc r t.toNat 1 (by omega)
    apply Bool.eq_iff_iff.mpr
    simp only [incFrom, beq_self_eq_true, Bool.true_or, Bool.true_and, Nat.zero_add, this]
    cases r with
    | nil => simp [Smith.SpendBucket.strictInc]
    | cons u r' => simp [Smith.SpendBucket.strictInc, UInt64.lt_iff_toNat_lt]

theorem body2_eq (cm : CommitV) (t : UInt64) (k pv : Nat) (rest : Env) :
    execB cm (("t", embTh t) :: ("i", .int .usize k) :: ("prev", .int .u64 pv) :: rest) body2 =
    if (k == 0 || decide (pv < t.toNat)) then
      .ok (("t", embTh t) :: ("i", .int .usize k) :: ("prev", .int .u64 t.toNat) :: rest)
    else .err "thresholds not strictly increasing" := by
  by_cases hk : k = 0
  · subst hk; simp [body2, execB, exec, evalE, Env.get, Env.set, embTh, usz, W.bits, Cmp.eval, R.bind, R.map]
  · by_cases hp : pv < t.toNat
    · have : ¬ pv ≥ t.toNat := by omega
      have hk' : 0 < k := by omega
      simp [hk', body2, execB, exec, evalE, Env.get, Env.set, embTh, usz, W.bits, Cmp.eval, R.bind, R.map, hk, hp, this]
    · have : pv ≥ t.toNat := by omega
      have hk' : 0 < k := by omega
      simp [hk', body2, execB, exec, evalE, Env.get, Env.set, embTh, usz, W.bits, Cmp.eval, R.bind, R.map, hk, hp, this]

def lastOr : Nat → List UInt64 → Nat
  | pv, [] => pv
  | _, t :: r => lastOr t.toNat r

theorem loop2 (cm : CommitV) (rest : Env) (l : List UInt64) (k pv : Nat) :
    loopOver (fun e => execB cm e body2) "i" "t" (("prev", .int .u64 pv) :: rest) k (l.map embTh) =
    if incFrom k pv l then .ok (("prev", .int .u64 (lastOr pv l)) :: rest)
    else .err "thresholds not strictly increasing" := by
  induction l generalizing k pv with
  | nil => simp [loopOver, incFrom, lastOr]
  | cons t r ih =>
    simp only [List.map_cons, loopOver, body2_eq]
    by_cases h : (k == 0 || decide (pv < t.toNat)) = true
    · simp only [h, ↓reduceIte]
      rw [restore_len2 _ _ _ _ (by simp), ih]
      simp only [incFrom, h, Bool.true_and, lastOr]
    · simp only [incFrom, h, Bool.false_and]; simp

/-! ## Rule 4 -/

theorem body4_eq (cm : CommitV) (p : Smith.SpendBucket.Public) (x : Smith.SpendBucket.Record) (k : Nat)
    (env : Env) (hp : env.get "p" = some (embP p)) :
    execB cm (("r", embRec x) :: ("i", .int .usize k) :: env) body4 =
    if x.day.toNat > p.as_of_day.toNat then .err "record day after as_of_day"
    else .ok (("r", embRec x) :: ("i", .int .usize k) :: env) := by
  by_cases h : x.day.toNat > p.as_of_day.toNat <;>
  simp [body4, execB, exec, evalE, Env.get, V.field, embRec, embP, hp, Cmp.eval, R.bind, R.map, h]

theorem loop4 (cm : CommitV) (p : Smith.SpendBucket.Public) (env : Env) (hp : env.get "p" = some (embP p))
    (l : List Smith.SpendBucket.Record) (k : Nat) :
    loopOver (fun e => execB cm e body4) "i" "r" env k (l.map embRec) =
    if l.all (fun r => !(r.day.toNat > p.as_of_day.toNat)) then .ok env else .err "record day after as_of_day" := by
  induction l generalizing k with
  | nil => simp [loopOver]
  | cons x r ih =>
    simp only [List.map_cons, loopOver, body4_eq cm p x k env hp]
    by_cases h : x.day.toNat > p.as_of_day.toNat <;> simp [h, ih]

/-! ## Rule 5 -/

def okT (lo : Nat) (rest : Env) : Except String Nat → R Env
  | .ok t => .ok (("total", .int .u64 t) :: ("lower", .int .u32 lo) :: rest)
  | .error e => .err e

theorem body5_eq (cm : CommitV) (p : Smith.SpendBucket.Public) (x : Smith.SpendBucket.Record) (k acc lo : Nat)
    (rest : Env) (hp : rest.get "p" = some (embP p)) :
    execB cm (("r", embRec x) :: ("i", .int .usize k) :: ("total", .int .u64 acc) :: ("lower", .int .u32 lo) :: rest)
      body5 =
    if Smith.SpendBucket.inWindow lo p.as_of_day.toNat x then
      (if acc + x.amount_cents.toNat < 2 ^ 64 then
        .ok (("r", embRec x) :: ("i", .int .usize k) :: ("total", .int .u64 (acc + x.amount_cents.toNat)) ::
          ("lower", .int .u32 lo) :: rest)
      else .err "total overflow")
    else .ok (("r", embRec x) :: ("i", .int .usize k) :: ("total", .int .u64 acc) :: ("lower", .int .u32 lo) :: rest) := by
  by_cases h1 : lo < x.day.toNat <;> by_cases h2 : x.day.toNat ≤ p.as_of_day.toNat <;>
  by_cases h3 : acc + x.amount_cents.toNat < 2 ^ 64 <;>
  simp [body5, execB, exec, evalE, Env.get, Env.set, V.field, embRec, embP, hp, Cmp.eval, R.bind, R.map,
    checkedOp, W.bits, Smith.SpendBucket.inWindow, h1, h2, h3, restore_eq_len]

theorem loop5 (cm : CommitV) (p : Smith.SpendBucket.Public) (rest : Env) (hp : rest.get "p" = some (embP p))
    (lo : Nat) (l : List Smith.SpendBucket.Record) (k acc : Nat) :
    loopOver (fun e => execB cm e body5) "i" "r" (("total", .int .u64 acc) :: ("lower", .int .u32 lo) :: rest) k
      (l.map embRec) = okT lo rest (Smith.SpendBucket.sumLoop l lo p.as_of_day.toNat acc) := by
  induction l generalizing k acc with
  | nil => simp [loopOver, okT, Smith.SpendBucket.sumLoop]
  | cons x r ih =>
    simp only [List.map_cons, loopOver, body5_eq cm p x k acc lo rest hp]
    by_cases hw : Smith.SpendBucket.inWindow lo p.as_of_day.toNat x = true
    · by_cases h3 : acc + x.amount_cents.toNat < 2 ^ 64
      · simp only [hw, h3, ↓reduceIte]
        rw [restore_len2 _ _ _ _ (by simp), ih]
        simp [Smith.SpendBucket.sumLoop, hw, u64CheckedAdd, h3]
      · simp [hw, h3, okT, Smith.SpendBucket.sumLoop, u64CheckedAdd]
    · simp only [hw, Bool.false_eq_true, ↓reduceIte, restore_cons2, ih]
      simp [Smith.SpendBucket.sumLoop, hw]

/-! ## Rule 6 -/

theorem body6_eq (cm : CommitV) (t : UInt64) (k b tot : Nat) (rest : Env) :
    execB cm (("t", embTh t) :: ("i", .int .usize k) :: ("bucket", .int .u32 b) :: ("total", .int .u64 tot) :: rest)
      body6 =
    if t.toNat ≤ tot then
      (if b + 1 < 2 ^ 32 then
        .ok (("t", embTh t) :: ("i", .int .usize k) :: ("bucket", .int .u32 (b + 1)) :: ("total", .int .u64 tot) :: rest)
      else .err "bucket overflow")
    else .ok (("t", embTh t) :: ("i", .int .usize k) :: ("bucket", .int .u32 b) :: ("total", .int .u64 tot) :: rest) := by
  by_cases h1 : t.toNat ≤ tot <;> by_cases h2 : b + 1 < 2 ^ 32 <;>
  simp [body6, execB, exec, evalE, Env.get, Env.set, embTh, Cmp.eval, R.bind, R.map, checkedOp, W.bits, u32, h1, h2, restore_eq_len]

theorem loop6 (cm : CommitV) (tot : Nat) (rest : Env) (l : List UInt64) (k b : Nat) (hb : b + l.length < 2 ^ 32) :
    loopOver (fun e => execB cm e body6) "i" "t" (("bucket", .int .u32 b) :: ("total", .int .u64 tot) :: rest) k
      (l.map embTh) =
    .ok (("bucket", .int .u32 (Smith.SpendBucket.bucketLoop l tot b)) :: ("total", .int .u64 tot) :: rest) := by
  induction l generalizing k b with
  | nil => simp [loopOver, Smith.SpendBucket.bucketLoop]
  | cons t r ih =>
    simp only [List.length_cons] at hb
    simp only [List.map_cons, loopOver, body6_eq]
    by_cases h1 : t.toNat ≤ tot
    · have h2 : b + 1 < 2 ^ 32 := by omega
      simp only [h1, h2, ↓reduceIte]
      rw [restore_len2 _ _ _ _ (by simp), ih _ _ (by omega)]
      simp [Smith.SpendBucket.bucketLoop, h1]
    · simp only [h1, ↓reduceIte, restore_cons2]
      rw [ih _ _ (by omega)]
      simp [Smith.SpendBucket.bucketLoop, h1]

/-! ## The whole program -/

section stages
variable (cm : CommitV) (C : CommitFn Smith.SpendBucket.Private) (hcm : CommitAgrees cm C)
  (p : Smith.SpendBucket.Public) (s : Smith.SpendBucket.Private)

def E0 : Env := [("s", embS s), ("p", embP p)]
def E1 : Env := ("root", embBytes (C.commit Smith.SpendBucket.tag s)) :: E0 p s
def E2 (pv : Nat) : Env := ("prev", .int .u64 pv) :: E1 C p s

theorem hpE2 (pv : Nat) : (E2 C p s pv).get "p" = some (embP p) := by simp [E2, E1, E0, Env.get]
theorem hsE2 (pv : Nat) : (E2 C p s pv).get "s" = some (embS s) := by simp [E2, E1, E0, Env.get]

include hcm in
theorem st1 : exec cm (E0 p s) (.let_ "root" (.commit "bookerbob/smith/spend-records/v0" (.var "s"))) =
    .ok (E1 C p s) := by
  have hc := hcm s
  simp only [Smith.SpendBucket.tag] at hc
  simp [exec, evalE, E0, E1, Env.get, hc, Smith.SpendBucket.tag]

theorem st2 : exec cm (E1 C p s) (.ite (.ne (.var "root") ((Ex.var "p").field "records_root"))
    [.refuse "records root mismatch"] []) =
    if C.commit Smith.SpendBucket.tag s != p.records_root then .err "records root mismatch" else .ok (E1 C p s) := by
  by_cases h : C.commit Smith.SpendBucket.tag s = p.records_root <;>
  simp [exec, evalE, E0, E1, Env.get, V.field, embP, embBytes_eqv, h, execB, R.map, R.bind]

theorem st3 : exec cm (E1 C p s) (.ite (.or (.eq (.len ((Ex.var "p").field "thresholds_cents")) (usz 0))
      (.cmp .gt (.len ((Ex.var "p").field "thresholds_cents")) (usz 8))) [.refuse "thresholds count out of range"] []) =
    if (p.thresholds_cents.length == 0 || p.thresholds_cents.length > 8) then .err "thresholds count out of range"
    else .ok (E1 C p s) := by
  by_cases hA : p.thresholds_cents.length = 0 <;> by_cases hB : p.thresholds_cents.length > 8 <;>
  simp [exec, evalE, E1, E0, Env.get, V.field, embP, usz, W.bits, V.eqv, Cmp.eval, execB, R.map, R.bind, hA, hB] <;>
  omega

theorem st5 : exec cm (E2 C p s 0) (.forEach "i" "t" ((Ex.var "p").field "thresholds_cents") body2) =
    if Smith.SpendBucket.strictInc p.thresholds_cents then .ok (E2 C p s (lastOr 0 p.thresholds_cents))
    else .err "thresholds not strictly increasing" := by
  have hf : (embP p).field "thresholds_cents" = some (.list (p.thresholds_cents.map embTh)) := by
    simp [embP, V.field]
  simp only [exec, evalE, hpE2, Option.bind_some, hf]
  rw [E2, loop2, incFrom_zero]; rfl

theorem st6 (pv : Nat) : exec cm (E2 C p s pv) (.ite (.or (.or (.cmp .lt ((Ex.var "p").field "window_days") (u32 1))
      (.cmp .gt ((Ex.var "p").field "window_days") (u32 3650)))
      (.cmp .gt ((Ex.var "p").field "window_days") ((Ex.var "p").field "as_of_day"))) [.refuse "window_days out of range"] []) =
    if (p.window_days.toNat < 1 || p.window_days.toNat > 3650 || p.window_days.toNat > p.as_of_day.toNat) then
      .err "window_days out of range" else .ok (E2 C p s pv) := by
  by_cases hA : p.window_days.toNat < 1 <;> by_cases hB : p.window_days.toNat > 3650 <;>
  by_cases hC : p.window_days.toNat > p.as_of_day.toNat <;>
  simp [exec, evalE, hpE2, V.field, embP, u32, W.bits, Cmp.eval, execB, R.map, R.bind, hA, hB, hC] <;> omega

theorem st7 (pv : Nat) : exec cm (E2 C p s pv) (.ite (.cmp .gt (.len ((Ex.var "s").field "records")) (usz 256))
    [.refuse "too many records"] []) =
    if s.records.length > 256 then .err "too many records" else .ok (E2 C p s pv) := by
  by_cases h : s.records.length > 256 <;>
  simp [exec, evalE, hsE2, V.field, embS, usz, W.bits, Cmp.eval, execB, R.map, R.bind, h]

theorem st8 (pv : Nat) : exec cm (E2 C p s pv) (.forEach "i" "r" ((Ex.var "s").field "records") body4) =
    if s.records.all (fun r => !(r.day.toNat > p.as_of_day.toNat)) then .ok (E2 C p s pv)
    else .err "record day after as_of_day" := by
  simp only [exec, evalE, hsE2, Option.bind_some, embS, V.field, List.find?,
    show ("records" == "salt") = false by decide, beq_self_eq_true, Option.map_some]
  exact loop4 cm p _ (hpE2 C p s pv) s.records 0

theorem st10 (pv : Nat) : exec cm (("lower", .int .u32 0) :: E2 C p s pv)
    (.checked .sub "lower" ((Ex.var "p").field "as_of_day") ((Ex.var "p").field "window_days") "window underflow") =
    match Smith.SpendBucket.u32CheckedSub p.as_of_day.toNat p.window_days.toNat with
    | none => .err "window underflow"
    | some lo => .ok (("lower", .int .u32 lo) :: E2 C p s pv) := by
  have := hpE2 C p s pv
  by_cases h : p.window_days.toNat ≤ p.as_of_day.toNat <;>
  simp [exec, evalE, Env.get, Env.set, this, V.field, embP, checkedOp, Smith.SpendBucket.u32CheckedSub, h]

theorem st9 (pv : Nat) : exec cm (E2 C p s pv) (.let_ "lower" (u32 0)) = .ok (("lower", .int .u32 0) :: E2 C p s pv) := by
  simp [exec, evalE, u32, W.bits]

theorem st11 (pv lo : Nat) : exec cm (("lower", .int .u32 lo) :: E2 C p s pv) (.let_ "total" (u64 0)) =
    .ok (("total", .int .u64 0) :: ("lower", .int .u32 lo) :: E2 C p s pv) := by
  simp [exec, evalE, u64, W.bits]

theorem st12 (pv lo : Nat) : exec cm (("total", .int .u64 0) :: ("lower", .int .u32 lo) :: E2 C p s pv)
    (.forEach "i" "r" ((Ex.var "s").field "records") body5) =
    okT lo (E2 C p s pv) (Smith.SpendBucket.sumLoop s.records lo p.as_of_day.toNat 0) := by
  have hf : (embS s).field "records" = some (.list (s.records.map embRec)) := by simp [embS, V.field]
  have hg : Env.get (("total", .int .u64 0) :: ("lower", .int .u32 lo) :: E2 C p s pv) "s" = some (embS s) := by
    simp [Env.get, hsE2]
  simp only [exec, evalE, hg, Option.bind_some, hf]
  exact loop5 cm p _ (hpE2 C p s pv) lo s.records 0 0

theorem st13 (pv lo tot : Nat) : exec cm (("total", .int .u64 tot) :: ("lower", .int .u32 lo) :: E2 C p s pv)
    (.let_ "bucket" (u32 0)) =
    .ok (("bucket", .int .u32 0) :: ("total", .int .u64 tot) :: ("lower", .int .u32 lo) :: E2 C p s pv) := by
  simp [exec, evalE, u32, W.bits]

theorem st14 (pv lo tot : Nat) (hl : p.thresholds_cents.length ≤ 8) :
    exec cm (("bucket", .int .u32 0) :: ("total", .int .u64 tot) :: ("lower", .int .u32 lo) :: E2 C p s pv)
      (.forEach "i" "t" ((Ex.var "p").field "thresholds_cents") body6) =
    .ok (("bucket", .int .u32 (Smith.SpendBucket.bucketLoop p.thresholds_cents tot 0)) ::
      ("total", .int .u64 tot) :: ("lower", .int .u32 lo) :: E2 C p s pv) := by
  have hf : (embP p).field "thresholds_cents" = some (.list (p.thresholds_cents.map embTh)) := by
    simp [embP, V.field]
  have hg : Env.get (("bucket", .int .u32 0) :: ("total", .int .u64 tot) :: ("lower", .int .u32 lo) :: E2 C p s pv) "p" =
      some (embP p) := by simp [Env.get, hpE2]
  simp only [exec, evalE, hg, Option.bind_some, hf]
  exact loop6 cm tot _ p.thresholds_cents 0 0 (by omega)

theorem out_eq (env : Env) (b : Nat) : evalOut cm (("bucket", .int .u32 b) :: env) [("bucket", .var "bucket")] =
    some [("bucket", .int .u32 b)] := by
  simp [evalOut, evalE, Env.get]

end stages

theorem run_eq_check (cm : CommitV) (C : CommitFn Smith.SpendBucket.Private) (hcm : CommitAgrees cm C)
    (p : Smith.SpendBucket.Public) (s : Smith.SpendBucket.Private) :
    run cm prog (embP p) (embS s) = toR (Smith.SpendBucket.check C p s) := by
  have h0 : [("s", embS s), ("p", embP p)] = E0 p s := rfl
  have h4 : exec cm (E1 C p s) (.let_ "prev" (u64 0)) = .ok (E2 C p s 0) := by
    simp [exec, evalE, E2, u64, W.bits]
  simp only [run, prog, execB, h0, st1 cm C hcm, R.bind, st2, st3, h4, st5]
  unfold Smith.SpendBucket.check
  by_cases h1 : (C.commit Smith.SpendBucket.tag s != p.records_root) = true
  · simp [h1, st2, st3, h4, st5, st6, st7, st8, st9, st10, st11, st12, st13, R.bind, toR]
  by_cases h2 : (p.thresholds_cents.length == 0 || p.thresholds_cents.length > 8) = true
  · simp [h1, h2, st2, st3, h4, st5, st6, st7, st8, st9, st10, st11, st12, st13, R.bind, toR]
  have hl : p.thresholds_cents.length ≤ 8 := by simp at h2; omega
  cases h3 : Smith.SpendBucket.strictInc p.thresholds_cents with
  | false => simp [h1, h2, h3, st2, st3, h4, st5, st6, st7, st8, st9, st10, st11, st12, st13, R.bind, toR]
  | true =>
  by_cases h6 : (p.window_days.toNat = 0 ∨ 3650 < p.window_days.toNat) ∨ p.as_of_day.toNat < p.window_days.toNat
  · simp [h1, h2, h3, h6, st2, st3, h4, st5, st6, st7, st8, st9, st10, st11, st12, st13, R.bind, toR]
  by_cases h7 : 256 < s.records.length
  · simp [h1, h2, h3, h6, h7, st2, st3, h4, st5, st6, st7, st8, st9, st10, st11, st12, st13, R.bind, toR]
  cases h8 : s.records.all (fun r => !(r.day.toNat > p.as_of_day.toNat)) with
  | false => simp [h1, h2, h3, h6, h7, h8, st2, st3, h4, st5, st6, st7, st8, st9, st10, st11, st12, st13, R.bind, toR]
  | true =>
  cases h10 : Smith.SpendBucket.u32CheckedSub p.as_of_day.toNat p.window_days.toNat with
  | none => simp [h1, h2, h3, h6, h7, h8, h10, st2, st3, h4, st5, st6, st7, st8, st9, st10, st11, st12, st13, R.bind, toR]
  | some lo =>
    cases h12 : Smith.SpendBucket.sumLoop s.records lo p.as_of_day.toNat 0 with
    | error e => simp [h1, h2, h3, h6, h7, h8, h10, h12, okT, st2, st3, h4, st5, st6, st7, st8, st9, st10, st11, st12, st13, R.bind, toR]
    | ok tot =>
      have hb : Smith.SpendBucket.bucketLoop p.thresholds_cents tot 0 < 2 ^ 32 := by
        rw [Smith.SpendBucket.bucketLoop_eq]
        have := Smith.SpendBucket.bucketOf_le p.thresholds_cents tot
        omega
      simp [h1, h2, h3, h6, h7, h8, h10, h12, okT, st14 cm C p s _ lo tot hl, out_eq, embO,
        Nat.mod_eq_of_lt hb, st2, st3, h4, st5, st6, st7, st8, st9, st10, st11, st12, st13, R.bind, toR]

theorem toR_ok (e : Except String Smith.SpendBucket.Output) (v : V) :
    toR e = .ok v ↔ ∃ o, e = .ok o ∧ v = embO o := by
  cases e <;> simp [toR, eq_comm]

theorem run_ok_iff_spec (cm : CommitV) (C : CommitFn Smith.SpendBucket.Private) (hcm : CommitAgrees cm C)
    (p : Smith.SpendBucket.Public) (s : Smith.SpendBucket.Private) (v : V) :
    run cm prog (embP p) (embS s) = .ok v ↔ ∃ o, v = embO o ∧ Smith.SpendBucket.Spec C p s o := by
  rw [run_eq_check cm C hcm, toR_ok]
  constructor
  · rintro ⟨o, h, rfl⟩; exact ⟨o, rfl, (Smith.SpendBucket.check_ok_iff_spec C p s o).mp h⟩
  · rintro ⟨o, rfl, h⟩; exact ⟨o, (Smith.SpendBucket.check_ok_iff_spec C p s o).mpr h, rfl⟩

theorem run_err_iff_no_spec (cm : CommitV) (C : CommitFn Smith.SpendBucket.Private) (hcm : CommitAgrees cm C)
    (p : Smith.SpendBucket.Public) (s : Smith.SpendBucket.Private) :
    (∃ m, run cm prog (embP p) (embS s) = .err m) ↔ ¬ ∃ o, Smith.SpendBucket.Spec C p s o := by
  rw [run_eq_check cm C hcm, ← Smith.SpendBucket.check_error_iff_no_spec]
  constructor
  · rintro ⟨m, h⟩
    cases hc : Smith.SpendBucket.check C p s with
    | ok o => rw [hc] at h; simp [toR] at h
    | error e => exact ⟨e, rfl⟩
  · rintro ⟨e, h⟩; exact ⟨e, by rw [h]; rfl⟩

theorem run_not_stuck (cm : CommitV) (C : CommitFn Smith.SpendBucket.Private) (hcm : CommitAgrees cm C)
    (p : Smith.SpendBucket.Public) (s : Smith.SpendBucket.Private) :
    run cm prog (embP p) (embS s) ≠ .stuck := by
  rw [run_eq_check cm C hcm]
  cases Smith.SpendBucket.check C p s <;> simp [toR]

end GapIR.SpendBucketProof

#print axioms GapIR.SpendBucketProof.run_ok_iff_spec
#print axioms GapIR.SpendBucketProof.run_err_iff_no_spec
#print axioms GapIR.SpendBucketProof.run_not_stuck
