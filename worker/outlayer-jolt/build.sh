#!/bin/sh
# Build the Jolt verifier component and print its sha256 (the `hash` of `create_project`).
# Sends nothing. Like worker/outlayer/build.sh: the crate is copied to one fixed directory,
# /tmp/bookerbob-outlayer-jolt-build (OUTLAYER_JOLT_BUILD_DIR overrides it, and changes the hash),
# and built there from a clean target directory, so the hash does not depend on the checkout path.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
stage=${OUTLAYER_JOLT_BUILD_DIR:-/tmp/bookerbob-outlayer-jolt-build}
mkdir -p "$stage"
build=$(cd "$stage" && pwd -P)
cargo_home=${CARGO_HOME:-$HOME/.cargo}
rm -rf "$build/src" "$build/target"
mkdir -p "$build/src"
(cd "$here" && tar --exclude target -cf - Cargo.toml Cargo.lock manifest.json src wit programs) | (cd "$build/src" && tar -xf -)
cd "$build/src"
RUSTFLAGS="--remap-path-prefix=$build/src=/bookerbob-jolt --remap-path-prefix=$cargo_home=/cargo" CARGO_TARGET_DIR="$build/target" \
  cargo build --release --locked --target wasm32-wasip2 ${JOBS:+-j "$JOBS"}
out=$build/target/wasm32-wasip2/release/bookerbob-jolt-verify-outlayer.wasm
grep -aq 'outlayer.manifest' "$out" || { echo "FAIL  the outlayer.manifest custom section is missing from $out" >&2; exit 1; }
# The pinned programs carry the guest's memory image, which holds the paths of the machine that
# built the guest (they are part of the program hash the chain pins, and public in zk/out/). The
# module itself may add none: every $HOME string in the wasm must come from programs/.
in_wasm=$(strings -a "$out" | grep -c "$HOME" || true)
in_programs=$(cat "$here"/programs/*.dat | strings -a | grep -c "$HOME" || true)
if [ "$in_wasm" -gt "$in_programs" ]; then echo "FAIL  $out carries a local path beyond the pinned programs ($in_wasm > $in_programs)" >&2; exit 1; fi
if grep -aq "$build" "$out"; then echo "FAIL  $out carries the build path" >&2; exit 1; fi
wasm=target/wasm32-wasip2/release/bookerbob-jolt-verify-outlayer.wasm
mkdir -p "$here/target/wasm32-wasip2/release"
cp "$out" "$here/$wasm"
echo "$(shasum -a 256 "$here/$wasm" | cut -d' ' -f1)  worker/outlayer-jolt/$wasm  $(wc -c < "$here/$wasm" | tr -d ' ') bytes"
