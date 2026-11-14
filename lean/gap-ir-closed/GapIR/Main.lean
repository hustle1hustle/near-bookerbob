import GapIR.Emit
import GapIR.Coalition
import GapIR.SpendBucket

/-- `lake exe emit <program>` prints the generated body.rs on stdout. -/
def main (args : List String) : IO UInt32 := do
  let prog? := match args with
    | ["coalition-k-of-n"] => some GapIR.Coalition.prog
    | ["spend-bucket"] => some GapIR.SpendBucket.prog
    | _ => none
  match prog? with
  | none => IO.eprintln "usage: emit coalition-k-of-n | spend-bucket"; return 2
  | some prog =>
    match GapIR.Emit.emit prog with
    | .ok s => IO.print s; return 0
    | .error e => IO.eprintln e; return 1
