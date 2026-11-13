#!/bin/sh
# The committed Jolt proofs, checked with the committed prebuilt verifier for this platform:
# zk/bin/bookerbob-zk-<target>.xz, its archive and binary sha256 in zk/bin/SHA256 checked first.
# Exit 0: every proof verifies. Exit 3: no prebuilt verifier for this platform (a clean SKIP;
# `make zk-verify` builds one from zk/ instead). Anything else: a failure.
set -eu
cd "$(dirname "$0")/../zk"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) t=aarch64-apple-darwin ;;
  Linux-x86_64) t=x86_64-unknown-linux-gnu ;;
  Linux-aarch64 | Linux-arm64) t=aarch64-unknown-linux-gnu ;;
  *) t=unknown ;;
esac
t=${ZK_TARGET:-$t}
xzf="bin/bookerbob-zk-$t.xz"
if [ ! -f "$xzf" ]; then
  # The two shipped targets must be present: a missing one is a failure, not a skip.
  case "$t" in aarch64-apple-darwin | x86_64-unknown-linux-gnu) echo "FAIL  zk-verify-prebuilt: the shipped verifier $xzf is missing"; exit 1 ;; esac
  echo "SKIP  zk-verify-prebuilt: no prebuilt Jolt verifier for $t ($(uname -s) $(uname -m)) in zk/bin (have: $(ls bin | grep '\.xz$' | sed 's/bookerbob-zk-//; s/\.xz$//' | tr '\n' ' ')); make zk-verify builds one"
  exit 3
fi
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -c1-64; else shasum -a 256 "$1" | cut -c1-64; fi; }
want_xz=$(grep " bookerbob-zk-$t.xz\$" bin/SHA256 | cut -c1-64)
want_bin=$(grep " bookerbob-zk-$t (uncompressed)\$" bin/SHA256 | cut -c1-64)
[ -n "$want_xz" ] && [ "$(sha "$xzf")" = "$want_xz" ] || { echo "FAIL  $xzf does not match zk/bin/SHA256"; exit 1; }
bin="bin/bookerbob-zk-$t"
xz -dkc "$xzf" > "$bin" && chmod +x "$bin"
[ "$(sha "$bin")" = "$want_bin" ] || { echo "FAIL  $bin does not match zk/bin/SHA256"; exit 1; }
n=0
for p in standing:standing standing-testnet:standing standing-testnet-2:standing standing-testnet-3:standing price:price referee:referee cohort:cohort; do
  out=${p%%:*}; g=${p##*:}
  [ -d "out/$out" ] || continue
  "./$bin" verify "$g" "../fixtures/zk/$out-input.json" "out/$out" > /dev/null || { echo "FAIL  Jolt proof $out does not verify"; exit 1; }
  n=$((n + 1))
done
echo "PASS  zk-verify-prebuilt: $n Jolt proofs verify with the committed $t verifier (sha256 ${want_bin%"${want_bin#????????????}"}..)"
