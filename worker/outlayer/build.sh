#!/bin/sh
# Build the OutLayer referee component and print its sha256 (the `hash` of `create_project`).
# Sends nothing.
#
# Reproducible from any checkout: the sources the component needs are copied to one fixed
# directory, /tmp/bookerbob-outlayer-build (OUTLAYER_BUILD_DIR overrides it, and changes the hash),
# and built there from a clean target directory. Cargo's crate metadata hash takes
# in the absolute path of path dependencies, which --remap-path-prefix does not reach, so a
# build in the checkout itself gives a different hash per checkout path. The paths that do
# reach the artefact are remapped, so it carries no home directory. Same toolchain (rustc
# 1.96.0) and the same host OS give the same bytes; macOS resolves /tmp to /private/tmp.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
# The staging path is part of the hash; the default is the pinned one the releases use.
stage=${OUTLAYER_BUILD_DIR:-/tmp/bookerbob-outlayer-build}
mkdir -p "$stage"
build=$(cd "$stage" && pwd -P)
cargo_home=${CARGO_HOME:-$HOME/.cargo}
rm -rf "$build/src" "$build/target"
mkdir -p "$build/src"
# The workspace manifest and its members (cargo loads them for `edition.workspace` and the
# like); no target directories.
(cd "$repo" && tar --exclude target -cf - Cargo.toml Cargo.lock core contract cli worker graph zkcore dusdc gate) | (cd "$build/src" && tar -xf -)
cd "$build/src/worker/outlayer"
RUSTFLAGS="--remap-path-prefix=$build/src=/bookerbob --remap-path-prefix=$cargo_home=/cargo" CARGO_TARGET_DIR="$build/target" \
  cargo build --release --locked --target wasm32-wasip2 ${JOBS:+-j "$JOBS"}
out=$build/target/wasm32-wasip2/release/bookerbob-referee-outlayer.wasm
grep -aq 'outlayer.manifest' "$out" || { echo "FAIL  the outlayer.manifest custom section is missing from $out" >&2; exit 1; }
if grep -aq "$HOME" "$out"; then echo "FAIL  $out carries a local path" >&2; exit 1; fi
if grep -aq "$build" "$out"; then echo "FAIL  $out carries the build path" >&2; exit 1; fi
# The rest of the repo (make outlayer-local, scripts/outlayer-go.mjs) reads it from here.
wasm=target/wasm32-wasip2/release/bookerbob-referee-outlayer.wasm
mkdir -p "$here/target/wasm32-wasip2/release"
cp "$out" "$here/$wasm"
echo "$(shasum -a 256 "$here/$wasm" | cut -d' ' -f1)  worker/outlayer/$wasm  $(wc -c < "$here/$wasm" | tr -d ' ') bytes"
