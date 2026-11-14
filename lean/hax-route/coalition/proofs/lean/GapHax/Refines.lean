import HaxCoalition
import GapHaxSpec.CoalitionKofN
open CoreModels Aeneas
open Aeneas.Std hiding namespace core alloc
open RustM ControlFlow Error
open hax_coalition

namespace GapHax

abbrev SIter (T : Type) := core.slice.iter.Iter T
def ival {T : Type} (it : SIter T) : List T := Slice.val (show Slice T from it)

theorem iter_next_nil {T : Type} (it : SIter T) (h : ival it = []) :
    core.slice.iter.Iter.Insts.CoreIterTraitsIteratorIteratorSharedAT.next it
      = ok (core.option.Option.None, it) := by
  unfold core.slice.iter.Iter.Insts.CoreIterTraitsIteratorIteratorSharedAT.next
  simp [rust_primitives.sequence.seq_len]
  intro hne; exact absurd h hne

theorem iter_next_cons {T : Type} (it : SIter T) (a : T) (l : List T) (h : ival it = a :: l) :
    ∃ it' : SIter T, ival it' = l ∧
    core.slice.iter.Iter.Insts.CoreIterTraitsIteratorIteratorSharedAT.next it
      = ok (core.option.Option.Some a, it') := by
  unfold core.slice.iter.Iter.Insts.CoreIterTraitsIteratorIteratorSharedAT.next
  have hv : (↑(show Slice T from it) : List T) = a :: l := h
  have hlen : Slice.len (show Slice T from it) ≠ 0#usize := by
    intro h0
    have := congrArg UScalar.val h0
    rw [Slice.len_val] at this
    simp [Slice.length, hv] at this
  refine ⟨Slice.from l ?_, ?_, ?_⟩
  · have := Slice.length_ineq (show Slice T from it); rw [hv] at this; simp at this; omega
  · simp [ival]
  · simp [rust_primitives.sequence.seq_len, rust_primitives.sequence.seq_remove, hlen, hv]; rfl


/-- Rust's `(c >= b'0' && c <= b'9') || (c >= b'a' && c <= b'f')` on a U8. -/
def hexU8 (c : Std.U8) : Bool := (48 ≤ c.val && c.val ≤ 57) || (97 ≤ c.val && c.val ≤ 102)

theorem all_lower_hex_loop_spec (it : SIter Std.U8) (acc : Bool) :
    body.all_lower_hex_loop it acc ⦃ b => b = (acc && (ival it).all hexU8) ⦄ := by
  unfold body.all_lower_hex_loop
  apply loop.spec_decr_nat (fun x => (ival x.1).length)
    (fun x => (x.2 && (ival x.1).all hexU8) = (acc && (ival it).all hexU8))
  · rintro ⟨it', acc'⟩ hinv
    simp only at hinv
    unfold body.all_lower_hex_loop.body
    dsimp only
    cases hl : ival it' with
    | nil =>
      rw [iter_next_nil it' hl]
      simp [WP.spec_ok, hl] at hinv ⊢
      exact hinv
    | cons a l =>
      obtain ⟨it2, h2, hn⟩ := iter_next_cons it' a l hl
      rw [hn]
      simp only [bind_ok]
      have hg48 : (a ≥ 48#u8) ↔ 48 ≤ a.val := by scalar_tac
      have hl57 : (a ≤ 57#u8) ↔ a.val ≤ 57 := by scalar_tac
      have hg97 : (a ≥ 97#u8) ↔ 97 ≤ a.val := by scalar_tac
      have hl102 : (a ≤ 102#u8) ↔ a.val ≤ 102 := by scalar_tac
      rw [hl] at hinv
      by_cases c1 : 48 ≤ a.val <;> by_cases c2 : a.val ≤ 57 <;> by_cases c3 : 97 ≤ a.val <;>
        by_cases c4 : a.val ≤ 102 <;>
        simp [hg48, hl57, hg97, hl102, c1, c2, c3, c4, WP.spec_ok, hexU8, h2, ← hinv] <;> omega
  · rfl

theorem spec_exists_ok {α : Type} {m : RustM α} {p : WP.Post α} (h : m ⦃ p ⦄) :
    ∃ v, m = ok v ∧ p v := by
  cases m with
  | ret a => exact ⟨a, rfl, by simpa [WP.spec_ok] using h⟩
  | vis i k => exact absurd h (by simp [WP.spec_vis])
  | div => exact absurd h (by simpa using (WP.spec_div (p := p)).mp)

theorem ps_ok {α : Type} {x : RustM α} {P : α → Prop} {F : Error → Prop} {D : Prop}
    (h : WP.partialSpec x P F D) (hF : ∀ e, ¬ F e) (hD : ¬ D) : ∃ a, x = ok a ∧ P a := by
  cases x with
  | ret a => exact ⟨a, rfl, by simpa [WP.partialSpec] using h⟩
  | vis i k => cases i <;> simp_all [WP.partialSpec]
  | div => simp_all [WP.partialSpec]

theorem usize_add_one (x : Usize) (h : x.val + 1 ≤ Usize.max) :
    ∃ c : Usize, c.val = x.val + 1 ∧ x + 1#usize = ok c := by
  obtain ⟨c, hc1, hc2⟩ := ps_ok (@UScalar.add_spec _ x 1#usize)
    (by intro e; cases e <;> simp [UScalar.max_USize_eq] <;> scalar_tac) (by simp)
  exact ⟨c, by simpa using hc2, hc1⟩

abbrev EIter (T : Type) := core.iter.adapters.enumerate.Enumerate (SIter T)

theorem enum_next_nil {T : Type} (e : EIter T) (h : ival e.iter = []) :
    core.iter.adapters.enumerate.Enumerate.Insts.CoreIterTraitsIteratorIteratorPairUsizeClause0_Item.next
      (core.slice.iter.Iter.Insts.CoreIterTraitsIteratorIteratorSharedAT T) e
      = ok (core.option.Option.None, { iter := e.iter, count := e.count }) := by
  unfold core.iter.adapters.enumerate.Enumerate.Insts.CoreIterTraitsIteratorIteratorPairUsizeClause0_Item.next
  simp [core.slice.iter.Iter.Insts.CoreIterTraitsIteratorIteratorSharedAT, iter_next_nil _ h]

theorem enum_next_cons {T : Type} (e : EIter T) (a : T) (l : List T) (h : ival e.iter = a :: l)
    (hb : e.count.val + 1 ≤ Usize.max) :
    ∃ e' : EIter T, ival e'.iter = l ∧ e'.count.val = e.count.val + 1 ∧
    core.iter.adapters.enumerate.Enumerate.Insts.CoreIterTraitsIteratorIteratorPairUsizeClause0_Item.next
      (core.slice.iter.Iter.Insts.CoreIterTraitsIteratorIteratorSharedAT T) e
      = ok (core.option.Option.Some (e.count, a), e') := by
  obtain ⟨it', h1, h2⟩ := iter_next_cons e.iter a l h
  obtain ⟨c, hc, hc'⟩ := usize_add_one e.count hb
  refine ⟨{ iter := it', count := c }, h1, hc, ?_⟩
  unfold core.iter.adapters.enumerate.Enumerate.Insts.CoreIterTraitsIteratorIteratorPairUsizeClause0_Item.next
  simp [core.slice.iter.Iter.Insts.CoreIterTraitsIteratorIteratorSharedAT, h2, hc']

def legsOK : List types.Seat → Nat → Bool
  | [], _ => true
  | a :: r, k => (a.leg.val == k) && legsOK r (k + 1)

@[simp high] theorem cast_u32_usize (x : Std.U32) : (UScalar.cast .Usize x).val = x.val := by
  have hx : x.val < 2 ^ 32 := by scalar_tac
  simp only [UScalar.cast_val_eq, UScalarTy.Usize_numBits_eq]
  rcases System.Platform.numBits_eq with h | h <;> rw [h] <;> omega

theorem legs_loop_spec (e : EIter types.Seat) (hb : e.count.val + (ival e.iter).length ≤ Usize.max) :
    body.legs_sequential_loop e ⦃ r => r = (if legsOK (ival e.iter) e.count.val
        then core.result.Result.Ok () else core.result.Result.Err (toStr "seat legs not sequential")) ⦄ := by
  unfold body.legs_sequential_loop
  apply loop.spec_decr_nat (fun x => (ival x.iter).length)
    (fun x => x.count.val + (ival x.iter).length ≤ Usize.max ∧
      legsOK (ival x.iter) x.count.val = legsOK (ival e.iter) e.count.val)
  · intro x ⟨hxb, hinv⟩
    unfold body.legs_sequential_loop.body
    cases hl : ival x.iter with
    | nil =>
      rw [enum_next_nil x hl]
      simp [WP.spec_ok, hl, legsOK] at hinv ⊢
      simp [← hinv]
    | cons a l =>
      rw [hl] at hxb hinv
      obtain ⟨x', h1, h2, hn⟩ := enum_next_cons x a l hl (by simp at hxb; omega)
      rw [hn]
      simp only [bind_ok, lift]
      by_cases hk : a.leg.val = x.count.val
      · simp [hk, WP.spec_ok, h1, h2, legsOK] at hinv hxb ⊢
        exact ⟨by omega, hinv⟩
      · simp [hk, WP.spec_ok, legsOK] at hinv ⊢
        rw [← hinv]; simp [hk]
  · exact ⟨hb, rfl⟩

/-- The identity `Slice T → Iter T` (an `Iter` IS a `Seq` IS a `Slice` in CoreModels), as a
function so terms stay well-typed at reducible transparency. -/
def toIter {T : Type} (s : Slice T) : SIter T := s
@[simp] theorem ival_toIter {T : Type} (s : Slice T) : ival (toIter s) = s.val := rfl
@[simp] theorem val_toIter {T : Type} (s : Slice T) : Slice.val (toIter s) = s.val := rfl

theorem slice_iter_eq {T : Type} (sl : Slice T) :
    core.slice.Slice.iter sl = ok (toIter sl) := by
  unfold core.slice.Slice.iter rust_primitives.sequence.seq_from_slice
  exact Std.bind_ok (α := rust_primitives.sequence.Seq T) sl ok


theorem legs_spec (sl : Slice types.Seat) :
    body.legs_sequential sl ⦃ r => r = (if legsOK sl.val 0
        then core.result.Result.Ok () else core.result.Result.Err (toStr "seat legs not sequential")) ⦄ := by
  unfold body.legs_sequential
  rw [slice_iter_eq]
  simp only [bind_tc_ok, core.iter.traits.iterator.Iterator.enumerate.default,
    core.iter.adapters.enumerate.Enumerate.new]
  have := legs_loop_spec ({ iter := toIter sl, count := 0#usize } : EIter types.Seat)
    (by simp [ival])
  simpa [ival] using this

abbrev TIter (T : Type) := core.iter.adapters.take.Take (SIter T)

theorem usize_sub_one (x : Usize) (h : x.val ≠ 0) :
    ∃ c : Usize, c.val = x.val - 1 ∧ x - 1#usize = ok c := by
  obtain ⟨c, hc1, hc2⟩ := ps_ok (@UScalar.sub_spec _ x 1#usize)
    (by intro e; cases e <;> simp <;> omega) (by simp)
  exact ⟨c, by simp at hc2; omega, hc1⟩

theorem take_next {T : Type} (t : TIter T) :
    (t.n.val = 0 ∧ core.iter.adapters.take.Take.Insts.CoreIterTraitsIteratorIterator.next
      (core.slice.iter.Iter.Insts.CoreIterTraitsIteratorIteratorSharedAT T) t
      = ok (core.option.Option.None, t)) ∨
    (t.n.val ≠ 0 ∧ ival t.iter = [] ∧ ∃ t' : TIter T, t'.n.val = t.n.val - 1 ∧ ival t'.iter = [] ∧
      core.iter.adapters.take.Take.Insts.CoreIterTraitsIteratorIterator.next
      (core.slice.iter.Iter.Insts.CoreIterTraitsIteratorIteratorSharedAT T) t
      = ok (core.option.Option.None, t')) ∨
    (∃ a l, t.n.val ≠ 0 ∧ ival t.iter = a :: l ∧ ∃ t' : TIter T, t'.n.val = t.n.val - 1 ∧ ival t'.iter = l ∧
      core.iter.adapters.take.Take.Insts.CoreIterTraitsIteratorIterator.next
      (core.slice.iter.Iter.Insts.CoreIterTraitsIteratorIteratorSharedAT T) t
      = ok (core.option.Option.Some a, t')) := by
  unfold core.iter.adapters.take.Take.Insts.CoreIterTraitsIteratorIterator.next
  by_cases hn : t.n.val = 0
  · left
    have : t.n = 0#usize := by apply UScalar.eq_of_val_eq; simpa using hn
    exact ⟨hn, by simp [this]⟩
  · right
    have hne : (t.n != 0#usize) = true := by simp; intro h; apply hn; simp [h]
    obtain ⟨c, hc, hc'⟩ := usize_sub_one t.n hn
    cases hl : ival t.iter with
    | nil =>
      left
      refine ⟨hn, rfl, { iter := t.iter, n := c }, hc, hl, ?_⟩
      simp [hne, hc', core.slice.iter.Iter.Insts.CoreIterTraitsIteratorIteratorSharedAT, iter_next_nil _ hl]
    | cons a l =>
      right
      obtain ⟨it', h1, h2⟩ := iter_next_cons t.iter a l hl
      refine ⟨a, l, hn, rfl, { iter := it', n := c }, hc, h1, ?_⟩
      simp [hne, hc', core.slice.iter.Iter.Insts.CoreIterTraitsIteratorIteratorSharedAT, h2]

/-- String equality as the model defines it (`alloc.string.String` is `String`). -/
def sEq (x y : alloc.string.String) : Bool := decide ((show String from x) = (show String from y))

def anyMem (a : types.Seat) (l : List types.Seat) : Bool := l.any (fun b => sEq a.member b.member)

theorem same_member_eq (a b : types.Seat) :
    body.same_member a b = ok (sEq a.member b.member) := by
  simp [body.same_member, CoreModels.alloc.string.String.Insts.CoreCmpPartialEqString.eq, sEq]

theorem inner_loop_spec (a : types.Seat) (t : TIter types.Seat) (dup : Bool) :
    body.no_duplicate_member_loop0_loop0 t dup a ⦃ r =>
      r = (dup || anyMem a ((ival t.iter).take t.n.val)) ⦄ := by
  unfold body.no_duplicate_member_loop0_loop0
  apply loop.spec_decr_nat (fun x => x.1.n.val)
    (fun x => (x.2 || anyMem a ((ival x.1.iter).take x.1.n.val)) =
      (dup || anyMem a ((ival t.iter).take t.n.val)))
  · rintro ⟨t', d'⟩ hinv
    simp only at hinv
    unfold body.no_duplicate_member_loop0_loop0.body
    dsimp only
    rcases take_next t' with ⟨h0, hn⟩ | ⟨h0, hl, t2, h1, h2, hn⟩ | ⟨b, l, h0, hl, t2, h1, h2, hn⟩
    · rw [hn]; simp [WP.spec_ok, h0, anyMem] at hinv ⊢; simpa [anyMem] using hinv
    · rw [hn]; simp [WP.spec_ok, hl, anyMem] at hinv ⊢; simpa [anyMem] using hinv
    · rw [hn]
      simp only [bind_tc_ok, same_member_eq]
      have htake : (ival t'.iter).take t'.n.val = b :: l.take (t'.n.val - 1) := by
        rw [hl]; obtain ⟨m, hm⟩ : ∃ m, t'.n.val = m + 1 := ⟨t'.n.val - 1, by omega⟩
        rw [hm]; simp
      rw [htake] at hinv
      have hlt : t2.n.val < t'.n.val := by omega
      by_cases hs : sEq a.member b.member = true <;> cases d' <;>
        simp_all [WP.spec_ok, anyMem]
  · rfl

def dupScan (all : List types.Seat) : List types.Seat → Nat → Bool
  | [], _ => false
  | a :: r, k => anyMem a (all.take k) || dupScan all r (k + 1)

theorem outer_loop_spec (sl : Slice types.Seat) (e : EIter types.Seat) (dup : Bool)
    (hb : e.count.val + (ival e.iter).length ≤ Usize.max) :
    body.no_duplicate_member_loop0 e sl dup ⦃ r =>
      r = (dup || dupScan sl.val (ival e.iter) e.count.val) ⦄ := by
  unfold body.no_duplicate_member_loop0
  apply loop.spec_decr_nat (fun x => (ival x.1.iter).length)
    (fun x => x.1.count.val + (ival x.1.iter).length ≤ Usize.max ∧
      (x.2 || dupScan sl.val (ival x.1.iter) x.1.count.val) =
      (dup || dupScan sl.val (ival e.iter) e.count.val))
  · rintro ⟨e', d'⟩ ⟨hxb, hinv⟩
    simp only at hxb hinv
    unfold body.no_duplicate_member_loop0.body
    dsimp only
    cases hl : ival e'.iter with
    | nil =>
      rw [enum_next_nil e' hl]
      simp [WP.spec_ok, hl, dupScan] at hinv ⊢; exact hinv
    | cons a l =>
      rw [hl] at hxb hinv
      obtain ⟨e2, h1, h2, hn⟩ := enum_next_cons e' a l hl (by simp at hxb; omega)
      rw [hn]
      rw [slice_iter_eq]
      simp only [core.iter.traits.iterator.Iterator.take.default, core.iter.adapters.take.Take.new,
        bind_ok]
      apply WP.spec_bind (inner_loop_spec a { iter := toIter sl, n := e'.count } d')
      intro d2 hd2
      simp [WP.spec_ok, h1, h2] at hd2 hxb hinv ⊢
      refine ⟨by omega, ?_⟩
      rw [hd2, ← hinv]; simp [dupScan, ival, Bool.or_assoc]
  · exact ⟨hb, rfl⟩

theorem no_dup_spec (sl : Slice types.Seat) :
    body.no_duplicate_member sl ⦃ r => r = (if dupScan sl.val sl.val 0
        then core.result.Result.Err (toStr "duplicate member") else core.result.Result.Ok ()) ⦄ := by
  unfold body.no_duplicate_member
  rw [slice_iter_eq]
  simp only [bind_tc_ok, core.iter.traits.iterator.Iterator.enumerate.default,
    core.iter.adapters.enumerate.Enumerate.new]
  simp only [bind_ok]
  apply WP.spec_bind (outer_loop_spec sl { iter := toIter sl, count := 0#usize } false (by simp [ival]))
  intro d hd
  simp [ival] at hd
  subst hd
  cases dupScan sl.val sl.val 0 <;> simp [WP.spec_ok]

/-- The UTF-8 bytes of a string, as the `as_bytes` model builds them. -/
def bytesOf (s : alloc.string.String) : List Std.U8 :=
  (show String from s).toByteArray.toList.map
    (fun x => ⟨ x.toNat, by cases x; simp only [UInt8.toNat_ofBitVec, UScalarTy.U8_numBits_eq, Nat.reducePow]; omega ⟩)

/-- Rust type invariant: a `String` fits in `usize` bytes. -/
abbrev Fits (s : alloc.string.String) : Prop := (bytesOf s).length ≤ Usize.max

theorem as_bytes_eq (s : alloc.string.String) (h : Fits s) :
    alloc.string.String.as_bytes s = ok (Slice.from (bytesOf s) h) := by
  show (if h' : (bytesOf s).length ≤ Usize.max then ok (Slice.from (bytesOf s) h')
    else fail .panic) = _
  rw [dif_pos h]

theorem checked_add_one_ok (d : Std.U32) (h : d.val + 1 < 2 ^ 32) :
    ∃ c : Std.U32, c.val = d.val + 1 ∧
      core.num.U32.checked_add d 1#u32 = ok (core.option.Option.Some c) := by
  have := UScalar.overflowing_add_eq d 1#u32
  simp only [UScalar.max] at this
  rw [if_neg (by simp; scalar_tac)] at this
  refine ⟨(UScalar.overflowing_add d 1#u32).1, by simpa using this.1, ?_⟩
  simp only [core.num.U32.checked_add, core.num.U32.overflowing_add,
    rust_primitives.arithmetic.overflowing_add_u32, bind_ok]
  generalize hz : UScalar.overflowing_add d 1#u32 = z at this ⊢
  obtain ⟨r, o⟩ := z
  simp_all

theorem checked_add_one_none (d : Std.U32) (h : ¬ d.val + 1 < 2 ^ 32) :
    core.num.U32.checked_add d 1#u32 = ok core.option.Option.None := by
  have := UScalar.overflowing_add_eq d 1#u32
  simp only [UScalar.max] at this
  rw [if_pos (by simp; scalar_tac)] at this
  simp only [core.num.U32.checked_add, core.num.U32.overflowing_add,
    rust_primitives.arithmetic.overflowing_add_u32, bind_ok]
  generalize hz : UScalar.overflowing_add d 1#u32 = z at this ⊢
  obtain ⟨r, o⟩ := z
  simp_all

theorem all_lower_hex_spec (l : List Std.U8) (h : l.length ≤ Usize.max) :
    body.all_lower_hex (Slice.from l h) ⦃ b => b = l.all hexU8 ⦄ := by
  unfold body.all_lower_hex
  rw [slice_iter_eq]
  simp only [bind_ok]
  have := all_lower_hex_loop_spec (toIter (Slice.from l h)) true
  simpa [Slice.val_from] using this

def cnt : List types.Seat → Nat → Option Nat
  | [], acc => some acc
  | s :: r, acc =>
    match s.delivered with
    | none => cnt r acc
    | some id =>
      if (bytesOf id).length ≠ 64 then none
      else if !((bytesOf id).all hexU8) then none
      else if acc + 1 < 2 ^ 32 then cnt r (acc + 1) else none

def relC : core.result.Result Std.U32 Str → Option Nat → Prop
  | core.result.Result.Ok d, some n => d.val = n
  | core.result.Result.Err _, none => True
  | _, _ => False

def AllFit (l : List types.Seat) : Prop := ∀ s ∈ l, ∀ id, s.delivered = some id → Fits id

theorem count_loop_spec (it : SIter types.Seat) (d : Std.U32) (hf : AllFit (ival it)) :
    body.count_delivered_loop it d ⦃ r => relC r (cnt (ival it) d.val) ⦄ := by
  unfold body.count_delivered_loop
  apply loop.spec_decr_nat (fun x => (ival x.1).length)
    (fun x => AllFit (ival x.1) ∧ cnt (ival x.1) x.2.val = cnt (ival it) d.val)
  · rintro ⟨it', d'⟩ ⟨hf', hinv⟩
    simp only at hf' hinv
    unfold body.count_delivered_loop.body
    dsimp only
    cases hl : ival it' with
    | nil =>
      rw [iter_next_nil it' hl]
      simp [WP.spec_ok, hl, cnt] at hinv ⊢
      simp [← hinv, relC]
    | cons a l =>
      rw [hl] at hf' hinv
      obtain ⟨it2, h2, hn⟩ := iter_next_cons it' a l hl
      rw [hn]
      simp only [bind_ok]
      have hfl : AllFit l := fun s hs => hf' s (List.mem_cons_of_mem _ hs)
      cases hd : a.delivered with
      | none =>
        simp [hd, WP.spec_ok, h2, hfl]
        simp [cnt, hd] at hinv; exact hinv
      | some id =>
        have hfit : Fits id := hf' a List.mem_cons_self id hd
        simp [hd, as_bytes_eq id hfit, core.slice.Slice.len, rust_primitives.slice.slice_length]
        have hc : cnt (a :: l) d'.val = (if (bytesOf id).length ≠ 64 then none
            else if !((bytesOf id).all hexU8) then none
            else if d'.val + 1 < 2 ^ 32 then cnt l (d'.val + 1) else none) := by
          simp [cnt, hd]
        rw [hc] at hinv
        by_cases h64 : (bytesOf id).length = 64
        · rw [if_pos h64]
          apply WP.spec_bind (all_lower_hex_spec (bytesOf id) hfit)
          intro b hb; subst hb
          by_cases hx : (bytesOf id).all hexU8 = true
          · rw [if_pos hx]
            by_cases hov : d'.val + 1 < 4294967296
            · obtain ⟨c, hcv, hca⟩ := checked_add_one_ok d' hov
              rw [hca]
              simp [WP.spec_ok, h2, hfl, hcv]
              simp [h64, hx, hov] at hinv; exact hinv
            · rw [checked_add_one_none d' hov]
              simp [WP.spec_ok]
              simp [h64, hx, hov] at hinv; simp [← hinv, relC]
          · rw [if_neg hx]
            simp [WP.spec_ok]
            simp [h64, hx] at hinv; simp [← hinv, relC]
        · rw [if_neg h64]
          simp [WP.spec_ok]
          simp [h64] at hinv; simp [← hinv, relC]
  · exact ⟨hf, rfl⟩

theorem count_spec (sl : Slice types.Seat) (hf : AllFit sl.val) :
    body.count_delivered sl ⦃ r => relC r (cnt sl.val 0) ⦄ := by
  unfold body.count_delivered
  rw [slice_iter_eq]
  simp only [bind_ok]
  simpa using count_loop_spec (toIter sl) 0#u32 (by simpa using hf)

theorem arr_index {N : Usize} (a : Std.Array Std.U8 N) (i : Usize) (h : i.val < N.val) :
    ∃ hi : i.val < a.val.length, rust_primitives.slice.array_index a i = ok (a.val[i.val]'hi) := by
  have hl : a.val.length = N.val := by simp
  obtain ⟨x, hx, ⟨hi, hx2⟩⟩ := ps_ok (Slice.index_usize_spec a.to_slice i)
    (by intro e; cases e <;> simp [Array.val_to_slice] <;> omega) (by simp)
  refine ⟨by omega, ?_⟩
  simp only [rust_primitives.slice.array_index, hx, hx2, Array.val_to_slice]

theorem take_succ_eq {α : Type} (l m : List α) (j : Nat) (hl : j < l.length) (hm : j < m.length)
    (ht : l.take j = m.take j) (he : l[j] = m[j]) : l.take (j + 1) = m.take (j + 1) := by
  rw [List.take_succ, List.take_succ, ht, List.getElem?_eq_getElem hl, List.getElem?_eq_getElem hm, he]

theorem arr_eq_spec {N : Usize} (a b : Std.Array Std.U8 N) :
    core.Array.Insts.CoreCmpPartialEqArray.eq core.U8.Insts.CoreCmpPartialEqU8 a b
      ⦃ r => r = decide (a.val = b.val) ⦄ := by
  have hla : a.val.length = N.val := by simp
  have hlb : b.val.length = N.val := by simp
  unfold core.Array.Insts.CoreCmpPartialEqArray.eq core.Array.Insts.CoreCmpPartialEqArray.eq_loop
  apply loop.spec_decr_nat (fun j => N.val - j.val)
    (fun j => j.val ≤ N.val ∧ a.val.take j.val = b.val.take j.val)
  · rintro j ⟨hj, ht⟩
    unfold core.Array.Insts.CoreCmpPartialEqArray.eq_loop.body
    by_cases hlt : j < N
    · have hlt' : j.val < N.val := by scalar_tac
      rw [if_pos hlt]
      obtain ⟨ha, ea⟩ := arr_index a j hlt'
      obtain ⟨hb, eb⟩ := arr_index b j hlt'
      simp only [ea, eb, bind_ok, core.U8.Insts.CoreCmpPartialEqU8]
      by_cases he : a.val[j.val] = b.val[j.val]
      · have : (a.val[j.val] == b.val[j.val]) = true := by simp [he]
        simp only [this, if_true]
        obtain ⟨c, hc, hca⟩ := usize_add_one j (by scalar_tac)
        rw [hca]
        simp only [bind_ok, WP.spec_ok]
        refine ⟨⟨by omega, ?_⟩, by omega⟩
        rw [hc]; exact take_succ_eq _ _ _ ha hb ht he
      · have : (a.val[j.val] == b.val[j.val]) = false := by simp [he]
        simp only [this, Bool.false_eq_true, ite_false, WP.spec_ok]
        have : ¬ (a.val = b.val) := by intro hab; apply he; simp [hab]
        simp [this]
    · have hge : N.val ≤ j.val := by scalar_tac
      rw [if_neg hlt]
      simp only [WP.spec_ok]
      have hjN : j.val = N.val := by omega
      rw [hjN, ← hla, List.take_length, hla, ← hlb, List.take_length] at ht
      simp [ht]
  · exact ⟨by simp, by simp⟩

theorem arr_ne_spec {N : Usize} (a b : Std.Array Std.U8 N) :
    core.Array.Insts.CoreCmpPartialEqArray.ne core.U8.Insts.CoreCmpPartialEqU8 a b
      ⦃ r => r = decide (a.val ≠ b.val) ⦄ := by
  unfold core.Array.Insts.CoreCmpPartialEqArray.ne
  apply WP.spec_bind (arr_eq_spec a b)
  intro r hr; subst hr
  simp [WP.spec_ok]

/-- The identity `Vec T → Slice T` (CoreModels: `Vec = Seq = Slice`), as a function. -/
def toSl {T : Type} (v : alloc.vec.Vec T) : Slice T := v

def seatsL (s : types.Private) : List types.Seat := (toSl s.seats).val

def checkPure (root : List Std.U8) (p : types.Public) (s : types.Private) : Option (Nat × Nat) :=
  if root ≠ p.seats_root.val then none
  else if (seatsL s).length < 1 ∨ (seatsL s).length > 8 then none
  else if legsOK (seatsL s) 0 = false then none
  else if dupScan (seatsL s) (seatsL s) 0 = true then none
  else match cnt (seatsL s) 0 with
    | none => none
    | some d => if d < p.k_min.val then none else some (d, (seatsL s).length)

def relO : core.result.Result types.Output Str → Option (Nat × Nat) → Prop
  | core.result.Result.Ok o, some (d, n) => o.delivered.val = d ∧ o.seats.val = n
  | core.result.Result.Err _, none => True
  | _, _ => False

@[simp] theorem blanket_from {α : Type} (x : α) : (core.convert.From.Blanket α).from x = ok x := rfl

def tag : Str := toStr "bookerbob/smith/coalition-seats/v0"

theorem check_spec (p : types.Public) (s : types.Private) (root : Std.Array Std.U8 32#usize)
    (hc : smith_std.commit tag s.seats = ok root) (hf : AllFit (seatsL s)) :
    body.check p s ⦃ r => relO r (checkPure root.val p s) ⦄ := by
  unfold body.check
  rw [show smith_std.commit (toStr "bookerbob/smith/coalition-seats/v0") s.seats = ok root from hc]
  simp only [bind_ok]
  apply WP.spec_bind (arr_ne_spec root p.seats_root)
  intro b hb; subst hb
  by_cases hr : root.val ≠ p.seats_root.val
  · simp [hr, WP.spec_ok, checkPure, relO]
  have hr' : root.val = p.seats_root.val := by simpa using hr
  have hlen : alloc.vec.Vec.len s.seats = ok (Slice.len (toSl s.seats)) := rfl
  have hder : alloc.vec.Vec.Insts.CoreOpsDerefDerefSlice.deref s.seats
      = ok (toSl s.seats) := rfl
  simp only [hr, decide_false, Bool.false_eq_true, ite_false, hlen, hder, bind_ok]
  have hL : (Slice.len (toSl s.seats)).val = (seatsL s).length := by
    simp [seatsL, Slice.len_val]
  by_cases h1 : (seatsL s).length < 1
  · have : Slice.len (toSl s.seats) < 1#usize := by scalar_tac
    simp [this, WP.spec_ok, checkPure, relO, hr', h1]
  have : ¬ Slice.len (toSl s.seats) < 1#usize := by scalar_tac
  simp only [this, if_false]
  by_cases h8 : (seatsL s).length > 8
  · have : Slice.len (toSl s.seats) > 8#usize := by scalar_tac
    simp [this, WP.spec_ok, checkPure, relO, hr', h8]
  have : ¬ Slice.len (toSl s.seats) > 8#usize := by scalar_tac
  simp only [this, if_false]
  apply WP.spec_bind (legs_spec _)
  intro r1 hr1; subst hr1
  have hL' : (toSl s.seats).val = seatsL s := rfl
  rw [hL']
  by_cases hlg : legsOK (seatsL s) 0 = true
  case neg =>
    simp [hlg, WP.spec_ok, checkPure, relO, hr', h1, h8, core.result.Result.Insts.CoreOpsTry_traitTry.branch,
      core.result.Result.Insts.CoreOpsTry_traitTryTResultInfallibleE.branch,
      core.result.Result.Insts.CoreOpsTry_traitFromResidualResultNeverE.from_residual,
      core.result.Result.Insts.CoreOpsTry_traitFromResidualResultInfallibleE.from_residual,
      blanket_from, core.convert.From.Blanket.from, bind_ok]
  simp only [hlg, ite_true, core.result.Result.Insts.CoreOpsTry_traitTry.branch,
      core.result.Result.Insts.CoreOpsTry_traitTryTResultInfallibleE.branch, bind_ok]
  apply WP.spec_bind (no_dup_spec _)
  intro r2 hr2; subst hr2
  rw [hL']
  by_cases hdp : dupScan (seatsL s) (seatsL s) 0 = true
  · simp [hdp, WP.spec_ok, checkPure, relO, hr', h1, h8, hlg, core.result.Result.Insts.CoreOpsTry_traitTry.branch,
      core.result.Result.Insts.CoreOpsTry_traitTryTResultInfallibleE.branch,
      core.result.Result.Insts.CoreOpsTry_traitFromResidualResultNeverE.from_residual,
      core.result.Result.Insts.CoreOpsTry_traitFromResidualResultInfallibleE.from_residual,
      blanket_from, core.convert.From.Blanket.from, bind_ok]
  simp only [hdp, Bool.false_eq_true, ite_false, core.result.Result.Insts.CoreOpsTry_traitTry.branch,
      core.result.Result.Insts.CoreOpsTry_traitTryTResultInfallibleE.branch, bind_ok]
  apply WP.spec_bind (count_spec _ hf)
  intro r3 hr3
  rw [hL'] at hr3
  have hpre : checkPure root.val p s = (match cnt (seatsL s) 0 with
      | none => none
      | some d => if d < p.k_min.val then none else some (d, (seatsL s).length)) := by
    simp [checkPure, hr', h1, h8, hlg, hdp]
  rw [hpre]
  revert hr3
  cases r3 with
  | Err e =>
    cases hcn : cnt (seatsL s) 0 with
    | some n => simp [relC]
    | none =>
      intro _
      simp [WP.spec_ok, relO, core.result.Result.Insts.CoreOpsTry_traitTry.branch,
        core.result.Result.Insts.CoreOpsTry_traitTryTResultInfallibleE.branch,
        core.result.Result.Insts.CoreOpsTry_traitFromResidualResultNeverE.from_residual,
        core.result.Result.Insts.CoreOpsTry_traitFromResidualResultInfallibleE.from_residual,
        blanket_from, core.convert.From.Blanket.from, bind_ok]
  | Ok d =>
    cases hcn : cnt (seatsL s) 0 with
    | none => simp [relC]
    | some n =>
      intro hdn; simp only [relC] at hdn
      simp only [core.result.Result.Insts.CoreOpsTry_traitTry.branch,
        core.result.Result.Insts.CoreOpsTry_traitTryTResultInfallibleE.branch, bind_ok]
      by_cases hk : d < p.k_min
      · have : n < p.k_min.val := by scalar_tac
        simp [hk, this, WP.spec_ok, relO]
      · have : ¬ n < p.k_min.val := by scalar_tac
        simp [hk, this, WP.spec_ok, relO, lift, hdn]
        rw [hL']; omega

/-! ## Bridge to the existing hand-written Spec (`GapHaxSpec/CoalitionKofN.lean`, a byte copy of
`lean-smith/SmithLean/CoalitionKofN.lean` with only its import line renamed). -/

def toU8 (x : Std.U8) : UInt8 := UInt8.ofNat x.val

def toSeat (x : types.Seat) : Smith.Coalition.Seat :=
  { leg := UInt32.ofNat x.leg.val, member := (show String from x.member), price := x.price.val,
    delivered := (show Option String from x.delivered) }

def toPub (p : types.Public) : Smith.Coalition.Public :=
  { coalition := (show String from p.coalition), job := UInt64.ofNat p.job.val,
    seats_root := p.seats_root.val.map toU8, k_min := UInt32.ofNat p.k_min.val }

def toPriv (s : types.Private) : Smith.Coalition.Private := { seats := (seatsL s).map toSeat }

def toOut (o : types.Output) : Smith.Coalition.Output :=
  { delivered := UInt32.ofNat o.delivered.val, seats := UInt32.ofNat o.seats.val }

theorem u32_lt (x : Std.U32) : x.val < 2 ^ 32 := by scalar_tac

theorem toNat_ofNat32 (n : Nat) (h : n < 2 ^ 32) : (UInt32.ofNat n).toNat = n := by
  have h' : n < 4294967296 := h
  simp [h']

theorem legsOK_eq (l : List types.Seat) (k : Nat) :
    legsOK l k = Smith.Coalition.legsFrom (l.map toSeat) k := by
  induction l generalizing k with
  | nil => rfl
  | cons a r ih =>
    simp only [legsOK, List.map_cons, Smith.Coalition.legsFrom, ih, toSeat,
      toNat_ofNat32 _ (u32_lt a.leg)]

theorem sEq_iff (x y : alloc.string.String) :
    sEq x y = true ↔ (show String from x) = (show String from y) := by
  simp [sEq]

theorem anyMem_eq (a : types.Seat) (pre : List types.Seat) :
    anyMem a pre = !((pre.map toSeat).all fun b => (toSeat a).member != b.member) := by
  rw [Bool.eq_iff_iff]
  have key : ∀ x y : String, ((x == y) = true) ↔ x = y :=
    fun x y => @beq_iff_eq String _ _ x y
  simp only [anyMem, List.any_eq_true, List.all_eq_true, sEq, toSeat, bne, List.all_map,
    decide_eq_true_eq, Bool.not_eq_true', Function.comp, Bool.not_eq_eq_eq_not, Bool.not_true,
    List.all_eq_false]
  constructor
  · rintro ⟨x, hx, h⟩; exact ⟨x, hx, by simpa using (key _ _).mpr h⟩
  · rintro ⟨x, hx, h⟩; exact ⟨x, hx, by simpa using (key _ _).mp (by simpa using h)⟩

theorem dupScan_eq (pre l : List types.Seat) :
    dupScan (pre ++ l) l pre.length =
      !(Smith.Coalition.noDupFrom (pre.reverse.map toSeat) (l.map toSeat)) := by
  induction l generalizing pre with
  | nil => simp [dupScan, Smith.Coalition.noDupFrom]
  | cons a r ih =>
    have h1 : (pre ++ a :: r).take pre.length = pre := by simp
    have h2 : pre ++ a :: r = (pre ++ [a]) ++ r := by simp
    have h3 := ih (pre ++ [a])
    simp only [List.length_append, List.length_singleton, List.reverse_append,
      List.reverse_singleton, List.singleton_append, List.map_cons] at h3
    simp only [dupScan, h1, List.map_cons, Smith.Coalition.noDupFrom]
    rw [h2, h3]
    rw [anyMem_eq]
    simp only [List.map_reverse, List.all_reverse]
    cases (List.map toSeat pre).all (fun b => (toSeat a).member != b.member) <;> simp

theorem bytesOf_length (s : alloc.string.String) :
    (bytesOf s).length = (show String from s).toUTF8.size := by
  simp [bytesOf, ByteArray.length_toList]; exact String.toUTF8_eq_toByteArray.symm ▸ rfl

theorem bytesOf_all (s : alloc.string.String) :
    (bytesOf s).all hexU8 = (show String from s).toUTF8.toList.all Smith.Coalition.isLowerHex := by
  simp only [bytesOf, List.all_map, String.toUTF8_eq_toByteArray]
  congr 1

theorem cnt_eq (l : List types.Seat) (acc : Nat) :
    cnt l acc = (match Smith.Coalition.countLoop (l.map toSeat) acc with
      | .ok d => some d | .error _ => none) := by
  induction l generalizing acc with
  | nil => rfl
  | cons a r ih =>
    simp only [cnt, List.map_cons, Smith.Coalition.countLoop]
    cases hd : a.delivered with
    | none => simp [toSeat, hd, ih]
    | some id =>
      have : (toSeat a).delivered = some (show String from id) := by
        simp only [toSeat]; rw [hd]; rfl
      simp only [this]
      rw [bytesOf_length, bytesOf_all]
      by_cases h64 : (show String from id).toUTF8.size = 64
      · by_cases hx : (show String from id).toUTF8.toList.all Smith.Coalition.isLowerHex = true
        · by_cases hov : acc + 1 < 4294967296
          · simp [h64, hx, hov, Smith.u32CheckedAdd, ih]
          · simp [h64, hx, hov, Smith.u32CheckedAdd]
        · simp [h64, hx]
      · simp [h64]

theorem toU8_inj (a b : List Std.U8) : a.map toU8 = b.map toU8 ↔ a = b := by
  constructor
  · intro h
    apply List.map_injective_iff.mpr _ h
    intro x y hxy
    simp only [toU8] at hxy
    have hx : x.val < 256 := by scalar_tac
    have hy : y.val < 256 := by scalar_tac
    have := congrArg UInt8.toNat hxy
    simp [UInt8.toNat_ofNat, Nat.mod_eq_of_lt hx, Nat.mod_eq_of_lt hy] at this
    exact UScalar.eq_of_val_eq this
  · rintro rfl; rfl


theorem toPriv_len (s : types.Private) : (toPriv s).seats.length = (seatsL s).length := by
  simp [toPriv]

theorem checkPure_eq (C : Smith.CommitFn (List Smith.Coalition.Seat)) (p : types.Public)
    (s : types.Private) (root : Std.Array Std.U8 32#usize)
    (hroot : root.val.map toU8 = C.commit Smith.Coalition.tag (toPriv s).seats) :
    checkPure root.val p s = (match Smith.Coalition.check C (toPub p) (toPriv s) with
      | .ok o => some (o.delivered.toNat, o.seats.toNat) | .error _ => none) := by
  have hr : (C.commit Smith.Coalition.tag (toPriv s).seats != (toPub p).seats_root) =
      decide (root.val ≠ p.seats_root.val) := by
    rw [← hroot]; simp only [toPub, bne_iff_ne, ne_eq]
    rw [Bool.eq_iff_iff]; simp [toU8_inj]
  have hlg : Smith.Coalition.legsFrom (toPriv s).seats 0 = legsOK (seatsL s) 0 := by
    simp [toPriv, legsOK_eq]
  have hdp : Smith.Coalition.noDupFrom [] (toPriv s).seats = !dupScan (seatsL s) (seatsL s) 0 := by
    have := dupScan_eq [] (seatsL s); simp at this; simp [toPriv, this]
  have hk : (toPub p).k_min.toNat = p.k_min.val := toNat_ofNat32 _ (u32_lt _)
  unfold Smith.Coalition.check checkPure
  simp only [hr, toPriv_len, hlg, hdp, hk]
  by_cases h0 : root.val ≠ p.seats_root.val
  · simp [h0]
  simp only [h0, decide_false, Bool.false_eq_true, if_false, not_false_eq_true, if_true]
  simp only [Bool.or_eq_true, decide_eq_true_eq]
  by_cases hn : (seatsL s).length < 1 ∨ (seatsL s).length > 8
  · rw [if_pos hn, if_pos hn]
  rw [if_neg hn, if_neg hn]
  by_cases hl : legsOK (seatsL s) 0 = false
  · simp [hl]
  simp only [hl, if_false, Bool.not_eq_true', Bool.false_eq_true]
  by_cases hd : dupScan (seatsL s) (seatsL s) 0 = true
  · simp [hd]
  simp only [hd, Bool.not_not, if_false, Bool.false_eq_true]
  rw [cnt_eq]
  have hseats : (toPriv s).seats = (seatsL s).map toSeat := rfl
  rw [hseats]
  cases hc : Smith.Coalition.countLoop ((seatsL s).map toSeat) 0 with
  | error e => simp
  | ok d =>
    have := (Smith.Coalition.countLoop_ok_iff _ 0 d (by norm_num)).mp hc
    have hle : Smith.Coalition.deliveredCount ((seatsL s).map toSeat) ≤ ((seatsL s).map toSeat).length :=
      List.length_filter_le _ _
    simp only [List.length_map] at hle
    have hd32 : d < 2 ^ 32 := by omega
    have hn8 : (seatsL s).length < 2 ^ 32 := by omega
    by_cases hkm : d < p.k_min.val
    · simp [hkm]
    · simp [hkm, Smith.Coalition.toNat_toUInt32_of_lt hd32, Smith.Coalition.toNat_toUInt32_of_lt hn8]


theorem output_ext (o o' : types.Output) (h1 : o.delivered.val = o'.delivered.val)
    (h2 : o.seats.val = o'.seats.val) : o = o' := by
  cases o; cases o'
  simp only at h1 h2
  rw [UScalar.eq_of_val_eq h1, UScalar.eq_of_val_eq h2]

theorem ok_inj {α : Type} {a b : α} (h : (ok a : RustM α) = ok b) : a = b := by
  simpa using h

/-- **The headline theorem.** The function hax/Aeneas extracted from the Rust `body.rs` (the
smith dialect copy, `gap-hax/coalition/src/body.rs`) returns `Ok o` exactly when the EXISTING
hand-written Spec of coalition-k-of-n holds of the translated inputs and output.

Hypotheses, each a stated trust boundary:
* `hc`: the opaque `smith_std::commit` returns `root` on this input (it is an axiom constant);
* `hroot`: that root is what the Spec's `CommitFn` gives for these seats (commit agreement);
* `hf`: every delivery id fits a `usize` (Rust `String` invariant). -/
theorem check_ok_iff_spec_rust (C : Smith.CommitFn (List Smith.Coalition.Seat))
    (p : types.Public) (s : types.Private) (o : types.Output) (root : Std.Array Std.U8 32#usize)
    (hc : smith_std.commit tag s.seats = ok root)
    (hroot : root.val.map toU8 = C.commit Smith.Coalition.tag (toPriv s).seats)
    (hf : AllFit (seatsL s)) :
    body.check p s = ok (core.result.Result.Ok o) ↔
      Smith.Coalition.Spec C (toPub p) (toPriv s) (toOut o) := by
  obtain ⟨r, hr, hrel⟩ := spec_exists_ok (check_spec p s root hc hf)
  rw [checkPure_eq C p s root hroot] at hrel
  rw [hr, ← Smith.Coalition.check_ok_iff_spec]
  constructor
  · intro h
    have := ok_inj h; subst this
    cases hm : Smith.Coalition.check C (toPub p) (toPriv s) with
    | error e => rw [hm] at hrel; simp [relO] at hrel
    | ok o' =>
      rw [hm] at hrel
      simp only [relO] at hrel
      obtain ⟨h1, h2⟩ := hrel
      congr 1
      cases o'
      simp only [toOut, Smith.Coalition.Output.mk.injEq]
      constructor <;> apply UInt32.toNat.inj <;>
        simp [toNat_ofNat32 _ (u32_lt _), h1, h2]
  · intro h
    rw [h] at hrel
    cases r with
    | Err e => simp [relO] at hrel
    | Ok o' =>
      simp only [relO, toOut] at hrel
      obtain ⟨h1, h2⟩ := hrel
      rw [toNat_ofNat32 _ (u32_lt _)] at h1 h2
      rw [output_ext o' o h1 h2]

/-- Totality: under the same hypotheses the extracted check never panics or diverges; every run
ends in `Ok` or in a refusal `Err`. -/
theorem check_total (p : types.Public) (s : types.Private) (root : Std.Array Std.U8 32#usize)
    (hc : smith_std.commit tag s.seats = ok root) (hf : AllFit (seatsL s)) :
    ∃ r, body.check p s = ok r :=
  let ⟨r, hr, _⟩ := spec_exists_ok (check_spec p s root hc hf); ⟨r, hr⟩

end GapHax
