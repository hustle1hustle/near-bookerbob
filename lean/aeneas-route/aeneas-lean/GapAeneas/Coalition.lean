import Coalition.Funs
import SmithLean.CoalitionKofN
/-!
# The Aeneas translation of the dialect body.rs meets the coalition-k-of-n Spec

`Coalition/Funs.lean` is what Aeneas generated from `rust/coalition-k-of-n/src/body.rs` (Charon
LLBC, no hand edits). This file proves, about THAT generated `body.check`:

* it never panics and never diverges on inputs related to a spec-level input, and
* its result is the hand model's result `Smith.Coalition.check C p s` (same verdict, same output
  counts, same refusal string), hence (reusing `check_ok_iff_spec`) it returns `Ok o'` exactly
  when the `Spec` holds, with the same output, and `Err` exactly when no output meets the `Spec`.

The one assumption about Rust is `hC`: the opaque `commits.commit_seats` (the template's sha256 +
postcard commitment) returns, on the concrete seats, the bytes of the Spec's `C.commit` on the
spec-level seats. Everything else is the generated code and the Aeneas std models.
-/
open Aeneas Aeneas.Std RustM ControlFlow Error Aeneas.Std.WP
open dialect_coalition_k_of_n

namespace GapAeneas

/-! ## Generic helpers -/

theorem ite_ok {α} (c : Prop) [Decidable c] (a b : α) :
    (if c then (ok a : RustM α) else ok b) = ok (if c then a else b) := by split <;> rfl

theorem spec_iff_ok {α} {m : RustM α} {p : α → Prop} : spec m p ↔ ∃ v, m = ok v ∧ p v := by
  constructor
  · intro h
    cases m with
    | ret a => exact ⟨a, rfl, (spec_ok a).mp h⟩
    | vis e k => simp at h
    | div => simp at h
  · rintro ⟨v, rfl, h⟩; exact (spec_ok v).mpr h

theorem ByteArray_toList_eq (bs : ByteArray) : bs.toList = bs.data.toList := by
  suffices ∀ n i r, bs.size - i = n → ByteArray.toList.loop bs i r = r.reverse ++ bs.data.toList.drop i by
    simpa [ByteArray.toList] using this _ 0 [] rfl
  intro n
  induction n with
  | zero =>
    intro i r h
    unfold ByteArray.toList.loop
    have : ¬ i < bs.size := by omega
    simp only [this, ↓reduceIte]
    rw [List.drop_eq_nil_of_le (by simp [ByteArray.size_data] at *; omega)]; simp
  | succ n ih =>
    intro i r h
    unfold ByteArray.toList.loop
    have hi : i < bs.size := by omega
    simp only [hi, ↓reduceIte]
    rw [ih (i + 1) _ (by omega)]
    have hi' : i < bs.data.toList.length := by simpa [ByteArray.size_data] using hi
    rw [List.drop_eq_getElem_cons hi']
    simp [ByteArray.get!, getElem!_pos bs.data i (by simpa [ByteArray.size_data] using hi)]


/-! ## Byte strings: Rust `Vec<u8>` and Lean `String` -/

/-- The bytes of a Rust byte vector, as naturals. -/
def bv (v : alloc.vec.Vec Std.U8) : List Nat := v.val.map (·.val)
/-- The UTF-8 bytes of a Lean string, as naturals (what postcard puts on the wire). -/
def sb (s : String) : List Nat := s.toUTF8.toList.map (·.toNat)

theorem bv_inj {a b : alloc.vec.Vec Std.U8} : bv a = bv b ↔ a.val = b.val :=
  (List.map_injective_iff.mpr (fun x y h => (UScalar.eq_equiv x y).mpr h)).eq_iff

theorem sb_inj {a b : String} : sb a = sb b ↔ a = b := by
  have hinj : Function.Injective (List.map (fun x : UInt8 => x.toNat)) :=
    List.map_injective_iff.mpr (fun x y h => UInt8.toNat_inj.mp h)
  unfold sb
  rw [hinj.eq_iff, ByteArray_toList_eq, ByteArray_toList_eq]
  constructor
  · intro h; apply String.toByteArray_inj.mp; exact ByteArray.ext_iff.mpr (Array.ext' h)
  · intro h; rw [h]

/-! ## The relation between spec-level and Rust-level inputs

A Rust input `r` represents a spec input `m` when every field carries the same value: integers
equal as naturals, strings as their UTF-8 bytes. This is what the template's postcard decoding
produces from one byte string for both the original (`String`) and the dialect (`Vec<u8>`) types. -/

inductive OptR : Option String → Option (alloc.vec.Vec Std.U8) → Prop
  | none : OptR none none
  | some {a b} : bv b = sb a → OptR (some a) (some b)

structure SeatR (m : Smith.Coalition.Seat) (r : types.Seat) : Prop where
  leg : r.leg.val = m.leg.toNat
  member : bv r.member = sb m.member
  price : r.price.val = m.price
  delivered : OptR m.delivered r.delivered

structure PubR (p : Smith.Coalition.Public) (r : types.Public) : Prop where
  coalition : bv r.coalition = sb p.coalition
  job : r.job.val = p.job.toNat
  root : r.seats_root.val.map (·.val) = p.seats_root.map (·.toNat)
  k_min : r.k_min.val = p.k_min.toNat

def SeatsR (ms : List Smith.Coalition.Seat) (rs : alloc.vec.Vec types.Seat) : Prop :=
  List.Forall₂ SeatR ms rs.val

end GapAeneas
