import SmithLean.Commit
import SmithLean.S_141a68aed288f1c4.Types
/-!
# coalition-split v2: the reviewer's spec (agent B)

Written from `specs/coalition-split.json` (version 2) alone: `ask`, `rules`, `types`, `public`,
`private`, `output`, `vectors`, `changelog`. No code was read. One clause per rule, each quoting
the rule it formalizes; the arithmetic lives in helper `def`s named after the rule text.

Conventions (from Types.lean): u128 is `Nat`; "checked u128, overflow refuses" is the bound
`< u128Max = 2^128` on every intermediate value; floor division is Nat `/`; the commitment is the
parameter `C : CommitFn (List Seat)`, written `C.commit tag s.seats`.
-/

namespace Smith.S_141a68aed288f1c4.B

open Smith

variable (C : CommitFn (List Seat))

/-! ## Helpers, named after the rule text -/

/-- Rule 2: "A seat delivered when `delivered` is Some."
-- AMBIGUITY: `Some ""` (an empty receipt) still counts as delivered; the text keys on Some, not
on the string's content. -/
def isDelivered (x : Seat) : Bool := x.delivered.isSome

/-- The delivered seats, in seat order. -/
def deliveredSeats (s : Private) : List Seat := s.seats.filter isDelivered

/-- The seats that did not deliver, in seat order. -/
def undeliveredSeats (s : Private) : List Seat := s.seats.filter (fun x => !isDelivered x)

/-- Rule 2: "P = the sum of price over all seats". -/
def P (s : Private) : Nat := (s.seats.map (·.price)).sum

/-- Rule 2: "D = the sum of price over delivered seats". -/
def D (s : Private) : Nat := ((deliveredSeats s).map (·.price)).sum

/-- Rule 8: "deliverers = number of delivered seats". -/
def deliverersCount (s : Private) : Nat := (deliveredSeats s).length

/-- Rule 3 / rule 8: "number of seats that did not deliver". -/
def slashedCount (s : Private) : Nat := (undeliveredSeats s).length

/-- Rule 3: "slashed_total = bond * (number of seats that did not deliver)". -/
def slashed_total (p : Public) (s : Private) : Nat := p.bond * slashedCount s

/-- Rule 3: "to_deliverers = slashed_total - slashed_total / 2 when D > 0, else 0".
-- AMBIGUITY: `slashed_total - slashed_total / 2` is the ceiling half of the slashed pool (the
other half, `slashed_total / 2`, stays with the buyer through rule 5's remainder). I read the
expression literally (ceil), not as "half" (floor). -/
def to_deliverers (p : Public) (s : Private) : Nat :=
  if D s > 0 then slashed_total p s - slashed_total p s / 2 else 0

/-- Rule 4: the payout line of one delivered seat: "bond_back = bond, share = budget * price / P
(floor), from_slashed = to_deliverers * price / D (floor)". Nat `/` is floor. (With D = 0 the
Nat quotient is 0, but rule 4's refusal clause `rule4` keeps that case out of any accepted run.) -/
def expectedPayout (p : Public) (s : Private) (x : Seat) : Payout :=
  { member := x.member
    bond_back := p.bond
    share := p.budget * x.price / P s
    from_slashed := to_deliverers p s * x.price / D s }

/-- Rule 4 / rule 6: "the list of (member, bond_back, share, from_slashed) for the delivered seats
in seat order". -/
def expectedPayouts (p : Public) (s : Private) : List Payout :=
  s.seats.filterMap (fun x => if isDelivered x then some (expectedPayout p s x) else none)

/-- Rule 6: "the members of the seats that did not deliver, in seat order". -/
def slashedMembers (s : Private) : List String :=
  s.seats.filterMap (fun x => if isDelivered x then none else some x.member)

/-- One payout line's total: `bond_back + share + from_slashed`. -/
def payoutLine (y : Payout) : Nat := y.bond_back + y.share + y.from_slashed

/-- Rule 8 / rule 5: "paid_out = the sum over delivered seats of (bond_back + share +
from_slashed)". -/
def paid_out (p : Public) (s : Private) : Nat := ((expectedPayouts p s).map payoutLine).sum

/-- Rule 5: "bond * (number of seats)", the bond pool. -/
def bondPool (p : Public) (s : Private) : Nat := p.bond * s.seats.length

/-- Rule 5: "budget + bond * (number of seats)", the whole pool. -/
def pool (p : Public) (s : Private) : Nat := p.budget + bondPool p s

/-- Rule 5: "to_buyer = budget + bond * (number of seats) - the sum over delivered seats of
(bond_back + share + from_slashed)". Checked subtraction: the spec requires `paid_out ≤ pool`
(rule 7 clause), so this Nat subtraction is the exact u128 one. -/
def to_buyer (p : Public) (s : Private) : Nat := pool p s - paid_out p s

/-! ## The spec: one clause per rule -/

/-- The reviewer's reading of coalition-split v2. `Spec C p s o` holds exactly when the prover
should accept public `p` with private `s` and reveal output `o`. -/
structure Spec (C : CommitFn (List Seat)) (p : Public) (s : Private) (o : Output) : Prop where
  /-- Rule 1: "seats_root must equal commit(\"bookerbob/smith/coalition-seats/v0\", &s.seats);
  otherwise refuse. Between 1 and 8 seats, seat i has leg i, no member twice; otherwise refuse."
  -- AMBIGUITY: "between 1 and 8" read as inclusive on both ends (1 ≤ n ≤ 8). "seat i has leg i"
  read as the 0-based position in `s.seats` (the vector has legs 0, 1, 2). "no member twice" read
  as pairwise distinct member strings (`List.Nodup`), exact string equality. -/
  rule1 :
    p.seats_root = C.commit tag s.seats ∧
    (1 ≤ s.seats.length ∧ s.seats.length ≤ 8) ∧
    (∀ (i : Nat) (h : i < s.seats.length), (s.seats[i]'h).leg.toNat = i) ∧
    (s.seats.map (·.member)).Nodup
  /-- Rule 2: "A seat delivered when `delivered` is Some. P = the sum of price over all seats,
  D = the sum of price over delivered seats. P must be > 0; otherwise refuse." -/
  rule2 : 0 < P s
  /-- Rule 3: "slashed_total = bond * (number of seats that did not deliver). to_deliverers =
  slashed_total - slashed_total / 2 when D > 0, else 0." This is a definition, so the clause
  pins the helpers to the text (it holds by `rfl`); the arithmetic is in `slashed_total` and
  `to_deliverers`. -/
  rule3 :
    slashed_total p s = p.bond * slashedCount s ∧
    to_deliverers p s = (if D s > 0 then slashed_total p s - slashed_total p s / 2 else 0)
  /-- Rule 4: "For each delivered seat, in seat order: bond_back = bond, share = budget * price / P
  (floor), from_slashed = to_deliverers * price / D (floor). If any seat delivered and D = 0
  (every delivered seat has price 0), refuse; from_slashed is never computed with D = 0."
  The explicit refusal: delivered seats exist → D > 0. The per-seat formulas are
  `expectedPayout`, applied in seat order by `expectedPayouts` and checked in rule 6. -/
  rule4 : 0 < deliverersCount s → 0 < D s
  /-- Rule 5: "to_buyer = budget + bond * (number of seats) - the sum over delivered seats of
  (bond_back + share + from_slashed)." A definition, pinned by `rfl`; the value is `to_buyer`.
  -- AMBIGUITY: "number of seats" read as all seats (delivered and not), i.e. the whole bond pool
  posted by the coalition, not only the slashed ones. The vector confirms it: 30000000 +
  5000000 * 3 - 17638119 = 27361881. -/
  rule5 : to_buyer p s = p.budget + p.bond * s.seats.length - paid_out p s
  /-- Rule 6: "p.delivered must equal exactly the list of (member, bond_back, share, from_slashed)
  for the delivered seats in seat order; p.slashed must equal exactly the members of the seats
  that did not deliver, in seat order; p.to_buyer must equal to_buyer. Otherwise refuse."
  Exact list equality: same length, same order, same fields. -/
  rule6 :
    p.delivered = expectedPayouts p s ∧
    p.slashed = slashedMembers s ∧
    p.to_buyer = to_buyer p s
  /-- Rule 7: "All arithmetic is checked u128; any overflow refuses." Every intermediate value
  stays below `u128Max`: the price sums P and D; bond times the number of undelivered seats
  (slashed_total; to_deliverers ≤ slashed_total needs no clause); budget times price and
  to_deliverers times price for each delivered seat; each payout line; paid_out; bond times the
  seat count; budget plus the bond pool; and the checked subtraction in to_buyer: the pool is at
  least the paid-out total.
  -- AMBIGUITY: partial sums of a Nat sum are bounded by the total, so one bound on each total
  covers every checked_add along the way; the inputs themselves (budget, bond, each price) are
  below 2^128 by decoding (Types.lean) and get no clause. -/
  rule7 :
    P s < u128Max ∧
    D s < u128Max ∧
    slashed_total p s < u128Max ∧
    (∀ x ∈ deliveredSeats s, p.budget * x.price < u128Max) ∧
    (∀ x ∈ deliveredSeats s, to_deliverers p s * x.price < u128Max) ∧
    (∀ y ∈ expectedPayouts p s, payoutLine y < u128Max) ∧
    paid_out p s < u128Max ∧
    bondPool p s < u128Max ∧
    pool p s < u128Max ∧
    paid_out p s ≤ pool p s
  /-- Rule 8: "Output: deliverers = number of delivered seats, slashed = number of seats that did
  not deliver, paid_out = the sum over delivered seats of (bond_back + share + from_slashed)."
  The two counts are at most 8 (rule 1), so `UInt32.ofNat` is exact. -/
  rule8 :
    o.deliverers = UInt32.ofNat (deliverersCount s) ∧
    o.slashed = UInt32.ofNat (slashedCount s) ∧
    o.paid_out = paid_out p s

/-- The output is a function of the inputs: two accepted runs on the same `p`, `s` reveal the
same `o`. -/
theorem spec_unique {p : Public} {s : Private} {o o' : Output}
    (h : Spec C p s o) (h' : Spec C p s o') : o = o' := by
  obtain ⟨hd, hs, hp⟩ := h.rule8
  obtain ⟨hd', hs', hp'⟩ := h'.rule8
  cases o; cases o'
  simp only at hd hs hp hd' hs' hp'
  subst hd hs hp hd' hs' hp'
  rfl

/-! Sanity check of the helpers against the spec's first vector ("job C as finalized on chain"):
the recomputed payouts, the buyer's remainder and the output are the announced ones. -/
section Vector

private def seatsC : List Seat :=
  [ { leg := 0, member := "m01.bookerbob.testnet", price := 48000000,
      delivered := some "63957149e4f0d670da818c778b9395a1dcfdfd2b0426ae0f37a422e0e55bcedd" },
    { leg := 1, member := "h05.bookerbob.testnet", price := 450000000, delivered := none },
    { leg := 2, member := "m02.bookerbob.testnet", price := 45000000,
      delivered := some "94102e551365daa87d9f114fa47296d40f1e246b2de8acd912baaedd520d902a" } ]

private def publicC : Public :=
  { coalition := "coalition.bookerbob-demo.testnet", job := 2, seats_root := []
    budget := 30000000, bond := 5000000
    delivered :=
      [ { member := "m01.bookerbob.testnet", bond_back := 5000000, share := 2651933,
          from_slashed := 1290322 },
        { member := "m02.bookerbob.testnet", bond_back := 5000000, share := 2486187,
          from_slashed := 1209677 } ]
    slashed := ["h05.bookerbob.testnet"]
    to_buyer := 27361881 }

private def privateC : Private := { seats := seatsC }

example : expectedPayouts publicC privateC = publicC.delivered := by decide
example : slashedMembers privateC = publicC.slashed := by decide
example : to_buyer publicC privateC = publicC.to_buyer := by decide
example : paid_out publicC privateC = 17638119 := by decide
example : deliverersCount privateC = 2 ∧ slashedCount privateC = 1 := by decide

end Vector

end Smith.S_141a68aed288f1c4.B
