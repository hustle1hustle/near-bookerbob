import GapIR.IR
import GapIR.Coalition
import SmithLean.CoalitionKofN
/-!
# The IR program meets the existing `Smith.Coalition.Spec`

The theorem is about `GapIR.Coalition.prog`, the same term `lake exe emit` prints to body.rs.
The hand model `Smith.Coalition.check` appears only as a lemma in the middle (`run_eq_check`);
the end result `run_ok_iff_spec` mentions only the IR program and the Spec.
-/

namespace GapIR.CoalitionProof
open GapIR GapIR.Coalition Smith

/-! ## Lean values ↔ IR values (the shape of types.rs) -/

def embStr (x : String) : V := .str x.toUTF8.toList
def embBytes (b : Bytes32) : V := .list (b.map fun x => .int .u8 x.toNat)
def embSeat (x : Smith.Coalition.Seat) : V :=
  .struct [("leg", .int .u32 x.leg.toNat), ("member", embStr x.member), ("price", .int .u128 x.price),
    ("delivered", .opt (x.delivered.map embStr))]
def embP (p : Smith.Coalition.Public) : V :=
  .struct [("coalition", embStr p.coalition), ("job", .int .u64 p.job.toNat),
    ("seats_root", embBytes p.seats_root), ("k_min", .int .u32 p.k_min.toNat)]
def embS (s : Smith.Coalition.Private) : V := .struct [("seats", .list (s.seats.map embSeat))]
def embO (o : Smith.Coalition.Output) : V :=
  .struct [("delivered", .int .u32 o.delivered.toNat), ("seats", .int .u32 o.seats.toNat)]

/-- The one assumption about the commitment: the IR's `commit` on the embedded seat list is the
Lean model's commitment of the list (both are smith_std::commit on the same Rust value). -/
def CommitAgrees (cm : CommitV) (C : CommitFn (List Smith.Coalition.Seat)) : Prop :=
  ∀ l, cm Smith.Coalition.tag (.list (l.map embSeat)) = embBytes (C.commit Smith.Coalition.tag l)

/-! ## Small facts -/

theorem ByteArray.toList_loop_eq (bs : ByteArray) : ∀ (k i : Nat) (r : List UInt8), bs.size - i = k →
    ByteArray.toList.loop bs i r = r.reverse ++ bs.data.toList.drop i := by
  intro k
  induction k with
  | zero =>
    intro i r h
    unfold ByteArray.toList.loop
    have : ¬ i < bs.size := by omega
    simp [this]
    omega
  | succ k ih =>
    intro i r h
    unfold ByteArray.toList.loop
    have hi : i < bs.size := by omega
    simp only [hi, ↓reduceIte]
    rw [ih (i+1) _ (by omega)]
    have hd : i < bs.data.toList.length := by simp; omega
    rw [List.drop_eq_getElem_cons hd]
    simp [ByteArray.get!, getElem!_pos, hi]

theorem ByteArray.toList_eq (bs : ByteArray) : bs.toList = bs.data.toList := by
  unfold ByteArray.toList
  rw [ByteArray.toList_loop_eq bs _ 0 [] rfl]; simp

theorem utf8_length (x : String) : x.toUTF8.toList.length = x.toUTF8.size := by
  rw [ByteArray.toList_eq]; simp

theorem utf8_inj (a b : String) : a.toUTF8.toList = b.toUTF8.toList ↔ a = b := by
  constructor
  · intro h
    rw [ByteArray.toList_eq, ByteArray.toList_eq, Array.toList_inj] at h
    apply String.toByteArray_inj.mp
    simp only [String.toUTF8_eq_toByteArray] at h
    cases ha : a.toByteArray; cases hb : b.toByteArray
    rw [ha, hb] at h; simp_all
  · rintro rfl; rfl

@[simp] theorem restore_self (e : Env) : restore e e = e := by simp [restore]
@[simp] theorem restore_cons1 (e : Env) (a) : restore e (a :: e) = e := by simp [restore]
@[simp] theorem restore_cons2 (e : Env) (a b) : restore e (a :: b :: e) = e := by
  simp [restore, show e.length + 1 + 1 - e.length = 2 by omega]

theorem restore_len1 (e e' : Env) (a) (h : e'.length = e.length) : restore e (a :: e') = e' := by
  simp [restore, h, show e.length + 1 - e.length = 1 by omega]
theorem restore_len2 (e e' : Env) (a b) (h : e'.length = e.length) : restore e (a :: b :: e') = e' := by
  simp [restore, h, show e.length + 1 + 1 - e.length = 2 by omega]

theorem leg_mod (x : UInt32) : x.toNat % 2 ^ 64 = x.toNat :=
  Nat.mod_eq_of_lt (Nat.lt_trans x.toNat_lt (by decide))

/-! ## Rule 3 -/

theorem body3_eq (cm : CommitV) (x : Smith.Coalition.Seat) (k : Nat) (env : Env) :
    execB cm (("seat", embSeat x) :: ("i", .int .usize k) :: env) body3 =
    if x.leg.toNat = k then .ok (("seat", embSeat x) :: ("i", .int .usize k) :: env)
    else .err "seat legs not sequential" := by
  by_cases h : x.leg.toNat = k
  · subst h
    simp [body3, execB, exec, evalE, Env.get, V.field, embSeat, W.bits, V.eqv, leg_mod, R.bind, R.map]
  · simp [body3, execB, exec, evalE, Env.get, V.field, embSeat, W.bits, V.eqv, leg_mod, R.bind, R.map, h]

theorem loop3 (cm : CommitV) (l : List Smith.Coalition.Seat) (k : Nat) (env : Env) :
    loopOver (fun e => execB cm e body3) "i" "seat" env k (l.map embSeat) =
    if Smith.Coalition.legsFrom l k then .ok env else .err "seat legs not sequential" := by
  induction l generalizing k with
  | nil => simp [loopOver, Smith.Coalition.legsFrom]
  | cons x rest ih =>
    simp only [List.map_cons, loopOver, body3_eq]
    by_cases h : x.leg.toNat = k <;> simp [h, ih, Smith.Coalition.legsFrom]

/-! ## Rule 4 -/

theorem embStr_eqv (a b : String) : (embStr a).eqv (embStr b) = some (decide (a = b)) := by
  simp only [embStr, V.eqv]
  by_cases h : a = b
  · subst h; simp
  · have : ¬ a.toUTF8.toList = b.toUTF8.toList := fun h' => h ((utf8_inj a b).mp h')
    simp only [h, decide_false]
    simp only [String.toUTF8_eq_toByteArray] at this
    simp [this]

theorem body4_eq (cm : CommitV) (x y : Smith.Coalition.Seat) (ka kb : Nat) (env : Env) :
    execB cm (("b", embSeat y) :: ("j", .int .usize kb) :: ("a", embSeat x) :: ("i", .int .usize ka) :: env) body4 =
    if kb < ka ∧ x.member = y.member then .err "duplicate member"
    else .ok (("b", embSeat y) :: ("j", .int .usize kb) :: ("a", embSeat x) :: ("i", .int .usize ka) :: env) := by
  by_cases h1 : kb < ka
  · by_cases h2 : x.member = y.member
    · simp [body4, execB, exec, evalE, Env.get, V.field, embSeat, Cmp.eval, embStr_eqv, R.bind, R.map, h1, h2]
    · simp [body4, execB, exec, evalE, Env.get, V.field, embSeat, Cmp.eval, embStr_eqv, R.bind, R.map, h1, h2]
  · simp [body4, execB, exec, evalE, Env.get, V.field, embSeat, Cmp.eval, R.bind, R.map, h1]

theorem loop4_inner (cm : CommitV) (x : Smith.Coalition.Seat) (ka : Nat) (env : Env)
    (l : List Smith.Coalition.Seat) (kb : Nat) :
    loopOver (fun e => execB cm e body4) "j" "b" (("a", embSeat x) :: ("i", .int .usize ka) :: env) kb
      (l.map embSeat) =
    if ∀ y ∈ l.take (ka - kb), x.member ≠ y.member then .ok (("a", embSeat x) :: ("i", .int .usize ka) :: env)
    else .err "duplicate member" := by
  induction l generalizing kb with
  | nil => simp [loopOver]
  | cons y rest ih =>
    simp only [List.map_cons, loopOver, body4_eq]
    by_cases h1 : kb < ka
    · have ht : ka - kb = (ka - (kb + 1)) + 1 := by omega
      rw [ht, List.take_succ_cons]
      by_cases h2 : x.member = y.member
      · simp [h1, h2]
      · simp only [h1, h2, and_false, ↓reduceIte, restore_cons2, ih, List.mem_cons, forall_eq_or_imp]
        simp [h2]
    · have ht : ka - kb = 0 := by omega
      have ht' : ka - (kb + 1) = 0 := by omega
      simp [h1, ih, ht, ht']

theorem loop4 (cm : CommitV) (all : List Smith.Coalition.Seat) (env : Env)
    (hs : env.get "s" = some (.struct [("seats", .list (all.map embSeat))]))
    (pre l : List Smith.Coalition.Seat) (hall : all = pre ++ l) :
    loopOver (fun e => execB cm e body4o) "i" "a" env pre.length (l.map embSeat) =
    if Smith.Coalition.noDupFrom pre.reverse l then .ok env else .err "duplicate member" := by
  induction l generalizing pre with
  | nil => simp [loopOver, Smith.Coalition.noDupFrom]
  | cons x rest ih =>
    have hin : execB cm (("a", embSeat x) :: ("i", .int .usize pre.length) :: env) body4o =
        if ∀ y ∈ pre, x.member ≠ y.member then .ok (("a", embSeat x) :: ("i", .int .usize pre.length) :: env)
        else .err "duplicate member" := by
      simp only [body4o, execB, exec, evalE, Env.get, V.field, hs]
      simp only [show ("s" = "a") = False by decide, show ("s" = "i") = False by decide, ite_false,
        Option.bind_some]
      simp only [List.find?, beq_self_eq_true, Option.map_some]
      rw [loop4_inner]
      subst hall
      simp only [Nat.sub_zero, List.take_left]
      split <;> simp [R.bind]
    simp only [List.map_cons, loopOver, hin]
    have hih := ih (pre ++ [x]) (by simp [hall])
    simp only [List.length_append, List.length_singleton, List.reverse_append, List.reverse_singleton,
      List.singleton_append] at hih
    by_cases h : ∀ y ∈ pre, x.member ≠ y.member
    · simp only [h, ↓reduceIte, restore_cons2, hih, Smith.Coalition.noDupFrom, Bool.and_eq_true,
        List.all_eq_true, List.mem_reverse, bne_iff_ne, ne_eq]
      simp_all
    · simp only [h, ↓reduceIte, Smith.Coalition.noDupFrom]
      obtain ⟨y, hy, hxy⟩ : ∃ y ∈ pre, x.member = y.member := by simpa using h
      have : (pre.reverse.all fun b => x.member != b.member) = false :=
        List.all_eq_false.mpr ⟨y, by simpa using hy, by simp [hxy]⟩
      simp [this]

/-! ## Rules 5 and 6 -/

theorem hex_eq (b : UInt8) : Smith.Coalition.isLowerHex b =
    ((decide (48 ≤ b.toNat) && decide (b.toNat ≤ 57)) || (decide (97 ≤ b.toNat) && decide (b.toNat ≤ 102))) := by
  simp [Smith.Coalition.isLowerHex, UInt8.le_iff_toNat_le]

theorem hexBody_eq (cm : CommitV) (b : UInt8) (k : Nat) (env : Env) :
    execB cm (("c", .int .u8 b.toNat) :: ("j", .int .usize k) :: env) hexBody =
    if Smith.Coalition.isLowerHex b then .ok (("c", .int .u8 b.toNat) :: ("j", .int .usize k) :: env)
    else .err "delivery id not lowercase hex" := by
  rw [hex_eq]
  have hb := b.toNat_lt
  simp only [hexBody, execB, exec, evalE, isLowerHex, u8, Env.get, W.bits, Cmp.eval]
  by_cases h1 : 48 ≤ b.toNat <;> by_cases h2 : b.toNat ≤ 57 <;> by_cases h3 : 97 ≤ b.toNat <;>
    by_cases h4 : b.toNat ≤ 102 <;> simp [h1, h2, h3, h4, R.bind, R.map] <;> omega

theorem loopHex (cm : CommitV) (env : Env) (bs : List UInt8) (k : Nat) :
    loopOver (fun e => execB cm e hexBody) "j" "c" env k (bs.map fun b => .int .u8 b.toNat) =
    if bs.all Smith.Coalition.isLowerHex then .ok env else .err "delivery id not lowercase hex" := by
  induction bs generalizing k with
  | nil => simp [loopOver]
  | cons b rest ih =>
    simp only [List.map_cons, loopOver, hexBody_eq]
    by_cases h : Smith.Coalition.isLowerHex b <;> simp [h, ih]

/-- What the per-seat body leaves: the `delivered` counter after this seat, or the refusal. -/
def okD (rest : Env) : Except String Nat → R Env
  | .ok d => .ok (("delivered", .int .u32 d) :: rest)
  | .error e => .err e

theorem body56_eq (cm : CommitV) (x : Smith.Coalition.Seat) (acc k : Nat) (rest : Env) :
    execB cm (("seat", embSeat x) :: ("i", .int .usize k) :: ("delivered", .int .u32 acc) :: rest) body56 =
    match x.delivered with
    | none => .ok (("seat", embSeat x) :: ("i", .int .usize k) :: ("delivered", .int .u32 acc) :: rest)
    | some id =>
      if id.toUTF8.size != 64 then .err "delivery id not 64 chars"
      else if !(id.toUTF8.toList.all Smith.Coalition.isLowerHex) then .err "delivery id not lowercase hex"
      else if acc + 1 < 2 ^ 32 then
        .ok (("seat", embSeat x) :: ("i", .int .usize k) :: ("delivered", .int .u32 (acc + 1)) :: rest)
      else .err "delivered count overflow" := by
  have hlen : (id : String) → id.toUTF8.toList.length = id.toUTF8.size := utf8_length
  cases hd : x.delivered with
  | none => simp [body56, execB, exec, evalE, Env.get, V.field, embSeat, hd, R.bind, R.map]
  | some id =>
    have hl := hlen id
    simp only [String.toUTF8_eq_toByteArray, String.size_toByteArray] at hl
    by_cases h1 : id.toUTF8.size = 64
    · by_cases h2 : id.toUTF8.toList.all Smith.Coalition.isLowerHex = true
      · simp only [String.toUTF8_eq_toByteArray, String.size_toByteArray] at h1 h2
        by_cases h3 : acc + 1 < 2 ^ 32
        · simp [body56, inner56, hexLoop, execB, exec, evalE, Env.get, Env.set, V.field, embSeat, embStr, hd,
            R.bind, R.map, V.eqv, usz, u32, W.bits, loopHex, checkedOp, hl, h1, h2, h3, restore_len1]
        · simp [body56, inner56, hexLoop, execB, exec, evalE, Env.get, Env.set, V.field, embSeat, embStr, hd,
            R.bind, R.map, V.eqv, usz, u32, W.bits, loopHex, checkedOp, hl, h1, h2, h3]
      · simp only [String.toUTF8_eq_toByteArray, String.size_toByteArray] at h1 h2
        simp [body56, inner56, hexLoop, execB, exec, evalE, Env.get, V.field, embSeat, embStr, hd,
          R.bind, R.map, V.eqv, usz, u32, W.bits, loopHex, hl, h1, h2]
    · simp only [String.toUTF8_eq_toByteArray, String.size_toByteArray] at h1
      simp [body56, inner56, hexLoop, execB, exec, evalE, Env.get, V.field, embSeat, embStr, hd,
        R.bind, R.map, V.eqv, usz, W.bits, hl, h1]

theorem loop56 (cm : CommitV) (rest : Env) (l : List Smith.Coalition.Seat) (acc k : Nat) :
    loopOver (fun e => execB cm e body56) "i" "seat" (("delivered", .int .u32 acc) :: rest) k (l.map embSeat) =
    okD rest (Smith.Coalition.countLoop l acc) := by
  induction l generalizing acc k with
  | nil => simp [loopOver, Smith.Coalition.countLoop, okD]
  | cons x xs ih =>
    simp only [List.map_cons, loopOver, body56_eq]
    cases hd : x.delivered with
    | none => simp [Smith.Coalition.countLoop, hd, ih]
    | some id =>
      simp only [Smith.Coalition.countLoop, hd, u32CheckedAdd]
      simp only [String.toUTF8_eq_toByteArray, String.size_toByteArray, bne_iff_ne, ne_eq, ite_not,
        Bool.not_eq_true', List.all_eq_false]
      by_cases h1 : id.utf8ByteSize = 64
      · by_cases h2 : ∃ x ∈ id.toByteArray.toList, Smith.Coalition.isLowerHex x = false
        · simp [h1, h2, okD]
        · by_cases h3 : acc + 1 < 2 ^ 32
          · have h2' : ¬∃ x, x ∈ id.toByteArray.toList ∧ ¬Smith.Coalition.isLowerHex x = true := by
              simpa using h2
            simp only [h1, h2', h3, ↓reduceIte, Bool.false_eq_true]
            rw [restore_len2 _ _ _ _ (by simp), ih]
          · simp [h1, h2, h3, okD]
      · simp [h1, okD]

/-! ## The whole program -/

theorem eqvList_bytes : ∀ a b : List UInt8,
    eqvList (a.map fun x => .int .u8 x.toNat) (b.map fun x => .int .u8 x.toNat) = some (decide (a = b))
  | [], [] => rfl
  | [], _ :: _ => by simp [eqvList]
  | _ :: _, [] => by simp [eqvList]
  | x :: xs, y :: ys => by
    simp only [List.map_cons, eqvList, V.eqv, if_pos rfl, eqvList_bytes xs ys]
    by_cases h : x = y
    · subst h; by_cases h' : xs = ys <;> simp [h']
    · have : x.toNat ≠ y.toNat := fun e => h (UInt8.toNat_inj.mp e)
      simp [h, this]

theorem embBytes_eqv (a b : Bytes32) : (embBytes a).eqv (embBytes b) = some (decide (a = b)) := by
  simp only [embBytes, V.eqv]; exact eqvList_bytes a b

theorem loop4_zero (cm : CommitV) (all : List Smith.Coalition.Seat) (env : Env)
    (hs : env.get "s" = some (.struct [("seats", .list (all.map embSeat))])) :
    loopOver (fun e => execB cm e body4o) "i" "a" env 0 (all.map embSeat) =
    if Smith.Coalition.noDupFrom [] all then .ok env else .err "duplicate member" := by
  exact loop4 cm all env hs [] all rfl

def toR : Except String Smith.Coalition.Output → R V
  | .ok o => .ok (embO o)
  | .error e => .err e

section stages
variable (cm : CommitV) (C : CommitFn (List Smith.Coalition.Seat)) (hcm : CommitAgrees cm C)
  (p : Smith.Coalition.Public) (s : Smith.Coalition.Private)

def E0 : Env := [("s", embS s), ("p", embP p)]
def E1 : Env := ("root", embBytes (C.commit Smith.Coalition.tag s.seats)) :: E0 p s
def E2 : Env := ("n", .int .usize s.seats.length) :: E1 C p s
def E3 (d : Nat) : Env := ("delivered", .int .u32 d) :: E2 C p s

include hcm in
theorem st1 : exec cm (E0 p s) (.let_ "root" (.commit "bookerbob/smith/coalition-seats/v0"
    ((Ex.var "s").field "seats"))) = .ok (E1 C p s) := by
  have hc := hcm s.seats
  simp only [Smith.Coalition.tag] at hc
  simp [exec, evalE, E0, E1, Env.get, V.field, embS, hc, Smith.Coalition.tag]

theorem st2 : exec cm (E1 C p s) (.ite (.ne (.var "root") ((Ex.var "p").field "seats_root"))
    [.refuse "seats_root mismatch"] []) =
    if C.commit Smith.Coalition.tag s.seats != p.seats_root then .err "seats_root mismatch" else .ok (E1 C p s) := by
  by_cases h : C.commit Smith.Coalition.tag s.seats = p.seats_root <;>
  simp [exec, evalE, E0, E1, Env.get, V.field, embP, embBytes_eqv, h, execB, R.map, R.bind]

theorem st3 : exec cm (E1 C p s) (.let_ "n" (.len ((Ex.var "s").field "seats"))) = .ok (E2 C p s) := by
  simp [exec, evalE, E0, E1, E2, Env.get, V.field, embS]

theorem st4 : exec cm (E2 C p s) (.ite (.or (.cmp .lt (.var "n") (usz 1)) (.cmp .gt (.var "n") (usz 8)))
    [.refuse "seat count out of range"] []) =
    if (s.seats.length < 1 || s.seats.length > 8) then .err "seat count out of range" else .ok (E2 C p s) := by
  by_cases hA : s.seats.length < 1 <;> by_cases hB : s.seats.length > 8 <;>
  simp [exec, evalE, E2, Env.get, usz, W.bits, Cmp.eval, execB, R.map, R.bind, hA, hB] <;> omega

theorem hsE2 : (E2 C p s).get "s" = some (.struct [("seats", .list (s.seats.map embSeat))]) := by
  simp [E2, E1, E0, Env.get, embS]

theorem st5 : exec cm (E2 C p s) rule3 =
    if Smith.Coalition.legsFrom s.seats 0 then .ok (E2 C p s) else .err "seat legs not sequential" := by
  simp only [rule3, exec, evalE, hsE2, Option.bind_some, V.field, List.find?, beq_self_eq_true,
    Option.map_some]
  exact loop3 cm s.seats 0 _

theorem st6 : exec cm (E2 C p s) rule4 =
    if Smith.Coalition.noDupFrom [] s.seats then .ok (E2 C p s) else .err "duplicate member" := by
  simp only [rule4, exec, evalE, hsE2, Option.bind_some, V.field, List.find?, beq_self_eq_true,
    Option.map_some]
  exact loop4_zero cm s.seats _ (hsE2 C p s)

theorem st7 : exec cm (E2 C p s) (.let_ "delivered" (u32 0)) = .ok (E3 C p s 0) := by
  simp [exec, evalE, E3, u32, W.bits]

theorem st8 : exec cm (E3 C p s 0) rule56 = okD (E2 C p s) (Smith.Coalition.countLoop s.seats 0) := by
  have : (E3 C p s 0).get "s" = some (.struct [("seats", .list (s.seats.map embSeat))]) := by
    simp [E3, E2, E1, E0, Env.get, embS]
  simp only [rule56, exec, evalE, this, Option.bind_some, V.field, List.find?, beq_self_eq_true,
    Option.map_some]
  exact loop56 cm _ s.seats 0 0

theorem st9 (d : Nat) : exec cm (E3 C p s d) (.ite (.cmp .lt (.var "delivered") ((Ex.var "p").field "k_min"))
    [.refuse "delivered below k_min"] []) =
    if d < p.k_min.toNat then .err "delivered below k_min" else .ok (E3 C p s d) := by
  by_cases h : d < p.k_min.toNat <;>
  simp [exec, evalE, E3, E2, E1, E0, Env.get, V.field, embP, Cmp.eval, execB, R.map, R.bind, h]

theorem out_eq (d : Nat) : evalOut cm (E3 C p s d) [("delivered", .var "delivered"), ("seats", .cast .u32 (.var "n"))] =
    some [("delivered", .int .u32 d), ("seats", .int .u32 (s.seats.length % 2 ^ 32))] := by
  simp [evalOut, evalE, E3, E2, Env.get, W.bits]

end stages

theorem R.bind_ite {α β} (c : Prop) [Decidable c] (a b : R α) (f : α → R β) :
    (if c then a else b).bind f = if c then a.bind f else b.bind f := by split <;> rfl

theorem run_eq_check (cm : CommitV) (C : CommitFn (List Smith.Coalition.Seat)) (hcm : CommitAgrees cm C)
    (p : Smith.Coalition.Public) (s : Smith.Coalition.Private) :
    run cm prog (embP p) (embS s) = toR (Smith.Coalition.check C p s) := by
  have h0 : [("s", embS s), ("p", embP p)] = E0 p s := rfl
  simp only [run, prog, execB, h0, st1 cm C hcm, R.bind, st2, st3, st4, st5, st6, st7, st8]
  unfold Smith.Coalition.check
  by_cases h1 : (C.commit Smith.Coalition.tag s.seats != p.seats_root) = true
  · simp [h1, toR, R.bind]
  · simp only [h1, Bool.false_eq_true, ↓reduceIte, R.bind, st3, st4, st5, st6, st7, st8]
    by_cases h2 : s.seats = [] ∨ 8 < s.seats.length
    · simp [h2, toR]
    · simp [h2, Bool.false_eq_true, ↓reduceIte, R.bind, st3, st4, st5, st6, st7, st8]
      by_cases h3 : Smith.Coalition.legsFrom s.seats 0 = true
      · by_cases h4 : Smith.Coalition.noDupFrom [] s.seats = true
        · simp [h3, h4, Bool.not_true, Bool.false_eq_true, ↓reduceIte, R.bind, st3, st4, st5, st6, st7, st8]
          cases h5 : Smith.Coalition.countLoop s.seats 0 with
          | error e => simp [okD, toR, R.bind, st3, st4, st5, st6, st7, st8]
          | ok d =>
            have hd := ((Smith.Coalition.countLoop_ok_iff s.seats 0 d (by decide)).mp h5).2.1
            have hd32 : d < 2 ^ 32 := by
              have := ((Smith.Coalition.countLoop_ok_iff s.seats 0 d (by decide)).mp h5).2.2
              omega
            have hok : okD (E2 C p s) (.ok d) = .ok (E3 C p s d) := rfl
            simp only [hok, R.bind, st9]
            by_cases h6 : d < p.k_min.toNat
            · simp [h6, toR, R.bind, st3, st4, st5, st6, st7, st8]
            · simp only [h6, ↓reduceIte, R.bind, out_eq]
              simp [toR, embO, Nat.mod_eq_of_lt hd32]
        · simp [h3, h4, toR, R.bind, st3, st4, st5, st6, st7, st8]
      · simp [h3, toR, R.bind, st3, st4, st5, st6, st7, st8]

/-! ## The results: the IR program against the Spec, the hand model gone -/

theorem toR_ok (e : Except String Smith.Coalition.Output) (v : V) :
    toR e = .ok v ↔ ∃ o, e = .ok o ∧ v = embO o := by
  cases e <;> simp [toR, eq_comm]

/-- Accept with output `v` exactly when `v` is (the embedding of) an output the Spec allows. -/
theorem run_ok_iff_spec (cm : CommitV) (C : CommitFn (List Smith.Coalition.Seat)) (hcm : CommitAgrees cm C)
    (p : Smith.Coalition.Public) (s : Smith.Coalition.Private) (v : V) :
    run cm prog (embP p) (embS s) = .ok v ↔ ∃ o, v = embO o ∧ Smith.Coalition.Spec C p s o := by
  rw [run_eq_check cm C hcm, toR_ok]
  constructor
  · rintro ⟨o, h, rfl⟩; exact ⟨o, rfl, (Smith.Coalition.check_ok_iff_spec C p s o).mp h⟩
  · rintro ⟨o, rfl, h⟩; exact ⟨o, (Smith.Coalition.check_ok_iff_spec C p s o).mpr h, rfl⟩

/-- Refuse exactly when no output meets the Spec. -/
theorem run_err_iff_no_spec (cm : CommitV) (C : CommitFn (List Smith.Coalition.Seat)) (hcm : CommitAgrees cm C)
    (p : Smith.Coalition.Public) (s : Smith.Coalition.Private) :
    (∃ m, run cm prog (embP p) (embS s) = .err m) ↔ ¬ ∃ o, Smith.Coalition.Spec C p s o := by
  rw [run_eq_check cm C hcm, ← Smith.Coalition.check_error_iff_no_spec]
  constructor
  · rintro ⟨m, h⟩
    cases hc : Smith.Coalition.check C p s with
    | ok o => rw [hc] at h; simp [toR] at h
    | error e => exact ⟨e, rfl⟩
  · rintro ⟨e, h⟩; exact ⟨e, by rw [h]; rfl⟩

/-- On decoded inputs the program never leaves the IR's defined domain (no `stuck`). -/
theorem run_not_stuck (cm : CommitV) (C : CommitFn (List Smith.Coalition.Seat)) (hcm : CommitAgrees cm C)
    (p : Smith.Coalition.Public) (s : Smith.Coalition.Private) :
    run cm prog (embP p) (embS s) ≠ .stuck := by
  rw [run_eq_check cm C hcm]
  cases Smith.Coalition.check C p s <;> simp [toR]

end GapIR.CoalitionProof

#print axioms GapIR.CoalitionProof.run_ok_iff_spec
#print axioms GapIR.CoalitionProof.run_err_iff_no_spec
#print axioms GapIR.CoalitionProof.run_not_stuck
