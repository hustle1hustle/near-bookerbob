/-!
# The smith IR: syntax and semantics (a deep embedding)

A smith check is written ONCE, as a term `prog : Prog` of this IR. The same term is
* given a meaning by `run` below (this file), about which the Lean proofs speak, and
* printed to the `body.rs` that Jolt compiles by `GapIR.Emit.emit` (Emit.lean), a total,
  syntax-directed printer, one fixed Rust idiom per IR constructor.

The IR is first-order: unsigned integers of fixed width with checked arithmetic, booleans,
strings as UTF-8 bytes, immutable lists and records (the spec's types), `Option`, immutable
iteration over a list with its index (bounded by the list), and early return of `Err(msg)`.
There is no unchecked arithmetic, no indexing, no mutation of compound values, no recursion.

Outcomes: `ok`, `err msg` (the Rust `return Err(msg)`), and `stuck` (a construct used outside
its domain, e.g. comparing a `u32` with a `u64`; such a program does not type-check in Rust).
The correctness theorem of a program proves it is never `stuck` on decoded inputs.
-/

namespace GapIR

/-- Integer widths. `usize` is 64 bits (riscv64 guest); the only usize values are lengths and
loop indices, which are bounded by memory on any target. -/
inductive W | u8 | u32 | u64 | u128 | usize
  deriving DecidableEq, Repr

def W.bits : W → Nat
  | .u8 => 8 | .u32 => 32 | .u64 => 64 | .u128 => 128 | .usize => 64

/-- Values. A record is the spec's struct as named fields, in declaration order. -/
inductive V where
  | int (w : W) (n : Nat)
  | bool (b : Bool)
  | str (bytes : List UInt8)
  | list (vs : List V)
  | opt (o : Option V)
  | struct (fs : List (String × V))
  deriving Repr, Inhabited

/-- Comparison operators on integers of one width. -/
inductive Cmp | lt | le | gt | ge
  deriving DecidableEq, Repr

inductive Ex where
  | var (x : String)
  | int (w : W) (n : Nat)
  | bool (b : Bool)
  | field (e : Ex) (f : String)
  /-- `Vec::len` on a list (element count), `String::len` / `<[u8]>::len` on bytes. -/
  | len (e : Ex)
  /-- `str::as_bytes`. -/
  | bytes (e : Ex)
  /-- `e as w` on an integer: truncation mod 2^bits. -/
  | cast (w : W) (e : Ex)
  | cmp (op : Cmp) (a b : Ex)
  | eq (a b : Ex)
  | ne (a b : Ex)
  | and (a b : Ex)
  | or (a b : Ex)
  | not (a : Ex)
  /-- `smith_std::commit(tag, &e)`, the template's sha256(tag || postcard(e)). -/
  | commit (tag : String) (e : Ex)
  /-- `Vec::new()`. -/
  | nil
  /-- `T { f: (e).clone(), .. }`, a record of one of the spec's types `T`. -/
  | mk (ty : String) (fs : List (String × Ex))
  deriving Repr, Inhabited

inductive Op | add | sub | mul | div
  deriving DecidableEq, Repr

inductive St where
  /-- `let x = (e).clone();` -/
  | let_ (x : String) (e : Ex)
  /-- `x = (e).clone();` -/
  | set (x : String) (e : Ex)
  /-- `x = match (a).checked_op(b) { Some(v) => v, None => return Err(msg) };` -/
  | checked (op : Op) (x : String) (a b : Ex) (msg : String)
  /-- `return Err(msg);` -/
  | refuse (msg : String)
  | ite (c : Ex) (t e : List St)
  /-- `for (i, x) in (src).iter().enumerate() { let x = x.clone(); body }` -/
  | forEach (i x : String) (src : Ex) (body : List St)
  /-- `x.push((e).clone());` on a local list. -/
  | push (x : String) (e : Ex)
  /-- `match (e).clone() { Some(x) => { some }, None => { none } }` -/
  | matchOpt (e : Ex) (x : String) (some none : List St)
  deriving Repr, Inhabited

/-- A check: statements, then `Ok(Output { f: (e).clone(), .. })`. -/
structure Prog where
  body : List St
  out : List (String × Ex)
  deriving Repr

/-! ## Semantics -/

inductive R (α : Type) where
  | ok (a : α)
  | err (msg : String)
  | stuck
  deriving Repr, DecidableEq

def R.bind {α β} : R α → (α → R β) → R β
  | .ok a, f => f a
  | .err m, _ => .err m
  | .stuck, _ => .stuck

def R.map {α β} (f : α → β) : R α → R β
  | .ok a => .ok (f a)
  | .err m => .err m
  | .stuck => .stuck

abbrev Env := List (String × V)

def Env.get : Env → String → Option V
  | [], _ => none
  | (y, v) :: rest, x => if x = y then some v else Env.get rest x

/-- Update the innermost binding of `x`; `none` if unbound. -/
def Env.set : Env → String → V → Option Env
  | [], _, _ => none
  | (y, w) :: rest, x, v =>
    if x = y then some ((y, v) :: rest) else ((Env.set rest x v).map ((y, w) :: ·))

/-- Leave a block: drop the bindings it introduced (Rust's lexical scope). -/
def restore (outer inner : Env) : Env := inner.drop (inner.length - outer.length)

def V.field : V → String → Option V
  | .struct fs, f => (fs.find? (·.1 == f)).map (·.2)
  | _, _ => none

def intsOf : List V → Option (List Nat)
  | [] => some []
  | .int _ n :: vs => (intsOf vs).map (n :: ·)
  | _ :: _ => none

-- `==` where the Rust types are `PartialEq` and the IR can see them: integers of one width,
-- booleans, strings, and lists and records of those (derived `PartialEq`: element by element, field
-- by field; lists of different lengths are unequal).
mutual
def V.eqv : V → V → Option Bool
  | .int w a, .int w' b => if w = w' then some (a == b) else none
  | .bool a, .bool b => some (a == b)
  | .str a, .str b => some (a == b)
  | .list a, .list b => eqvList a b
  | .struct a, .struct b => eqvFields a b
  | _, _ => none
def eqvList : List V → List V → Option Bool
  | [], [] => some true
  | [], _ :: _ => some false
  | _ :: _, [] => some false
  | x :: xs, y :: ys => match V.eqv x y, eqvList xs ys with
    | some a, some b => some (a && b)
    | _, _ => none
def eqvFields : List (String × V) → List (String × V) → Option Bool
  | [], [] => some true
  | (f, x) :: xs, (g, y) :: ys =>
    if f = g then
      match V.eqv x y, eqvFields xs ys with
      | some a, some b => some (a && b)
      | _, _ => none
    else none
  | _, _ => none
end

def Cmp.eval : Cmp → Nat → Nat → Bool
  | .lt, a, b => a < b | .le, a, b => a ≤ b | .gt, a, b => a > b | .ge, a, b => a ≥ b

/-- The commitment, a parameter: whatever `smith_std::commit` computes on the Rust value
corresponding to an IR value. -/
abbrev CommitV := String → V → V

def evalE (cm : CommitV) (env : Env) : Ex → Option V
  | .var x => env.get x
  | .int w n => if n < 2 ^ w.bits then some (.int w n) else none
  | .bool b => some (.bool b)
  | .field e f => (evalE cm env e).bind (·.field f)
  | .len e => match evalE cm env e with
    | some (.list vs) => some (.int .usize vs.length)
    | some (.str bs) => some (.int .usize bs.length)
    | _ => none
  | .bytes e => match evalE cm env e with
    | some (.str bs) => some (.list (bs.map fun b => .int .u8 b.toNat))
    | _ => none
  | .cast w e => match evalE cm env e with
    | some (.int _ n) => some (.int w (n % 2 ^ w.bits))
    | _ => none
  | .cmp op a b => match evalE cm env a, evalE cm env b with
    | some (.int w x), some (.int w' y) => if w = w' then some (.bool (op.eval x y)) else none
    | _, _ => none
  | .eq a b => match evalE cm env a, evalE cm env b with
    | some x, some y => (x.eqv y).map .bool
    | _, _ => none
  | .ne a b => match evalE cm env a, evalE cm env b with
    | some x, some y => (x.eqv y).map (.bool ∘ not)
    | _, _ => none
  | .and a b => match evalE cm env a with
    | some (.bool x) => if x then
        (match evalE cm env b with
         | some (.bool y) => some (.bool y)
         | _ => none)
      else some (.bool false)
    | _ => none
  | .or a b => match evalE cm env a with
    | some (.bool x) => if x then some (.bool true) else
        (match evalE cm env b with
         | some (.bool y) => some (.bool y)
         | _ => none)
    | _ => none
  | .not a => match evalE cm env a with
    | some (.bool x) => some (.bool !x)
    | _ => none
  | .commit tag e => (evalE cm env e).map (cm tag)
  | .nil => some (.list [])
  | .mk _ fs => (evalFields fs).map .struct
where
  evalFields : List (String × Ex) → Option (List (String × V))
    | [] => some []
    | (f, e) :: rest => match evalE cm env e, evalFields rest with
      | some v, some vs => some ((f, v) :: vs)
      | _, _ => none

def checkedOp (op : Op) (w : W) (a b : Nat) : Option Nat :=
  match op with
  | .add => if a + b < 2 ^ w.bits then some (a + b) else none
  | .sub => if b ≤ a then some (a - b) else none
  | .mul => if a * b < 2 ^ w.bits then some (a * b) else none
  | .div => if b = 0 then none else some (a / b)

/-- Iterate a body over `vs` with index `k`; each iteration is its own scope. -/
def loopOver (body : Env → R Env) (i x : String) : Env → Nat → List V → R Env
  | env, _, [] => .ok env
  | env, k, v :: vs =>
    match body ((x, v) :: (i, .int .usize k) :: env) with
    | .ok env' => loopOver body i x (restore env env') (k + 1) vs
    | .err m => .err m
    | .stuck => .stuck

mutual
def exec (cm : CommitV) (env : Env) : St → R Env
  | .let_ x e => match evalE cm env e with
    | some v => .ok ((x, v) :: env)
    | none => .stuck
  | .set x e => match evalE cm env e with
    | some v => match env.set x v with
      | some env' => .ok env'
      | none => .stuck
    | none => .stuck
  | .checked op x a b msg => match evalE cm env a, evalE cm env b with
    | some (.int w m), some (.int w' n) =>
      if w = w' then
        match checkedOp op w m n with
        | some r => match env.set x (.int w r) with
          | some env' => .ok env'
          | none => .stuck
        | none => .err msg
      else .stuck
    | _, _ => .stuck
  | .refuse msg => .err msg
  | .push x e => match env.get x, evalE cm env e with
    | some (.list vs), some v => match env.set x (.list (vs ++ [v])) with
      | some env' => .ok env'
      | none => .stuck
    | _, _ => .stuck
  | .ite c t e => match evalE cm env c with
    | some (.bool b) =>
      if b then (execB cm env t).map (restore env) else (execB cm env e).map (restore env)
    | _ => .stuck
  | .forEach i x src body => match evalE cm env src with
    | some (.list vs) => loopOver (fun env' => execB cm env' body) i x env 0 vs
    | _ => .stuck
  | .matchOpt e x sm nn => match evalE cm env e with
    | some (.opt (some v)) => (execB cm ((x, v) :: env) sm).map (restore env)
    | some (.opt none) => (execB cm env nn).map (restore env)
    | _ => .stuck

def execB (cm : CommitV) (env : Env) : List St → R Env
  | [] => .ok env
  | st :: rest => (exec cm env st).bind fun env' => execB cm env' rest
end

def evalOut (cm : CommitV) (env : Env) : List (String × Ex) → Option (List (String × V))
  | [] => some []
  | (f, e) :: rest => match evalE cm env e, evalOut cm env rest with
    | some v, some vs => some ((f, v) :: vs)
    | _, _ => none

/-- `check(p, s)`: `p` and `s` are the two parameters, bound as variables. -/
def run (cm : CommitV) (prog : Prog) (p s : V) : R V :=
  (execB cm [("s", s), ("p", p)] prog.body).bind fun env =>
    match evalOut cm env prog.out with
    | some fs => .ok (.struct fs)
    | none => .stuck

end GapIR
