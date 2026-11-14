/-!
# The commitment form every smith spec uses

`smith_std::commit(tag, value) = sha256(tag || postcard(value))` (zk/smith/template/smith_std.rs).

The Lean model takes the commitment as a parameter: a `CommitFn α` is any function from a tag
and a value to 32 bytes, and every spec, model and theorem is stated for an arbitrary one. Nothing
about the check depends on what the bytes are, only on the fact that the check compares the same
function of the same private input that the spec names. That is exactly the trust boundary a
Rust-to-Lean translation (Aeneas, hax) would also leave: the `sha2` and `postcard` crates are
treated as trusted external functions. A parameter rather than `opaque` constants keeps the
exported delta free of axiom-like declarations (Emet's and the attester's delta rules).
-/

namespace Smith

/-- 32 bytes. Modeled as a byte list; only equality is used. -/
abbrev Bytes32 := List UInt8

/-- `smith_std::commit(tag, value) = sha256(tag || postcard(value))` for values of type `α`, as
an arbitrary function: the theorems hold for every `CommitFn`, the real one included. -/
structure CommitFn (α : Type) where
  commit : String → α → Bytes32

/-- A stand-in for running the models on vectors: the commitment of one known value is the root
the Rust side computed for it; anything else gets zeros. -/
def CommitFn.table {α : Type} [DecidableEq α] (known : List (α × Bytes32)) : CommitFn α :=
  ⟨fun _ v => ((known.find? fun kv => kv.1 == v).map (·.2)).getD (List.replicate 32 0)⟩

/-- `u32::checked_add` on a Nat-valued counter: the result is the Nat sum when it fits in u32. -/
def u32CheckedAdd (a b : Nat) : Option Nat :=
  if a + b < 2 ^ 32 then some (a + b) else none

/-- `u64::checked_add` on a Nat-valued accumulator. -/
def u64CheckedAdd (a b : Nat) : Option Nat :=
  if a + b < 2 ^ 64 then some (a + b) else none

theorem u32CheckedAdd_eq_some {a b c : Nat} :
    u32CheckedAdd a b = some c ↔ a + b < 2 ^ 32 ∧ c = a + b := by
  unfold u32CheckedAdd; split <;> simp_all <;> omega

theorem u64CheckedAdd_eq_some {a b c : Nat} :
    u64CheckedAdd a b = some c ↔ a + b < 2 ^ 64 ∧ c = a + b := by
  unfold u64CheckedAdd; split <;> simp_all <;> omega

end Smith
