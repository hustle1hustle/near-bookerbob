# gap-ir: what an auditor has to check, once, for every program

The smith writes a check once, as a Lean term `prog : GapIR.Prog`. Lean proves facts about
`GapIR.run prog` (the IR semantics, `GapIR/IR.lean`). `GapIR.Emit.emit prog` (`GapIR/Emit.lean`,
117 lines) prints the `body.rs` that the unchanged smith template compiles and Jolt runs. The only
link that is not machine-checked is: **each Rust idiom below means what the IR constructor means**.
It is program-independent, so it is reviewed once, not per check. That the file Jolt compiles is
exactly the printer's output for the proved term is a kernel theorem (`GapIR/Pin.lean`) plus a byte
compare (`tools/pin.py --check`).

Conventions that make the table short: every subexpression is parenthesized; every read that binds
or assigns goes through `.clone()`, so the Rust program has value semantics (no moves, no aliasing,
no borrow outlives a statement); compound values are never mutated; names are `[a-z][a-z0-9_]*`,
not keywords or primitives, and `v` is reserved; messages and tags are printable ASCII without `"`
or `\`, so nothing is escaped. Anything else is refused by the printer, not escaped.

| IR | Rust emitted | IR meaning (`evalE` / `exec`) | why they agree |
|---|---|---|---|
| `var x` | `x` | innermost binding of `x` | Rust lexical scope; `restore` drops a block's bindings on exit |
| `int w n` | `{n}{w}` e.g. `64usize` | `n` if `n < 2^bits w` | out-of-range literal is a rustc error (deny lint) |
| `bool b` | `true` / `false` | | |
| `field e f` | `(E).f` | field `f` of a record | types.rs is generated from the same spec field names |
| `len e` | `(E).len()` | list length; byte length of a string | `Vec::len`, `String::len` and `<[u8]>::len` are counts / bytes |
| `bytes e` | `(E).as_bytes()` | the string's UTF-8 bytes as u8 ints | `str::as_bytes` |
| `cast w e` | `((E) as w)` | `n mod 2^bits w` | unsigned `as` truncates |
| `cmp op a b` | `((A) op (B))` | numeric compare, same width or stuck | rustc rejects mixed widths |
| `eq`/`ne` | `((A) == (B))` / `!=` | ints, bools, bytes, lists of ints; else stuck | derived/std `PartialEq` on those types |
| `and`/`or`/`not` | `&&` `\|\|` `!` | short-circuit | Rust `&&`/`\|\|` short-circuit |
| `commit tag e` | `commit("tag", &(E))` | the parameter `cm tag v` | assumption `CommitAgrees` (sha2 + postcard, same as every approach) |
| `let_ x e` | `let [mut] x = (E).clone();` | push `(x, v)` | `mut` iff `x` is assigned anywhere (warning-only difference) |
| `set x e` | `x = (E).clone();` | update innermost `x` | |
| `checked op x a b m` | `x = match (A).checked_op(B) { Some(v) => v, None => return Err("m") };` | `a+b < 2^bits` / `b ≤ a`, else `err m` | `checked_add` / `checked_sub` on unsigned |
| `refuse m` | `return Err("m");` | `err m` | |
| `ite c t e` | `if C { T } else { E }` | branch, then drop the block's bindings | |
| `forEach i x src b` | `for (i, x) in (SRC).iter().enumerate() { let x = x.clone(); B }` | iterate a snapshot of the list, `i` from 0 as usize, each iteration its own scope | the body cannot mutate the source (no compound mutation; a `set` of the source variable is a borrow error, i.e. fails closed) |
| `matchOpt e x s n` | `match (E).clone() { Some(x) => { S } None => { N } }` | | |
| `Prog.out` | `Ok(Output { f: (E).clone(), .. })` | record of the fields | rustc checks field names and types |

Direction of failure: wherever the two could disagree on an ill-typed program (mixed widths, a
field that does not exist, comparing strings with `<`), the IR is `stuck` and rustc refuses to
compile. The theorem `run_not_stuck` proves the shipped program is never stuck, so the program the
proof covers is in the domain where the table applies.

Evidence beyond reading: three-way differential runs on the same inputs, every refusal path hit:
original model-written body.rs, IR-generated body.rs (both through the template's `run`, exact
postcard decoding), and `GapIR.run` compiled from Lean. coalition-k-of-n 20,003 cases (the spec's
3 vectors + 20,000 structured random), spend-bucket 20,000: zero disagreements in verdict, output
and refusal message. The generated files pass the smith's own lint (`agents/smith/lint.wasm`) and
compile for `riscv64imac-unknown-none-elf` with the guest
toolchain pin (Rust 1.95) inside the unchanged template crate.
