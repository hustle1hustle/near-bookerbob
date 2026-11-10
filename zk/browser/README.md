# zk/browser: a Jolt proof made in the visitor's browser

`agents/prove.html` makes a Jolt zkVM proof in the browser that the buyer's agent followed the
buyer's rules, verifies it in the page, and refuses the same proof when one number in the claim
is changed. This folder is everything behind it: the guest, the wasm prover, the wasm verifier,
the native tool and the build.

This browser prover is a separate set of crates with its own Jolt pin; the four guests in `zk/`
stay on a16z/jolt `997c1543efd4`, the program hash registered on chain, and nothing here touches
them.

The zkVM is [Jolt](https://github.com/a16z/jolt), by a16z crypto and contributors. This folder
runs their prover and verifier as they are at the pin, plus the two known wasm32 fixes below.

## What is proved

The guest `decide` (`guest/src/lib.rs`). Every input is public:

- the buyer's budget, the predicates the buyer revealed, the cohort size
- the offers: merchant, public base price, discount schedule
- the claim: a merchant and a price

It reprices every offer with `bookerbob_zkcore::price::quote_in_cohort`, the one function
`core/src/price.rs` and the bazaar contract call (a path dependency, not a copy), and holds only
when the claimed merchant is in the list exactly once, the claimed price is its code price, the
price fits the budget, and no offer is cheaper. Output: the merchant and the price.

The statement is `agents/prove/public.json`, written by `decide-host public` from the
hotel-lisbon round of `agents/board.json` with the schedules from `agents/merchants.json`:
`h05.bookerbob.testnet` at 408 dUSDC against a public 510, budget 500, 8 offers, 3 revealed bits,
cohort k=6. A host test checks that this rule gives the board's price and discount for all 8
hotel rows.

What it does not prove: that the offers, the budget or the bits are honest (they are inputs). It
is not the on-chain standing proof and nothing on chain verifies it. This build is not
zero-knowledge: Jolt's `zk` feature is off, because every input is already public (the crates
carry a `zk` feature that forwards to Jolt's; it is not built or tested here). At this pin the
SDK's prover commits with Dory over BN254, with a Keccak transcript (`jolt-sdk/src/host_utils.rs`:
`PCS = DoryScheme`, `F = Fr`, `ProtocolSponge = Keccak`). Classical security only.

## Pin and toolchain

| | |
|---|---|
| Jolt | a16z/jolt `b4eb62480d76ed8c1f0b16bf7cab6e12f6cda873` (2026-11-05), fetched by `build.sh` into `vendor/jolt` |
| arkworks | a16z/arkworks-algebra `dev/twist-shout` at `b8f0f512`, as in upstream's own lock, pinned by the three `Cargo.lock` files here |
| Rust | 1.95 (`rust-toolchain.toml`), targets `wasm32-unknown-unknown` and the two RISC-V ones |
| wasm-bindgen | 0.2.114, crate and CLI (the CLI is installed into `.tools/` by `build.sh`) |
| guest build | the `jolt` CLI on PATH. The one used here is `jolt 0.1.0 (997c1543e 2026-03-24)`, the same binary `zk/` uses; it only drives cargo for the RISC-V build, the guest links jolt-sdk at `b4eb62480d76` |
| node | 22 (sizes and `check.mjs`) |

## The patch, and whose it is

`jolt-wasm32.patch` applies the known wasm32 fixes to the fetched copy of Jolt. Neither is ours.

1. `CoeffLut::saturated` multiplies two `usize`; at 65,536 entries the product is 2^32, which
   wraps to 0 on wasm32, and the prover panics on an empty table. Reported with this fix
   (`checked_mul`) in [a16z/jolt#1913](https://github.com/a16z/jolt/issues/1913), bug 1, open at
   the time of writing; also `0001-jolt-coefflut-u64.patch` in
   [0xAndoroid/jolt-wasm-prover](https://github.com/0xAndoroid/jolt-wasm-prover/tree/main/patches).
2. The tracer reserves 2^24 rows up front and the override is an environment variable, which a
   browser does not have. On wasm32 the reserve is 2^18 rows here. Same idea as
   `0009-jolt-tracer-wasm32-capacity.patch` in 0xAndoroid/jolt-wasm-prover (theirs changes
   `tracer/src/lib.rs`, this one the constant in `tracer/src/parallel.rs`). This one is not in
   issue #1913.

What was confirmed: issue #1913 read through `gh` on 2026-11-10 (open, bug 1 as described, a
maintainer's reply pointing to the patches folder above); the patches folder of
0xAndoroid/jolt-wasm-prover at commit `6d3bdeb4` read through the GitHub API (files 0001 and 0009).
Issue #1913's second bug (an arkworks thread pool build that fails on wasm32) did not show up in
this single-thread build at this pin: the proof completes without a change for it.

On 64-bit targets the patch changes nothing (the first hunk gives the same answer, the second is
behind `cfg(target_arch = "wasm32")`), so the native tool builds from the same patched copy.

## Build

```
zk/browser/build.sh            # everything, into agents/prove/ (JOBS=8 for more cargo jobs)
node zk/browser/check.mjs      # the wasm verifier in node: accepts the sample, refuses 10 changes
python3 -m http.server -d agents   # then open /prove.html, or /prove.html#check
```

`build.sh` fetches Jolt at the pin, applies the patch, runs the host tests, writes `public.json`,
compiles and preprocesses the guest, proves and verifies natively, refuses six changed
statements, builds both wasm files, gzips them, writes `sizes.json` and runs `check.mjs`. A
full rebuild of the Rust parts took 9 min 24 s with `JOBS=8` on the machine below (the three
fat-LTO links are most of it); a first build also compiles wasm-bindgen-cli and was not timed as
one run.

Pieces by hand, from `zk/browser/`:

```
cargo test -p decide-host                                   # 3 tests, no proving
./target/release/decide-host public ../.. ../../agents/prove/public.json
./target/release/decide-host build ../../agents/prove/public.json target/artifacts
./target/release/decide-host verify target/artifacts ../../agents/prove/public.json
```

Layout: `guest/` the provable function, `public/` public.json and the exact input and output
bytes (one file, shared by the prover and both verifiers), `host/` the native tool and tests,
`prove-wasm/` the browser prover (wasm-bindgen), `verify-wasm/` the browser verifier (plain C
ABI, no glue), `check.mjs`, `build.sh`, `jolt-wasm32.patch`.

`prove.html#check` verifies the committed native proof (`agents/prove/sample-proof.bin`) and
runs the same refusals, for a device that should not prove. `prove.html#run` starts proving on
load.

## Measured

All on one machine: Apple M3 Pro (11 cores), macOS 26.5.1, 2026-11-10. The guest runs 39,159
cycles, padded to 2^16.

| where | threads | prove | verify | proof | notes |
|---|---|---|---|---|---|
| native (`decide-host build`) | 11 | 1.53 s | 28 to 29 ms | 78,527 bytes | preprocessing 0.85 s |
| headless Chrome 157, `prove.html`, from `python3 -m http.server` | 1 | 20.60 s, 21.02 s, 20.97 s, 20.97 s | 357 to 368 ms | 78,527 bytes | wasm memory 54.3 MB (56,950,784 bytes), prover start 0.7 s |
| headless Chrome 157, `prove.html#check` | 1 | none | 362 to 366 ms | 78,527 bytes | 1.80 MB download |
| node 22, `check.mjs` | 1 | none | 351 ms | 78,527 bytes | |

Inside the browser prove (one run): trace 18 ms, Jolt stage 0 (Dory commit) 12.4 s, stages 1 to 7
(sumchecks) 1.5 s, stage 8 (Dory opening) 7.1 s. The two Dory stages are 93% of the time, which
is where threads would pay.

The browser proof is byte for byte the native one (sha-256 `3ffc20c1f1888c41...`, in
`sizes.json`): without `zk` the prover uses no randomness.

Refusals: the native verifier refused 6 changed statements, the wasm verifier 9 changed
statements and one flipped proof bit (`check.mjs`), and the page refused price + 1 and
budget - 1 base unit in every headless run (`StageClaimOutputMismatch { stage: 1 }`, about 250 ms).

No phone has been timed on this page. The "phone width" run above is Chrome's device emulation on
the laptop, not a phone. For scale only, and as a number of a different build: the Mumbai build
(below) proved a 367,490-cycle guest with `zk` on in Safari on an iPhone 15 Pro Max in 31.5 to
37.9 s with 4 to 6 threads, and in 72.9 s on one thread in desktop Chrome.

Sizes, exact, from `agents/prove/sizes.json`:

| file | bytes |
|---|---|
| `single/bookerbob_prove_wasm_bg.wasm.gz` | 3,431,241 (11,319,009 unzipped) |
| `verifier.wasm.gz` | 1,606,526 (4,228,097 unzipped) |
| `prover.bin` (prover preprocessing) | 296,233 |
| `verifier.bin` (verifier preprocessing) | 197,427 |
| `guest.elf` | 23,008 |
| `sample-proof.bin` | 78,527 |
| download, prove mode | 5,554,435 |
| download, `#check` mode | 1,882,480 |

The wasm files are gzipped at build time and gunzipped in the page with `DecompressionStream`,
because GitHub Pages and `python3 -m http.server` send them without a content-encoding. Building
twice on this machine gave the same byte counts for both.

## Not done

- Threads. `build.sh` carries the recipe behind `THREADS=1` (atomics, rebuilt std,
  wasm-bindgen-rayon; needs `rustup component add rust-src`), but it was not built or run here, the page never asks for it, and Pages
  needs a cross-origin-isolation service worker whose scope has to cover `prove.html` (a file in
  `agents/`, not `agents/prove/`).
- A real phone run, Safari and Firefox. Only headless Chrome was driven.
- `wasm-opt`. Not installed here; the sizes are straight from rustc and wasm-bindgen.
- Under 2^15 cycles. The guest costs about 720 cycles per schedule rule to deserialize and as
  much again to match, mostly `String` allocation in the shared price types; 32,768 would halve
  the Dory stages.

## Ideas that came from the Mumbai build (for PRIOR_WORK.md)

From `booker-bob-ethglobal-mumbai-2026` (`jolt/prove-wasm`, `jolt/verify-wasm`, `web/public/prove`).
The code here is this repo's own; these are the ideas it took.

- Compile jolt-sdk's host prover to `wasm32-unknown-unknown` behind wasm-bindgen and run it in a Web Worker.
- Pin Jolt `b4eb62480d76` with Rust 1.95 and wasm-bindgen 0.2.114, and the linker flags (2 GB max memory, 8 MB stack).
- Keep the wasm32 fixes as a patch file applied to a fetched copy of Jolt at build time.
- Ship the guest ELF and the serialized prover preprocessing as static files, so the browser neither compiles nor preprocesses.
- Report prover stages from Jolt's own tracing spans (`prove_stage*`) over a BroadcastChannel, panics too.
- Count downloaded bytes against a published `sizes.json` for a real progress bar.
- A verifier with a plain C ABI and no JS glue, which rebuilds the public inputs from `public.json`.
- Show a refusal by verifying the same proof against a statement with one number changed.
- The threaded build recipe (atomics, `-Z build-std`, wasm-bindgen-rayon, the worker import fix), kept in `build.sh` and not run here.
- The iPhone timing above, as that build's reference number.

New in this repo: the `decide` guest over BookerBob's price rule and board data, one shared
crate for the statement's bytes, the trace and prove steps split so the page shows the measured
cycle count, a fresh verifier instance per check, gzip with in-page gunzip, the `#check` mode,
and the byte-identical native and browser proofs.
