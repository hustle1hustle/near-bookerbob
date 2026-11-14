#!/usr/bin/env bash
# Builds the NEAR contract: MVP wasm (NEAR's VM has no sign-ext / bulk-memory), then wasm-opt.
set -euo pipefail
cd "$(dirname "$0")/.."
RUSTFLAGS='-C target-cpu=mvp --cfg near --cfg getrandom_backend="custom"' CARGO_TARGET_DIR="$PWD/target" \
  cargo build --release --target wasm32-unknown-unknown --lib
wasm-opt -O3 -ocimfs=200 --signext-lowering --llvm-memory-copy-fill-lowering --enable-bulk-memory --enable-sign-ext \
  target/wasm32-unknown-unknown/release/bookerbob_jolt_onchain.wasm -o target/jolt_onchain.wasm
ls -l target/jolt_onchain.wasm | awk '{print "wasm bytes", $5}'
