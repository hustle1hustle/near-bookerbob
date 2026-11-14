#!/usr/bin/env bash
# measure.sh <account> <upto>: one measure(upto) tx at 1 PGas; prints the gas log and tx id.
ACC=$1; U=$2; NET=${NEAR_NET:-testnet-fastnear}
near contract call-function as-transaction "$ACC" measure json-args "{\"upto\":$U}" prepaid-gas '1000 Tgas' \
  attached-deposit '0 NEAR' sign-as "$ACC" network-config "$NET" sign-with-legacy-keychain send 2>&1 \
  | grep -E "Transaction ID|Tgas|start:|rror|Gas burned" | sed 's/\x1b\[[0-9;]*m//g' | head -20
