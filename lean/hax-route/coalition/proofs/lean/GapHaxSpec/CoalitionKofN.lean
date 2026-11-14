import GapHaxSpec.Commit
/-!
# coalition-k-of-n: the spec in Lean, a Lean model of body.rs, and their agreement

Source of the spec: `zk/smith/specs/coalition-k-of-n.json`, the eight `rules`.
Source of the model: `zk/smith/programs/coalition-k-of-n/body/src/body.rs` (the model's code).

Three layers:
* `Spec p s o`: what the requester asked for, as a proposition. One clause per rule.
* `check p s`: a Lean function that follows body.rs line by line (same checks, same order,
  same error strings, checked_add modeled as a Nat guard).
* `check_ok_iff_spec`: `check p s = .ok o ↔ Spec p s o`. From it: a refusal happens exactly
  when no output satisfies the spec (`check_error_iff_no_spec`), and the output is unique.
-/

namespace Smith.Coalition

/-- `Seat` from the spec's `types`. `price` is u128 in Rust; the check never reads it. -/
structure Seat where
  leg : UInt32
  member : String
  price : Nat
  delivered : Option String
  deriving Repr, DecidableEq

structure Public where
  coalition : String
  job : UInt64
  seats_root : Bytes32
  k_min : UInt32
  deriving Repr

structure Private where
  seats : List Seat
  deriving Repr

structure Output where
  delivered : UInt32
  seats : UInt32
  deriving Repr, DecidableEq

-- The commitment over `Vec<Seat>`, a parameter of everything below.
variable (C : CommitFn (List Seat))

def tag : String := "bookerbob/smith/coalition-seats/v0"

/-- `(c >= b'0' && c <= b'9') || (c >= b'a' && c <= b'f')` -/
def isLowerHex (c : UInt8) : Bool :=
  (48 ≤ c && c ≤ 57) || (97 ≤ c && c ≤ 102)

/-- Rule 5 on one id: `id.as_bytes()` has 64 bytes, all lowercase hex. -/
def HexId (id : String) : Prop :=
  id.toUTF8.size = 64 ∧ ∀ c ∈ id.toUTF8.toList, isLowerHex c = true

/-- The number of delivered seats. -/
def deliveredCount (seats : List Seat) : Nat :=
  (seats.filter (·.delivered.isSome)).length

/-- The spec: rules 1 to 8 of coalition-k-of-n.json. -/
structure Spec (C : CommitFn (List Seat)) (p : Public) (s : Private) (o : Output) : Prop where
  /-- Rule 1: seats_root commits to the seat records. -/
  root : p.seats_root = C.commit tag s.seats
  /-- Rule 2: between 1 and 8 seats. -/
  count : 1 ≤ s.seats.length ∧ s.seats.length ≤ 8
  /-- Rule 3: the legs are 0, 1, 2, ... in order. -/
  legs : s.seats.map (·.leg.toNat) = List.range s.seats.length
  /-- Rule 4: no member appears twice. -/
  distinct : (s.seats.map (·.member)).Nodup
  /-- Rule 5: a delivered seat carries a 64-char lowercase hex id. -/
  hex : ∀ seat ∈ s.seats, ∀ id, seat.delivered = some id → HexId id
  /-- Rule 6: the two counts. -/
  delivered : o.delivered.toNat = deliveredCount s.seats
  seats : o.seats.toNat = s.seats.length
  /-- Rule 7: at least k_min delivered. -/
  kmin : p.k_min.toNat ≤ deliveredCount s.seats

/-! ## The model of body.rs -/

/-- Rule 3 loop: `for (i, seat) in seats.iter().enumerate() { if seat.leg as usize != i ... }` -/
def legsFrom : List Seat → Nat → Bool
  | [], _ => true
  | seat :: rest, i => seat.leg.toNat == i && legsFrom rest (i + 1)

/-- Rule 4 loop: each seat against every prior seat. `prior` is the seats before the cursor. -/
def noDupFrom : List Seat → List Seat → Bool
  | _, [] => true
  | prior, a :: rest => (prior.all fun b => a.member != b.member) && noDupFrom (a :: prior) rest

/-- Rules 5 and 6 loop, with the `checked_add`. `acc` is the Nat value of the u32 counter. -/
def countLoop : List Seat → Nat → Except String Nat
  | [], acc => .ok acc
  | seat :: rest, acc =>
    match seat.delivered with
    | none => countLoop rest acc
    | some id =>
      if id.toUTF8.size != 64 then .error "delivery id not 64 chars"
      else if !(id.toUTF8.toList.all isLowerHex) then .error "delivery id not lowercase hex"
      else match u32CheckedAdd acc 1 with
        | none => .error "delivered count overflow"
        | some acc' => countLoop rest acc'

/-- `check(p, s)` from body.rs, in order. -/
def check (p : Public) (s : Private) : Except String Output :=
  let root := C.commit tag s.seats
  if root != p.seats_root then .error "seats_root mismatch"
  else
  let n := s.seats.length
  if n < 1 || n > 8 then .error "seat count out of range"
  else if !legsFrom s.seats 0 then .error "seat legs not sequential"
  else if !noDupFrom [] s.seats then .error "duplicate member"
  else match countLoop s.seats 0 with
    | .error e => .error e
    | .ok delivered =>
      if delivered < p.k_min.toNat then .error "delivered below k_min"
      else .ok { delivered := delivered.toUInt32, seats := n.toUInt32 }

/-! ## Lemmas: each loop computes its rule -/

theorem legsFrom_iff (l : List Seat) (k : Nat) :
    legsFrom l k = true ↔ l.map (·.leg.toNat) = List.range' k l.length := by
  induction l generalizing k with
  | nil => simp [legsFrom]
  | cons seat rest ih =>
    simp [legsFrom, List.range'_succ, ih]

/-- The pairwise loop, generalized over the prior seats. -/
theorem noDupFrom_iff (prior l : List Seat) :
    noDupFrom prior l = true ↔
      (∀ a ∈ l, ∀ b ∈ prior, a.member ≠ b.member) ∧ (l.map (·.member)).Nodup := by
  induction l generalizing prior with
  | nil => simp [noDupFrom]
  | cons a rest ih =>
    simp only [noDupFrom, Bool.and_eq_true, List.all_eq_true, ih, List.map_cons,
      List.nodup_cons, List.mem_map, List.mem_cons, bne_iff_ne]
    constructor
    · rintro ⟨h1, h2, h3⟩
      refine ⟨?_, ?_, h3⟩
      · intro x hx b hb
        rcases hx with rfl | hx
        · exact h1 b hb
        · exact h2 x hx b (.inr hb)
      · rintro ⟨x, hx, hxa⟩
        exact h2 x hx a (.inl rfl) hxa
    · rintro ⟨h1, h2, h3⟩
      refine ⟨fun b hb => h1 a (.inl rfl) b hb, ?_, h3⟩
      intro x hx b hb
      rcases hb with rfl | hb
      · intro h; exact h2 ⟨x, hx, h⟩
      · exact h1 x (.inr hx) b hb

theorem HexId_iff (id : String) :
    (id.toUTF8.size == 64 && id.toUTF8.toList.all isLowerHex) = true ↔ HexId id := by
  simp [HexId, List.all_eq_true]

theorem toNat_toUInt32_of_lt {n : Nat} (h : n < 2 ^ 32) : n.toUInt32.toNat = n := by
  simp [Nat.toUInt32, Nat.mod_eq_of_lt h]

theorem countLoop_ok_iff (l : List Seat) (acc d : Nat) (hacc : acc < 2 ^ 32) :
    countLoop l acc = .ok d ↔
      (∀ seat ∈ l, ∀ id, seat.delivered = some id → HexId id) ∧
      acc + deliveredCount l < 2 ^ 32 ∧ d = acc + deliveredCount l := by
  induction l generalizing acc with
  | nil => simp [countLoop, deliveredCount]; omega
  | cons seat rest ih =>
    cases hd : seat.delivered with
    | none =>
      simp only [countLoop, hd, ih acc hacc, deliveredCount, List.filter_cons, Option.isSome_none,
        Bool.false_eq_true, ↓reduceIte, List.mem_cons]
      constructor
      · rintro ⟨h1, h2, h3⟩
        refine ⟨?_, h2, h3⟩
        rintro x (rfl | hx) id hid
        · simp_all
        · exact h1 x hx id hid
      · rintro ⟨h1, h2, h3⟩
        exact ⟨fun x hx id hid => h1 x (.inr hx) id hid, h2, h3⟩
    | some id =>
      simp only [countLoop, hd]
      by_cases hlen : id.toUTF8.size = 64
      · by_cases hhex : id.toUTF8.toList.all isLowerHex = true
        · have hhexid : HexId id := ⟨hlen, List.all_eq_true.mp hhex⟩
          simp only [hlen, bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, hhex,
            Bool.not_true]
          cases hadd : u32CheckedAdd acc 1 with
          | none =>
            simp only [u32CheckedAdd] at hadd
            split at hadd
            · simp at hadd
            · simp only [deliveredCount, List.filter_cons, hd, Option.isSome_some,
                ↓reduceIte, List.length_cons]
              constructor
              · intro h; simp at h
              · rintro ⟨-, h2, -⟩; omega
          | some acc' =>
            rw [u32CheckedAdd_eq_some] at hadd
            obtain ⟨hlt, rfl⟩ := hadd
            simp only [ih (acc + 1) hlt, deliveredCount, List.filter_cons, hd, Option.isSome_some,
              ↓reduceIte, List.length_cons, List.mem_cons]
            constructor
            · rintro ⟨h1, h2, h3⟩
              refine ⟨?_, by omega, by omega⟩
              rintro x (rfl | hx) id' hid'
              · rw [hd] at hid'; cases hid'; exact hhexid
              · exact h1 x hx id' hid'
            · rintro ⟨h1, h2, h3⟩
              exact ⟨fun x hx id' hid' => h1 x (.inr hx) id' hid', by omega, by omega⟩
        · simp only [hlen, bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, hhex,
            Bool.not_false]
          constructor
          · intro h; simp at h
          · rintro ⟨h1, -, -⟩
            exact absurd (h1 seat List.mem_cons_self id hd).2
              (fun h => hhex (List.all_eq_true.mpr h))
      · have : (id.toUTF8.size != 64) = true := by simpa using hlen
        simp only [this, ↓reduceIte]
        constructor
        · intro h; simp at h
        · rintro ⟨h1, -, -⟩
          exact absurd (h1 seat List.mem_cons_self id hd).1 hlen

/-! ## The theorem: the model agrees with the spec -/

theorem check_ok_iff_spec (p : Public) (s : Private) (o : Output) :
    check C p s = .ok o ↔ Spec C p s o := by
  have h8 : deliveredCount s.seats ≤ s.seats.length := List.length_filter_le _ _
  unfold check
  simp only [bne_iff_ne, ne_eq, ite_not, Bool.or_eq_true, decide_eq_true_eq, Bool.not_eq_true']
  constructor
  · intro h
    split at h
    · rename_i hroot
      split at h
      · simp at h
      · rename_i hcount
        split at h
        · simp at h
        · rename_i hlegs
          split at h
          · simp at h
          · rename_i hdup
            split at h
            · simp at h
            · rename_i d hloop
              split at h
              · simp at h
              · rename_i hk
                cases h
                have hl := (legsFrom_iff s.seats 0).mp (by simpa using hlegs)
                have hn := (noDupFrom_iff [] s.seats).mp (by simpa using hdup)
                obtain ⟨hhex, hlt, rfl⟩ := (countLoop_ok_iff s.seats 0 d (by omega)).mp hloop
                simp only [Nat.zero_add] at hlt hk
                refine ⟨hroot.symm, by omega, ?_, hn.2, hhex, ?_, ?_, by omega⟩
                · rw [hl, List.range_eq_range']
                · simp only [Nat.zero_add]; exact toNat_toUInt32_of_lt (by omega)
                · simp only; exact toNat_toUInt32_of_lt (by omega)
    · simp at h
  · rintro ⟨hroot, hcount, hlegs, hdup, hhex, hdel, hseats, hk⟩
    have hl : legsFrom s.seats 0 = true :=
      (legsFrom_iff s.seats 0).mpr (by rw [hlegs, List.range_eq_range'])
    have hn : noDupFrom [] s.seats = true :=
      (noDupFrom_iff [] s.seats).mpr ⟨by simp, hdup⟩
    have hc : countLoop s.seats 0 = .ok (deliveredCount s.seats) :=
      (countLoop_ok_iff s.seats 0 _ (by omega)).mpr ⟨hhex, by omega, by omega⟩
    have hcount' : ¬ (s.seats.length < 1 ∨ s.seats.length > 8) := by omega
    have hk' : ¬ deliveredCount s.seats < p.k_min.toNat := by omega
    simp only [hroot.symm, hcount', hl, hn, hc, hk', ↓reduceIte, Bool.true_eq_false,
      Except.ok.injEq]
    cases o
    simp only [Output.mk.injEq]
    constructor
    · apply UInt32.toNat.inj
      rw [hdel, toNat_toUInt32_of_lt (by omega)]
    · apply UInt32.toNat.inj
      rw [hseats, toNat_toUInt32_of_lt (by omega)]

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

/-- The spec determines the output: two outputs meeting it are equal. -/
theorem spec_unique (p : Public) (s : Private) (o o' : Output)
    (h : Spec C p s o) (h' : Spec C p s o') : o = o' := by
  cases o; cases o'
  simp only [Output.mk.injEq]
  constructor
  · apply UInt32.toNat.inj; rw [h.delivered, h'.delivered]
  · apply UInt32.toNat.inj; rw [h.seats, h'.seats]

/-- Rule 8, as a property: the output is a function of the two counts alone. Two private
inputs with the same delivered count and the same seat count give the same output, whatever
the members, prices and ids. -/
theorem output_depends_only_on_counts (p p' : Public) (s s' : Private) (o o' : Output)
    (h : Spec C p s o) (h' : Spec C p' s' o')
    (hd : deliveredCount s.seats = deliveredCount s'.seats)
    (hn : s.seats.length = s'.seats.length) : o = o' := by
  cases o; cases o'
  simp only [Output.mk.injEq]
  constructor
  · apply UInt32.toNat.inj; rw [h.delivered, h'.delivered, hd]
  · apply UInt32.toNat.inj; rw [h.seats, h'.seats, hn]

end Smith.Coalition
