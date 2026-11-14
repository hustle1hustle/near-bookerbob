1. Install Lean via elan; the toolchain is pinned in `lean-toolchain`. Core Lean only, no Mathlib.
2. `lake build` checks every proof and prints `#print axioms` for the six theorems and two pins (expect propext, Classical.choice, Quot.sound only).
3. `lake exe emit coalition-k-of-n | cmp - out/body.rs` and `lake exe emit spend-bucket | cmp - out/spend-bucket.body.rs` show the printed Rust is these files.
4. `python3 tools/pin.py --check` shows the kernel-pinned character lists in GapIR/Pin.lean are byte for byte these files; AUDIT.md is the Rust idiom table that is trusted.
