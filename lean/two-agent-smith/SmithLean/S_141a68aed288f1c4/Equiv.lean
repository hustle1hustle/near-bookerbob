import SmithLean.S_141a68aed288f1c4.A
import SmithLean.S_141a68aed288f1c4.B
/-!
# coalition-split v2: the writer's spec and the reviewer's spec agree

`spec_a_iff_spec_b`: `Spec C p s o ↔ B.Spec C p s o`, for every commitment function `C`.

The two specs name the same quantities with two helper families. Most of B's helpers unfold to
A's (`rfl`); the two list recomputations differ in shape (B: `filterMap` with an `if`; A:
`filter` then `map`) and are bridged by induction on the seats. Rule 1's "seat i has leg i" is
A's `map leg = range` and B's pointwise `∀ i, seats[i].leg.toNat = i`; `List.ext_getElem` turns
one into the other. Rule 7: B's extra bound `D < u128Max` follows from A's `P < u128Max`
(`D_le_P`); B's per-line bound is quantified over the payout list, A's over the delivered seats
(`List.mem_map`). Rule 8: A compares `.toNat`, B compares with `UInt32.ofNat`; both counts are at
most 8, so the conversion is exact.
-/

namespace Smith.S_141a68aed288f1c4

variable (C : CommitFn (List Seat))

/-! ## Helper bridges: B's family in A's terms -/

theorem B_deliveredSeats_eq (s : Private) : B.deliveredSeats s = deliveredSeats s.seats := rfl

theorem B_undeliveredSeats_eq (s : Private) : B.undeliveredSeats s = missedSeats s.seats := rfl

theorem B_P_eq (s : Private) : B.P s = P s.seats := rfl

theorem B_D_eq (s : Private) : B.D s = D s.seats := rfl

theorem B_deliverersCount_eq (s : Private) :
    B.deliverersCount s = (deliveredSeats s.seats).length := rfl

theorem B_slashedCount_eq (s : Private) : B.slashedCount s = (missedSeats s.seats).length := rfl

theorem B_slashed_total_eq (p : Public) (s : Private) :
    B.slashed_total p s = slashedTotal p.bond s.seats := rfl

theorem B_to_deliverers_eq (p : Public) (s : Private) :
    B.to_deliverers p s = toDeliverers p.bond s.seats := rfl

theorem B_expectedPayout_eq (p : Public) (s : Private) (x : Seat) :
    B.expectedPayout p s x =
      payoutOf p.budget p.bond (P s.seats) (D s.seats) (toDeliverers p.bond s.seats) x := rfl

theorem B_payoutLine_eq : B.payoutLine = lineTotal := rfl

/-- `filterMap (if delivered then some (f x) else none)` is `filter` then `map`. -/
theorem filterMap_delivered_eq_map_filter {β : Type} (f : Seat → β) (l : List Seat) :
    l.filterMap (fun x => if B.isDelivered x then some (f x) else none) =
      (deliveredSeats l).map f := by
  simp only [B.isDelivered]
  induction l with
  | nil => rfl
  | cons seat rest ih =>
    by_cases hs : seat.delivered.isSome = true
    · rw [deliveredSeats_cons_some rest hs]
      simp [hs, ih]
    · have hs' : seat.delivered.isSome = false := by simpa using hs
      rw [deliveredSeats_cons_none rest hs']
      simp [hs', ih]

/-- `filterMap (if delivered then none else some x.member)` is the missed seats' members. -/
theorem filterMap_missed_eq_slashedMembers (l : List Seat) :
    l.filterMap (fun x => if B.isDelivered x then none else some x.member) =
      slashedMembers l := by
  simp only [B.isDelivered]
  induction l with
  | nil => rfl
  | cons seat rest ih =>
    by_cases hs : seat.delivered.isSome = true
    · rw [slashedMembers_cons_some rest hs]
      simp [hs, ih]
    · have hs' : seat.delivered.isSome = false := by simpa using hs
      rw [slashedMembers_cons_none rest hs']
      simp [hs', ih]

theorem B_expectedPayouts_eq (p : Public) (s : Private) :
    B.expectedPayouts p s = expectedDelivered p.budget p.bond s.seats := by
  unfold B.expectedPayouts expectedDelivered expectedL
  rw [filterMap_delivered_eq_map_filter]
  rfl

theorem B_slashedMembers_eq (s : Private) : B.slashedMembers s = slashedMembers s.seats :=
  filterMap_missed_eq_slashedMembers s.seats

theorem B_paid_out_eq (p : Public) (s : Private) :
    B.paid_out p s = paidOut p.budget p.bond s.seats := by
  unfold B.paid_out paidOut paidOutL
  rw [B_expectedPayouts_eq, B_payoutLine_eq]
  rfl

theorem B_bondPool_eq (p : Public) (s : Private) : B.bondPool p s = p.bond * s.seats.length := rfl

theorem B_pool_eq (p : Public) (s : Private) :
    B.pool p s = p.budget + p.bond * s.seats.length := rfl

theorem B_to_buyer_eq (p : Public) (s : Private) :
    B.to_buyer p s = toBuyer p.budget p.bond s.seats := by
  unfold B.to_buyer toBuyer
  rw [B_pool_eq, B_paid_out_eq]

/-- The delivered price sum never exceeds the total price sum. -/
theorem D_le_P (seats : List Seat) : D seats ≤ P seats := by
  induction seats with
  | nil => simp [D, P, deliveredSeats]
  | cons seat rest ih =>
    rw [P_cons]
    by_cases hs : seat.delivered.isSome = true
    · rw [D_cons_some rest hs]; omega
    · have hs' : seat.delivered.isSome = false := by simpa using hs
      rw [D_cons_none rest hs']; omega

/-! ## Rule 1: the two shapes of "seat i has leg i" -/

theorem legs_map_range_iff (seats : List Seat) :
    seats.map (·.leg.toNat) = List.range seats.length ↔
      ∀ (i : Nat) (h : i < seats.length), (seats[i]'h).leg.toNat = i := by
  constructor
  · intro heq i h
    have h' : i < (seats.map (·.leg.toNat)).length := by simpa using h
    have := List.getElem_of_eq heq h'
    simpa [List.getElem_map, List.getElem_range] using this
  · intro hpt
    apply List.ext_getElem
    · simp
    · intro i h1 h2
      simp only [List.getElem_map, List.getElem_range]
      exact hpt i (by simpa using h1)

/-! ## Rule 4: the two shapes of "delivered seats exist" -/

theorem delivered_ne_nil_iff_count_pos (seats : List Seat) :
    deliveredSeats seats ≠ [] ↔ 0 < (deliveredSeats seats).length :=
  List.length_pos_iff.symm

/-! ## Rule 7: A's `Fits` is B's bound list -/

theorem fits_iff_rule7 (p : Public) (s : Private) :
    Fits p.budget p.bond s.seats ↔
      (B.P s < u128Max ∧
       B.D s < u128Max ∧
       B.slashed_total p s < u128Max ∧
       (∀ x ∈ B.deliveredSeats s, p.budget * x.price < u128Max) ∧
       (∀ x ∈ B.deliveredSeats s, B.to_deliverers p s * x.price < u128Max) ∧
       (∀ y ∈ B.expectedPayouts p s, B.payoutLine y < u128Max) ∧
       B.paid_out p s < u128Max ∧
       B.bondPool p s < u128Max ∧
       B.pool p s < u128Max ∧
       B.paid_out p s ≤ B.pool p s) := by
  rw [B_P_eq, B_D_eq, B_slashed_total_eq, B_deliveredSeats_eq, B_to_deliverers_eq,
    B_expectedPayouts_eq, B_payoutLine_eq, B_paid_out_eq, B_bondPool_eq, B_pool_eq]
  constructor
  · rintro ⟨hP, hst, hlines, hpaid, hbp, hpool, htb⟩
    refine ⟨hP, ?_, hst, fun x hx => (hlines x hx).1, fun x hx => (hlines x hx).2.1, ?_, hpaid,
      hbp, hpool, htb⟩
    · exact Nat.lt_of_le_of_lt (D_le_P s.seats) hP
    · intro y hy
      unfold expectedDelivered expectedL at hy
      obtain ⟨x, hx, rfl⟩ := List.mem_map.mp hy
      exact (hlines x hx).2.2
  · rintro ⟨hP, _, hst, hb, ht, hl, hpaid, hbp, hpool, htb⟩
    refine ⟨hP, hst, ?_, hpaid, hbp, hpool, htb⟩
    intro x hx
    refine ⟨hb x hx, ht x hx, ?_⟩
    apply hl
    unfold expectedDelivered expectedL
    exact List.mem_map.mpr ⟨x, hx, rfl⟩

/-! ## Rule 8: `.toNat` equality is `UInt32.ofNat` equality for counts below 2^32 -/

theorem toNat_eq_iff_eq_ofNat {u : UInt32} {n : Nat} (h : n < 2 ^ 32) :
    u.toNat = n ↔ u = UInt32.ofNat n := by
  constructor
  · intro hu
    apply UInt32.toNat.inj
    rw [hu]
    exact (toNat_toUInt32_of_lt h).symm
  · intro hu
    rw [hu]
    exact toNat_toUInt32_of_lt h

/-! ## The theorem -/

theorem spec_a_iff_spec_b (p : Public) (s : Private) (o : Output) :
    Spec C p s o ↔ B.Spec C p s o := by
  have hdl : (deliveredSeats s.seats).length ≤ s.seats.length := List.length_filter_le _ _
  have hml : (missedSeats s.seats).length ≤ s.seats.length := List.length_filter_le _ _
  constructor
  · rintro ⟨hroot, hcount, hlegs, hdup, hpos, hdp, hdel, hsl, htb, hfits, hdv, hsc, hpo⟩
    refine
      { rule1 := ⟨hroot, hcount, (legs_map_range_iff s.seats).mp hlegs, hdup⟩
        rule2 := hpos
        rule3 := ⟨rfl, rfl⟩
        rule4 := fun h => hdp ((delivered_ne_nil_iff_count_pos s.seats).mpr h)
        rule5 := rfl
        rule6 := ⟨?_, ?_, ?_⟩
        rule7 := (fits_iff_rule7 p s).mp hfits
        rule8 := ⟨?_, ?_, ?_⟩ }
    · rw [B_expectedPayouts_eq]; exact hdel
    · rw [B_slashedMembers_eq]; exact hsl
    · rw [B_to_buyer_eq]; exact htb
    · rw [B_deliverersCount_eq]
      exact (toNat_eq_iff_eq_ofNat (by omega)).mp hdv
    · rw [B_slashedCount_eq]
      exact (toNat_eq_iff_eq_ofNat (by omega)).mp hsc
    · rw [B_paid_out_eq]; exact hpo
  · rintro ⟨⟨hroot, hcount, hlegs, hdup⟩, hpos, _, hdp, _, ⟨hdel, hsl, htb⟩, hfits, ⟨hdv, hsc, hpo⟩⟩
    rw [B_expectedPayouts_eq] at hdel
    rw [B_slashedMembers_eq] at hsl
    rw [B_to_buyer_eq] at htb
    rw [B_deliverersCount_eq] at hdv hdp
    rw [B_slashedCount_eq] at hsc
    rw [B_paid_out_eq] at hpo
    rw [B_D_eq] at hdp
    exact
      { root := hroot
        count := hcount
        legs := (legs_map_range_iff s.seats).mpr hlegs
        distinct := hdup
        price_pos := hpos
        delivered_price_pos := fun h => hdp ((delivered_ne_nil_iff_count_pos s.seats).mp h)
        delivered := hdel
        slashed := hsl
        to_buyer := htb
        fits := (fits_iff_rule7 p s).mpr hfits
        deliverers := (toNat_eq_iff_eq_ofNat (by omega)).mpr hdv
        slashed_count := (toNat_eq_iff_eq_ofNat (by omega)).mpr hsc
        paid_out := hpo }

/-- The two directions as named theorems, for callers that want one side. -/
theorem spec_a_imp_spec_b (p : Public) (s : Private) (o : Output) (h : Spec C p s o) :
    B.Spec C p s o := (spec_a_iff_spec_b C p s o).mp h

theorem spec_b_imp_spec_a (p : Public) (s : Private) (o : Output) (h : B.Spec C p s o) :
    Spec C p s o := (spec_a_iff_spec_b C p s o).mpr h

end Smith.S_141a68aed288f1c4
