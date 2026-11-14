# Jolt zkVM for BookerBob (numbers measured 2026-11-04 to 2026-11-10)

Status: **all four guests are proven and verified** (first on 2026-11-04; standing and referee
re-proved on 2026-11-05, see below).

Measured 2026-11-04 on this Mac (Apple Silicon, 11 cores, cargo -j4, AC power), Jolt a16z@997c1543e; peak RAM from `/usr/bin/time -l`. Proved and verified in the founder-approved build session; the committed files are in `zk/out/<guest>/`.

| guest | prove (s) | verify (ms) | proof (bytes) | peak RAM (MB) | wall incl. guest build (s) | verifier preprocessing (bytes) | program hash |
|---|---|---|---|---|---|---|---|
| `standing` | 8.94 | 70 | 92,716 | 3,230 | 15.1 | 4,180,340 | `c780ceabae4decfa..` |
| `price` | 1.27 | 59 | 80,380 | 375 | 3.4 | 3,284,109 | `6a35b5c3a8c1fe69..` |
| `referee` | 2.26 | 62 | 84,796 | 744 | not measured | 4,669,874 | `6d4c5afb8a61704f..` |
| `cohort` | 2.91 | 63 | 84,724 | 560 | 5.0 | 2,876,057 | `50eb77d3d5c13c68..` |

The standing row is the re-proof of 2026-11-05 (`zk/out/standing/result.json`: 8.94 s, 92,716
bytes). `zk/out/standing.prove.log` and `zk/out/standing.time.txt` are older: they record the
first proof of 2026-11-04 over a graph of hires only (4.69 s, 88,300 bytes, peak RSS
1,392,508,928 bytes). The 3,230 MB peak in the table was read in the re-proof session and has
no committed log behind it.

The referee row was re-proved on 2026-11-05 after the rule `github account_age_years >= 3` (`github_builder`) joined the rule table, which is part of the referee guest; the other three guests are unchanged.

Challengeable on chain since 2026-11-05: an update is posted pending with sha256 of its proof; anyone can challenge it inside one review round with a 0.1 NEAR bond; a registered arbiter re-runs the verifier and signs the resolution; a false update slashes the worker's 0.5 NEAR bond to the challenger. Run live once (valid, docs/testnet.md). Round 2 (3 hires + 2 seeds, `zk/out/standing-testnet-2`): prove 2.71 s, verify 61 ms, proof 84,796 B, peak RSS 999 MB.

Live testnet graph 3 (3 hires, m01's 2 seeds, h05's first seed; `zk/out/standing-testnet-3`, 2026-11-05): prove 4.05 s, verify 64 ms; finalized on chain after its challenge window, and the bazaar built the proven standing tree from its score list (m01 rank 1, h05 rank 2).

Live testnet graph (3 hires + 1 seed, root `ad42980d…`, `zk/out/standing-testnet`): prove 3.32 s, verify 66 ms, proof 84,796 B, peak RSS 998 MB (on battery); its worker-signed update was accepted on chain (tx `5Us18yJb…`, docs/testnet.md).

Standing was re-proved on 2026-11-05 after `publish_reviews` started pushing the Seed graph event: the fixture graph is now 20 hires and 1 seed (before, hires only, so the standing list was empty). Same program hash.

`make verify` checks natively that each committed output equals what the contract's code
computes and that each program hash is the sha256 of its committed verifier
preprocessing (`bookerbob zk-results`). `make zk-verify` verifies the proofs themselves
offline from the committed files (needs the Jolt build in `zk/`).

## Why Jolt here

The design reason: recomputing standing over a large hire graph does not fit a contract
call, and OutLayer's output is capped at 900 bytes. Jolt proves an arbitrary Rust computation
(RISC-V) and the proof is checked off chain; the chain keeps a root and a signed result.

What is true at today's size: the live graph has 6 events and the fixture 21. The `standing`
guest sets no `max_input_size`, so Jolt's default at this pin applies (4,096 bytes for the
whole event list); a larger graph needs a larger limit, which changes the program hash, and no
run at scale exists. The contract also receives and hashes the full score list on every update
(`submit_graph_scores`).

## Guests

| guest | proves | status |
|---|---|---|
| `standing` (a bounded, damped fan-out of standing from each seed along hire edges, `graph/src/lib.rs` `conferred`; each seed's mass is bounded, with no stationary distribution) | from the graph events (hire edges, released review seeds), the hash-chained root they produce, and the merchant scores plus every account's standing with conserved transport, w = 1/2 (following a design rule in REP's unpublished draft "(title withheld) for a World of Agents"); output (root, scores hash) | proved and verified (`zk/out/standing`) |
| `price` | `price = f(schedule, revealed, cohort size)` with `bookerbob-zkcore::price`, the contract's own function; output (price, discount_bps, input hash), so a receipt can carry the proof hash next to its price | proved and verified |
| `referee` | the structured-claim check with `bookerbob-zkcore::referee`, as a second path beside the TEE worker; output (receipt?, input hash); a refusal proves too | proved and verified |
| `cohort` | the answer came from a committed cohort of at least 5 distinct members: the hash chain over their nullifiers equals the contract's `cohort_root`; output (root, k); below 5 the guest panics. Jolt can prove a panicking run with the panic flag set, so what holds is that both verifiers here require panic = false (`zk/src/main.rs`, `zk/browser/verify-wasm/src/lib.rs`): no proof they accept exists. The guest comments that say "no proof exists" mean this; they are left as they are so the program hashes do not move | proved and verified |

Shared no_std code, unit-tested natively without Jolt: `bookerbob-graph` (standing) and
`bookerbob-zkcore` (price, referee, cohort). `bookerbob-core` and the contract call the same
functions, so a proof covers exactly what the chain runs. The guest inputs come from the
contract's own data (`bookerbob zk-inputs`, `fixtures/zk/`, checked in `make verify`): the
price input reproduces the contract's quote (36 USDC), the cohort input reproduces its
`cohort_root` (k = 6), the honest referee input passes and the injected one is refused.

## What each guest reads, and what stays private (built without the `zk` feature)

Jolt 997c1543e is built here without its optional `zk` feature, so a proof is succinct but not
zero-knowledge: treat everything a guest reads as visible to whoever holds the proof.

| guest | reads | where that input already is | private? |
|---|---|---|---|
| `standing` | graph events (hire edges, released review seeds) | logged on chain as `graph_event`, hashed into `graph_root` | no, all public |
| `price` | the merchant schedule, the revealed predicates, the cohort size | schedule and predicates on chain; k from `cohort_root` | no, all public |
| `referee` | the proof set (fact ids and values) and the agent's claims | synthetic fixtures only | would leak real facts, so the referee guest is not run on real data until the `zk` feature is on; real facts go to the sealed TEE referee instead |
| `cohort` | the members' nullifiers | on chain, per verdict | no, all public |

## What is built and tested (no Jolt needed)

- `bookerbob-graph` (`graph/`, no_std, sha256 only): the events, their canonical bytes and
  decoder, the hash-chained root `root' = sha256(tag || root || event)`, conserved
  transport, and `compute(events) -> (root, scores, standing)`. The same crate is used by
  `bookerbob-core`, the contract and the guest, so the proven computation is the on-chain
  one bit for bit.
- The contract extends `graph_root` on every `hire` and every review release and emits
  each event's bytes (`graph_event`), so the prover's input can be rebuilt from chain logs.
  `make verify` (sealed reviews R11, R12) checks that the 20 logged events hash to the
  contract's root and match `fixtures/graph/standing-events.json`.
- `submit_graph_scores`: accepted only for the registered program (`set_graph_program`),
  the current root (a stale root is refused), and a registered worker key's ed25519
  signature over `sha256("bookerbob/graph-update/v0\0" || program_hash || root ||
  scores_hash)`. The proof stays off chain. 5 contract tests: accepted, tampered score,
  stale root, other program, unregistered worker.

## The flow (reproduce)

1. Rebuild the events from the contract's `graph_event` logs.
2. In `zk/`: `cargo run --release -- prove <guest> ../fixtures/zk/<guest>-input.json
   out/<guest>` for standing, price, referee and cohort: proof, verifier preprocessing,
   `result.json` (output, program hash, prove time, proof size); peak RAM with
   `/usr/bin/time -l`, on AC power.
3. The worker verifies the proof (`verify <guest> ...`), recomputes the output natively,
   checks their hash, and signs the update. `make verify` reruns the offline verify on the
   committed files.
4. `submit_graph_scores` on chain.

Program hash: sha256 of the serialized Jolt verifier preprocessing, which commits to the
guest bytecode. That is what a proof is verified against, so it is what the contract
registers. The doc comment on `set_graph_program` in `contract/src/lib.rs` says "sha256 of its
ELF"; that comment is wrong and this paragraph is the definition. The contract source stays as
deployed until after the submission (code parity with the tagged build).

Nothing in CI rebuilds a guest and re-derives a program hash from source:
`.github/workflows/zk-verifier.yml` builds the host and verifies the committed proofs against
the committed preprocessing. Whether a guest build gives the same hash on another machine is
not tested.

## The Dory setup (URS)

Jolt commits to polynomials with Dory. Dory needs public generators: vectors of random points
in G1 and G2 plus two blinding points (the URS). Both pins load them from
`~/Library/Caches/dory/dory_<n>.urs` (`dory-pcs`, `setup()`), and when the file is missing they
draw new ones from `OsRng` and save them there. The file holds the prover setup followed by the
verifier setup derived from it, and the verifier setup is the first field of the verifier
preprocessing. So the program hash commits to the URS: a verifier holding the registered hash
uses exactly these generators, and a rebuild with any other URS gives a different hash.

How `n` is chosen: `n = log2(max trace length, rounded up to a power of 2) + 4` (8 from
2^25 on). At `997c1543e` that is `JoltProverPreprocessing::new`; the browser pin
(`b4eb62480`, `jolt-prover` `setup_total_vars`, `jolt-dory` `setup_prover`) also takes the
advice sizes into account and rounds `n` up to even. Both pins read the same file format and
the same cache.

| program | pin | max trace | URS file | rebuilds from current source |
|---|---|---|---|---|
| standing (`zk/out/standing*`, `c780ceab..`, registered on chain) | 997c1543e | 2^24 | `dory_28.urs` | yes |
| price, cohort | 997c1543e | 2^20 | `dory_24.urs` | no: `zkcore` changed after them; their committed proofs still verify |
| referee | 997c1543e | 2^22 | `dory_26.urs` | no: `zkcore` changed after it; its committed proof still verifies |
| `agents/standing/verifier.bin` (`8cb059d8..`) | b4eb62480 | 2^24 | `dory_28.urs` | yes |
| `agents/prove/verifier.bin` (decide) | b4eb62480 | 2^16 | `dory_20.urs` | not run |

Evidence for each row: the whole verifier setup section of that `.urs` file occurs byte for
byte in the committed preprocessing, and no other cached file's does.

Ours was generated on our machine by `dory-pcs`, the first time a Jolt build there needed each
size (file dates: `dory_28` 2026-03-25, `dory_24` and `dory_26` 2026-09-24, `dory_20`
2026-11-10). dory-pcs sampled each point from a random x-coordinate (OsRng, ark-ec
Projective::rand; in G2 the point is then multiplied by the cofactor), so whoever ran it learned
no discrete logs and holds no trapdoor. A reader cannot check that from the bytes: the same file
could have been built as known multiples of one generator, and whoever did that could open a
commitment two ways. So what a reader trusts is provenance: that these files came from the stock
sampler on our machine.

The files are pinned in `zk/urs/` with `zk/urs/SHA256` (public parameters, about 3 MB).
`scripts/dory-urs.sh pre <stamp>` fails when the dory cache holds any `dory_*.urs` that is not
pinned (a guest of that size would load it silently; `BOOKERBOB_DORY_ALLOW_UNPINNED=1` accepts
them), installs any missing pinned file, checks the sha256 of each one and fails on a mismatch,
then touches `<stamp>`. `scripts/dory-urs.sh post <stamp>` fails if any `.urs` in the cache was
written after that. It never moves or deletes a cache file. The cache is `$LOCALAPPDATA/dory`
when `LOCALAPPDATA` is set, as `dory-pcs` resolves it, so `make dory-urs`, `make zk-verify`,
`make zk-prove G=<guest> OUT=<dir>`, `zk/browser/build.sh` and `node scripts/standing-v2.mjs
prove` point it at a clean directory of their own (`$HOME/.cache/bookerbob-urs`, override with
`DORY_LOCALAPPDATA`) that holds only the pinned files. The build script and the two prove paths
run `post` after preprocessing.

Reproduction check, with `LOCALAPPDATA` pointing at an empty directory so the cache holds only
the pinned files (the shared cache is left alone):

```
T=$(mktemp -d); S=$T/stamp
LOCALAPPDATA=$T sh scripts/dory-urs.sh pre $S
(cd zk && LOCALAPPDATA=$T ./bin/bookerbob-zk prove standing ../fixtures/zk/standing-live-input.json $T/out)
(cd zk/browser && LOCALAPPDATA=$T ./target/release/standing-host build ../../fixtures/zk/standing-live-input.json $T/browser)
LOCALAPPDATA=$T sh scripts/dory-urs.sh post $S
```

Measured 2026-11-14: the prebuilt `zk/bin` host gives verifier preprocessing sha256
`c780ceab..`, the on-chain standing program, and `standing-host` gives `verifier.bin`
`8cb059d8..` and the same guest ELF, both byte for byte. With an empty cache instead, the same
command draws a new `dory_28.urs` each time, so the standing hash differs on every run
(`bf5f744e..` and `c830f89f..` in two runs). The price, cohort and referee rebuilds carry the
pinned URS section unchanged, and their hashes still differ from the committed ones further in,
in the program bytes.

Next step: replace the drawn URS. Dory
needs no secret, so generators hashed to the curve from a public seed let anyone recheck the
file, with no ceremony. It moves every program hash, so the programs would be registered again.

## A fifth guest, proved in the browser (separate pin)

`agents/prove.html` proves one more guest, `decide`, in the visitor's own browser: it reprices
the 8 hotel offers with the same `zkcore` price rule and checks the agent's pick (listed, priced
by code, inside the budget, the cheapest that fits). 39,159 cycles, padded to 2^16; native
prove 1.53 s, verify 28 ms, proof 78,527 bytes (Apple M3 Pro, 11 threads); headless Chrome
5.7 to 15 s on 8 threads across runs and about 21 s on one, and the browser's proof is byte for byte the native
one. A static host sends no cross-origin isolation headers, so the page registers its own
small service worker (`agents/coi-prove-sw.js`, scope `prove` only) that adds them; without it
the page falls back to one thread and says so. The page then
verifies the same proof against a claim changed by one unit and shows it refused.

Who proves to whom: in use, the agent's operator makes this proof and anyone checks it. On the
page the visitor's browser plays both sides, with the buyer's rules and nothing uploaded. With
inputs this small and all public (a 3,109 byte `public.json`, 39,159 cycles), rerunning the
rule natively is faster than the check, which costs about 360 ms and a 1.88 MB download. A
proof matters when an input is hidden or the checker is a contract; neither is true here yet.

It is a separate crate set (`zk/browser/`) on a newer Jolt, rev `b4eb62480d76`, because that
revision has the known wasm32 fixes (a16z/jolt issue #1913 and 0xAndoroid/jolt-wasm-prover;
applied here as `zk/browser/jolt-wasm32.patch`, not ours). The four guests above stay on
`997c1543efd4`, the program the contract anchors. This proof is checked in the page, not on
chain, and is not zero-knowledge (every input is public). No phone has been timed on it yet.
Build and numbers: `zk/browser/README.md`.

## A sixth guest: the QFEX referral floor (REP Proofs extension, separate pin)

The founder's QFEX referral floor in the gallery ([real-attestations.md](real-attestations.md))
is a Jolt proof made in the browser, in the REP Proofs extension, over a notarized MPC-TLS
session with `api.qfex.com` (`GET /users/me/referrals/activity`, 2026-11-13). REP's notary in
an Intel TDX enclave saw only two hash commitments, one over the whole request and one over the
whole answer, and signed them. The guest recomputes both commitments from the private bytes,
checks the HTTP framing, the request line, the host, the login token's pinned issuer and every
referral row, and outputs floors only:

- 30-day and lifetime referral volume: at least $1,000,000;
- referrals per level: 1+, 25+, 0+;
- the account is not identified (public mode carries no account tag).

| item | value |
|---|---|
| guest ELF (reproducible build) | `57f74108b49d2d5c7bfaf0bd8107657f198ea5d98901cfb593045615256bec0e` |
| Jolt pin | `248aefd` (REP's build, separate from this repo's guests) |
| rules registry head | BLAKE3 `e77bb403acdeeb222b5fc46d10ec4e6676e8d0c52f2c441faf97986e1dc0781d`, SHA-256 `84ccc1a4baa23b545771de0e3cf7e113f1e4c5ca4a826067a20c4da61a247a79` |
| notary key | key 1, `0307293878f0133efed565f3aa39963d7362f7adab8b2b172d1ff3bf7908aaed32`, valid 2026-11-11 to 2026-12-11 |
| bundle | `tools/zk-gallery-verify/qfex-gallery-bundle.json` (the same bytes as `fixtures/live/qfex/referral-zk-bundle.json`) |

Check it offline (a verifier only: 1.8 MB of Jolt verifier wasm and the guest's verifier data):

```
cd tools/zk-gallery-verify && npm install && node verify-gallery.mjs qfex-gallery-bundle.json
```

It prints `VALID (registry head e77bb403acdeeb22...)` and the floors above. It walks the
registry's hash chain, checks the notary's signature and key window, that the proof's two
commitments are the two digests the notary signed, and the Jolt proof against the pinned guest.

## Dependency and prior work

- Jolt: upstream a16z/jolt pinned to `997c1543efd49eb193ca403bb7722fc4b2f8e65b`
  (2026-03-24), the commit the installed `jolt` CLI was built from; arkworks patches at the
  revisions upstream's `Cargo.lock` uses. The REP fork (REP's private Jolt fork) is private, so a
  judge could not fetch it; upstream is public.
- REP's earlier Jolt guests (the JMPR Elite family, `jmpr-elite-*` in REP's private Jolt fork, last
  changed 2026-10-01 to 2026-10-14) are prior work, disclosed in `PRIOR_WORK.md`, and are
  not used. Every BookerBob guest is new code written in the window.
- Measurements (prove time, peak RAM, proof size) per guest are in the table at the top and
  in `docs/evidence.md`.

## A forged graph is refused (`make standing-negatives`, in `make judge`)

The committed proof of the live testnet graph (`zk/out/standing-live`: 10 events, 6 hire edges and
4 seeds the contract logged, after the coalition runs) verifies with the committed prebuilt verifier. Its output root is
the graph root the bazaar's proven standing tree was built from (`standing_root()` on
`bookerbob.testnet`, read live by `agents/standing.html`). The proof binds the event log and its
output; each change below is refused by the Jolt verifier (its proof line fails, a panic does not
count):

| change | why it fails |
|---|---|
| a hire edge outside the proven log (m09 hires m01) | the events no longer hash to the proven root |
| a sybil ring (3 fresh accounts hire each other) | same; and with no attested seed upstream it would confer 0 anyway |
| a seed's weight (m01's 6 ratings claimed as 60) | the seed is a hashed event: the root changes |
| a dropped hire edge | the root changes |
| two events swapped | the root is a hash chain, so order counts |
| the claimed root, one byte | the proof binds its output |
| the claimed scores hash, one byte | same |

The same check runs in a browser: `agents/standing.html` verifies a re-proof of this log, made
natively with the same guest code at the browser verifier's Jolt pin, in the tab, with the 7 changes
(`node zk/browser/check-standing.mjs`, in `make judge`).

A standing score is only as good as the edges under it. Every edge here is a contract event:
`hire` is signed by the hiring account, and a seed is released only from sealed reviews by
buyers who proved their context and paid. Anyone can add an edge; only a seed starts standing.

## A v1 issue found, and fixed in the measured v2: self-returned standing

Found on 2026-11-14 while writing the cost-of-attack test for standing v2 (`standing-v2/`). In v1
(`graph/src/lib.rs` `conferred`, the program registered on chain), mass a seed sends around a ring
of hires and back to its own merchant counts as standing for that merchant. The extra is bounded
by w/(1-w) of its own seed (one seed's worth at w = 1/2), and less for a plain two-account ring.

Is the live graph affected? In v1 the `in_top` tree ranks merchants by their review average,
and conferred standing takes no part in admission, so no rank or admission on chain changed.
The published standing values:
- the 6-event graph proved in `zk/out/standing-testnet-3`: no (the only ring, m02 and m03, had
  no seed);
- the 8-event graph after the coalition run (`fixtures/zk/standing-coalition-input.json`): yes,
  for one account. m02 holds a 5-rating seed and sits in the m02 and m03 ring, so about 1.67 of
  its own seeds (5/3, rounded down per hop) come back to it in v1's `standing` list.

`standing-v2/` (v2 to v4, measured in docs/coalitions.md, none on chain) does not count mass
returned to a seed's own merchant (test `self_returned_mass_does_not_count`). The v1 program
registered on chain still counts it in its `standing` list, which does not rank admission.

## What these proofs are, and are not

- This build is upstream a16z/jolt at `997c1543e`, compiled without Jolt's optional `zk`
  feature (we enable `host` only). The proofs are **succinct, and they hide nothing**: they show
  the computation was done right, they do not hide its inputs. Every input we prove is public
  or committed anyway (graph events are public chain logs; price, referee and cohort inputs
  are committed by hash).
- Upstream says Jolt "is in alpha and is not suitable for production use" and "has not been
  audited". Treat a Jolt proof here as strong engineering evidence, not an audited guarantee.
- The contract does not verify the proof itself: a bonded worker key signs the update, anyone
  can challenge it, and an arbiter key reruns the verifier (see above).
