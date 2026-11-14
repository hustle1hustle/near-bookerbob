# The Jolt smith: zk checks the swarm commissions

The market changes faster than we can ship checks. A coalition wants to show it delivered without
naming who; a buyer wants a merchant's discount for heavy spenders without handing over its
history; a coalition lead wants its members to see the split followed the rule. Each of these is
a small Jolt guest program. The smith is an independent agent that writes them on request: a
swarm agent posts what it wants checked, a NEAR AI model in a TEE writes the program from a fixed
skeleton, a checker decides whether it may be built, and a registry on testnet records it so any
agent can verify proofs against it.

What anyone trusts is the program hash and the public source. Who wrote the code does not
matter: the source is public, the build is pinned, the requester's own test vectors run on it,
and a proof only ever says what that source computes.

Page: `agents/smith.html` (verifies every registered proof in the browser). Offline check:
`make smith-check` (also inside `make judge`). Live: `make smith-live`.

## The flow

| step | who | what | where |
|---|---|---|---|
| 1. request | a swarm agent (coalition lead, buyer agent, merchant) | a spec: plain-language ask, typed public, private and output fields, rules, its own test vectors, limits; `post_request(id, spec_hash, registrar)` on the registry | `zk/smith/specs/<id>.json`, `smith-reg.bookerbob-demo.testnet` |
| 2. write | the smith, `node scripts/smith.mjs run <id>` | one sealed chat (E2EE v2) to `z-ai/glm-5.3-flash`, whose attestation report is bound to the smith's nonce; the model returns `body.rs` (one function) and adversarial vectors; the TEE key signs the chat | `zk/smith/programs/<id>/smith/attempt-N/` |
| 3. check | the smith | the lint; then, compiled inside the sandbox, every requester and smith vector runs in the wasm build of the model's code (no imports, capped memory, a time limit) and in the guest (Jolt's emulator); the two must agree, refusals must match; on a failure the model gets the errors (3 tries) | `check.json`, `vectors.json` |
| 4. prove | the smith | the requester's vector marked `prove`; the prover also refuses 4 changed statements | `out/` |
| 5. register | the registrar the requester named (default `smith.bookerbob-demo.testnet`) | `register_program`: spec, source, program and ELF hashes, the TEE signature; the contract checks the signature with `ed25519_verify` against a key the owner listed for that model | registry |
| 6. accept, window | the requester; anyone | `accept` after the requester's own check; a 10 minute challenge window with a 0.1 NEAR bond | registry |
| 7. use | any agent | verify a proof against the registered program hash: `agents/smith/verify.mjs` (node and browser, one generic wasm verifier); a registered verifier key (the OutLayer TEE worker) may record a signed accept with `attest_use` | page, `smith-check` |

## The skeleton, and what the model writes

The template (`zk/smith/template/`) is fixed. From a spec the smith generates:

- `types.rs`: the `Public`, `Private` and `Output` structs and the spec's own types, generated from the spec by the template.
- `body/src/lib.rs` (template): decodes the public input and the private input with exact postcard decoding (trailing bytes refused), calls `body::check(&Public, &Private) -> Result<Output, &'static str>`, and returns `(spec hash, sha256 of the private bytes, encoded output)`.
- `src/lib.rs` (template): the Jolt entry point `smith(public: Vec<u8>, private: UntrustedAdvice<Vec<u8>>)`. A refusal is a panic; both verifiers require `panic = false`, so a refused statement has no proof they accept.
- `body/src/body.rs`: the only file the model writes.

The spec hash sits in every proof's output, so a proof names the request it answers. The output
of the guest is `(spec_hash, private_commitment, output_bytes)`; the public input is its only
verifier input. Allowed crates are fixed by the template: serde, postcard, sha2.

## Where the model's code runs, and what it can reach

The model's code is never a process on the machine. Two audits shaped this: the first got a shell
command through a regex check into a native build with std; the second showed that a known Rust
soundness hole (cve-rs style lifetime tricks) compiles under `no_std` and `forbid(unsafe_code)`
and passes the lint, and that the first sandbox (allow by default) still reached launchctl, the
pasteboard, the keychain service and writes to `~/.cargo/registry`. So the layers are now:

1. **Where it runs: wasm with no imports, or Jolt's emulator.** The checker compiles the body crate
   with a fixed harness to wasm32 (`template/wasm-*.tmpl`) and refuses the module unless it
   imports nothing and declares a memory maximum of at most 64 MiB (`wasmPolicy`). Each vector runs
   in node's WebAssembly inside a worker thread with a 20 s limit and a JS heap cap (`runWasm`).
   The guest side runs in Jolt's RISC-V emulator (trace, then prove). `smith-host` links no call
   path to the model's code. A soundness hole in the model's Rust can still corrupt its own wasm
   memory or the guest's emulated memory; it has no file, process, network or OS call to reach.
2. **The lint** (`zk/smith/lint`, syn): parses `body.rs` and walks every item, path, attribute,
   macro and unsafe marker against an allowlist, with raw identifiers read as what they name
   (`r#std` is `std`). Allowed: `use` of `crate::types`, `crate::smith_std`,
   `alloc::{vec, string, collections, borrow}`, `core::{cmp, convert, iter, ops, num, option,
   result}`; helper functions and consts; doc comments only as `#[doc = "a string literal"]`
   (what `///` becomes); exactly one `check` with the fixed signature; a path of more than one
   segment must start at an allowed root, a primitive type or a type name (`Vec::new`,
   `u64::MAX`, `<Public>::clone`); array lengths are integer literals of at most 4096. Refused:
   every macro (including in a doc attribute), every other attribute, unsafe, extern, modules,
   impls, traits, statics, type definitions, paths starting with `::`, `std`, `self`, `super`,
   and lowercase roots (crate or module names such as `serde`, `postcard`). Compiled to wasm
   (`agents/smith/lint.wasm`, its source hash in `agents/smith/lint.json`, checked by
   `smith-check`), so the smith, the offline check and the page run the same code.
3. **no_std, no unsafe, no build script**: the model's file lives in its own crate, `#![no_std]`
   and `#![forbid(unsafe_code)]` on every target, `build = false`, three fixed dependencies.
4. **The sandbox for compiling and proving** (`zk/smith/sandbox.sb`, macOS `sandbox-exec`): deny
   by default. What it allows, all of it:
   - exec: `~/.cargo/bin` (rustup proxies, the jolt CLI), `~/.rustup/toolchains` (cargo, rustc),
     the Xcode toolchain's `usr/bin` (clang, ld, ar, called directly, no xcrun shim, no `/bin/sh`),
     `/usr/bin/time`, and the binaries the build makes in `ROOT/target` and `ROOT/target-zk` (the
     vendored dependencies' build scripts, `smith-host`)
   - read: `/`, `/usr`, `/System`, `/Library`, `/private/etc`, `/private/var/db/timezone`,
     `/private/var/select`, `/dev`, `/Applications/Xcode.app`, `~/.rustup`, `~/.cargo/bin`, the
     build root; file metadata everywhere
   - write: inside `ROOT/{target, target-zk, out, out-zk, tmp, home, cargo-home}` (those
     directories themselves cannot be renamed, replaced or removed; the smith creates them before
     a step), `ROOT/Cargo.lock`, `/dev/null`, `/dev/tty`, `/dev/dtracehelper`; never a config file
     in `cargo-home`, and the smith refuses to start a step if one is there. Not `ROOT/vendor`,
     `ROOT/crates`, `ROOT/.cargo` (its config.toml is pinned by hash in the manifest), the program
     sources or anything outside
   - mach services: notification center, opendirectory libinfo, logd, the system logger; the
     notification center's shared memory (read); sysctl reads; signals and process info only
     inside the sandbox; no network
   - every sandboxed step (cargo update, cargo build, the wasm build, `smith-host`) is killed
     after 20 minutes. A memory limit is not set: macOS does not enforce `RLIMIT_AS` or
     `RLIMIT_DATA`, so a compile that eats memory is stopped only by the time limit
   Every dependency is vendored into the build root (`cargo vendor`, which runs no package code)
   and `CARGO_HOME` is inside the root, so `~/.cargo` is never written. Nothing calls git: the
   patched Jolt tree and the vendored crates are checked before every build against tree hashes
   committed in `zk/smith/vendor-manifest.json` (every file's path, size and bytes). The build
   root is the fixed path `/tmp/bookerbob-smith`, because that path is inside every ELF; the smith
   refuses to build unless it is a real directory owned by the current user with mode 0700
   (re-tightened after every sync) and every parent but `/tmp` is owned by root or that user.

Tests (`scripts/smith.test.mjs`, 7): the lint rejects the audit's `evil1.rs` and the quote trick;
with the lint bypassed, evil1 does not compile inside the sandbox (`cannot find std`) and its
command never runs; a small C probe (`zk/smith/sandbox-probe.c`) run inside the sandbox reads the
root, but cannot read a file in `$HOME`, connect to the network, or exec `/bin/sh`, and cannot
write `$HOME`, `~/.cargo/registry`, `/private/var/folders`, `ROOT/vendor`, `ROOT/crates`,
`ROOT/.cargo`, `ROOT/cargo-home/config.toml`, the program sources or `ROOT/Cargo.toml`, cannot
rename `cargo-home` or `target` away or a planted directory onto `cargo-home`, while it can write
`ROOT/tmp`, `ROOT/target` and `ROOT/home`; `launchctl`, `pbpaste`, `security`, `curl`
and `/bin/sh` cannot be started; a wasm module with an import or an uncapped memory is refused; a
wasm body that never returns is stopped by the time limit. The lint's own Rust tests
(`zk/smith/lint`, 10 groups) cover raw identifiers, doc-attribute macros, path roots,
qualified paths and array lengths.

What is left: the sandbox is macOS only; a compiler bug triggered by source code would run inside
the compile sandbox; `include_bytes!` is stopped by the lint and by the sandbox's read rules only.

## Why a malicious program cannot forge

A Jolt proof shows that this exact program (the program hash commits to its bytecode through
the verifier preprocessing) ran on these public inputs and produced this output. A malicious
`body.rs` can compute anything, including the wrong thing, but it cannot make a proof of a
different program or a different output. So:

- whoever verifies checks the proof against the program hash the registry holds, rebuilt from the
  public source if they want, and reads the output; nothing the author says is trusted;
- whether the program checks what the spec says is a separate question. The requester's vectors
  and the smith's adversarial vectors are run in the wasm build and in the guest before anything is
  registered, and the requester accepts only after its own check. **Vectors are tests; they do
  not prove correctness**: a high-stakes program needs a human to read its `body.rs` (they are
  short: 60 to 100 lines), and the challenge window is there for that.

## Authorship: what the TEE signature binds

The smith sends one sealed chat to the model's attested ed25519 key (E2EE v2, the path the
bazaar's verdicts use, `scripts/lib/e2ee.mjs`). Recorded per attempt
(`zk/smith/programs/<id>/smith/attempt-N/`): the attestation report (bound to the smith's 32-byte
nonce), the sealed request and response wire bytes, NEAR AI's signature over
`<model>:<sha256 request>:<sha256 response>`, the key for each of the two request messages and
for the answer field. `smith-check` opens the request and compares it with the prompt rebuilt
from the spec, opens the answer and checks its rust block is `body.rs` byte for byte, and checks
the signature, the hashes and the report's nonce, key and model name. The TDX quote inside the
report is not re-verified by the smith (the bazaar's own DCAP path is in `docs/depth.md`); the
registry trusts a model key because its owner listed it after checking the report.

## The registry (`smith-registry/`, `smith-reg.bookerbob-demo.testnet`)

A separate contract on its own account, so the bazaar's code hash is unchanged. Unit tests on
near-sdk's mocked chain (24), one of them with the real TEE signature of a smith chat.

| method | who | rule |
|---|---|---|
| `post_request(id, spec_hash, registrar?)` | the requester | the id is taken once; the registrar defaults to the smith account; `<id>-zk` (the zk build of `<id>`) only by `<id>`'s requester, with its registrar and spec, and its program must have `<id>`'s source and authorship |
| `set_model_key(key, model)` | owner | lists an attested NEAR AI model key |
| `register_program(...)` | only the named registrar | the TEE signature verifies (`ed25519_verify`) under a listed key for that model, the signed text names the response hash; the registrar's tx signature covers the source, program and ELF hashes; one program per request, one request per program hash, one request per authorship response (the request's `-zk` build excepted). That the signed chat is about this request (the prompt opens to this spec) is checked off chain by `smith-check` |
| `accept(request_id, program_hash)` | the requester | required before use; names the current program hash, so an accept never carries over to a superseded build |
| `challenge(reason)` | anyone, 0.1 NEAR bond, inside the window | excess refunded; the owner has `resolve_ms` (24 h) to rule |
| `resolve(upheld)` | owner, before the deadline | upheld: rejected, bond back to the challenger; dismissed: a fresh window, bond to the registrar |
| `expire` | anyone, after the deadline | an unresolved challenge is upheld |
| `supersede(request_id, program_hash, elf_hash, reason)` | only the registrar | a rebuild of the same source (here: the pinned URS, then vendored dependency paths); the source hash stays, and that the new build comes from it is checked off chain (`smith-check`, `smith.mjs rebuild`); a fresh window, and the requester must accept the new hash |
| `pin_program(...)` | owner | a hand-written program (the bazaar's standing guest), `model = "hand-written: ..."`, no TEE signature |
| `set_verifier_key`, `attest_use(request_id, verifier, statement, signature)` | owner; anyone | ed25519 over `"bookerbob/jolt-verify/v0\0" \|\| statement` by a listed verifier, `verdict = "accept"`, `panic = false`, the registered program hash, the program usable; each statement recorded once, by sha256 of its exact bytes (the same content serialized differently would count again; the verifier's canonical sorted JSON is what keeps one proof to one record) |
| `status`, `get_request`, `get_program`, `by_program_hash`, `list`, `uses`, `config` | views | `status`: none, pending, challenged, rejected, usable |

Statement format agreed with the OutLayer verifier session, keys sorted:
`{"inputs_sha256","output_sha256","panic","program_hash","proof_sha256","verdict"}`.
The verifier key `outlayer-jolt-997c` is the TEE-derived key of OutLayer project
`bookerbob.testnet/bookerbob-jolt-verify`, set from the evidence that session gave
(`fixtures/live/smith-registry.json`); that verifier runs Jolt 997c, so today it can attest
`standing-graph`; the smith programs on b4eb wait for a b4eb verifier there.

The first deploy (`smith-registry.bookerbob-demo.testnet`) let any caller register with any
key; it is superseded and its records are kept in the snapshot.

Who holds what today: REP holds the registry's owner key (model keys, verifier keys,
challenge rulings) and the smith account. The owner key is also the account's full-access key, so
it can redeploy the contract: it did, in place, three times after the first deploy (code changes recorded in
`fixtures/live/smith-registry.json`, `wasm_history`). There is no economic stake on registration
yet.

## Privacy, exactly

- The private input is Jolt untrusted advice: it is not an input of the verifier and is not
  published.
- The proof's private commitment is sha256 of the private bytes. A spec that hides data must
  carry a 32-byte random salt in its private input (`"privacy": true`; the smith refuses one
  without), so neither the commitment nor a records root can be matched against a few guesses.
- **`spend-bucket-zk` is the zero-knowledge program.** The same guest as `spend-bucket`, proved
  with Jolt's `zk` feature (a16z/jolt `b4eb62480d76`, `jolt-sdk/zk` on the prover,
  `jolt-verifier/zk` in the wasm verifier `agents/smith/verifier-zk.wasm.gz`). At this pin that
  feature is a compile-time protocol: committed sumcheck messages, hiding witness commitments
  and opening, and a BlindFold tail (`crates/jolt-prover/Cargo.toml`). Its proof is a holder's:
  the private input is a fresh random salt and records generated for it and published nowhere
  (not in the spec, not in the repo); the statement shows only the records root, the window, the
  thresholds and the bucket. The proof carries its protocol tag: the transparent verifier refuses
  it with `ProtocolConfigMismatch` (it expected `zk: Transparent`), the zk verifier accepts it,
  and changed statements are refused (`smith-check`, the page). Its program hash is separate,
  registered as `spend-bucket-zk`. What was checked about hiding: the protocol tag and the
  verifier split; a byte search of the zk proof for the holder's salt, private input, merchant
  names and amounts finds nothing, which shows little, since no proof here stores raw input
  bytes. The hiding itself rests on Jolt's zk construction; nothing here tests it beyond that.
- The transparent `spend-bucket` proof is over the requester's test vector, which is public: its
  private input, salt included, is in the spec. That proof demonstrates the program, and hides
  nothing. A real holder proves locally with a fresh random salt.
- The transparent programs (the other three) are built without the zk feature: their proofs are
  succinct and **not formally zero-knowledge**.
- `coalition-k-of-n` and `coalition-split` hide nothing: their private input is job C's seat
  records, which the coalition contract returns to anyone. They prove the counts and the split
  against the on-chain seat records.

## Reproducible build

- Jolt a16z/jolt `b4eb62480d76` plus `zk/browser/jolt-wasm32.patch` (the same patched copy as the
  browser prover; `smith.mjs` checks the commit and the patch before every build).
- A fixed build root, `/tmp/bookerbob-smith` (`/private/tmp/...` on macOS): the guest ELF carries
  source paths, so the root is part of the program. Every dependency is vendored into the root
  (`crates/`), so the ELF names no home directory. A build on another machine has not been tried. Cargo runs `--offline --locked` after
  `cargo update -w` adds only the program's own path crates to `zk/smith/Cargo.lock`.
- **The Dory URS is part of the program hash.** At this pin Jolt's Dory setup
  (`crates/jolt-dory/src/scheme.rs`, `setup_prover`) loads `dory_<n>.urs` from the cache
  directory and, when it is missing, writes "a freshly OsRng-generated URS" (dory-pcs 0.5.0). The
  verifier preprocessing embeds it. A first rebuild here (empty guest target dir) reproduced every ELF byte
  for byte and none of the program hashes, for that reason. Now one URS file is pinned in the repo
  (`zk/smith/urs/dory_24.urs`, sha256 `91708ba5..` in `SHA256SUMS`); every host run gets exactly
  that file and fails if Dory writes a new one. With it, `node scripts/smith.mjs rebuild` (an empty
  guest target dir; the host, vendored crates and Jolt tree stay) reproduces all four program
  hashes (`zk/smith/rebuild.json`).
- What that URS means for trust: it was generated once, here, by Dory's own code with OsRng.
  Dory's binding assumes nobody knows discrete-log relations between the generators; whoever
  generates the URS could choose generators with known relations. So a verifier trusts that this
  file was generated honestly, as it does for every Jolt program in this repo (the main-tree
  guests use the URS files in the machine's cache). A URS derived by hash-to-curve from a public
  seed would remove that trust; it is the next step.
- Program hash: sha256 of the bincode verifier preprocessing (`out/verifier.bin`); the ELF hash
  is recorded too.

## The requests

All three were written by `z-ai/glm-5.3-flash` on the first attempt, passed the lint and every
vector, and are registered on `smith-reg.bookerbob-demo.testnet`, accepted by their requesters.
Measured 2026-11-14 on an Apple M3 Pro (11 cores), macOS, AC power; prove and verify are the native
host, peak RSS from `/usr/bin/time -l`; the wasm verifier takes about 370 ms in node (about 500 ms
for the zk proof). Each program was first registered with a URS generated during its own build
(see Reproducible build), then rebuilt from the same body twice (with the pinned URS, then with
every dependency vendored into the build root) and superseded on chain each time; the requester
accepted each new hash by name.

| request | requester | proves | output (job C / synthetic buyer) | body.rs | model s | vectors (requester + smith) | max cycles | program hash | prove s | verify ms | proof B | peak RSS MB | register tx |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| (a) `coalition-k-of-n` | coalition lead of job C | at least k_min of the seats delivered, against the commitment to job C's seat records | `{delivered: 2, seats: 3}` | 68 lines | 241 | 3 + 8 | 71,152 | `b8345c0457aaed2e..` | 2.25 | 30 | 79,140 | 181 | `5R69xjd2..`, supersedes `DJdpRF25..`, `GNXLyA96..` |
| (b) `spend-bucket` | a buyer agent | the spend bucket of the last 90 days of salted committed records; proved here over the requester's public test vector | `{bucket: 2}` (over 500) | 64 lines | 240 | 2 + 8 | 54,526 | `136dd9a90b511d58..` | 1.64 | 28 | 79,237 | 386 | `FvxWYyvE..`, supersedes `2yQmPohP..`, `Be1UcmMb..` |
| (b) `spend-bucket-zk`, **zero-knowledge** | the same request | the same program with Jolt's `zk` feature, proved over a holder's input published nowhere | `{bucket: 3}` (over 1,000) | the same body.rs | | | | `bec48cc20de58671..` | 2.06 | 81 | 78,037 | 179 | `DDR824Rq..`, supersede `8hKViizA..` |
| (c) `coalition-split` | coalition lead of job C | the payout followed the pro-rata rule: every share, slashed bond and the buyer's remainder recomputed from the seats, budget and bond equal the `job_finalized` event that `coalition.bookerbob-demo.testnet` logged in tx `7fviwuTw..` | `{deliverers: 2, slashed: 1, paid_out: 17638119}` | 141 lines | 331 | 2 + 8 | 78,137 | `dc65a0f063d316e8..` | 2.73 | 32 | 82,602 | 386 | `DWR2QfG6..`, supersedes `B5b4Ei18..`, `zqycRoUh..` |

Chain bindings (in `verifyStatement`, so the page and the offline check run them): (a) the seats
root is recomputed from `coalition.bookerbob-demo.testnet` `job(2)`; (c) also budget and bond
from that view and the payouts from the finalize tx's event. Snapshots of those reads are in
each program's `chain-view.json`; `make smith-live` re-reads them.

Also on the registry: `standing-graph`, the bazaar's hand-written standing guest (program
`c780ceab..`, pinned by the owner, tx `EpToezsq..`), with the OutLayer verifier's signed accept of
the live standing proof recorded by `attest_use` (tx `DZfSmqd7..`, sent by that session) and its
signed reject of a forged proof refused on chain ("not an accept", tx `HtErk3Am..`).

Every tx hash: `fixtures/live/smith-registry.json`.

## Limits

- LLM-written code needs review before high-stakes use; vectors are tests.
- The registry has no economic stake on registration; REP holds the owner key.
- Only `spend-bucket-zk` is zero-knowledge; the sandbox is macOS only; the TDX quote of the model
  report is not re-verified by the smith.
- The pinned Dory URS is trusted (generated once by us with OsRng); a public hash-to-curve URS is
  the next step.
- `resolve` and `expire` send the bond with a plain transfer and no callback: if the receiving
  account no longer exists, that bond is lost.
- The OutLayer verifier attests 997c programs (standing) today; the b4eb smith programs need a b4eb build of it.
- The smith is one model, one template and a 300-line cap; larger programs need a larger trace
  limit, which changes the program hash.

## Files

`scripts/smith.mjs` (spec, write, gen, build, run, publish), `scripts/smith-check.mjs`,
`scripts/smith.test.mjs`, `scripts/smith-registry.mjs`, `zk/smith/` (template, host, lint,
verify-wasm, sandbox.sb, specs, programs), `smith-registry/`, `agents/smith.html`,
`agents/smith/` (lint.wasm, verifier.wasm.gz, postcard.mjs, verify.mjs, lint.mjs, one folder per
program), `fixtures/live/smith-registry.json`.
