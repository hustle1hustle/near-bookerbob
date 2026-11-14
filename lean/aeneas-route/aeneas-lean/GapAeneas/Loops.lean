import GapAeneas.Coalition
open Aeneas Aeneas.Std RustM ControlFlow Error Aeneas.Std.WP
open dialect_coalition_k_of_n

namespace GapAeneas

theorem drop_step {α} [DecidableEq α] {l1 l2 : List α} {j : Nat} (h1 : j < l1.length) (h2 : j < l2.length)
    (x y : α) (hx : x = l1[j]) (hy : y = l2[j]) (c : Bool) (hc : c = true ↔ x ≠ y) (e : Bool) :
    ((if c = true then false else e) && decide (l1.drop (j+1) = l2.drop (j+1))) =
      (e && decide (l1.drop j = l2.drop j)) := by
  have e1 := List.drop_eq_getElem_cons h1
  have e2 := List.drop_eq_getElem_cons h2
  subst hx hy
  simp only [e1, e2, List.cons.injEq]
  by_cases h : l1[j] = l2[j]
  · have : c = false := by cases c <;> simp_all
    simp only [this, h, true_and, Bool.false_eq_true, ↓reduceIte]
  · have : c = true := hc.mpr h
    simp [this, h]

theorem u8_bne (x y : Std.U8) : (x != y) = true ↔ x ≠ y := bne_iff_ne

@[step]
theorem bytes32_eq_loop_spec (a b : Std.Array Std.U8 32#usize) (e : Bool) (i : Std.Usize)
    (hi : i.val ≤ 32) :
    body.bytes32_eq_loop a b e i ⦃ r => r = (e && decide (a.val.drop i.val = b.val.drop i.val)) ⦄ := by
  have ha : a.val.length = 32 := by simp
  have hb : b.val.length = 32 := by simp
  unfold body.bytes32_eq_loop
  apply loop.spec_decr_nat (fun (_, j) => 32 - j.val)
    (fun (o, j) => j.val ≤ 32 ∧ (o && decide (a.val.drop j.val = b.val.drop j.val)) =
      (e && decide (a.val.drop i.val = b.val.drop i.val)))
  · rintro ⟨o, j⟩ ⟨hj, hinv⟩
    unfold body.bytes32_eq_loop.body
    simp only [ite_ok]
    step*
    · refine ⟨by scalar_tac, ?_, by scalar_tac⟩
      rw [← hinv, i3_post]
      exact drop_step (l1 := a.val) (l2 := b.val) (by scalar_tac) (by scalar_tac) _ _ i1_post1 i2_post1 (i1 != i2) (u8_bne i1 i2) o
    · rw [← hinv, List.drop_eq_nil_of_le (by scalar_tac), List.drop_eq_nil_of_le (by scalar_tac)]; simp
  · exact ⟨hi, rfl⟩

@[step]
theorem bytes32_eq_spec (a b : Std.Array Std.U8 32#usize) :
    body.bytes32_eq a b ⦃ r => r = decide (a.val = b.val) ⦄ := by
  unfold body.bytes32_eq
  step*
  simpa using r_post

@[step]
theorem bytes_eq_loop_spec (a b : alloc.vec.Vec Std.U8) (e : Bool) (i : Std.Usize)
    (hl : a.length = b.length) (hi : i.val ≤ a.length) :
    body.bytes_eq_loop a b e i ⦃ r => r = (e && decide (a.val.drop i.val = b.val.drop i.val)) ⦄ := by
  unfold body.bytes_eq_loop
  apply loop.spec_decr_nat (fun (_, j) => a.length - j.val)
    (fun (o, j) => j.val ≤ a.length ∧ (o && decide (a.val.drop j.val = b.val.drop j.val)) =
      (e && decide (a.val.drop i.val = b.val.drop i.val)))
  · rintro ⟨o, j⟩ ⟨hj, hinv⟩
    unfold body.bytes_eq_loop.body
    simp only [ite_ok]
    step*
    · refine ⟨by scalar_tac, ?_, by scalar_tac⟩
      rw [← hinv, i4_post]
      exact drop_step (l1 := a.val) (l2 := b.val) (by scalar_tac) (by scalar_tac) _ _ i2_post i3_post
        (i2 != i3) (u8_bne i2 i3) o
    · rw [← hinv, List.drop_eq_nil_of_le (by scalar_tac), List.drop_eq_nil_of_le (by scalar_tac)]; simp
  · exact ⟨hi, rfl⟩

@[step]
theorem bytes_eq_spec (a b : alloc.vec.Vec Std.U8) :
    body.bytes_eq a b ⦃ r => r = decide (a.val = b.val) ⦄ := by
  unfold body.bytes_eq
  dsimp only
  split_ifs with h
  · have : a.val ≠ b.val := fun h' => by simp [h'] at h
    simp [this]
  · have : a.length = b.length := by simpa using h
    step*
    simpa using r_post

/-! Rule 3. -/
def legsR : List types.Seat → Nat → Bool
  | [], _ => true
  | s :: r, k => (s.leg.val == k) && legsR r (k + 1)

@[step]
theorem legs_sequential_loop_spec (seats : alloc.vec.Vec types.Seat) (e : Bool) (i : Std.Usize)
    (hi : i.val ≤ seats.length) :
    body.legs_sequential_loop seats e i ⦃ r => r = (e && legsR (seats.val.drop i.val) i.val) ⦄ := by
  unfold body.legs_sequential_loop
  apply loop.spec_decr_nat (fun (_, j) => seats.length - j.val)
    (fun (o, j) => j.val ≤ seats.length ∧ (o && legsR (seats.val.drop j.val) j.val) =
      (e && legsR (seats.val.drop i.val) i.val))
  · rintro ⟨o, j⟩ ⟨hj, hinv⟩
    unfold body.legs_sequential_loop.body
    simp only [ite_ok]
    step*
    · refine ⟨by scalar_tac, ?_, by scalar_tac⟩
      have hd : seats.val.drop j.val = s :: seats.val.drop (j.val + 1) := by
        rw [s_post]; exact List.drop_eq_getElem_cons (by scalar_tac)
      rw [← hinv, i3_post, hd]
      have hc : i2.val = s.leg.val := by
        rw [i2_post, UScalar.cast_val_eq]; apply Nat.mod_eq_of_lt; scalar_tac
      simp only [legsR]
      generalize legsR (List.drop (j.val + 1) seats.val) (j.val + 1) = t
      by_cases h : i2 = j
      · have : s.leg.val = j.val := by rw [← hc, h]
        simp [h, this]
      · have : s.leg.val ≠ j.val := by
          rw [← hc]; intro h'; exact h ((UScalar.eq_equiv _ _).mpr h')
        have hb : (i2 != j) = true := bne_iff_ne.mpr h
        simp [hb, this]
    · rw [← hinv, List.drop_eq_nil_of_le (by scalar_tac)]; simp [legsR]
  · exact ⟨hi, rfl⟩

/-! Rule 4. -/
/-- seat k's member differs from every member before it -/
def newAt (l : List types.Seat) (k : Nat) : Bool :=
  if h : k < l.length then (l.take k).all (fun b => !decide (l[k].member.val = b.member.val)) else true

@[step]
theorem member_new_loop_spec (seats : alloc.vec.Vec types.Seat) (i : Std.Usize) (e : Bool) (j : Std.Usize)
    (hi : i.val < seats.length) (hj : j.val ≤ i.val) :
    body.member_new_loop seats i e j ⦃ r => r = (e && ((seats.val.take i.val).drop j.val).all
      (fun b => !decide (seats.val[i.val].member.val = b.member.val))) ⦄ := by
  unfold body.member_new_loop
  apply loop.spec_decr_nat (fun (_, k) => i.val - k.val)
    (fun (o, k) => k.val ≤ i.val ∧ (o && ((seats.val.take i.val).drop k.val).all
      (fun b => !decide (seats.val[i.val].member.val = b.member.val))) =
      (e && ((seats.val.take i.val).drop j.val).all
      (fun b => !decide (seats.val[i.val].member.val = b.member.val))))
  · rintro ⟨o, k⟩ ⟨hk, hinv⟩
    unfold body.member_new_loop.body
    simp only [ite_ok]
    step*
    · refine ⟨by scalar_tac, ?_, by scalar_tac⟩
      rw [← hinv, j1_post]
      have hlen : k.val < (seats.val.take i.val).length := by simp; scalar_tac
      rw [List.drop_eq_getElem_cons hlen (l := seats.val.take i.val)]
      simp only [List.all_cons, List.getElem_take, b_post, s_post, s1_post]
      generalize (List.drop (k.val + 1) (List.take i.val seats.val)).all _ = t
      have hk' : k.val < seats.val.length := by scalar_tac
      by_cases hm : seats.val[i.val].member.val = (seats.val[k.val]'hk').member.val <;> simp [hm]
    · rw [← hinv, List.drop_eq_nil_of_le (by simp; scalar_tac)]; simp
  · exact ⟨hj, rfl⟩

@[step]
theorem member_new_spec (seats : alloc.vec.Vec types.Seat) (i : Std.Usize) (hi : i.val < seats.length) :
    body.member_new seats i ⦃ r => r = newAt seats.val i.val ⦄ := by
  unfold body.member_new
  step*
  simp [r_post, newAt, hi]

@[step]
theorem members_distinct_loop_spec (seats : alloc.vec.Vec types.Seat) (e : Bool) (i : Std.Usize)
    (hi : i.val ≤ seats.length) :
    body.members_distinct_loop seats e i ⦃ r =>
      r = (e && (List.range' i.val (seats.length - i.val)).all (newAt seats.val)) ⦄ := by
  unfold body.members_distinct_loop
  apply loop.spec_decr_nat (fun (_, j) => seats.length - j.val)
    (fun (o, j) => j.val ≤ seats.length ∧
      (o && (List.range' j.val (seats.length - j.val)).all (newAt seats.val)) =
      (e && (List.range' i.val (seats.length - i.val)).all (newAt seats.val)))
  · rintro ⟨o, j⟩ ⟨hj, hinv⟩
    unfold body.members_distinct_loop.body
    simp only [ite_ok]
    step*
    · refine ⟨by scalar_tac, ?_, by scalar_tac⟩
      rw [← hinv, i2_post]
      have : seats.length - j.val = (seats.length - (j.val + 1)) + 1 := by scalar_tac
      rw [this, List.range'_succ]
      simp only [List.all_cons, ← b_post]
      cases o <;> cases b <;> simp
    · have : seats.length - j.val = 0 := by scalar_tac
      rw [← hinv, this]; simp
  · exact ⟨hi, rfl⟩

/-! Rule 5. -/
@[irreducible] def isHexN (c : Nat) : Bool := (48 ≤ c && c ≤ 57) || (97 ≤ c && c ≤ 102)

theorem lowhex (c : Std.U8) :
    (if c ≥ 48#u8 then if c ≤ 57#u8 then ok true else if c ≥ 97#u8 then ok (decide (c ≤ 102#u8)) else ok false
      else if c ≥ 97#u8 then ok (decide (c ≤ 102#u8)) else ok false : RustM Bool) = ok (isHexN c.val) := by
  unfold isHexN
  split_ifs <;> simp_all <;> scalar_tac

@[step]
theorem all_lower_hex_loop_spec (id : alloc.vec.Vec Std.U8) (ok1 : Bool) (i : Std.Usize)
    (hi : i.val ≤ id.length) :
    body.all_lower_hex_loop id ok1 i ⦃ r =>
      r = (ok1 && (id.val.drop i.val).all (fun c => isHexN c.val)) ⦄ := by
  unfold body.all_lower_hex_loop
  apply loop.spec_decr_nat (fun (_, j) => id.length - j.val)
    (fun (o, j) => j.val ≤ id.length ∧
      (o && (id.val.drop j.val).all (fun c => isHexN c.val)) =
      (ok1 && (id.val.drop i.val).all (fun c => isHexN c.val)))
  · rintro ⟨o, j⟩ ⟨hj, hinv⟩
    unfold body.all_lower_hex_loop.body
    simp only [lowhex]; simp only [ite_ok]
    step*
    · have hlt : j.val < id.length := by scalar_tac
      have hdrop : id.val.drop j.val = c :: id.val.drop (j.val+1) := by
        rw [c_post]; exact List.drop_eq_getElem_cons hlt
      refine ⟨by scalar_tac, ?_, by scalar_tac⟩
      rw [← hinv, hdrop]
      simp only [i2_post, List.all_cons]
      generalize isHexN c.val = h; generalize (List.drop (j.val + 1) id.val).all (fun c => isHexN c.val) = t
      cases h <;> cases o <;> simp
    · have : id.length ≤ j.val := by scalar_tac
      rw [← hinv, List.drop_eq_nil_of_le this]; simp
  · exact ⟨hi, rfl⟩

def statusN (s : types.Seat) : Nat :=
  match s.delivered with
  | none => 0
  | some id => if id.length ≠ 64 then 1 else if id.val.all (fun c => isHexN c.val) then 0 else 2

@[step]
theorem seat_id_status_spec (s : types.Seat) :
    body.seat_id_status s ⦃ r => r.val = statusN s ⦄ := by
  unfold body.seat_id_status statusN
  rcases h : s.delivered with _ | id
  · simp
  · simp only
    unfold body.all_lower_hex
    step*
    all_goals simp_all

/-! Rules 5 and 6: the counting loop as a pure function of (count, status, remaining seats). -/
def cdF : Nat → Nat → List types.Seat → Nat × Nat
  | d, st, [] => (d, st)
  | d, st, s :: r =>
    if st = 0 then
      if statusN s ≠ 0 then cdF d (statusN s) r
      else if s.delivered.isSome then
        (if d + 1 < 2 ^ 32 then cdF (d + 1) 0 r else cdF d 3 r)
      else cdF d 0 r
    else cdF d st r

@[step]
theorem count_delivered_loop_spec (seats : alloc.vec.Vec types.Seat) (d : Std.U32) (st : Std.U8)
    (i : Std.Usize) (hi : i.val ≤ seats.length) :
    body.count_delivered_loop seats d st i ⦃ r =>
      (r.1.val, r.2.val) = cdF d.val st.val (seats.val.drop i.val) ⦄ := by
  unfold body.count_delivered_loop
  apply loop.spec_decr_nat (fun (_, _, j) => seats.length - j.val)
    (fun (dd, ss, j) => j.val ≤ seats.length ∧
      cdF dd.val ss.val (seats.val.drop j.val) = cdF d.val st.val (seats.val.drop i.val))
  · rintro ⟨dd, ss, j⟩ ⟨hj, hinv⟩
    unfold body.count_delivered_loop.body
    simp only
    by_cases hlt : j < seats.len
    · simp only [hlt, ↓reduceIte]
      have hjl : j.val < seats.val.length := by scalar_tac
      have hd : seats.val.drop j.val = seats.val[j.val] :: seats.val.drop (j.val + 1) :=
        List.drop_eq_getElem_cons hjl
      by_cases hss : ss = 0#u8
      · have hss' : ss.val = 0 := by simp [hss]
        simp only [hss, ↓reduceIte]
        step as ⟨sx, sx_post⟩
        step as ⟨x, x_post⟩
        by_cases hx : (x != 0#u8) = true
        · have hx' : statusN sx ≠ 0 := by
            rw [← x_post]; intro h; apply bne_iff_ne.mp hx; exact (UScalar.eq_equiv _ _).mpr (by simpa using h)
          simp only [hx, ↓reduceIte, bind_tc_ok]
          step*
          refine ⟨by scalar_tac, ?_, by scalar_tac⟩
          rw [← hinv, i2_post, hd, ← sx_post, hss']
          simp [cdF, hx', x_post]
        · have hx' : statusN sx = 0 := by
            rw [← x_post]; have := bne_iff_ne.not.mp hx; simp at this; simp [this]
          simp only [hx, ↓reduceIte, Bool.false_eq_true]
          by_cases hs : sx.delivered.isSome = true
          · simp only [hs, ↓reduceIte]
            step as ⟨o, o_post⟩
            have hmax : U32.max = 2 ^ 32 - 1 := by simp [U32.max_eq]
            cases o with
            | none =>
              simp only at o_post
              simp only
              step*
              refine ⟨by scalar_tac, ?_, by scalar_tac⟩
              rw [← hinv, i2_post, hd, ← sx_post, hss']
              have : ¬ dd.val + 1 < 2 ^ 32 := by omega
              simp [cdF, hx', hs]; intro h; omega
            | some z =>
              simp only at o_post
              simp only
              step*
              refine ⟨by scalar_tac, ?_, by scalar_tac⟩
              rw [← hinv, i2_post, hd, ← sx_post, hss']
              have : dd.val + 1 < 2 ^ 32 := by omega
              simp [cdF, hx', hs, o_post.2.1]; intro h; omega
          · simp only [hs, ↓reduceIte, Bool.false_eq_true, bind_tc_ok]
            step*
            refine ⟨by scalar_tac, ?_, by scalar_tac⟩
            rw [← hinv, i2_post, hd, ← sx_post, hss']
            simp [cdF, hx', hs]
      · have hss' : ss.val ≠ 0 := by intro h; exact hss ((UScalar.eq_equiv _ _).mpr (by simpa using h))
        simp only [hss, ↓reduceIte, bind_tc_ok]
        step*
        refine ⟨by scalar_tac, ?_, by scalar_tac⟩
        rw [← hinv, i2_post, hd]
        simp [cdF, hss']
    · simp only [hlt, ↓reduceIte, spec_ok]
      rw [← hinv, List.drop_eq_nil_of_le (by scalar_tac)]; simp [cdF]
  · exact ⟨hi, rfl⟩

end GapAeneas
