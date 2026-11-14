import GapIR.IR
/-!
# coalition-k-of-n, written once in the IR

The program below is the single source: `lake exe emit coalition` prints it to body.rs, and
`GapIR/CoalitionProof.lean` proves `run` of it meets `Smith.Coalition.Spec`.
-/

namespace GapIR.Coalition
open GapIR

local notation "v" x => Ex.var x
local notation e " ∙ " f => Ex.field e f

def u32 (n : Nat) : Ex := .int .u32 n
def u8 (n : Nat) : Ex := .int .u8 n
def usz (n : Nat) : Ex := .int .usize n

def isLowerHex (c : Ex) : Ex :=
  .or (.and (.cmp .ge c (u8 48)) (.cmp .le c (u8 57)))
      (.and (.cmp .ge c (u8 97)) (.cmp .le c (u8 102)))

-- Named blocks, so the proof can state one lemma per loop body. The program is the same term.

def body3 : List St :=
  [.ite (.ne (.cast .usize ((v "seat") ∙ "leg")) (v "i")) [.refuse "seat legs not sequential"] []]

/-- Rule 3 -/
def rule3 : St := .forEach "i" "seat" ((v "s") ∙ "seats") body3

def body4 : List St :=
  [.ite (.and (.cmp .lt (v "j") (v "i")) (.eq ((v "a") ∙ "member") ((v "b") ∙ "member")))
    [.refuse "duplicate member"] []]

def body4o : List St := [.forEach "j" "b" ((v "s") ∙ "seats") body4]

/-- Rule 4: each seat against every earlier one. -/
def rule4 : St := .forEach "i" "a" ((v "s") ∙ "seats") body4o

def hexBody : List St := [.ite (.not (isLowerHex (v "c"))) [.refuse "delivery id not lowercase hex"] []]

def hexLoop : St := .forEach "j" "c" (.bytes (v "id")) hexBody

def inner56 : List St := [
  .ite (.ne (.len (.bytes (v "id"))) (usz 64)) [.refuse "delivery id not 64 chars"] [],
  hexLoop,
  .checked .add "delivered" (v "delivered") (u32 1) "delivered count overflow"]

def body56 : List St := [.matchOpt ((v "seat") ∙ "delivered") "id" inner56 []]

/-- Rules 5 and 6. -/
def rule56 : St := .forEach "i" "seat" ((v "s") ∙ "seats") body56

def prog : Prog where
  body := [
    -- Rule 1
    .let_ "root" (.commit "bookerbob/smith/coalition-seats/v0" ((v "s") ∙ "seats")),
    .ite (.ne (v "root") ((v "p") ∙ "seats_root")) [.refuse "seats_root mismatch"] [],
    -- Rule 2
    .let_ "n" (.len ((v "s") ∙ "seats")),
    .ite (.or (.cmp .lt (v "n") (usz 1)) (.cmp .gt (v "n") (usz 8)))
      [.refuse "seat count out of range"] [],
    rule3,
    rule4,
    .let_ "delivered" (u32 0),
    rule56,
    -- Rule 7
    .ite (.cmp .lt (v "delivered") ((v "p") ∙ "k_min")) [.refuse "delivered below k_min"] []
  ]
  -- Rule 8
  out := [("delivered", v "delivered"), ("seats", .cast .u32 (v "n"))]

end GapIR.Coalition
