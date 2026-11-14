#!/bin/sh
# The Dory setup (URS) guard. Run it before any Jolt preprocessing or proving (zk/ prove,
# zk/browser/build.sh, standing-host, decide-host).
#
#   scripts/dory-urs.sh [pre [<stamp>]]   install and check the pinned files; touch <stamp> after
#   scripts/dory-urs.sh post <stamp>      fail if any dory_*.urs in the cache is newer than <stamp>
#
# dory-pcs (both Jolt pins) loads <cache>/dory_<n>.urs and, when the file is missing, generates a
# fresh one from OsRng and saves it there. The verifier preprocessing embeds the verifier half of
# that file, so an unpinned file means a program hash nobody can rebuild. `pre`:
#   1. fails when the cache holds any dory_*.urs that is not in zk/urs/SHA256 (a guest of that
#      size would load it silently), unless BOOKERBOB_DORY_ALLOW_UNPINNED=1;
#   2. installs every pinned file from zk/urs/ that is missing;
#   3. checks the sha256 of every pinned file in the cache and fails on a mismatch.
# It never deletes or moves a file in the cache. `post` catches a URS generated during the build
# (a size that is not pinned).
# The cache directory is resolved the way dory-pcs resolves it: $LOCALAPPDATA/dory, else
# $HOME/Library/Caches/dory when $HOME/Library/Caches exists, else $HOME/.cache/dory.
# `make zk-prove` and zk/browser/build.sh point LOCALAPPDATA at a clean directory of their own
# (default $HOME/.cache/bookerbob-urs), so the cache they use holds only the pinned files.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
pins="$root/zk/urs"
if [ -n "${LOCALAPPDATA:-}" ]; then cache="$LOCALAPPDATA/dory"
elif [ -d "$HOME/Library/Caches" ]; then cache="$HOME/Library/Caches/dory"
else cache="$HOME/.cache/dory"; fi
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -c1-64; else shasum -a 256 "$1" | cut -c1-64; fi; }
mode=${1:-pre}

if [ "$mode" = post ]; then
  stamp=${2:-}
  [ -n "$stamp" ] && [ -f "$stamp" ] || { echo "FAIL  dory-urs post: give the stamp file the pre run touched (dory-urs.sh pre <stamp>)"; exit 1; }
  new=$(find "$cache" -maxdepth 1 -name 'dory_*.urs' -newer "$stamp" 2>/dev/null | sort)
  if [ -n "$new" ]; then
    echo "FAIL  dory-urs: a Dory URS was generated or replaced in $cache during this build:"
    echo "$new" | sed 's/^/        /'
    echo "      A program preprocessed against it does not rebuild from zk/urs. Pin it on purpose (copy it to"
    echo "      zk/urs, add its sha256 to zk/urs/SHA256), or find what changed the trace size."
    echo "      (Another Jolt process writing the same cache directory also trips this.)"
    exit 1
  fi
  echo "PASS  dory-urs post: no Dory URS generated in $cache since the guard ran"
  exit 0
fi
[ "$mode" = pre ] || { echo "usage: scripts/dory-urs.sh [pre [<stamp>]] | post <stamp>"; exit 2; }

[ -f "$pins/SHA256" ] || { echo "FAIL  dory-urs: $pins/SHA256 is missing"; exit 1; }
mkdir -p "$cache"

# 1. Unpinned files already in the cache.
unpinned=""
for f in "$cache"/dory_*.urs; do
  [ -f "$f" ] || continue
  grep -q "  $(basename "$f")\$" "$pins/SHA256" || unpinned="$unpinned $(basename "$f")"
done
if [ -n "$unpinned" ]; then
  if [ "${BOOKERBOB_DORY_ALLOW_UNPINNED:-0}" = 1 ]; then
    echo "WARN  dory-urs: unpinned Dory setups in $cache:$unpinned (allowed by BOOKERBOB_DORY_ALLOW_UNPINNED=1)"
  else
    echo "FAIL  dory-urs: $cache holds Dory setups that are not pinned in zk/urs/SHA256:"
    for u in $unpinned; do echo "        $cache/$u"; done
    echo "      A guest whose size maps to one of them would load it silently, and its program hash would"
    echo "      not rebuild from zk/urs. Nothing was moved or deleted. Either:"
    echo "        point LOCALAPPDATA at a clean directory (dory-pcs then uses \$LOCALAPPDATA/dory), e.g."
    echo "          LOCALAPPDATA=\$HOME/.cache/bookerbob-urs sh scripts/dory-urs.sh"
    echo "        (make zk-prove and zk/browser/build.sh do this by default), or"
    echo "        set BOOKERBOB_DORY_ALLOW_UNPINNED=1 to accept them for this run."
    exit 1
  fi
fi

# 2 and 3. Install the missing pinned files, check every pinned one.
n=0; installed=""
while read -r want name; do
  [ -n "$name" ] || continue
  src="$pins/$name"; dst="$cache/$name"
  [ -f "$src" ] || { echo "FAIL  dory-urs: pinned $src is missing"; exit 1; }
  [ "$(sha "$src")" = "$want" ] || { echo "FAIL  dory-urs: $src does not match zk/urs/SHA256"; exit 1; }
  if [ ! -f "$dst" ]; then
    # Copy then rename, so a concurrent reader never sees a partial file.
    cp "$src" "$dst.tmp.$$" && mv "$dst.tmp.$$" "$dst"
    installed="$installed $name"
  fi
  got=$(sha "$dst")
  if [ "$got" != "$want" ]; then
    echo "FAIL  dory-urs: $dst is not the pinned Dory setup"
    echo "        have  $got"
    echo "        want  $want  (zk/urs/$name)"
    echo "      Preprocessing with it gives a different program hash. Nothing was changed. Point LOCALAPPDATA"
    echo "      at a clean directory, or move that file aside yourself if nothing of yours was proved with it."
    exit 1
  fi
  n=$((n + 1))
done < "$pins/SHA256"
[ -z "${2:-}" ] || touch "$2"
echo "PASS  dory-urs: $n pinned Dory setups in $cache match zk/urs/SHA256${installed:+ (installed:$installed)}"
