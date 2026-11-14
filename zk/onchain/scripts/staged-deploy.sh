#!/usr/bin/env bash
# Deploys a contract larger than one transaction (testnet only): the loader first, then the
# code in chunks, then `deploy` with the code's sha256. Usage: staged-deploy.sh <account> <wasm>
set -euo pipefail
ACC=$1; WASM=$2; NET=${NEAR_NET:-testnet-fastnear}
case "$ACC" in *.testnet) ;; *) echo "testnet only"; exit 2;; esac
cd "$(dirname "$0")/.."
T=$(mktemp -d)
call() { # method file gas
  for i in 1 2 3 4 5 6; do
    out=$(near contract call-function as-transaction "$ACC" "$1" file-args "$2" prepaid-gas "$3" attached-deposit '0 NEAR' \
      sign-as "$ACC" network-config "$NET" sign-with-legacy-keychain send 2>&1) && { echo "$out" | grep -E "Transaction ID|Logs|chunk|deploying" | sed 's/^/  /'; return 0; }
    echo "$out" | grep -qi "rate limit\|timeout\|503\|502" || { echo "$out" | tail -5; return 1; }
    perl -e 'select(undef,undef,undef,10)'
  done; return 1
}
echo "loader -> $ACC"
near contract deploy "$ACC" use-file loader/target/loader.wasm without-init-call network-config "$NET" sign-with-legacy-keychain send 2>&1 | grep -E "Transaction ID" | sed 's/^/  /'
split -b 700000 "$WASM" "$T/part."
for p in "$T"/part.*; do echo "put $(basename "$p") $(wc -c <"$p") bytes"; call put "$p" '100 Tgas'; done
shasum -a 256 "$WASM" | cut -c1-64 | xxd -r -p > "$T/sha"
echo "deploy sha256 $(shasum -a 256 "$WASM" | cut -c1-16).."
call deploy "$T/sha" '1000 Tgas'
rm -rf "$T"
