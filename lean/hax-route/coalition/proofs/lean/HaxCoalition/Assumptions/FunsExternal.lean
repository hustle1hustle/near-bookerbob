-- [hax_coalition]: external functions.
-- Seeded by hax from Extraction/FunsExternal_Template.lean: fill the holes.
-- hax never modifies this file; after re-extraction, compare it against the
-- regenerated template to see what changed.
module
public import Aeneas
public import CoreModels
public import HaxCoalition.Extraction.Types
@[expose] public section
open CoreModels Aeneas
open Aeneas.Std hiding namespace core alloc
open RustM ControlFlow Error
open Std.Do
set_option linter.dupNamespace false
set_option linter.hashCommand false
set_option linter.unusedVariables false
set_option linter.style.whitespace false
set_option linter.style.setOption false
set_option linter.style.longLine false
set_option linter.internalConstructors false

/- You can set the `maxHeartbeats` value with the `-max-heartbeats` CLI option -/
set_option maxHeartbeats 1000000

/- You can set the `maxRecDepth` value with the `-max-recdepth` CLI option -/
set_option maxRecDepth 2048
open hax_coalition

/-- [hax_coalition::smith_std::commit]:
    Source: 'src/smith_std.rs', lines 28:0-31:1
    Visibility: public -/
axiom smith_std.commit
  {T : Type _} : Str → T → RustM (Array Std.U8 32#usize)

/-! ## gap-hax: hand models of the two std items hax-lean v0.3.41 does not model yet.
These are TRUSTED (part of the base): each is a one-line restatement of Rust's documented
behavior. `alloc.string.String` is `_root_.String` in CoreModels (valid UTF-8, like Rust's).

* `String::as_bytes` is the UTF-8 byte view. A Rust `String` never exceeds `isize::MAX` bytes;
  a Lean `String` has no bound, so the model fails (panics) on a string longer than `usize`
  can index. The theorem carries "every string fits a usize" as a hypothesis (a Rust type
  invariant, guaranteed by decoding).
* `PartialEq for String` is byte equality, which for valid UTF-8 is `String` equality. -/
namespace CoreModels

def alloc.string.String.as_bytes (s : alloc.string.String) : RustM (Slice Std.U8) :=
  let l : List Std.U8 := (show String from s).toByteArray.toList.map
    (fun x => ⟨ x.toNat, by cases x; simp only [UInt8.toNat_ofBitVec, UScalarTy.U8_numBits_eq, Nat.reducePow]; omega ⟩)
  if h : l.length ≤ Usize.max then ok (Slice.from l h) else fail .panic

def alloc.string.String.Insts.CoreCmpPartialEqString.eq
    (a b : alloc.string.String) : RustM Bool :=
  ok (decide ((show String from a) = (show String from b)))

end CoreModels
