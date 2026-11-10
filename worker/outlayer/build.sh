#!/bin/sh
# Build the OutLayer referee component and print its sha256 (the `hash` of `create_project`).
# Local paths are remapped, so the artefact carries no home directory and the hash does not
# depend on where the repo is checked out. Sends nothing.
set -eu
cd "$(dirname "$0")"
repo=$(cd ../.. && pwd)
cargo_home=${CARGO_HOME:-$HOME/.cargo}
RUSTFLAGS="--remap-path-prefix=$repo=/bookerbob --remap-path-prefix=$cargo_home=/cargo" \
  cargo build --release --locked --target wasm32-wasip2 ${JOBS:+-j "$JOBS"}
wasm=target/wasm32-wasip2/release/bookerbob-referee-outlayer.wasm
grep -aq 'outlayer.manifest' "$wasm" || { echo "FAIL  the outlayer.manifest custom section is missing from $wasm" >&2; exit 1; }
if grep -aq "$HOME" "$wasm"; then echo "FAIL  $wasm carries a local path" >&2; exit 1; fi
echo "$(shasum -a 256 "$wasm" | cut -d' ' -f1)  worker/outlayer/$wasm  $(wc -c < "$wasm" | tr -d ' ') bytes"
