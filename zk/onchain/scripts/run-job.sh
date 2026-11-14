#!/usr/bin/env bash
# run-job.sh <contract> <proof.bin> <io_device.bin>: submit, then advance until the contract
# says verified or refused. Testnet only; signs with the contract account's legacy-keychain key.
set -euo pipefail
C=$1; PROOF=$2; IO=$3; NET=${NEAR_NET:-testnet-fastnear}; SIGNER=${SIGNER:-$C}
case "$C" in *.testnet) ;; *) echo "testnet only"; exit 2;; esac
T=$(mktemp -d)
node -e 'const f=require("fs");f.writeFileSync(process.argv[3],JSON.stringify({proof:f.readFileSync(process.argv[1]).toString("base64"),io:f.readFileSync(process.argv[2]).toString("base64")}))' "$PROOF" "$IO" "$T/args.json"
tx() { # method argsfile gas deposit -> prints tx id + return value lines to $T/out
  for i in 1 2 3 4 5 6 7 8; do
    if near contract call-function as-transaction "$C" "$1" file-args "$2" prepaid-gas "$3" attached-deposit "$4" \
        sign-as "$SIGNER" network-config "$NET" sign-with-legacy-keychain send >"$T/out" 2>&1; then
      sed 's/\x1b\[[0-9;]*m//g' "$T/out" | grep -E "Transaction ID|advance [0-9]|^[0-9\"{]" | sed 's/^[│ ]*//' ; return 0; fi
    if grep -qi "rate limit\|timed out\|status code: 50[234]" "$T/out"; then perl -e 'select(undef,undef,undef,10)'; continue; fi
    sed 's/\x1b\[[0-9;]*m//g' "$T/out" | grep -E "Transaction ID|rror|Smart contract panicked|ExecutionError" | head -5; return 1
  done; return 1
}
if [ -z "${ID:-}" ]; then
  echo "submit $(shasum -a 256 "$PROOF" | cut -c1-16).. ($(wc -c <"$PROOF") bytes)"
  tx submit "$T/args.json" '1000 Tgas' '2 NEAR' | tee "$T/sub"
  ID=$(grep -E '^[0-9]+$' "$T/sub" | tail -1)
fi
echo "job $ID"
echo "{\"id\":$ID}" > "$T/id.json"
while :; do
  tx advance "$T/id.json" '1000 Tgas' '0 NEAR' | tee "$T/adv" | grep -E "Transaction ID|advance"
  ST=$(near contract call-function as-read-only "$C" status file-args "$T/id.json" network-config "$NET" now 2>/dev/null | grep -oE '"status": ?"[^"]*"' | tail -1)
  echo "  $ST"
  case "$ST" in *running*) ;; *) break;; esac
done
rm -rf "$T"
