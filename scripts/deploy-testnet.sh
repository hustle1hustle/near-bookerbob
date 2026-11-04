#!/usr/bin/env bash
# BookerBob testnet deploy. Idempotent: every step checks chain state first and skips what
# is already done. Testnet only: it refuses any other network.
#
#   DRY_RUN=1 scripts/deploy-testnet.sh     print every command, send nothing
#   scripts/deploy-testnet.sh               run it
#
# Needs: near-cli-rs (`near`), cargo-near, curl, python3, and the bookerbob CLI (built by
# cargo). Written against near-cli-rs 0.30 syntax before near-cli-rs was installed on the
# build machine: do a dry run first and check the first real step by hand.
#
# Every transaction hash goes to docs/testnet.md. Keys: the bazaar's trust-anchor seeds are
# created in $KEYS_DIR (outside the repo) and only public keys leave it.
set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN="${DRY_RUN:-0}"
NETWORK="testnet"
RPC="${NEAR_RPC:-https://rpc.testnet.near.org}"
NEAR="${NEAR_CLI:-near}"
BAZAAR="${BAZAAR_ACCOUNT_ID:-bookerbob.testnet}"
MERCHANTS="${MERCHANTS:-30}"
MERCHANT_FUND="${MERCHANT_FUND:-0.1 NEAR}"
USDC="${USDC_CONTRACT_ID:-3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af}"
MPC="${MPC_SIGNER_ID:-v1.signer-prod.testnet}"
OUTLAYER="${OUTLAYER_CONTRACT_ID:-outlayer.testnet}"
OUTLAYER_PROJECT="${OUTLAYER_PROJECT:-}"
KEYS_DIR="${KEYS_DIR:-$HOME/.rep-secrets/bookerbob-testnet}"
WORLD_ACTION="${WORLD_ACTION:-bookerbob-fixture-action}"
WASM="target/near/bookerbob_bazaar.wasm"
LOG="docs/testnet.md"
BOOKERBOB="cargo run -q -p bookerbob-cli --"

# ---------- guards ----------
case "$BAZAAR" in *.testnet) ;; *) echo "refusing: $BAZAAR is not a .testnet account" >&2; exit 2 ;; esac
case "$RPC" in *testnet*) ;; *) echo "refusing: RPC $RPC is not testnet" >&2; exit 2 ;; esac
case "$MPC$OUTLAYER" in *.near*) echo "refusing: mainnet contract id" >&2; exit 2 ;; esac

say() { printf '\n== %s\n' "$*"; }
skip() { printf '   skip: %s\n' "$*"; }

# ---------- chain reads (curl, so a dry run can see state too) ----------
rpc() { curl -s -m 30 "$RPC" -H 'Content-Type: application/json' -d "$1"; }

account_exists() {
  rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" \
    | python3 -c 'import sys,json; sys.exit(0 if "result" in json.load(sys.stdin) else 1)'
}

# view <contract> <method> <json-args>: prints the JSON result, or exits 1 on error.
view() {
  local args_b64
  args_b64=$(printf '%s' "$3" | base64 | tr -d '\n')
  rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$args_b64\"}}" \
    | python3 -c 'import sys,json
d=json.load(sys.stdin); r=d.get("result",{})
if "error" in d or "error" in r or "result" not in r: sys.exit(1)
print(bytes(r["result"]).decode() or "null")'
}

# ---------- transactions ----------
log_init() {
  [ -f "$LOG" ] && return
  [ "$DRY_RUN" = 1 ] && return
  printf '# Testnet transactions\n\nWritten by `scripts/deploy-testnet.sh`. Network: testnet. Explorer: testnet.nearblocks.io.\n\n| when (UTC) | step | account | tx |\n|---|---|---|---|\n' > "$LOG"
}

# tx <step> <account> <near-cli args...>: run (or print), capture the tx hash into the log.
tx() {
  local step="$1" account="$2"; shift 2
  printf '   + %s' "$NEAR"; printf ' %q' "$@"; printf '\n'
  [ "$DRY_RUN" = 1 ] && return 0
  local out hash
  out=$("$NEAR" "$@" 2>&1) || { echo "$out" >&2; echo "failed: $step" >&2; exit 1; }
  echo "$out" | tail -5
  hash=$(echo "$out" | grep -oE 'Transaction ID: [1-9A-HJ-NP-Za-km-z]{43,44}' | head -1 | awk '{print $3}' || true)
  log_init
  printf '| %s | %s | %s | %s |\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$step" "$account" \
    "${hash:+[$hash](https://testnet.nearblocks.io/txns/$hash)}${hash:-see output}" >> "$LOG"
  LAST_OUT="$out"
}

call() { # call <step> <signer> <contract> <method> <json> <deposit> [gas]
  tx "$1" "$2" contract call-function as-transaction "$3" "$4" json-args "$5" \
    prepaid-gas "${7:-100.0 Tgas}" attached-deposit "$6" sign-as "$2" network-config "$NETWORK" sign-with-keychain send
}

# ---------- preflight ----------
say "preflight ($([ "$DRY_RUN" = 1 ] && echo dry run || echo live), bazaar $BAZAAR, $MERCHANTS merchants)"
if [ "$DRY_RUN" != 1 ]; then
  command -v "$NEAR" >/dev/null || { echo "near-cli-rs not found (cargo install --locked near-cli-rs)" >&2; exit 1; }
  cargo near --version >/dev/null 2>&1 || { echo "cargo-near not found (cargo install --locked cargo-near)" >&2; exit 1; }
fi
if [ -d "$KEYS_DIR" ] || [ "$DRY_RUN" != 1 ]; then
  KEYS=$($BOOKERBOB keys "$KEYS_DIR")
else
  skip "keys: $KEYS_DIR does not exist yet; a live run creates it. Using placeholders."
  KEYS='{"issuer":"<issuer-pk>","referee":"<referee-pk>","arbiter":"<arbiter-pk>","world":"<world-pk>"}'
fi
key() { printf '%s' "$KEYS" | python3 -c "import sys,json; print(json.load(sys.stdin)['$1'])"; }

# ---------- 1. bazaar account ----------
say "1. bazaar account"
if account_exists "$BAZAAR"; then skip "$BAZAAR exists"
else tx "create $BAZAAR (faucet)" "$BAZAAR" account create-account sponsor-by-faucet-service "$BAZAAR" autogenerate-new-keypair save-to-keychain network-config "$NETWORK" create
fi

# ---------- 2. build and deploy ----------
say "2. build, deploy and init"
if view "$BAZAAR" issuers '{}' >/dev/null 2>&1; then skip "bazaar already initialized"
else
  printf '   + make wasm\n'; [ "$DRY_RUN" = 1 ] || make wasm
  tx "deploy + new" "$BAZAAR" contract deploy "$BAZAAR" use-file "$WASM" with-init-call new \
    json-args "{\"owner\":\"$BAZAAR\",\"usdc\":\"$USDC\"}" prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
    network-config "$NETWORK" sign-with-keychain send
fi

# ---------- 3. trust anchors ----------
say "3. trust-anchor keys"
has() { view "$BAZAAR" "$1" '{}' 2>/dev/null | grep -q "$2"; }
ISSUER="ed25519:$(key issuer)"
has issuers "$ISSUER" && skip "issuer registered" || call "register_issuer" "$BAZAAR" "$BAZAAR" register_issuer "{\"key_id\":\"$ISSUER\",\"label\":\"testnet issuer\"}" '0 NEAR'
has referees "$(key referee)" && skip "referee registered" || call "register_referee" "$BAZAAR" "$BAZAAR" register_referee "{\"key_hex\":\"$(key referee)\",\"label\":\"testnet referee\"}" '0 NEAR'
# No view for arbiters or the world verifier: registering again only overwrites the label.
call "register_arbiter" "$BAZAAR" "$BAZAAR" register_arbiter "{\"key_hex\":\"$(key arbiter)\",\"label\":\"testnet arbiter\"}" '0 NEAR'
call "register_world_verifier" "$BAZAAR" "$BAZAAR" register_world_verifier "{\"key_hex\":\"$(key world)\",\"action\":\"$WORLD_ACTION\",\"label\":\"testnet world verifier (placeholder action)\"}" '0 NEAR'

# ---------- 4. USDC storage for the bazaar ----------
say "4. USDC storage registration"
if [ "$(view "$USDC" storage_balance_of "{\"account_id\":\"$BAZAAR\"}" 2>/dev/null || echo null)" != "null" ]; then skip "bazaar registered with USDC"
else call "usdc storage_deposit bazaar" "$BAZAAR" "$USDC" storage_deposit "{\"account_id\":\"$BAZAAR\",\"registration_only\":true}" '0.00125 NEAR'
fi

# ---------- 5. merchants ----------
say "5. merchant sub-accounts (one per agent) and their schedules"
for i in $(seq 1 "$MERCHANTS"); do
  if [ "$i" -le 22 ]; then id=$(printf 'm%02d' "$i"); else id=$(printf 'h%02d' $((i - 22))); fi
  acct="$id.$BAZAAR"
  if account_exists "$acct"; then skip "$acct exists"
  else tx "create $acct" "$acct" account create-account fund-myself "$acct" "$MERCHANT_FUND" autogenerate-new-keypair save-to-keychain sign-as "$BAZAAR" network-config "$NETWORK" sign-with-keychain send
  fi
  if [ "$(view "$BAZAAR" merchant "{\"merchant\":\"$acct\"}" 2>/dev/null || echo null)" != "null" ]; then skip "$acct registered"
  else
    args=$(python3 - "$id" <<'PY'
import json, sys
mid = sys.argv[1]
m = next(x for x in json.load(open("agents/merchants.json")) if x["account"].split(".")[0] == mid)
print(json.dumps({"schedule": m["schedule"], "category": m["category"], "payout": None}))
PY
)
    call "register_merchant $id" "$acct" "$BAZAAR" register_merchant "$args" '0.05 NEAR'
  fi
  # Registered merchants are not quoted until the owner approves the schedule.
  if [ "$(view "$BAZAAR" merchant "{\"merchant\":\"$acct\"}" 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)["approved"])' 2>/dev/null)" = "True" ]; then skip "$acct approved"
  else call "approve_merchant $id" "$BAZAAR" "$BAZAAR" approve_merchant "{\"merchant\":\"$acct\"}" '0 NEAR'
  fi
  if [ "$(view "$USDC" storage_balance_of "{\"account_id\":\"$acct\"}" 2>/dev/null || echo null)" = "null" ]; then
    call "usdc storage_deposit $id" "$acct" "$USDC" storage_deposit "{\"account_id\":\"$acct\",\"registration_only\":true}" '0.00125 NEAR'
  fi
done

# ---------- 6. first Chain Signatures sign, domain 1 (open check B2) ----------
say "6. MPC sign with domain_id 1 (Ed25519)"
if [ -f fixtures/live/mpc-sign.txt ]; then skip "fixtures/live/mpc-sign.txt exists"
else
  PAYLOAD=$(printf 'bookerbob mpc spike v0' | shasum -a 256 | awk '{print $1}')
  call "mpc sign domain 1" "$BAZAAR" "$MPC" sign "{\"request\":{\"payload_v2\":{\"Eddsa\":\"$PAYLOAD\"},\"path\":\"stellar-1\",\"domain_id\":1}}" '1 yoctoNEAR' '300.0 Tgas'
  if [ "$DRY_RUN" != 1 ]; then mkdir -p fixtures/live; printf 'payload %s\n%s\n' "$PAYLOAD" "$LAST_OUT" > fixtures/live/mpc-sign.txt; fi
fi

# ---------- 7. OutLayer request_referee (open check B4) ----------
say "7. OutLayer request_referee"
if [ -z "$OUTLAYER_PROJECT" ]; then
  skip "OUTLAYER_PROJECT not set. Build the worker (rustup target add wasm32-wasip2; cargo build -p bookerbob-referee-worker --target wasm32-wasip2 --release), upload it with the outlayer CLI, set REFEREE_SIGNING_SEED as an OutLayer secret, then rerun with OUTLAYER_PROJECT=<owner>/<project>"
else
  call "set_outlayer" "$BAZAAR" "$BAZAAR" set_outlayer "{\"outlayer\":\"$OUTLAYER\"}" '0 NEAR'
  INPUT=$($BOOKERBOB worker-input fixtures)
  ARGS=$(python3 -c 'import json,sys; print(json.dumps({"project_id": sys.argv[1], "input_data": sys.argv[2]}))' "$OUTLAYER_PROJECT" "$INPUT")
  # The fixture verdict is not on chain, so the callback is expected to log referee_failed
  # (unknown nullifier) with the output hash: that proves the round trip.
  call "request_referee" "$BAZAAR" "$BAZAAR" request_referee "$ARGS" '0.01 NEAR' '300.0 Tgas'
fi

say "done. $([ "$DRY_RUN" = 1 ] && echo 'dry run: nothing was sent.' || echo "transactions are in $LOG")"
