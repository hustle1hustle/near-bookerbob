# Rebuild delta a1dc658b (coalition-split, Smith.S_141a68aed288f1c4) with stock Lean 4.35.0
1. Install elan and run `lake build SmithLean.S_141a68aed288f1c4.Export` (the Lean kernel checks every proof); the toolchain is pinned by lean-toolchain.
2. `mkdir -p dist/base && sh tools/base.sh` builds the sealed base: dist/base/base.ndjson, sha256 59ad6e663c775c96f0066f1668f50573777ac5bd6cd5d98c19bfc86365c643a8.
3. `N=Smith.S_141a68aed288f1c4; lake env $(dirname $(elan which lean))/leanexport SmithLean.S_141a68aed288f1c4.Export -- $(cat tools/base-roots.txt) $N.check_ok_iff_spec $N.spec_a_iff_spec_b $N.Spec $N.check $N.B.Spec $N.Public $N.Private $N.Output > export-full.ndjson`
4. `python3 -I tools/split.py export-full.ndjson export.ndjson --slim --base dist/base/base-full.ndjson`; export.ndjson starts with the base bytes, and the rest is the delta: 2,332,414 bytes, sha256 a1dc658bd8f0d13dda675979c60f6f54e2a1ad721c74f2d00dd7347baf692acf (the coalition-split-v2.delta asset).
5. Optionally check base plus delta with the bundled nanoda: `$(dirname $(elan which lean))/nanoda_bin` on export.ndjson; the OutLayer component does the same check inside the TEE.
