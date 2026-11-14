import GapIR.IR
/-!
# spend-bucket, written once in the IR

`windows(2)` becomes a loop that keeps the previous threshold; the unchecked `bucket + 1`
becomes a `checked_add` (the IR has no unchecked arithmetic; at most 8 thresholds, so the
refusal is unreachable, which the proof has to show).
-/

namespace GapIR.SpendBucket
open GapIR

local notation "v" x => Ex.var x
local notation e " ∙ " f => Ex.field e f

def u32 (n : Nat) : Ex := .int .u32 n
def u64 (n : Nat) : Ex := .int .u64 n
def usz (n : Nat) : Ex := .int .usize n

def body2 : List St := [
  .ite (.and (.cmp .gt (v "i") (usz 0)) (.cmp .ge (v "prev") (v "t")))
    [.refuse "thresholds not strictly increasing"] [],
  .set "prev" (v "t")]

def body4 : List St :=
  [.ite (.cmp .gt ((v "r") ∙ "day") ((v "p") ∙ "as_of_day")) [.refuse "record day after as_of_day"] []]

def body5 : List St :=
  [.ite (.and (.cmp .gt ((v "r") ∙ "day") (v "lower")) (.cmp .le ((v "r") ∙ "day") ((v "p") ∙ "as_of_day")))
    [.checked .add "total" (v "total") ((v "r") ∙ "amount_cents") "total overflow"] []]

def body6 : List St :=
  [.ite (.cmp .le (v "t") (v "total")) [.checked .add "bucket" (v "bucket") (u32 1) "bucket overflow"] []]

def prog : Prog where
  body := [
    -- Rule 1
    .let_ "root" (.commit "bookerbob/smith/spend-records/v0" (v "s")),
    .ite (.ne (v "root") ((v "p") ∙ "records_root")) [.refuse "records root mismatch"] [],
    -- Rule 2
    .ite (.or (.eq (.len ((v "p") ∙ "thresholds_cents")) (usz 0)) (.cmp .gt (.len ((v "p") ∙ "thresholds_cents")) (usz 8)))
      [.refuse "thresholds count out of range"] [],
    .let_ "prev" (u64 0),
    .forEach "i" "t" ((v "p") ∙ "thresholds_cents") body2,
    -- Rule 3
    .ite (.or (.or (.cmp .lt ((v "p") ∙ "window_days") (u32 1)) (.cmp .gt ((v "p") ∙ "window_days") (u32 3650)))
        (.cmp .gt ((v "p") ∙ "window_days") ((v "p") ∙ "as_of_day")))
      [.refuse "window_days out of range"] [],
    -- Rule 4
    .ite (.cmp .gt (.len ((v "s") ∙ "records")) (usz 256)) [.refuse "too many records"] [],
    .forEach "i" "r" ((v "s") ∙ "records") body4,
    -- Rule 5
    .let_ "lower" (u32 0),
    .checked .sub "lower" ((v "p") ∙ "as_of_day") ((v "p") ∙ "window_days") "window underflow",
    .let_ "total" (u64 0),
    .forEach "i" "r" ((v "s") ∙ "records") body5,
    -- Rule 6
    .let_ "bucket" (u32 0),
    .forEach "i" "t" ((v "p") ∙ "thresholds_cents") body6
  ]
  -- Rule 7
  out := [("bucket", v "bucket")]

end GapIR.SpendBucket
