#!/usr/bin/env bash
# Builds everything agents/prove.html serves, from a clean clone:
#   1. fetches a16z/jolt at the pinned commit into vendor/jolt and applies jolt-wasm32.patch
#   2. runs the host tests (the guest's prices equal agents/board.json for all 8 hotel rows)
#   3. writes agents/prove/public.json from the board, compiles and preprocesses the guest,
#      proves and verifies natively, refuses six changed statements, writes sample-proof.bin
#   4. builds the wasm verifier and the single-thread wasm prover
#   5. with THREADS=1, also builds the threaded prover (needs rust-src; see README)
#   6. writes agents/prove/sizes.json and checks the wasm verifier in node (check.mjs)
#
# Needs: rustup (the toolchain in rust-toolchain.toml installs itself), node 22, git, gzip, and the
# `jolt` CLI on PATH for the guest build (any a16z/jolt build of it; this repo's zk/ uses 997c1543e).
# wasm-bindgen-cli 0.2.114 is installed into .tools/ when it is missing.
#   JOLT_SRC=<url or local clone>   where to fetch Jolt from (default https://github.com/a16z/jolt)
#   JOBS=<n>                        cargo jobs (default 4)
set -euo pipefail
cd "$(dirname "$0")"
JOLT_REV=b4eb62480d76ed8c1f0b16bf7cab6e12f6cda873
JOLT_SRC=${JOLT_SRC:-https://github.com/a16z/jolt}
JOBS=${JOBS:-4}
OUT=../../agents/prove
WASM=target/wasm32-unknown-unknown/release
BINDGEN_VERSION=0.2.114

command -v jolt >/dev/null || { echo "the jolt CLI is not on PATH (cargo install --git https://github.com/a16z/jolt --rev 997c1543efd49eb193ca403bb7722fc4b2f8e65b jolt)"; exit 2; }

# 1. Jolt at the pin, patched. The patch is a no-op on 64-bit targets.
if [ ! -d vendor/jolt/.git ] || [ "$(git -C vendor/jolt rev-parse HEAD)" != "$JOLT_REV" ]; then
  rm -rf vendor/jolt
  git init -q vendor/jolt
  git -C vendor/jolt remote add origin "$JOLT_SRC"
  git -C vendor/jolt fetch -q --depth 1 origin "$JOLT_REV" || git -C vendor/jolt fetch -q origin
  git -C vendor/jolt checkout -q "$JOLT_REV"
fi
# Applied once: touching the sources again would rebuild everything.
if ! git -C vendor/jolt apply --reverse --check "$PWD/jolt-wasm32.patch" 2>/dev/null; then
  git -C vendor/jolt checkout -q -- .
  git -C vendor/jolt apply "$PWD/jolt-wasm32.patch"
fi
echo "jolt $(git -C vendor/jolt rev-parse --short=12 HEAD) + jolt-wasm32.patch"

if [ "$(.tools/bin/wasm-bindgen --version 2>/dev/null)" != "wasm-bindgen $BINDGEN_VERSION" ]; then
  cargo install wasm-bindgen-cli --version "$BINDGEN_VERSION" --locked --root "$PWD/.tools" -j "$JOBS"
fi

# 2 and 3. Native: tests, the statement, the guest, a proof, the refusals.
cargo test --locked -p decide-host -j "$JOBS"
cargo build --locked --release -p decide-host -j "$JOBS"
mkdir -p "$OUT" target/artifacts
./target/release/decide-host public ../.. "$OUT/public.json"
./target/release/decide-host build "$OUT/public.json" target/artifacts
cp target/artifacts/guest.elf target/artifacts/prover.bin target/artifacts/verifier.bin target/artifacts/sample-proof.bin "$OUT/"

# 4. Wasm. gzip -n keeps the bytes free of a timestamp; the page gunzips with DecompressionStream,
# because a plain static host sends no content-encoding for these.
(cd verify-wasm && cargo build --locked --release --target wasm32-unknown-unknown --target-dir ../target -j "$JOBS")
gzip -9 -n -c "$WASM/bookerbob_verify_wasm.wasm" > "$OUT/verifier.wasm.gz"

LINK="-C link-arg=--max-memory=2147483648 -C link-arg=-zstack-size=8388608"
(cd prove-wasm && RUSTFLAGS="$LINK" cargo build --locked --release --target wasm32-unknown-unknown --target-dir ../target -j "$JOBS")
rm -rf "$OUT/single"
.tools/bin/wasm-bindgen --target web --no-typescript --out-dir "$OUT/single" "$WASM/bookerbob_prove_wasm.wasm"
SINGLE_RAW=$(wc -c < "$OUT/single/bookerbob_prove_wasm_bg.wasm")
gzip -9 -n "$OUT/single/bookerbob_prove_wasm_bg.wasm"

# 5. Threads (optional): std rebuilt with atomics, which stable cargo only does with RUSTC_BOOTSTRAP.
THREADS_RAW=0
rm -rf "$OUT/threads"
if [ "${THREADS:-0}" = 1 ]; then
  (cd prove-wasm && RUSTC_BOOTSTRAP=1 RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-args=--shared-memory -C link-args=--import-memory $LINK -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base" \
    cargo build --locked --release --target wasm32-unknown-unknown --target-dir ../target/threads -j "$JOBS" --features threads -Z build-std=std,panic_abort)
  .tools/bin/wasm-bindgen --target web --no-typescript --out-dir "$OUT/threads" target/threads/wasm32-unknown-unknown/release/bookerbob_prove_wasm.wasm
  # The pool's worker imports the package by directory, which only a bundler resolves.
  sed -i.bak "s#import('../../..')#import('../../../bookerbob_prove_wasm.js')#" "$OUT"/threads/snippets/wasm-bindgen-rayon-*/src/workerHelpers.js
  rm -f "$OUT"/threads/snippets/wasm-bindgen-rayon-*/src/workerHelpers.js.bak
  THREADS_RAW=$(wc -c < "$OUT/threads/bookerbob_prove_wasm_bg.wasm")
  gzip -9 -n "$OUT/threads/bookerbob_prove_wasm_bg.wasm"
fi

# 6. Exact sizes, and the wasm verifier against the committed proof.
VERIFY_RAW=$(wc -c < "$WASM/bookerbob_verify_wasm.wasm") SINGLE_RAW=$SINGLE_RAW THREADS_RAW=$THREADS_RAW JOLT_REV=$JOLT_REV \
MACHINE="$( (sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m) | tr -s ' ')" node - "$OUT" <<'EOF'
const fs = require("fs"), path = require("path");
const out = process.argv[2];
const native = JSON.parse(fs.readFileSync("target/artifacts/native.json", "utf8"));
const files = {};
const walk = (dir) => {
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (name !== "sizes.json" && name !== "measured.json") files[path.relative(out, p)] = fs.statSync(p).size;
  }
};
walk(out);
const sum = (names) => names.reduce((a, n) => a + files[n], 0);
const prover = (mode) => [`${mode}/bookerbob_prove_wasm_bg.wasm.gz`, "prover.bin", "guest.elf", "verifier.wasm.gz", "verifier.bin"];
const sizes = {
  note: "bytes on disk, as served. .gz files are gunzipped in the page; unzipped has their sizes after that. download is what each page mode fetches after the page itself.",
  jolt: { repo: "https://github.com/a16z/jolt", rev: process.env.JOLT_REV, patch: "zk/browser/jolt-wasm32.patch" },
  zk: native.mode === "zk",
  cycles: native.cycles,
  files,
  unzipped: {
    "verifier.wasm": +process.env.VERIFY_RAW,
    "single/bookerbob_prove_wasm_bg.wasm": +process.env.SINGLE_RAW,
    ...(+process.env.THREADS_RAW ? { "threads/bookerbob_prove_wasm_bg.wasm": +process.env.THREADS_RAW } : {}),
  },
  download: {
    prove: sum(prover("single")),
    ...(+process.env.THREADS_RAW ? { prove_threads: sum(prover("threads")) } : {}),
    check: sum(["verifier.wasm.gz", "verifier.bin", "sample-proof.bin"]),
  },
  native: {
    machine: process.env.MACHINE,
    threads: native.threads,
    prove_s: native.prove_s,
    verify_ms: native.verify_ms,
    proof_bytes: native.proof_bytes,
    proof_sha256: require("crypto").createHash("sha256").update(fs.readFileSync(path.join(out, "sample-proof.bin"))).digest("hex"),
    refused: native.refused,
  },
};
fs.writeFileSync(path.join(out, "sizes.json"), JSON.stringify(sizes, null, 2) + "\n");
console.log(`sizes.json: prove ${sizes.download.prove} bytes, check ${sizes.download.check} bytes, ${sizes.cycles} cycles`);
EOF
node check.mjs "$OUT"
