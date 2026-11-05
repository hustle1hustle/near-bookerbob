#!/bin/sh
# Rebuild vendor/crates.tar.xz after Cargo.lock changes: every crates.io dependency of the
# workspace, sources included, so `make verify-offline` builds with no network. Crates that only
# build on Windows are stubbed (Cargo.toml kept, sources dropped, checksum list emptied): cargo
# needs them to resolve the lockfile, never to compile on Linux or macOS.
set -eu
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
cargo vendor --locked "$tmp/crates" >/dev/null
for d in "$tmp"/crates/winapi* "$tmp"/crates/windows*; do
  [ -d "$d" ] || continue
  find "$d" -mindepth 1 -maxdepth 1 ! -name Cargo.toml ! -name .cargo-checksum.json -exec rm -rf {} +
  mkdir -p "$d/src" && : > "$d/src/lib.rs"
  python3 -c "import json,sys;p=sys.argv[1]+'/.cargo-checksum.json';j=json.load(open(p));j['files']={};json.dump(j,open(p,'w'))" "$d"
done
tar -C "$tmp" -cf - crates | xz -T0 -6 > vendor/crates.tar.xz
shasum -a 256 vendor/crates.tar.xz Cargo.lock > vendor/SHA256
rm -rf "$tmp"
echo "wrote vendor/crates.tar.xz ($(du -h vendor/crates.tar.xz | cut -f1)); vendor/SHA256 pins it to this Cargo.lock"
