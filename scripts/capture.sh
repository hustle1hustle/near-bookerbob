#!/usr/bin/env bash
# Demo captures for the offline beats, into docs/img/. Needs Google Chrome (headless).
#   scripts/capture.sh
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT="${PORT:-48731}"
TMP=$(mktemp -d)
trap 'kill $SRV 2>/dev/null || true; rm -rf "$TMP"' EXIT

make swarm >/dev/null 2>&1
make receipts >/dev/null 2>&1
make reviews >/dev/null 2>&1
make demo-offline 2>/dev/null > "$TMP/demo.txt"

# Terminal beats from the real demo output.
term() { # term <name> <title> <grep pattern>
  python3 - "$TMP/demo.txt" "$2" "$3" > "$TMP/$1.html" <<'PY'
import html, re, sys
lines = open(sys.argv[1]).read().splitlines()
title, pat = sys.argv[2], re.compile(sys.argv[3])
pick = [l for l in lines if pat.search(l)]
body = "\n".join(
    f'<div class="l {"pass" if l.startswith("PASS") else "fail" if l.startswith("FAIL") else ""}">{html.escape(l)}</div>' for l in pick)
print(f"""<!doctype html><meta charset="utf-8"><style>
body{{margin:0;background:#0A0A0F;color:#E6E6EF;font:15px/1.6 ui-monospace,Menlo,monospace}}
.w{{padding:28px 32px}} .t{{color:#7C7C94;margin-bottom:14px}} .p{{color:#3B5BFF}}
.l{{white-space:pre-wrap}} .l.pass::first-letter{{color:#5BE3A0}}
.hl{{color:#FF4D5E}}
</style><div class="w"><div class="t"><span class="p">$</span> make demo-offline &nbsp; # {html.escape(title)}</div>{body}</div>""")
PY
  sed -i '' -e 's/nullifier spent/<span class="hl">nullifier spent<\/span>/g' -e 's/F9 not in proof set/<span class="hl">F9 not in proof set<\/span>/g' "$TMP/$1.html"
}
term replay "same proof, another wallet" "^bookerbob verify|  2[456]  |^ALL PASS"
term dispute "a compromised referee is caught" "^bookerbob verify|  2[0-3]  "

python3 -m http.server "$PORT" --bind 127.0.0.1 -d "$PWD" >/dev/null 2>&1 &
SRV=$!
sleep 1
shot() { # shot <out> <url> <width> <height>
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size="$3,$4" --virtual-time-budget=5000 --screenshot="$1" "$2" >/dev/null 2>&1
  echo "wrote $1"
}
B="http://127.0.0.1:$PORT"
mkdir -p docs/img
cp "$TMP/replay.html" "$TMP/dispute.html" agents/ 2>/dev/null || true
shot docs/img/board.png "$B/agents/board.html" 1280 1240
shot docs/img/beat-winner.png "$B/agents/board.html#winner" 1280 560
shot docs/img/beat-cheat.png "$B/agents/board.html#cheat" 1280 330
shot docs/img/beat-hotel.png "$B/agents/board.html#tab-hotel-lisbon" 1280 1100
shot docs/img/beat-asks.png "$B/agents/board.html#asks" 1280 520
shot docs/img/receipts.png "$B/agents/receipts.html" 1280 900
shot docs/img/beat-replay.png "$B/agents/replay.html" 1280 260
shot docs/img/beat-dispute.png "$B/agents/dispute.html" 1280 300
rm -f agents/replay.html agents/dispute.html
