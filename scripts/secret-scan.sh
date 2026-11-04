#!/usr/bin/env bash
# Secret scan over the full git history (every commit, every branch), before the repo goes
# public. No gitleaks or trufflehog needed.
#   1. patterns: private-key shapes and known token prefixes
#   2. exact values: every secret value found under SECRETS_DIR (default ~/.rep-secrets) is
#      searched for verbatim in the history. Values are never printed, only where they hit.
# Exit 1 on any hit. Fixture seeds in fixtures/ are public test seeds and are reported apart.
set -euo pipefail
cd "$(dirname "$0")/.."
SECRETS_DIR="${SECRETS_DIR:-$HOME/.rep-secrets}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
git log -p --all --no-color --format='commit %H' > "$tmp/history.txt"
echo "secret scan: $(git rev-list --all | wc -l | tr -d ' ') commits, $(wc -c < "$tmp/history.txt" | tr -d ' ') bytes of history"
hits=0
check() { # name regex
  local n; n=$(grep -E -c -- "$2" "$tmp/history.txt" || true)
  if [ "$n" != 0 ]; then echo "HIT   $1: $n lines"; grep -E -n -- "$2" "$tmp/history.txt" | cut -c1-120 | sed -E 's/([A-Za-z0-9_]{6})[A-Za-z0-9_+\/=-]{12,}/\1<redacted>/g' | head -5; hits=$((hits+1)); else echo "ok    $1"; fi
}
# A NEAR secret key is 64 bytes (about 88 base58 chars); a tx signature has the same shape,
# so near-cli's "Signature:" lines (public) are excluded.
check "NEAR secret key (ed25519:<88 base58>)" '^[^S]*(private|secret|key)[^S]*ed25519:[1-9A-HJ-NP-Za-km-z]{80,}|^\+ed25519:[1-9A-HJ-NP-Za-km-z]{80,}|"ed25519:[1-9A-HJ-NP-Za-km-z]{80,}"'
check "PEM private key" 'BEGIN [A-Z ]*PRIVATE KEY'
check "Shopify token (shpat_, shpss_, shpca_)" 'shp(at|ss|ca|pa)_[0-9a-fA-F]{20,}'
check "OpenAI-style key (sk-)" '(^|[^a-z])sk-[A-Za-z0-9_-]{20,}'
check "AWS access key" 'AKIA[0-9A-Z]{16}'
check "GitHub token" 'gh[pousr]_[A-Za-z0-9]{30,}'
check "secret assignment with a value" '^\+.*(SECRET|TOKEN|PRIVATE_KEY|API_KEY|PASSWORD)[A-Z_]*=["'"'"']?[A-Za-z0-9_+-][A-Za-z0-9_+/=-]{11,}'
check "JWT" 'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.'
if [ -d "$SECRETS_DIR" ]; then
  # Every value of 16+ chars in the secrets dir: whole seed files and KEY=value values.
  # Secret files only: seeds, Semaphore secrets, env files, keys, tokens, and fly/notary
  # configs. Not the demo's public records (testers/*.json hold tx hashes and nullifiers that
  # are published on purpose in fixtures/live/testnet-manifest.json).
  find "$SECRETS_DIR" -type f -size -64k \( -name '*.seed' -o -name '*.secret' -o -name '*.env' -o -name '*.key' -o -name '*.token' -o -name '*.pem' \) -print0 2>/dev/null |
    xargs -0 cat 2>/dev/null | tr -d '\r' | sed -E 's/^[A-Z_]+=//; s/^["'"'"']//; s/["'"'"']$//' |
    grep -oE '[A-Za-z0-9_+/=:.-]{16,}' | sort -u > "$tmp/values.txt" || true
  # Drop public values that legitimately appear (account ids, hosts, version strings).
  grep -vE '\.(testnet|near|com|org|dev|io)$|^https?:|^[0-9]{4}-[0-9]{2}' "$tmp/values.txt" > "$tmp/v2.txt" || true
  nvals=$(wc -l < "$tmp/v2.txt" | tr -d ' ')
  n=$(grep -F -c -f "$tmp/v2.txt" "$tmp/history.txt" || true)
  if [ "$n" != 0 ]; then
    echo "HIT   exact secret values from $SECRETS_DIR: $n history lines (values not shown)"
    grep -F -n -f "$tmp/v2.txt" "$tmp/history.txt" | cut -d: -f1 | head -5 | while read -r l; do awk -v l="$l" 'NR<=l && /^commit /{c=$2} NR==l{print "      line " l " in commit " substr(c,1,10); exit}' "$tmp/history.txt"; done
    hits=$((hits+1))
  else echo "ok    exact secret values: none of $nvals values from $SECRETS_DIR in history"; fi
else echo "skip  exact values: no $SECRETS_DIR"; fi
fx=$(grep -E -c '^\+.*"[0-9a-f]{64}"' "$tmp/history.txt" || true)
echo "info  64-hex strings in history: $fx lines (hashes, public keys and the public fixture seeds; the live seeds are covered by the exact-value check)"
[ "$hits" = 0 ] && echo "PASS  no secrets in history" || { echo "FAIL  $hits finding(s)"; exit 1; }
