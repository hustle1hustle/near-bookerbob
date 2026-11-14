#!/bin/sh
# Build the OutLayer evaluator component and print its sha256 (the `hash` of `create_project`).
# Sends nothing. Same fixed-path method as worker/outlayer/build.sh: the sources are copied to
# /tmp/bookerbob-outlayer-eval-build (OUTLAYER_EVAL_BUILD_DIR overrides it, and changes the hash)
# and built from a clean target directory, so the hash does not depend on the checkout path.
#
# One more input than the referee: TLSNotary's certificate check uses `ring`, whose C parts need
# a clang that targets WebAssembly. Apple's clang does not, so the build uses wasi-sdk 25
# (clang 19.1.5-wasi-sdk), WASI_SDK=<its directory>
# (github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-25, the arm64-macos tarball has sha256
# e1e529ea226b1db0b430327809deae9246b580fa3cae32d31c82dfe770233587). Its version is part of
# the hash.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
wasi=${WASI_SDK:-$HOME/dev/.toolchains/wasi-sdk-25.0-arm64-macos}
[ -x "$wasi/bin/clang" ] || { echo "FAIL  no wasi-sdk clang at $wasi (set WASI_SDK)" >&2; exit 1; }
stage=${OUTLAYER_EVAL_BUILD_DIR:-/tmp/bookerbob-outlayer-eval-build}
mkdir -p "$stage"
build=$(cd "$stage" && pwd -P)
cargo_home=${CARGO_HOME:-$HOME/.cargo}
rm -rf "$build/src" "$build/target"
mkdir -p "$build/src"
(cd "$repo" && tar --exclude target -cf - Cargo.toml Cargo.lock core contract cli worker graph zkcore dusdc gate) | (cd "$build/src" && tar -xf -)
cd "$build/src/worker/outlayer-eval"
CC_wasm32_wasip2="$wasi/bin/clang" AR_wasm32_wasip2="$wasi/bin/llvm-ar" CFLAGS_wasm32_wasip2="--sysroot=$wasi/share/wasi-sysroot -ffile-prefix-map=$cargo_home=/cargo" \
RUSTFLAGS="--remap-path-prefix=$build/src=/bookerbob --remap-path-prefix=$cargo_home=/cargo" CARGO_TARGET_DIR="$build/target" \
  cargo build --release --locked --target wasm32-wasip2 ${JOBS:+-j "$JOBS"}
out=$build/target/wasm32-wasip2/release/bookerbob-eval-outlayer.wasm
grep -aq 'outlayer.manifest' "$out" || { echo "FAIL  the outlayer.manifest custom section is missing from $out" >&2; exit 1; }
if grep -aq "$HOME" "$out"; then echo "FAIL  $out carries a local path" >&2; exit 1; fi
if grep -aq "$build" "$out"; then echo "FAIL  $out carries the build path" >&2; exit 1; fi
wasm=target/wasm32-wasip2/release/bookerbob-eval-outlayer.wasm
mkdir -p "$here/target/wasm32-wasip2/release"
cp "$out" "$here/$wasm"
echo "$(shasum -a 256 "$here/$wasm" | cut -d' ' -f1)  worker/outlayer-eval/$wasm  $(wc -c < "$here/$wasm" | tr -d ' ') bytes"
