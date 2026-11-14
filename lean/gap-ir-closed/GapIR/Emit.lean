import GapIR.IR
/-!
# The codegen: IR → body.rs

Total, syntax-directed, one fixed Rust idiom per constructor (the table in AUDIT.md). Every
subexpression is parenthesized, every read of a variable is through `.clone()` (so the Rust
program has value semantics: no aliasing, no moves, no borrows that outlive a statement), and
the printer refuses names it cannot print safely instead of escaping them.

The printer builds a `List Char`, never a `String`: the kernel evaluates list appends quickly and
String appends (UTF-8 byte arrays) very slowly, and `GapIR/Pin.lean` checks the printed text of
each program in the kernel. `emit` is `String.ofList` of it, for `lake exe emit`.
-/

namespace GapIR.Emit

abbrev T := List Char

/-- A fixed piece of program text. -/
def t (s : String) : T := s.toList

def keywords : List T :=
  ["as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern",
   "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub",
   "ref", "return", "self", "static", "struct", "super", "trait", "true", "type", "unsafe", "use",
   "where", "while", "abstract", "become", "box", "do", "final", "macro", "override", "priv",
   "typeof", "unsized", "virtual", "yield", "try", "gen", "union", "u8", "u16", "u32", "u64",
   "u128", "usize", "i8", "i16", "i32", "i64", "i128", "isize", "bool", "char", "str",
   "Some", "None", "Ok", "Err", "v"].map t

def lowerOrDigit (c : Char) : Bool := ('a' ≤ c && c ≤ 'z') || ('0' ≤ c && c ≤ '9') || c == '_'

/-- `[a-z][a-z0-9_]*`, not a keyword, primitive or reserved name. -/
def okName (x : T) : Bool :=
  match x with
  | [] => false
  | c :: cs => ('a' ≤ c && c ≤ 'z') && cs.all lowerOrDigit && !keywords.contains x

/-- Refusal messages and tags: printable ASCII without `"` and `\`, so no escaping is needed. -/
def okLit (m : T) : Bool := m.all fun c => ' ' ≤ c && c ≤ '~' && c != '"' && c != '\\'

def W.rust : W → T
  | .u8 => t "u8" | .u32 => t "u32" | .u64 => t "u64" | .u128 => t "u128" | .usize => t "usize"

def Cmp.rust : Cmp → T
  | .lt => t "<" | .le => t "<=" | .gt => t ">" | .ge => t ">="

def Op.rust : Op → T
  | .add => t "checked_add" | .sub => t "checked_sub" | .mul => t "checked_mul" | .div => t "checked_div"

abbrev M := Except String

def name (x : String) : M T :=
  if okName x.toList then .ok x.toList else .error s!"name not printable: {x}"

def lit (m : String) : M T :=
  if okLit m.toList then .ok ('"' :: m.toList ++ ['"']) else .error s!"literal not printable: {m}"

def paren (a : T) : T := '(' :: a ++ [')']

/-- A type name of the spec: `[A-Z][A-Za-z0-9]*`. -/
def okType (x : T) : Bool :=
  match x with
  | [] => false
  | c :: cs => ('A' ≤ c && c ≤ 'Z') && cs.all fun c => ('A' ≤ c && c ≤ 'Z') || ('a' ≤ c && c ≤ 'z') || ('0' ≤ c && c ≤ '9')

def tyName (x : String) : M T :=
  if okType x.toList then .ok x.toList else .error s!"type not printable: {x}"

def ex : Ex → M T
  | .var x => name x
  | .int w n => if n < 2 ^ w.bits then .ok (Nat.toDigits 10 n ++ W.rust w) else .error "literal out of range"
  | .bool b => .ok (if b then t "true" else t "false")
  | .field e f => do .ok (paren (← ex e) ++ '.' :: (← name f))
  | .len e => do .ok (paren (← ex e) ++ t ".len()")
  | .bytes e => do .ok (paren (← ex e) ++ t ".as_bytes()")
  | .cast w e => do .ok (paren (paren (← ex e) ++ t " as " ++ W.rust w))
  | .cmp op a b => do .ok (paren (paren (← ex a) ++ ' ' :: Cmp.rust op ++ ' ' :: paren (← ex b)))
  | .eq a b => do .ok (paren (paren (← ex a) ++ t " == " ++ paren (← ex b)))
  | .ne a b => do .ok (paren (paren (← ex a) ++ t " != " ++ paren (← ex b)))
  | .and a b => do .ok (paren (paren (← ex a) ++ t " && " ++ paren (← ex b)))
  | .or a b => do .ok (paren (paren (← ex a) ++ t " || " ++ paren (← ex b)))
  | .not a => do .ok (paren ('!' :: paren (← ex a)))
  | .commit tag e => do .ok (t "commit(" ++ (← lit tag) ++ t ", &" ++ paren (← ex e) ++ [')'])
  | .nil => .ok (t "alloc::vec::Vec::new()")
  | .mk ty fs => do .ok ((← tyName ty) ++ t " { " ++ (← fields fs) ++ ['}'])
where
  fields : List (String × Ex) → M T
    | [] => .ok []
    | (f, e) :: rest => do .ok ((← name f) ++ t ": " ++ paren (← ex e) ++ t ".clone(), " ++ (← fields rest))

def ind (n : Nat) : T := List.replicate (4 * n) ' '

-- Names that are ever assigned; their `let` is `let mut`.
mutual
def assigned : St → List String
  | .set x _ => [x]
  | .checked _ x _ _ _ => [x]
  | .push x _ => [x]
  | .ite _ t e => assignedB t ++ assignedB e
  | .forEach _ _ _ b => assignedB b
  | .matchOpt _ _ s n => assignedB s ++ assignedB n
  | _ => []
def assignedB : List St → List String
  | [] => []
  | s :: rest => assigned s ++ assignedB rest
end

def nl : T := ['\n']

mutual
def st (muts : List String) (d : Nat) : St → M T
  | .let_ x e => do
    let m := if muts.contains x then t "mut " else []
    .ok (ind d ++ t "let " ++ m ++ (← name x) ++ t " = " ++ paren (← ex e) ++ t ".clone();" ++ nl)
  | .set x e => do .ok (ind d ++ (← name x) ++ t " = " ++ paren (← ex e) ++ t ".clone();" ++ nl)
  | .checked op x a b msg => do
    .ok (ind d ++ (← name x) ++ t " = match " ++ paren (← ex a) ++ '.' :: Op.rust op ++ paren (← ex b) ++
      t " { Some(v) => v, None => return Err(" ++ (← lit msg) ++ t ") };" ++ nl)
  | .refuse msg => do .ok (ind d ++ t "return Err(" ++ (← lit msg) ++ t ");" ++ nl)
  | .push x e => do .ok (ind d ++ (← name x) ++ t ".push(" ++ paren (← ex e) ++ t ".clone());" ++ nl)
  | .ite c th el => do
    .ok (ind d ++ t "if " ++ (← ex c) ++ t " {" ++ nl ++ (← blk muts (d+1) th) ++
      ind d ++ t "} else {" ++ nl ++ (← blk muts (d+1) el) ++ ind d ++ ['}'] ++ nl)
  | .forEach i x src b => do
    let x ← name x
    .ok (ind d ++ t "for (" ++ (← name i) ++ t ", " ++ x ++ t ") in " ++ paren (← ex src) ++
      t ".iter().enumerate() {" ++ nl ++ ind (d+1) ++ t "let " ++ x ++ t " = " ++ x ++ t ".clone();" ++ nl ++
      (← blk muts (d+1) b) ++ ind d ++ ['}'] ++ nl)
  | .matchOpt e x sm nn => do
    .ok (ind d ++ t "match " ++ paren (← ex e) ++ t ".clone() {" ++ nl ++
      ind (d+1) ++ t "Some(" ++ (← name x) ++ t ") => {" ++ nl ++ (← blk muts (d+2) sm) ++ ind (d+1) ++ ['}'] ++ nl ++
      ind (d+1) ++ t "None => {" ++ nl ++ (← blk muts (d+2) nn) ++ ind (d+1) ++ ['}'] ++ nl ++
      ind d ++ ['}'] ++ nl)
def blk (muts : List String) (d : Nat) : List St → M T
  | [] => .ok []
  | s :: rest => do .ok ((← st muts d s) ++ (← blk muts d rest))
end

def outFields : List (String × Ex) → M T
  | [] => .ok []
  | (f, e) :: rest => do
    .ok (ind 2 ++ (← name f) ++ t ": " ++ paren (← ex e) ++ t ".clone()," ++ nl ++ (← outFields rest))

def header : T :=
  t "// Generated by gap-ir from the IR program; do not edit by hand.\n" ++
  t "use crate::types::*;\nuse crate::smith_std::commit;\n\n" ++
  t "pub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {\n"

/-- The printed body.rs, as characters (what the kernel pin checks). -/
def emitT (prog : Prog) : M T := do
  let body ← blk (assignedB prog.body) 1 prog.body
  let out ← outFields prog.out
  .ok (header ++ body ++ t "    Ok(Output {\n" ++ out ++ t "    })\n}\n")

/-- The printed body.rs, for `lake exe emit`. -/
def emit (prog : Prog) : M String := (emitT prog).map String.ofList

end GapIR.Emit
