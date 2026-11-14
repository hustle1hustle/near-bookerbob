import GapAeneas.Loops
open Aeneas Aeneas.Std RustM ControlFlow Error Aeneas.Std.WP
open dialect_coalition_k_of_n

namespace GapAeneas

/-! ## Results: Rust `Result<_, &'static str>` against the model's `Except String _` -/

/-- A Rust `&str` carries the same bytes as a Lean string. -/
def StrR (e : Str) (m : String) : Prop := e.val.map (·.val) = sb m

theorem toStr_R (m : String) (h) : StrR (toStr m h) m := by
  simp [StrR, toStr, sb, String.toUTF8]
  intro a _; rfl

def ResN : Except String Nat → core.result.Result Std.U32 Str → Prop
  | .ok n, .Ok d => d.val = n
  | .error m, .Err e => StrR e m
  | _, _ => False

def cdE : Nat × Nat → Except String Nat
  | (d, st) =>
    if st = 1 then .error "delivery id not 64 chars"
    else if st = 2 then .error "delivery id not lowercase hex"
    else if st = 3 then .error "delivered count overflow"
    else .ok d

@[step]
theorem count_delivered_spec (seats : alloc.vec.Vec types.Seat) :
    body.count_delivered seats ⦃ r => ResN (cdE (cdF 0 0 seats.val)) r ⦄ := by
  unfold body.count_delivered
  step*
  all_goals
    simp only [List.drop_zero] at delivered_post
    rw [← delivered_post]
    simp only [UScalar.eq_equiv] at *
    simp_all [cdE, ResN, toStr_R]

/-! ## Bridges: each pure Rust-side function equals the hand model's function -/

theorem forall2_all {α β} {R : α → β → Prop} {l1 : List α} {l2 : List β} (h : List.Forall₂ R l1 l2)
    (f : α → Bool) (g : β → Bool) (hfg : ∀ a b, R a b → f a = g b) : l1.all f = l2.all g := by
  induction h with
  | nil => rfl
  | cons hab _ ih => simp [List.all_cons, hfg _ _ hab, ih]

/-- Rule 3. -/
theorem legsR_eq (ms : List Smith.Coalition.Seat) (rs : List types.Seat) (h : List.Forall₂ SeatR ms rs)
    (k : Nat) : legsR rs k = Smith.Coalition.legsFrom ms k := by
  induction h generalizing k with
  | nil => rfl
  | cons hab _ ih => simp [legsR, Smith.Coalition.legsFrom, ih, hab.leg]

theorem member_eq_iff {m1 m2 : Smith.Coalition.Seat} {r1 r2 : types.Seat} (h1 : SeatR m1 r1)
    (h2 : SeatR m2 r2) : r1.member.val = r2.member.val ↔ m1.member = m2.member := by
  rw [← bv_inj, h1.member, h2.member, sb_inj]

theorem all_prior_eq {a : Smith.Coalition.Seat} {b : types.Seat} (hab : SeatR a b)
    {pm : List Smith.Coalition.Seat} {pr : List types.Seat} (hp : List.Forall₂ SeatR pm pr) :
    pm.all (fun x => a.member != x.member) = pr.all (fun y => !decide (b.member.val = y.member.val)) := by
  apply forall2_all hp
  intro x y hxy
  have hiff := member_eq_iff hab hxy
  by_cases hm : a.member = x.member
  · have h2 : b.member.val = y.member.val := hiff.mpr hm
    rw [hm, h2]; simp
  · have h2 : ¬ b.member.val = y.member.val := fun h => hm (hiff.mp h)
    simp only [h2, decide_false, Bool.not_false]
    exact bne_iff_ne.mpr hm

/-- Rule 4, the Rust side as a recursion with the prior seats in program order. -/
def rnd (prior : List types.Seat) : List types.Seat → Bool
  | [] => true
  | a :: rest => prior.all (fun b => !decide (a.member.val = b.member.val)) && rnd (prior ++ [a]) rest

theorem rnd_eq (pm : List Smith.Coalition.Seat) (pr : List types.Seat) (hp : List.Forall₂ SeatR pm pr)
    (lm : List Smith.Coalition.Seat) (lr : List types.Seat) (hl : List.Forall₂ SeatR lm lr) :
    rnd pr lr = Smith.Coalition.noDupFrom pm.reverse lm := by
  induction hl generalizing pm pr with
  | nil => simp [rnd, Smith.Coalition.noDupFrom]
  | @cons a b la lb hab _ ih =>
    simp only [rnd, Smith.Coalition.noDupFrom]
    have hp' : List.Forall₂ SeatR (pm ++ [a]) (pr ++ [b]) := List.rel_append hp (List.Forall₂.cons hab .nil)
    rw [ih _ _ hp', List.reverse_append, List.reverse_singleton, List.singleton_append, List.all_reverse]
    congr 1
    exact (all_prior_eq hab hp).symm

theorem range_newAt_eq (l : List types.Seat) (k : Nat) (hk : k ≤ l.length) :
    (List.range' k (l.length - k)).all (newAt l) = rnd (l.take k) (l.drop k) := by
  induction h : l.length - k generalizing k with
  | zero =>
    have : l.drop k = [] := List.drop_eq_nil_of_le (by omega)
    simp [this, rnd]
  | succ n ih =>
    have hlt : k < l.length := by omega
    rw [List.range'_succ, List.all_cons, List.drop_eq_getElem_cons hlt, rnd]
    rw [ih (k + 1) (by omega) (by omega), List.take_succ_eq_append_getElem hlt]
    simp [newAt, hlt]

/-- Rule 4 assembled. -/
theorem distinct_eq (ms : List Smith.Coalition.Seat) (rs : List types.Seat) (h : List.Forall₂ SeatR ms rs) :
    (List.range' 0 (rs.length - 0)).all (newAt rs) = Smith.Coalition.noDupFrom [] ms := by
  rw [range_newAt_eq rs 0 (by omega)]
  simpa using rnd_eq [] [] .nil ms rs (by simpa using h)

/-! Rules 5 and 6. -/
theorem cdF_stuck (d st : Nat) (l : List types.Seat) (h : st ≠ 0) : (cdF d st l).2 = st := by
  induction l generalizing d with
  | nil => rfl
  | cons s r ih => simp [cdF, h, ih]

theorem cdE_stuck (d st : Nat) (l : List types.Seat) (h : st = 1 ∨ st = 2 ∨ st = 3) :
    cdE (cdF d st l) = cdE (0, st) := by
  have := cdF_stuck d st l (by omega)
  rcases hc : cdF d st l with ⟨a, b⟩
  rw [hc] at this; simp only at this; subst this
  simp [cdE]; split_ifs <;> simp_all

theorem isLowerHex_eq (c : UInt8) : Smith.Coalition.isLowerHex c = isHexN c.toNat := by
  unfold Smith.Coalition.isLowerHex isHexN
  simp [UInt8.le_iff_toNat_le]

theorem len_eq {id : String} {v : alloc.vec.Vec Std.U8} (h : bv v = sb id) :
    v.length = id.toUTF8.size := by
  have := congrArg List.length h
  simp [bv, sb, ByteArray_toList_eq, ByteArray.size_data] at this
  simpa using this

theorem hex_eq {id : String} {v : alloc.vec.Vec Std.U8} (h : bv v = sb id) :
    v.val.all (fun c => isHexN c.val) = id.toUTF8.toList.all Smith.Coalition.isLowerHex := by
  have : v.val.all (fun c => isHexN c.val) = (bv v).all isHexN := by simp [bv, List.all_map]; rfl
  rw [this, h, sb, List.all_map]
  congr 1; funext c; simp [isLowerHex_eq]

theorem optR_none {x : Option (alloc.vec.Vec Std.U8)} (h : OptR none x) : x = none := by
  cases h; rfl

theorem optR_some {a : String} {x : Option (alloc.vec.Vec Std.U8)} (h : OptR (some a) x) :
    ∃ b, x = some b ∧ bv b = sb a := by
  cases h with | some hb => exact ⟨_, rfl, hb⟩

theorem count_eq (ms : List Smith.Coalition.Seat) (rs : List types.Seat) (h : List.Forall₂ SeatR ms rs)
    (acc : Nat) : cdE (cdF acc 0 rs) = Smith.Coalition.countLoop ms acc := by
  induction h generalizing acc with
  | nil => simp [cdF, cdE, Smith.Coalition.countLoop]
  | @cons m r lm lr hmr _ ih =>
    have hd := hmr.delivered
    cases hmd : m.delivered with
    | none =>
      rw [hmd] at hd
      have hrd := optR_none hd
      have hs : statusN r = 0 := by simp [statusN, hrd]
      simp [cdF, hs, hrd, Smith.Coalition.countLoop, hmd, ih]
    | some id =>
      rw [hmd] at hd
      obtain ⟨b, hrd, hb⟩ := optR_some hd
      have hl := len_eq hb
      have hx := hex_eq hb
      simp only [Smith.Coalition.countLoop, hmd, cdF]
      by_cases h64 : id.toUTF8.size = 64
      · by_cases hall : id.toUTF8.toList.all Smith.Coalition.isLowerHex = true
        · have hs : statusN r = 0 := by
            simp only [statusN, hrd, hl, h64, hx, hall, ne_eq, not_true_eq_false, ↓reduceIte]
          simp only [h64, bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, hall, Bool.not_true, hs,
            ne_eq, not_true_eq_false, hrd, Option.isSome_some]
          unfold Smith.u32CheckedAdd
          by_cases hov : acc + 1 < 2 ^ 32
          · rw [if_pos hov, if_pos hov]; exact ih _
          · rw [if_neg hov, if_neg hov, cdE_stuck _ _ _ (by omega)]; simp [cdE]
        · have hs : statusN r = 2 := by
            simp only [statusN, hrd, hl, h64, hx, hall, ne_eq, not_true_eq_false, ↓reduceIte,
              Bool.false_eq_true]
          simp only [h64, bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, hall, Bool.not_false, hs,
            ne_eq, OfNat.ofNat_ne_zero, not_false_eq_true]
          rw [cdE_stuck _ _ _ (by omega)]; simp [cdE]
      · have hs : statusN r = 1 := by simp only [statusN, hrd, hl, h64, ne_eq, not_false_eq_true, ↓reduceIte]
        have : (id.toUTF8.size != 64) = true := by simpa using h64
        simp only [this, ↓reduceIte, hs, ne_eq, one_ne_zero, not_false_eq_true]
        rw [cdE_stuck _ _ _ (by omega)]; simp [cdE]

/-! ## The generated `body.check` refines the hand model -/

def ResR : Except String Smith.Coalition.Output → core.result.Result types.Output Str → Prop
  | .ok o, .Ok o' => o'.delivered.val = o.delivered.toNat ∧ o'.seats.val = o.seats.toNat
  | .error e, .Err e' => StrR e' e
  | _, _ => False

theorem resN_ok {m : Except String Nat} {d : Std.U32} : ResN m (.Ok d) ↔ m = .ok d.val := by
  cases m <;> simp [ResN, eq_comm]

theorem resN_err {m : Except String Nat} {e : Str} : ResN m (.Err e) ↔ ∃ msg, m = .error msg ∧ StrR e msg := by
  cases m <;> simp [ResN]

theorem root_iff {root : Std.Array Std.U8 32#usize} {p : Smith.Coalition.Public} {p' : types.Public}
    {c : Smith.Bytes32} (hp : PubR p p') (hr : root.val.map (·.val) = c.map (·.toNat)) :
    root.val = p'.seats_root.val ↔ c = p.seats_root := by
  have i1 : Function.Injective (List.map (fun x : Std.U8 => x.val)) :=
    List.map_injective_iff.mpr (fun x y h => (UScalar.eq_equiv x y).mpr h)
  have i2 : Function.Injective (List.map (fun x : UInt8 => x.toNat)) :=
    List.map_injective_iff.mpr (fun x y h => UInt8.toNat_inj.mp h)
  rw [← i1.eq_iff, hr, hp.root, i2.eq_iff]

theorem check_refines (C : Smith.CommitFn (List Smith.Coalition.Seat))
    (p : Smith.Coalition.Public) (s : Smith.Coalition.Private) (p' : types.Public) (s' : types.Private)
    (hp : PubR p p') (hs : SeatsR s.seats s'.seats)
    (hC : ∃ root, commits.commit_seats (toStr "bookerbob/smith/coalition-seats/v0") s'.seats = ok root ∧
      root.val.map (·.val) = (C.commit Smith.Coalition.tag s.seats).map (·.toNat)) :
    body.check p' s' ⦃ r => ResR (Smith.Coalition.check C p s) r ⦄ := by
  obtain ⟨root, hroot, hrv⟩ := hC
  have F2 : s'.seats.val.length = s.seats.length := (List.Forall₂.length_eq hs).symm
  have G1 : decide (root.val = p'.seats_root.val) = decide (C.commit Smith.Coalition.tag s.seats = p.seats_root) := by
    simp [root_iff hp hrv]
  have G3 : (true && legsR (List.drop 0 s'.seats.val) 0) = Smith.Coalition.legsFrom s.seats 0 := by
    simpa using legsR_eq _ _ hs 0
  have G4 : (true && (List.range' 0 (s.seats.length - 0)).all (newAt s'.seats.val)) =
      Smith.Coalition.noDupFrom [] s.seats := by
    have := distinct_eq _ _ hs; rw [F2] at this; simpa using this
  have G5 := count_eq _ _ hs 0
  have G6 := hp.k_min
  have G7 : ∀ h, (UScalar.cast UScalarTy.U32 (Usize.ofNatCore s'.seats.val.length h)).val = s.seats.length ∨
      8 < s.seats.length := by
    intro h; by_cases h8 : 8 < s.seats.length
    · exact .inr h8
    · left; rw [UScalar.cast_val_eq]; simp only [Usize.ofNatCore_val_eq]; rw [F2]; apply Nat.mod_eq_of_lt; simp; omega
  unfold body.check body.legs_sequential body.members_distinct
  rw [hroot]
  simp only [bind_tc_ok]
  step*
  all_goals
    simp only [alloc.vec.Vec.len, UScalar.lt_equiv, gt_iff_lt, Usize.ofNatCore_val_eq, F2] at *
    simp only [G1, G3, G4, G5, resN_ok, resN_err, G6] at *
    subst_vars
    unfold Smith.Coalition.check
    simp_all [ResR, toStr_R, bne_iff_ne]
  all_goals
    have h8 : ¬ 8 < s.seats.length := by omega
    simp only [h8, ↓reduceIte]
  · simp only [resN_ok] at r_post
    rw [r_post]; simp [*, toStr_R]
  · simp only [resN_ok] at r_post
    rw [r_post]
    have hk : ¬ d.val < p.k_min.toNat := by omega
    have hc := G7 (by scalar_tac)
    simp only [hk, ↓reduceIte]
    refine ⟨?_, ?_⟩
    · simp
    · rcases hc with hc | hc
      · simp [hc]; omega
      · omega
  · simp only [resN_err] at r_post
    obtain ⟨msg, hm, he⟩ := r_post
    rw [hm]; exact he
  · simp [ResR, toStr_R]
  · simp [ResR, toStr_R]

end GapAeneas

namespace GapAeneas

/-! ## The theorems against the Spec (reusing the hand model's `check_ok_iff_spec`) -/

/-- The generated `body.check` returns `Ok o'` exactly when the Spec holds, with the same counts. -/
theorem aeneas_ok_iff_spec (C : Smith.CommitFn (List Smith.Coalition.Seat))
    (p : Smith.Coalition.Public) (s : Smith.Coalition.Private) (p' : types.Public) (s' : types.Private)
    (hp : PubR p p') (hs : SeatsR s.seats s'.seats)
    (hC : ∃ root, commits.commit_seats (toStr "bookerbob/smith/coalition-seats/v0") s'.seats = ok root ∧
      root.val.map (·.val) = (C.commit Smith.Coalition.tag s.seats).map (·.toNat))
    (o' : types.Output) :
    body.check p' s' = ok (.Ok o') ↔
      ∃ o, Smith.Coalition.Spec C p s o ∧ o'.delivered.val = o.delivered.toNat ∧ o'.seats.val = o.seats.toNat := by
  obtain ⟨r, hr, hR⟩ := spec_iff_ok.mp (check_refines C p s p' s' hp hs hC)
  rw [hr]
  constructor
  · intro h
    have h' : r = .Ok o' := by simpa using h
    subst h'
    cases hm : Smith.Coalition.check C p s with
    | error e => rw [hm] at hR; simp [ResR] at hR
    | ok o => rw [hm] at hR; exact ⟨o, (Smith.Coalition.check_ok_iff_spec C p s o).mp hm, hR⟩
  · rintro ⟨o, hspec, hd, hn⟩
    have hm := (Smith.Coalition.check_ok_iff_spec C p s o).mpr hspec
    rw [hm] at hR
    cases r with
    | Ok o'' =>
      simp only [ResR] at hR
      congr 2
      cases o''; cases o'
      simp only at hR hd hn ⊢
      congr 1
      · exact (UScalar.eq_equiv _ _).mpr (by omega)
      · exact (UScalar.eq_equiv _ _).mpr (by omega)
    | Err e => simp [ResR] at hR

/-- It returns `Err` exactly when no output meets the Spec, with the model's refusal string. -/
theorem aeneas_err_iff_no_spec (C : Smith.CommitFn (List Smith.Coalition.Seat))
    (p : Smith.Coalition.Public) (s : Smith.Coalition.Private) (p' : types.Public) (s' : types.Private)
    (hp : PubR p p') (hs : SeatsR s.seats s'.seats)
    (hC : ∃ root, commits.commit_seats (toStr "bookerbob/smith/coalition-seats/v0") s'.seats = ok root ∧
      root.val.map (·.val) = (C.commit Smith.Coalition.tag s.seats).map (·.toNat)) :
    (∃ e, body.check p' s' = ok (.Err e)) ↔ ¬ ∃ o, Smith.Coalition.Spec C p s o := by
  rw [← Smith.Coalition.check_error_iff_no_spec]
  obtain ⟨r, hr, hR⟩ := spec_iff_ok.mp (check_refines C p s p' s' hp hs hC)
  rw [hr]
  cases hm : Smith.Coalition.check C p s with
  | error m =>
    rw [hm] at hR
    cases r with
    | Err e => exact ⟨fun _ => ⟨m, rfl⟩, fun _ => ⟨e, rfl⟩⟩
    | Ok _ => simp [ResR] at hR
  | ok o =>
    rw [hm] at hR
    cases r with
    | Err e => simp [ResR] at hR
    | Ok _ => simp

/-- And it never panics or diverges: on related inputs the Rust check always returns a value. -/
theorem aeneas_total (C : Smith.CommitFn (List Smith.Coalition.Seat))
    (p : Smith.Coalition.Public) (s : Smith.Coalition.Private) (p' : types.Public) (s' : types.Private)
    (hp : PubR p p') (hs : SeatsR s.seats s'.seats)
    (hC : ∃ root, commits.commit_seats (toStr "bookerbob/smith/coalition-seats/v0") s'.seats = ok root ∧
      root.val.map (·.val) = (C.commit Smith.Coalition.tag s.seats).map (·.toNat)) :
    ∃ r, body.check p' s' = ok r := by
  obtain ⟨r, hr, -⟩ := spec_iff_ok.mp (check_refines C p s p' s' hp hs hC)
  exact ⟨r, hr⟩

end GapAeneas

#print axioms GapAeneas.check_refines
#print axioms GapAeneas.aeneas_ok_iff_spec
#print axioms GapAeneas.aeneas_err_iff_no_spec
#print axioms GapAeneas.aeneas_total
