#!/bin/sh
# Build the sealed smith base: leanexport of the fixed roots (tools/base-roots.txt: the prelude and
# the two reference programs, which select the Init slice smith proofs need), slimmed (theorem
# proofs replaced by axioms with the same statement), written to dist/base/base.ndjson with
# dist/base/base.json {bytes, decls, sha256}. Every program export must list these roots FIRST
# (tools/smith-lean.mjs does), so its base part is byte-identical to this file.
set -eu
here=$(cd "$(dirname "$0")" && pwd); root=$(cd "$here/.." && pwd)
T=$HOME/.elan/toolchains/leanprover--lean4---v4.35.0/bin
cd "$root"
$HOME/.elan/bin/lake build SmithLean >/dev/null
roots=$(tr '\n' ' ' < tools/base-roots.txt)
$HOME/.elan/bin/lake env $T/leanexport SmithLean -- $roots > dist/base/base-full.ndjson
# slim + GC with nothing in the delta: the whole export is the base
python3 -I tools/split.py dist/base/base-full.ndjson dist/base/base.ndjson --slim --base dist/base/base-full.ndjson > dist/base/split.meta.json
python3 -I - <<'PY'
import json, hashlib
m = json.load(open("dist/base/split.meta.json")); b = open("dist/base/base.ndjson", "rb").read()
json.dump({"bytes": len(b), "decls": m["base_decls"], "records": m["base_records"], "sha256": hashlib.sha256(b).hexdigest(), "roots": open("tools/base-roots.txt").read().split(), "lean": "4.35.0", "slim": True}, open("dist/base/base.json", "w"), indent=1)
print(json.dumps({"base_bytes": len(b), "base_decls": m["base_decls"], "sha256": hashlib.sha256(b).hexdigest()[:16]}))
PY
# base-full.ndjson stays: tools/split.py --base needs the unslimmed base export to know the base names
