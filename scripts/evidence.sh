#!/usr/bin/env bash
# Evidence pack: measured numbers, printed and written to docs/evidence.md.
#   scripts/evidence.sh
# Offline. Every number comes from a command run here, except the NEAR AI cost, which is
# read from the committed live run (agents/out/live-run.json).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=docs/evidence.md
LOG="${TMPDIR:-/tmp}/bookerbob-evidence-verify.txt"
cargo build -q -p bookerbob-cli 2>/dev/null
BB=./target/debug/bookerbob

t0=$(python3 -c 'import time; print(time.time())')
make -s verify >"$LOG" 2>/dev/null
t1=$(python3 -c 'import time; print(time.time())')
verify_s=$(python3 -c "print(f'{$t1-$t0:.1f}')")
chain=$(grep -E '^ALL PASS' "$LOG" | head -1)
evals=$(grep -E 'referee evals' "$LOG" | sed 's/^PASS  //')
nearai=$(grep -E 'NEAR AI verdict:' "$LOG" | sed 's/^PASS  //')
rounds=$(grep -cE '^PASS  blind round' "$LOG")
storage=$("$BB" evidence 2>/dev/null)
reviewgas=$("$BB" reviews fixtures 2>/dev/null | grep '^GAS' | sed -E 's/^GAS   ([^:]+): ([0-9.]+) Tgas mocked host gas \(mean of ([0-9]+)\)/| `\1` | \2 | \3 |/')
reviews=$(grep -E 'sealed reviews:' "$LOG" | sed 's/^PASS  //')
live=$(node -e '
const r = require("./agents/out/live-run.json");
const ok = r.calls.filter((c) => c.signature_valid && c.request_hash_matches && c.response_hash_matches).length;
const cost = r.calls.reduce((a, c) => a + c.cost_usd, 0);
console.log(`${r.calls.length} calls, ${ok}/${r.calls.length} signatures valid, $${cost.toFixed(4)} total, $${(cost / r.calls.length).toFixed(5)} per call`);
')

{
  echo "# Evidence"
  echo
  echo "Written by \`scripts/evidence.sh\` on $(date -u +%Y-%m-%d) ($(uname -m), $(sysctl -n hw.ncpu 2>/dev/null || nproc) cores). Rerun it to refresh."
  echo
  echo "| what | measured |"
  echo "|---|---|"
  echo "| \`make verify\`, warm build | ${verify_s} s |"
  echo "| chain checks (contract code on MockedBlockchain) | ${chain} |"
  echo "| referee evals | ${evals} |"
  echo "| NEAR AI verdict, offline checks | ${nearai} |"
  echo "| blind rounds run through the contract | ${rounds} (one per category) |"
  echo "| sealed reviews (Semaphore v4, real purchases) | ${reviews} |"
  echo "| NEAR AI live run (\`agents/out/live-run.json\`) | ${live} |"
  echo
  echo "## Storage and gas per contract method"
  echo
  echo "Storage is exact: what the contract charges the caller (1 byte = 0.00001 NEAR; the"
  echo "unused deposit is refunded). Gas is the host-function gas the mocked VM counts, a lower"
  echo "bound without wasm execution; real gas per method comes with the testnet deploy. The"
  echo "first verdict in a context also creates its cohort counters, so it costs more."
  echo
  echo "$storage"
  echo
  echo "## Sealed reviews gas"
  echo
  echo "Mocked host gas per call. \`submit_review\` is mostly alt_bn128 host work (one"
  echo "multiexp, a 4-pair pairing check); it also parses the committed verification key JSON"
  echo "in wasm, which is not counted. \`join_review_group\` runs Poseidon in wasm, also not"
  echo "counted. Treat both as floors until the testnet deploy."
  echo
  echo "| method | host gas, mocked (Tgas) | calls |"
  echo "|---|---|---|"
  echo "$reviewgas"
  echo
  echo "## Who pays"
  echo
  echo "- Agent: its verdict record plus a 512-byte reserve for that record's referee receipt"
  echo "  and settle fields (0.05 NEAR attached, about 0.013 used, the rest refunded), its escrow"
  echo "  entry (0.01 NEAR), its World ID binding, and the gas of \`settle\`."
  echo "- Merchant: its registration and its sealed and revealed bids."
  echo "- Owner: issuer, referee, arbiter and World verifier keys, and rounds."
  echo "- Contract balance: nothing per purchase. Growth past a record's reserve is refused."
  echo "- NEAR AI inference is paid with the buyer side's API key (per call cost above)."
} >"$OUT"
cat "$OUT"
