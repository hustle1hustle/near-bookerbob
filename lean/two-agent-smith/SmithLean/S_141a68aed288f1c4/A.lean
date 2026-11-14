import SmithLean.S_141a68aed288f1c4.Types
/-!
# coalition-split v2: the spec in Lean, a Lean model of body.rs, and their agreement

Source of the spec: `specs/coalition-split.json`, version 2, the eight `rules`.
Source of the model: `tools/vecgate/programs/coalition-split-v2/src/body.rs`.

Three layers, as in `CoalitionKofN.lean` and `SpendBucket.lean`:
* `Spec C p s o`: the requester's rules as a proposition, one clause per rule, written from the
  rule text with the helper functions below (P, D, slashed_total, to_deliverers, the payout
  lines, the slashed members, paid_out, to_buyer).
* `check C p s`: a Lean function that follows body.rs statement by statement (same checks, same
  order, same error strings; every `checked_*` is a Nat guard against `u128Max`).
* `check_ok_iff_spec`: `check C p s = .ok o ↔ Spec C p s o`.

What v2 changes from v1 (S_bff28a1463eca2b6): rule 4 now says "If any seat delivered and D = 0
(every delivered seat has price 0), refuse; from_slashed is never computed with D = 0." The Rust
adds one guard right after the P > 0 check (`any_delivered && delivered_price == 0` refuses with
"delivered price is zero"); the model adds the same guard in the same place, the spec adds the
clause `delivered_price_pos`, and the proof threads one more conjunct through both directions
with `length_delivered_add_missed` (delivered + missed = all seats) to turn the Rust's
`undelivered.len() < n` into "the delivered seats are not empty".

The interesting rules are 4 and 7. The Rust recomputes the payout lines in one loop that pushes
onto two vectors and accumulates `paid_out` with `checked_add` line by line; the spec speaks of
lists and a sum. The two agree because every term is a natural number: a partial sum overflows
iff the total does (`payoutLoop_ok_iff`). Likewise the Rust guards the delivered price sum, but
that guard can never fire: the delivered sum never exceeds the total sum that was guarded one
statement earlier (`priceLoop_ok_iff` has no clause for it).
-/

namespace Smith.S_141a68aed288f1c4

-- The commitment over `Vec<Seat>`, a parameter of everything below.
variable (C : CommitFn (List Seat))

/-! ## The spec's quantities, each from the rule text -/

/-- Rule 2: "a seat delivered when `delivered` is Some". The delivered seats, in seat order. -/
def deliveredSeats (seats : List Seat) : List Seat := seats.filter (·.delivered.isSome)

/-- The seats that did not deliver, in seat order. -/
def missedSeats (seats : List Seat) : List Seat := seats.filter (!·.delivered.isSome)

/-- Rule 2: P = the sum of price over all seats. -/
def P (seats : List Seat) : Nat := (seats.map (·.price)).sum

/-- Rule 2: D = the sum of price over delivered seats. -/
def D (seats : List Seat) : Nat := ((deliveredSeats seats).map (·.price)).sum

/-- Rule 3: slashed_total = bond * (number of seats that did not deliver). -/
def slashedTotal (bond : Nat) (seats : List Seat) : Nat := bond * (missedSeats seats).length

/-- Rule 3: to_deliverers = slashed_total - slashed_total / 2 when D > 0, else 0. -/
def toDeliverers (bond : Nat) (seats : List Seat) : Nat :=
  if D seats > 0 then slashedTotal bond seats - slashedTotal bond seats / 2 else 0

/-- Rule 4, one delivered seat: bond_back = bond, share = budget * price / P (floor),
from_slashed = to_deliverers * price / D (floor). `tp` is P, `dp` is D, `td` is to_deliverers.
Under the spec D > 0 whenever a delivered seat exists (`Spec.delivered_price_pos`), so the
quotient is never 0 / 0 on a line the spec accepts; Nat reads it as 0 anyway. -/
def payoutOf (budget bond tp dp td : Nat) (seat : Seat) : Payout :=
  { member := seat.member, bond_back := bond, share := budget * seat.price / tp,
    from_slashed := td * seat.price / dp }

/-- Rule 4: the payout lines of the delivered seats, in seat order, for given P, D, to_deliverers. -/
def expectedL (budget bond tp dp td : Nat) (seats : List Seat) : List Payout :=
  (deliveredSeats seats).map (payoutOf budget bond tp dp td)

/-- One line's `bond_back + share + from_slashed`. -/
def lineTotal (l : Payout) : Nat := l.bond_back + l.share + l.from_slashed

/-- Rule 8: the sum over delivered seats of (bond_back + share + from_slashed). -/
def paidOutL (budget bond tp dp td : Nat) (seats : List Seat) : Nat :=
  ((expectedL budget bond tp dp td seats).map lineTotal).sum

/-- Rule 4 with the rule 2 and 3 quantities filled in. -/
def expectedDelivered (budget bond : Nat) (seats : List Seat) : List Payout :=
  expectedL budget bond (P seats) (D seats) (toDeliverers bond seats) seats

/-- Rule 8's paid_out with the rule 2 and 3 quantities filled in. -/
def paidOut (budget bond : Nat) (seats : List Seat) : Nat :=
  paidOutL budget bond (P seats) (D seats) (toDeliverers bond seats) seats

/-- Rule 6: the members of the seats that did not deliver, in seat order. -/
def slashedMembers (seats : List Seat) : List String := (missedSeats seats).map (·.member)

/-- Rule 5: to_buyer = budget + bond * (number of seats) - paid_out. -/
def toBuyer (budget bond : Nat) (seats : List Seat) : Nat :=
  budget + bond * seats.length - paidOut budget bond seats

/-- Rule 7: "all arithmetic is checked u128; any overflow refuses", as a bound on every value
the Rust computes with a `checked_*` (and `checked_sub` for to_buyer as `paid_out ≤ pool`). The
delivered price sum is not listed: it is at most P. -/
structure Fits (budget bond : Nat) (seats : List Seat) : Prop where
  price_sum : P seats < u128Max
  slashed_total : slashedTotal bond seats < u128Max
  lines : ∀ seat ∈ deliveredSeats seats,
    budget * seat.price < u128Max ∧
    toDeliverers bond seats * seat.price < u128Max ∧
    lineTotal (payoutOf budget bond (P seats) (D seats) (toDeliverers bond seats) seat) < u128Max
  paid_out : paidOut budget bond seats < u128Max
  bond_pool : bond * seats.length < u128Max
  pool : budget + bond * seats.length < u128Max
  to_buyer : paidOut budget bond seats ≤ budget + bond * seats.length

/-- The spec: rules 1 to 8 of coalition-split.json v2. Rules 3, 4 and 5 define quantities
(`slashedTotal`, `toDeliverers`, `payoutOf`, `toBuyer`); they are checked through rule 6, and
rule 4 adds its own refusal (`delivered_price_pos`). -/
structure Spec (C : CommitFn (List Seat)) (p : Public) (s : Private) (o : Output) : Prop where
  /-- Rule 1: seats_root commits to the seat records. -/
  root : p.seats_root = C.commit tag s.seats
  /-- Rule 1: between 1 and 8 seats. -/
  count : 1 ≤ s.seats.length ∧ s.seats.length ≤ 8
  /-- Rule 1: seat i has leg i. -/
  legs : s.seats.map (·.leg.toNat) = List.range s.seats.length
  /-- Rule 1: no member twice. -/
  distinct : (s.seats.map (·.member)).Nodup
  /-- Rule 2: P > 0. -/
  price_pos : 0 < P s.seats
  /-- Rule 4 (v2): "If any seat delivered and D = 0 (every delivered seat has price 0), refuse;
  from_slashed is never computed with D = 0." Delivered seats exist → D > 0. -/
  delivered_price_pos : deliveredSeats s.seats ≠ [] → 0 < D s.seats
  /-- Rule 6 over rule 4: the announced payouts are the recomputed lines, in seat order. -/
  delivered : p.delivered = expectedDelivered p.budget p.bond s.seats
  /-- Rule 6: the announced slashed members are the seats that did not deliver, in seat order. -/
  slashed : p.slashed = slashedMembers s.seats
  /-- Rule 6 over rule 5: the announced remainder is to_buyer. -/
  to_buyer : p.to_buyer = toBuyer p.budget p.bond s.seats
  /-- Rule 7: every checked u128 fits. -/
  fits : Fits p.budget p.bond s.seats
  /-- Rule 8: the three outputs. -/
  deliverers : o.deliverers.toNat = (deliveredSeats s.seats).length
  slashed_count : o.slashed.toNat = (missedSeats s.seats).length
  paid_out : o.paid_out = paidOut p.budget p.bond s.seats

/-! ## The model of body.rs -/

/-- Rule 1 loop: `for (i, seat) in seats.iter().enumerate() { if seat.leg != i as u32 ... }` -/
def legsFrom : List Seat → Nat → Bool
  | [], _ => true
  | seat :: rest, i => seat.leg.toNat == i && legsFrom rest (i + 1)

/-- Rule 1 loop: `for i in 0..n { for j in (i + 1)..n { if seats[i].member == seats[j].member`.
Modeled cursor-first: `prior` holds the seats before the cursor, each new seat is compared with
all of them. Same pairs, same verdict. -/
def noDupFrom : List Seat → List Seat → Bool
  | _, [] => true
  | prior, a :: rest => (prior.all fun b => a.member != b.member) && noDupFrom (a :: prior) rest

/-- Rule 2 loop: `total_price`, `delivered_price` with `checked_add`, and `undelivered`, of
which the Rust only ever reads the length, so the model carries the count `missed`. -/
def priceLoop : List Seat → Nat → Nat → Nat → Except String (Nat × Nat × Nat)
  | [], total_price, delivered_price, missed => .ok (total_price, delivered_price, missed)
  | seat :: rest, total_price, delivered_price, missed =>
    if total_price + seat.price < u128Max then
      if seat.delivered.isSome then
        if delivered_price + seat.price < u128Max then
          priceLoop rest (total_price + seat.price) (delivered_price + seat.price) missed
        else .error "delivered price sum overflow"
      else priceLoop rest (total_price + seat.price) delivered_price (missed + 1)
    else .error "price sum overflow"

/-- `let from_slashed = if delivered_price > 0 { checked_mul ... / delivered_price } else { 0 }` -/
def slashedShare (delivered_price to_deliverers price : Nat) : Except String Nat :=
  if delivered_price > 0 then
    if to_deliverers * price < u128Max then .ok (to_deliverers * price / delivered_price)
    else .error "slashed share overflow"
  else .ok 0

/-- Rules 4 to 6 loop: `expect_delivered`, `expect_slashed` (pushed in seat order) and
`paid_out` with `checked_add`. -/
def payoutLoop (budget bond total_price delivered_price to_deliverers : Nat) :
    List Seat → List Payout → List String → Nat →
      Except String (List Payout × List String × Nat)
  | [], expect_delivered, expect_slashed, paid_out =>
    .ok (expect_delivered, expect_slashed, paid_out)
  | seat :: rest, expect_delivered, expect_slashed, paid_out =>
    if seat.delivered.isSome then
      let bond_back := bond
      if budget * seat.price < u128Max then
        let share := budget * seat.price / total_price
        match slashedShare delivered_price to_deliverers seat.price with
        | .error e => .error e
        | .ok from_slashed =>
          if bond_back + share < u128Max then
            if bond_back + share + from_slashed < u128Max then
              let line_total := bond_back + share + from_slashed
              if paid_out + line_total < u128Max then
                let line : Payout :=
                  { member := seat.member, bond_back := bond_back, share := share,
                    from_slashed := from_slashed }
                payoutLoop budget bond total_price delivered_price to_deliverers rest
                  (expect_delivered ++ [line]) expect_slashed (paid_out + line_total)
              else .error "paid out overflow"
            else .error "payout line overflow"
          else .error "payout line overflow"
      else .error "budget share overflow"
    else
      payoutLoop budget bond total_price delivered_price to_deliverers rest
        expect_delivered (expect_slashed ++ [seat.member]) paid_out

/-- `check(p, s)` from body.rs (v2), in order. -/
def check (p : Public) (s : Private) : Except String Output :=
  let seats := s.seats
  -- Rule 1: the commitment must match the private seat records.
  if p.seats_root ≠ C.commit tag seats then .error "seats_root mismatch"
  else
  -- Rule 1: between 1 and 8 seats, seat i has leg i, no member twice.
  let n := seats.length
  if n < 1 ∨ n > 8 then .error "seat count out of range"
  else if !legsFrom seats 0 then .error "leg out of order"
  else if !noDupFrom [] seats then .error "duplicate member"
  else
  -- Rule 2: P = sum of all prices, D = sum of delivered prices.
  match priceLoop seats 0 0 0 with
  | .error e => .error e
  | .ok (total_price, delivered_price, missed) =>
    if total_price = 0 then .error "total price is zero"
    else
    -- Rule 4 (v2): a delivered seat with D == 0 would divide by zero; refuse.
    -- `let any_delivered = undelivered.len() < n;`
    if missed < n ∧ delivered_price = 0 then .error "delivered price is zero"
    else
    -- Rule 3: slashed bonds and the deliverers' half.
    if p.bond * missed < u128Max then
      let slashed_total := p.bond * missed
      let to_deliverers := if delivered_price > 0 then slashed_total - slashed_total / 2 else 0
      -- Rules 4-6: recompute every deliverer line and the slashed list in seat order.
      match payoutLoop p.budget p.bond total_price delivered_price to_deliverers seats [] [] 0 with
      | .error e => .error e
      | .ok (expect_delivered, expect_slashed, paid_out) =>
        -- Rule 5: buyer's remainder.
        if p.bond * n < u128Max then
          let bond_pool := p.bond * n
          if p.budget + bond_pool < u128Max then
            let pool := p.budget + bond_pool
            if paid_out ≤ pool then
              let to_buyer := pool - paid_out
              -- Rule 6: the announced payouts must match exactly.
              if expect_delivered ≠ p.delivered then .error "delivered payouts mismatch"
              else if expect_slashed ≠ p.slashed then .error "slashed members mismatch"
              else if to_buyer ≠ p.to_buyer then .error "to_buyer mismatch"
              else
              -- Rule 8: output counts and total paid.
              .ok { deliverers := expect_delivered.length.toUInt32,
                    slashed := expect_slashed.length.toUInt32, paid_out := paid_out }
            else .error "to_buyer underflow"
          else .error "pool overflow"
        else .error "bond pool overflow"
    else .error "slashed total overflow"

/-! ## Lemmas: the spec quantities on a cons -/

theorem u128Max_pos : 0 < u128Max := Nat.two_pow_pos 128

theorem deliveredSeats_cons_some {seat : Seat} (rest : List Seat)
    (hs : seat.delivered.isSome = true) :
    deliveredSeats (seat :: rest) = seat :: deliveredSeats rest := by
  cases hd : seat.delivered <;> simp_all [deliveredSeats]

theorem deliveredSeats_cons_none {seat : Seat} (rest : List Seat)
    (hs : seat.delivered.isSome = false) :
    deliveredSeats (seat :: rest) = deliveredSeats rest := by
  cases hd : seat.delivered <;> simp_all [deliveredSeats]

theorem missedSeats_cons_some {seat : Seat} (rest : List Seat)
    (hs : seat.delivered.isSome = true) :
    missedSeats (seat :: rest) = missedSeats rest := by
  cases hd : seat.delivered <;> simp_all [missedSeats]

theorem missedSeats_cons_none {seat : Seat} (rest : List Seat)
    (hs : seat.delivered.isSome = false) :
    missedSeats (seat :: rest) = seat :: missedSeats rest := by
  cases hd : seat.delivered <;> simp_all [missedSeats]

/-- Every seat is delivered or missed: the Rust's `undelivered.len() < n` is "some seat
delivered". -/
theorem length_delivered_add_missed (seats : List Seat) :
    (deliveredSeats seats).length + (missedSeats seats).length = seats.length := by
  induction seats with
  | nil => simp [deliveredSeats, missedSeats]
  | cons seat rest ih =>
    by_cases hs : seat.delivered.isSome = true
    · rw [deliveredSeats_cons_some rest hs, missedSeats_cons_some rest hs]
      simp only [List.length_cons]
      omega
    · have hs' : seat.delivered.isSome = false := by simpa using hs
      rw [deliveredSeats_cons_none rest hs', missedSeats_cons_none rest hs']
      simp only [List.length_cons]
      omega

theorem P_cons (seat : Seat) (rest : List Seat) : P (seat :: rest) = seat.price + P rest := by
  simp [P]

theorem D_cons_some {seat : Seat} (rest : List Seat) (hs : seat.delivered.isSome = true) :
    D (seat :: rest) = seat.price + D rest := by
  simp [D, deliveredSeats_cons_some rest hs]

theorem D_cons_none {seat : Seat} (rest : List Seat) (hs : seat.delivered.isSome = false) :
    D (seat :: rest) = D rest := by
  simp [D, deliveredSeats_cons_none rest hs]

theorem expectedL_cons_some (budget bond tp dp td : Nat) {seat : Seat} (rest : List Seat)
    (hs : seat.delivered.isSome = true) :
    expectedL budget bond tp dp td (seat :: rest) =
      payoutOf budget bond tp dp td seat :: expectedL budget bond tp dp td rest := by
  simp [expectedL, deliveredSeats_cons_some rest hs]

theorem expectedL_cons_none (budget bond tp dp td : Nat) {seat : Seat} (rest : List Seat)
    (hs : seat.delivered.isSome = false) :
    expectedL budget bond tp dp td (seat :: rest) = expectedL budget bond tp dp td rest := by
  simp [expectedL, deliveredSeats_cons_none rest hs]

theorem paidOutL_cons_some (budget bond tp dp td : Nat) {seat : Seat} (rest : List Seat)
    (hs : seat.delivered.isSome = true) :
    paidOutL budget bond tp dp td (seat :: rest) =
      lineTotal (payoutOf budget bond tp dp td seat) + paidOutL budget bond tp dp td rest := by
  simp [paidOutL, expectedL_cons_some budget bond tp dp td rest hs]

theorem paidOutL_cons_none (budget bond tp dp td : Nat) {seat : Seat} (rest : List Seat)
    (hs : seat.delivered.isSome = false) :
    paidOutL budget bond tp dp td (seat :: rest) = paidOutL budget bond tp dp td rest := by
  simp [paidOutL, expectedL_cons_none budget bond tp dp td rest hs]

theorem slashedMembers_cons_some {seat : Seat} (rest : List Seat)
    (hs : seat.delivered.isSome = true) :
    slashedMembers (seat :: rest) = slashedMembers rest := by
  simp [slashedMembers, missedSeats_cons_some rest hs]

theorem slashedMembers_cons_none {seat : Seat} (rest : List Seat)
    (hs : seat.delivered.isSome = false) :
    slashedMembers (seat :: rest) = seat.member :: slashedMembers rest := by
  simp [slashedMembers, missedSeats_cons_none rest hs]

theorem expectedL_length (budget bond tp dp td : Nat) (seats : List Seat) :
    (expectedL budget bond tp dp td seats).length = (deliveredSeats seats).length := by
  simp [expectedL]

theorem slashedMembers_length (seats : List Seat) :
    (slashedMembers seats).length = (missedSeats seats).length := by
  simp [slashedMembers]

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

/-- The rule 2 loop: with the delivered sum at most the total sum (the invariant the Rust
maintains), it succeeds iff the total price fits, and returns P, D and the missed count. -/
theorem priceLoop_ok_iff (l : List Seat) (t d m r1 r2 r3 : Nat) (hdt : d ≤ t)
    (ht : t < u128Max) :
    priceLoop l t d m = .ok (r1, r2, r3) ↔
      t + P l < u128Max ∧ r1 = t + P l ∧ r2 = d + D l ∧ r3 = m + (missedSeats l).length := by
  induction l generalizing t d m with
  | nil =>
    simp only [priceLoop, Except.ok.injEq, Prod.mk.injEq, P, D, deliveredSeats, missedSeats,
      List.map_nil, List.sum_nil, List.filter_nil, List.length_nil]
    omega
  | cons seat rest ih =>
    by_cases hs : seat.delivered.isSome = true
    · simp only [priceLoop, hs, ↓reduceIte, P_cons, D_cons_some rest hs,
        missedSeats_cons_some rest hs]
      split
      · rename_i hlt
        have hd : d + seat.price < u128Max := by omega
        simp only [hd, ↓reduceIte]
        rw [ih _ _ _ (by omega) hlt]
        omega
      · constructor
        · intro h; simp at h
        · intro h; omega
    · have hs' : seat.delivered.isSome = false := by simpa using hs
      simp only [priceLoop, hs', Bool.false_eq_true, ↓reduceIte, P_cons, D_cons_none rest hs',
        missedSeats_cons_none rest hs', List.length_cons]
      split
      · rename_i hlt
        rw [ih _ _ _ (by omega) hlt]
        omega
      · constructor
        · intro h; simp at h
        · intro h; omega

theorem slashedShare_eq (dp td price : Nat) :
    slashedShare dp td price =
      if dp = 0 ∨ td * price < u128Max then .ok (td * price / dp)
      else .error "slashed share overflow" := by
  unfold slashedShare
  by_cases hd : dp = 0
  · subst hd; simp
  · have hd' : dp > 0 := by omega
    by_cases hm : td * price < u128Max
    · simp [hd, hd', hm]
    · simp [hd, hd', hm]

/-- The rules 4 to 6 loop: it succeeds iff every line's checked products and sum fit and the
running paid_out fits, and it returns the lines, the slashed members and paid_out, appended
in seat order. -/
theorem payoutLoop_ok_iff (budget bond tp dp td : Nat) (l : List Seat) (ed : List Payout)
    (es : List String) (po : Nat) (r1 : List Payout) (r2 : List String) (r3 : Nat)
    (hpo : po < u128Max) :
    payoutLoop budget bond tp dp td l ed es po = .ok (r1, r2, r3) ↔
      (∀ seat ∈ deliveredSeats l,
        budget * seat.price < u128Max ∧ (dp = 0 ∨ td * seat.price < u128Max) ∧
        lineTotal (payoutOf budget bond tp dp td seat) < u128Max) ∧
      po + paidOutL budget bond tp dp td l < u128Max ∧
      r1 = ed ++ expectedL budget bond tp dp td l ∧ r2 = es ++ slashedMembers l ∧
      r3 = po + paidOutL budget bond tp dp td l := by
  induction l generalizing ed es po with
  | nil =>
    simp only [payoutLoop, Except.ok.injEq, Prod.mk.injEq, deliveredSeats, expectedL, paidOutL,
      slashedMembers, missedSeats, List.filter_nil, List.map_nil, List.sum_nil, List.append_nil,
      List.not_mem_nil, false_implies, implies_true, true_and, Nat.add_zero, hpo]
    constructor
    · rintro ⟨h1, h2, h3⟩; exact ⟨h1.symm, h2.symm, h3.symm⟩
    · rintro ⟨h1, h2, h3⟩; exact ⟨h1.symm, h2.symm, h3.symm⟩
  | cons seat rest ih =>
    by_cases hs : seat.delivered.isSome = true
    · simp only [payoutLoop, hs, ↓reduceIte, slashedShare_eq, deliveredSeats_cons_some rest hs,
        expectedL_cons_some budget bond tp dp td rest hs,
        paidOutL_cons_some budget bond tp dp td rest hs, slashedMembers_cons_some rest hs,
        List.forall_mem_cons, lineTotal, payoutOf]
      simp only [lineTotal, payoutOf] at ih
      -- the two floor quotients as atoms, so omega sees them as naturals
      generalize budget * seat.price / tp = sh
      generalize td * seat.price / dp = fs
      by_cases h1 : budget * seat.price < u128Max
      · simp only [h1, ↓reduceIte, true_and]
        by_cases h2 : dp = 0 ∨ td * seat.price < u128Max
        · simp only [h2, ↓reduceIte, true_and]
          by_cases h3 : bond + sh < u128Max
          · simp only [h3, ↓reduceIte]
            by_cases h4 : bond + sh + fs < u128Max
            · simp only [h4, ↓reduceIte, true_and]
              by_cases h5 : po + (bond + sh + fs) < u128Max
              · simp only [h5, ↓reduceIte]
                rw [ih _ _ _ h5]
                simp only [List.append_assoc, List.singleton_append, Nat.add_assoc]
              · simp only [h5, ↓reduceIte]
                constructor
                · intro h; simp at h
                · intro h; omega
            · simp only [h4, ↓reduceIte]
              constructor
              · intro h; simp at h
              · intro h; omega
          · simp only [h3, ↓reduceIte]
            constructor
            · intro h; simp at h
            · intro h; omega
        · simp [h2]
      · simp [h1]
    · have hs' : seat.delivered.isSome = false := by simpa using hs
      simp only [payoutLoop, hs', Bool.false_eq_true, ↓reduceIte, deliveredSeats_cons_none rest hs',
        expectedL_cons_none budget bond tp dp td rest hs',
        paidOutL_cons_none budget bond tp dp td rest hs', slashedMembers_cons_none rest hs']
      rw [ih _ _ _ hpo]
      simp only [List.append_assoc, List.singleton_append]

theorem toNat_toUInt32_of_lt {n : Nat} (h : n < 2 ^ 32) : n.toUInt32.toNat = n := by
  simp [Nat.toUInt32, Nat.mod_eq_of_lt h]

/-- An `if c { ... } else { return Err(e) }` succeeds iff `c` holds and the body succeeds. -/
theorem ite_ok_iff {α : Type} {c : Prop} [Decidable c] {x : Except String α} {e : String}
    {o : α} : ((if c then x else .error e) = .ok o) ↔ (c ∧ x = .ok o) := by
  split <;> simp_all

/-- An `if c { return Err(e) }` succeeds iff `c` fails and the rest succeeds. -/
theorem ite_err_iff {α : Type} {c : Prop} [Decidable c] {x : Except String α} {e : String}
    {o : α} : ((if c then .error e else x) = .ok o) ↔ (¬ c ∧ x = .ok o) := by
  split <;> simp_all

/-- The v2 guard in the model's terms is the spec's `delivered_price_pos`: the missed count is
below the seat count iff the delivered seats are not empty. -/
theorem not_guard_iff_delivered_price_pos (seats : List Seat) :
    ¬ ((missedSeats seats).length < seats.length ∧ D seats = 0) ↔
      (deliveredSeats seats ≠ [] → 0 < D seats) := by
  have hsum := length_delivered_add_missed seats
  constructor
  · intro h hne
    have hpos := List.length_pos_iff.mpr hne
    omega
  · rintro h ⟨hlt, hD⟩
    have hpos : 0 < (deliveredSeats seats).length := by omega
    have := h (List.ne_nil_of_length_pos hpos)
    omega

/-! ## The theorem: the model agrees with the spec -/

theorem check_ok_iff_spec (p : Public) (s : Private) (o : Output) :
    check C p s = .ok o ↔ Spec C p s o := by
  have hdl : (deliveredSeats s.seats).length ≤ s.seats.length := List.length_filter_le _ _
  have hml : (missedSeats s.seats).length ≤ s.seats.length := List.length_filter_le _ _
  unfold check
  simp only [ne_eq, ite_not, Bool.not_eq_true']
  constructor
  · intro h
    simp only [ite_ok_iff, ite_err_iff] at h
    obtain ⟨hroot, hcount, hlegs, hdup, h⟩ := h
    split at h
    · simp at h
    · rename_i t d m hpl
      obtain ⟨hP, rfl, rfl, rfl⟩ :=
        (priceLoop_ok_iff s.seats 0 0 0 t d m (Nat.le_refl 0) u128Max_pos).mp hpl
      simp only [Nat.zero_add] at h hP
      simp only [ite_ok_iff, ite_err_iff] at h
      obtain ⟨hpos, hdpos, hst, h⟩ := h
      split at h
      · simp at h
      · rename_i ed es po hpo
        obtain ⟨hlines, hpaid, rfl, rfl, rfl⟩ :=
          (payoutLoop_ok_iff p.budget p.bond (P s.seats) (D s.seats) _ s.seats [] [] 0 ed es po
            u128Max_pos).mp hpo
        simp only [List.nil_append, Nat.zero_add] at h hpaid
        simp only [ite_ok_iff, Except.ok.injEq] at h
        obtain ⟨hbp, hpool, hsub, hdel, hsl, htb, rfl⟩ := h
        have hl := (legsFrom_iff s.seats 0).mp (by simpa using hlegs)
        have hn := (noDupFrom_iff [] s.seats).mp (by simpa using hdup)
        refine ⟨hroot, by omega, ?_, hn.2, by omega,
          (not_guard_iff_delivered_price_pos s.seats).mp hdpos,
          hdel.symm, hsl.symm, htb.symm,
          ⟨hP, hst, ?_, hpaid, hbp, hpool, hsub⟩, ?_, ?_, rfl⟩
        · rw [hl, List.range_eq_range']
        · intro seat hseat
          obtain ⟨h1, h2, h3⟩ := hlines seat hseat
          refine ⟨h1, ?_, h3⟩
          rcases h2 with hD | h2
          · simp only [toDeliverers, hD, Nat.lt_irrefl, ↓reduceIte, Nat.zero_mul]
            exact u128Max_pos
          · exact h2
        · simp only [expectedL_length]
          exact toNat_toUInt32_of_lt (by omega)
        · simp only [slashedMembers_length]
          exact toNat_toUInt32_of_lt (by omega)
  · rintro ⟨hroot, hcount, hlegs, hdup, hpos, hdp, hdel, hsl, htb, hfits, hdv, hsc, hpo⟩
    have hl : legsFrom s.seats 0 = true :=
      (legsFrom_iff s.seats 0).mpr (by rw [hlegs, List.range_eq_range'])
    have hn : noDupFrom [] s.seats = true :=
      (noDupFrom_iff [] s.seats).mpr ⟨by simp, hdup⟩
    have hpl : priceLoop s.seats 0 0 0 =
        .ok (P s.seats, D s.seats, (missedSeats s.seats).length) :=
      (priceLoop_ok_iff s.seats 0 0 0 _ _ _ (Nat.le_refl 0) u128Max_pos).mpr
        ⟨by simpa using hfits.price_sum, by simp, by simp, by simp⟩
    have hlines : ∀ seat ∈ deliveredSeats s.seats,
        p.budget * seat.price < u128Max ∧
        (D s.seats = 0 ∨ toDeliverers p.bond s.seats * seat.price < u128Max) ∧
        lineTotal (payoutOf p.budget p.bond (P s.seats) (D s.seats) (toDeliverers p.bond s.seats)
          seat) < u128Max := by
      intro seat hseat
      obtain ⟨h1, h2, h3⟩ := hfits.lines seat hseat
      exact ⟨h1, Or.inr h2, h3⟩
    have hpo' : payoutLoop p.budget p.bond (P s.seats) (D s.seats) (toDeliverers p.bond s.seats)
        s.seats [] [] 0 =
        .ok (expectedDelivered p.budget p.bond s.seats, slashedMembers s.seats,
          paidOut p.budget p.bond s.seats) :=
      (payoutLoop_ok_iff p.budget p.bond (P s.seats) (D s.seats) (toDeliverers p.bond s.seats)
        s.seats [] [] 0 _ _ _ u128Max_pos).mpr
        ⟨hlines, by simpa [paidOut] using hfits.paid_out, by simp [expectedDelivered], by simp,
          by simp [paidOut]⟩
    have hcount' : ¬ (s.seats.length < 1 ∨ s.seats.length > 8) := by omega
    have hpos' : ¬ P s.seats = 0 := by omega
    have hdp' : ¬ ((missedSeats s.seats).length < s.seats.length ∧ D s.seats = 0) :=
      (not_guard_iff_delivered_price_pos s.seats).mpr hdp
    have hst : p.bond * (missedSeats s.seats).length < u128Max := hfits.slashed_total
    have hbp : p.bond * s.seats.length < u128Max := hfits.bond_pool
    have hpool : p.budget + p.bond * s.seats.length < u128Max := hfits.pool
    have hsub : paidOut p.budget p.bond s.seats ≤ p.budget + p.bond * s.seats.length :=
      hfits.to_buyer
    have hdel' : expectedDelivered p.budget p.bond s.seats = p.delivered := hdel.symm
    have hsl' : slashedMembers s.seats = p.slashed := hsl.symm
    have htb' : p.budget + p.bond * s.seats.length - paidOut p.budget p.bond s.seats =
        p.to_buyer := htb.symm
    simp only [toDeliverers, slashedTotal] at hpo'
    simp only [hroot, hcount', hl, hn, hpl, hpos', hdp', hst, hpo', hbp, hpool, hsub, hdel', hsl',
      htb', ↓reduceIte, Bool.true_eq_false, Except.ok.injEq]
    cases o
    simp only [Output.mk.injEq]
    refine ⟨?_, ?_, hpo.symm⟩
    · apply UInt32.toNat.inj
      rw [hdv, ← hdel', expectedDelivered, expectedL_length]
      exact toNat_toUInt32_of_lt (by omega)
    · apply UInt32.toNat.inj
      rw [hsc, ← hsl', slashedMembers_length]
      exact toNat_toUInt32_of_lt (by omega)

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
  refine ⟨?_, ?_, ?_⟩
  · apply UInt32.toNat.inj; rw [h.deliverers, h'.deliverers]
  · apply UInt32.toNat.inj; rw [h.slashed_count, h'.slashed_count]
  · exact h.paid_out.trans h'.paid_out.symm

/-! ## The spec's vectors through the model -/

namespace Vectors

def jobC : List Seat := [
  { leg := 0, member := "m01.bookerbob.testnet", price := 48000000,
    delivered := some "63957149e4f0d670da818c778b9395a1dcfdfd2b0426ae0f37a422e0e55bcedd" },
  { leg := 1, member := "h05.bookerbob.testnet", price := 450000000, delivered := none },
  { leg := 2, member := "m02.bookerbob.testnet", price := 45000000,
    delivered := some "94102e551365daa87d9f114fa47296d40f1e246b2de8acd912baaedd520d902a" } ]

/-- Vector 3: job C with every delivered seat at price 0, so D = 0 while P > 0. -/
def jobZero : List Seat := [
  { leg := 0, member := "m01.bookerbob.testnet", price := 0,
    delivered := some "63957149e4f0d670da818c778b9395a1dcfdfd2b0426ae0f37a422e0e55bcedd" },
  { leg := 1, member := "h05.bookerbob.testnet", price := 450000000, delivered := none },
  { leg := 2, member := "m02.bookerbob.testnet", price := 0,
    delivered := some "94102e551365daa87d9f114fa47296d40f1e246b2de8acd912baaedd520d902a" } ]

def root : Bytes32 := List.replicate 32 7
def Ctab (seats : List Seat) : CommitFn (List Seat) := CommitFn.table [(seats, root)]

def pub (to_buyer : Nat) : Public :=
  { coalition := "coalition.bookerbob-demo.testnet", job := 2, seats_root := root,
    budget := 30000000, bond := 5000000,
    delivered := [
      { member := "m01.bookerbob.testnet", bond_back := 5000000, share := 2651933,
        from_slashed := 1290322 },
      { member := "m02.bookerbob.testnet", bond_back := 5000000, share := 2486187,
        from_slashed := 1209677 } ],
    slashed := ["h05.bookerbob.testnet"], to_buyer := to_buyer }

/-- The announcement of vector 3: bond back only, share 0, from_slashed 0, to_buyer 35000000. -/
def pubZero : Public :=
  { coalition := "coalition.bookerbob-demo.testnet", job := 2, seats_root := root,
    budget := 30000000, bond := 5000000,
    delivered := [
      { member := "m01.bookerbob.testnet", bond_back := 5000000, share := 0, from_slashed := 0 },
      { member := "m02.bookerbob.testnet", bond_back := 5000000, share := 0, from_slashed := 0 } ],
    slashed := ["h05.bookerbob.testnet"], to_buyer := 35000000 }

-- vector 1: job C as finalized on chain, expect deliverers 2, slashed 1, paid_out 17638119
#eval check (Ctab jobC) (pub 27361881) ⟨jobC⟩
-- vector 2: a lead that pays itself one unit more, expect refuse
#eval check (Ctab jobC) (pub 27361882) ⟨jobC⟩
-- vector 3 (v2): every delivered seat has price 0 (D = 0), expect refuse "delivered price is zero"
#eval check (Ctab jobZero) pubZero ⟨jobZero⟩

end Vectors

end Smith.S_141a68aed288f1c4
