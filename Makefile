# BookerBob. `make verify` runs fully offline on fixtures.
JOBS ?= 2
CARGO ?= cargo
CARGO_FLAGS = -j $(JOBS)

.PHONY: outlayer-eval-local outlayer-eval-verify adversarial verify-presentation swarm-try swarm-verify outlayer-local leash buy-twice forge-poc try site audit audit-all wasm-parity one-flow flip-check flip-check-post eval-gate model-buy eval-verify zk-verify-prebuilt verify-offline market-eval join-merchant secret-scan judge leak verify-live demo-tester zk-verify zk-inputs scenario reviews receipts verify demo-offline demo-live test test-ucp fixtures fixtures-check swarm wasm clean who-sees-what standing-negatives coalition coalition-check leak-amount bucketed-check coalition-test coalition-wasm coalition-live coalition-verify standing-v2-verify coalition-v2-check coalition-v3-check coalition-v4-check verify-all outlayer-buy outlayer-jolt-local outlayer-dispute mainnet-outlayer-check collusion collusion-check mcp mcp-live smith-check smith-live

BOOKERBOB = $(CARGO) run $(CARGO_FLAGS) -q -p bookerbob-cli --

verify:
	$(BOOKERBOB) verify fixtures --receipts agents/receipts.json --check
	$(BOOKERBOB) swarm agents/merchants.json fixtures/verdict-ed25519.json agents/board.json --check
	$(BOOKERBOB) evals fixtures/referee-evals.json fixtures/proofs.json fixtures/verdict-ed25519.json agents/merchants.json
	$(BOOKERBOB) near-ai fixtures/live/near-ai fixtures/proofs.json
	$(BOOKERBOB) voprf-verify fixtures/live/voprf/run.json de0c0be1fbb9aea7fad3e1f5ebcdade3aa3fa92f6a0118eae8543100868ee417
	node scripts/nras.mjs verify
	$(BOOKERBOB) reviews fixtures agents/reviews.json --check
	$(BOOKERBOB) scenario fixtures
	$(BOOKERBOB) zk-inputs fixtures --check
	$(BOOKERBOB) zk-results fixtures zk/out

# The story in one screen: contract logs (stderr) hidden, PASS/FAIL lines only.
demo-offline:
	@echo "bookerbob. merchants compete for you. none of them learns who you are."
	@echo
	@$(BOOKERBOB) swarm agents/merchants.json fixtures/verdict-ed25519.json agents/board.json --check 2>/dev/null | head -14
	@echo
	@$(BOOKERBOB) verify fixtures 2>/dev/null | sed -n '1p;6p;13p;17,$$p'

# The same story against a deployed testnet bazaar, driven by env (.env.example).
# Refuses mainnet. DRY_RUN=1 prints every step and which ones need tools.
# Testnet demo mode: a fresh, funded, gasless tester purchase in dUSDC (docs/demo-mode.md).
demo-tester:
	node scripts/demo-tester.mjs run

# Re-derive every testnet claim over public RPC (no keys, no build).
# The fast path for judges, Node only, offline by default: about 25 s on a warm laptop.
# JUDGE_LIVE=1 make judge also re-derives the testnet claims over public RPC, 5 to 20 minutes.
# Full-history secret scan before the repo goes public (patterns + exact values from ~/.rep-secrets).
secret-scan:
	scripts/secret-scan.sh

judge:
	node scripts/judge.mjs

# Tacit collusion measured: OPEN vs SEALED vs TALK, pre-registered (docs/collusion.md).
# collusion runs the NEAR AI calls; collusion-check is offline and keyless.
collusion:
	node scripts/collusion.mjs run-all

collusion-check:
	node scripts/collusion.mjs check

# The Jolt smith (docs/smith.md): offline re-check of every registered program and proof;
# smith-live re-reads the registry, its txs and job C over public RPC.
smith-check:
	node scripts/smith-check.mjs
	node --test scripts/smith.test.mjs

smith-live:
	node scripts/smith-check.mjs --live

# An outside merchant agent joins the open market on testnet (bond, no owner step).
join-merchant:
	node scripts/join-merchant.mjs join $(NAME) $(BASE) $(DISCOUNT)

# Disclosure regimes compared over 1,000 simulated rounds (docs/market-eval.md).
forge-poc:
	node scripts/forge-poc.mjs verify

market-eval:
	node scripts/market-eval.mjs

# make verify with no network: the vendored crates (vendor/crates.tar.xz, checked against
# vendor/SHA256, which also pins Cargo.lock) replace crates.io. Logged run: README "Offline".
verify-offline:
	shasum -a 256 -c vendor/SHA256
	cmp -s vendor/SHA256 vendor/.extracted 2>/dev/null || { tar -C vendor -xJf vendor/crates.tar.xz && cp vendor/SHA256 vendor/.extracted; }
	$(MAKE) verify CARGO_FLAGS="-j $(JOBS) --offline --config vendor/offline.toml"

# Rebuild the bazaar wasm and compare it with the code both testnet bazaars run (contract/DEPLOYED.json).
wasm-parity:
	node scripts/wasm-parity.mjs

# A merchant inflates its base price to fake a discount: refused on testnet (docs/unit-economics.md).
cheat:
	node scripts/cheat.mjs run

# You are the buyer: your GitHub token file proves the fact behind one testnet purchase (docs/prove-me.md).
try:
	node scripts/try.mjs $(TOKEN)

# Thousands of attacks, each refused, offline and keyless (docs/adversarial.md): spent-nullifier
# replays and bid fuzz on the contract's own code (MockedBlockchain), out-of-proof claims on the
# referee. Fixed seed; writes fixtures/adversarial/run.json. Contract logs (stderr) hidden.
adversarial:
	@$(CARGO) build $(CARGO_FLAGS) -q -p bookerbob-cli
	@./target/debug/bookerbob adversarial fixtures/adversarial/run.json 2>/dev/null
	@echo "PASS  make adversarial"

# A mini swarm you run yourself, about 15 s warm, no keys (NEAR_AI_KEY=<yours> adds live model verdicts).
swarm-try:
	@$(CARGO) build $(CARGO_FLAGS) -q -p bookerbob-cli
	@node scripts/swarm-try.mjs

# The big swarm run (docs/swarm-run.md): re-check its public record over public RPC, no keys.
swarm-verify:
	node scripts/swarm-run.mjs verify $(or $(TAG),s1)

# site/ for GitHub Pages: board, receipts, eval over public RPC with snapshot fallbacks (Pages turns on with the flip).
site:
	node scripts/site.mjs

# One purchase rebuilt from public data, and its price recomputed four ways (scripts/audit.mjs).
NULLIFIER ?=
# One buyer through every outside system, each leg LIVE or DRY (AGENTS.md, first block).
one-flow:
	node scripts/one-flow.mjs

# Around the public flip: before (scan, tracked files, links) and after (unauthenticated 200s).
flip-check:
	node scripts/flip-check.mjs pre

flip-check-post:
	node scripts/flip-check.mjs post

# Every purchase in the public manifest (single settles and buying-group members), one audit each.
audit-all:
	node scripts/audit-all.mjs

audit:
	node scripts/audit.mjs $(NULLIFIER)

# If REP turned malicious: each REP-held key's worst case, read live where it can be (README, "Who can lie").
rep-is-evil:
	node scripts/rep-is-evil.mjs

# Who can change a bazaar's code, over public RPC (panel action 8). `node scripts/no-owner.mjs plan` prints the staged steps.
no-owner:
	node scripts/no-owner.mjs

# REP Eval: every TEE signature, the answers hash, the issuer signature, the CI's correct
# vector and the on-chain score, from fixtures/live/eval/rep-eval*.json (no keys).
eval-verify:
	node scripts/rep-eval.mjs verify
	node scripts/rep-eval-v2.mjs verify
	REP_EVAL_PROTOCOL=v3 node scripts/rep-eval-v2.mjs verify
	REP_EVAL_PROTOCOL=v4 node scripts/rep-eval-v2.mjs verify
	REP_EVAL_PROTOCOL=v5 node scripts/rep-eval-v2.mjs verify

# One testnet purchase whose verdict a NEAR AI model issued, through the eval gate (docs/eval.md).
# A past buyer proves it from a fresh account and pays less (needs the contract batch on testnet).
# An owner's signed limits on an agent, refused and honoured on testnet (needs the batch deployed).
leash:
	node scripts/leash.mjs run

buy-twice:
	node scripts/buy-twice.mjs run

# The referee on OutLayer: one purchase settled under its receipt, one cheat refused (docs/outlayer.md).
outlayer-buy:
	node scripts/outlayer-buy.mjs run

# The Jolt verifier component in wasmtime with a mock signing host (docs/outlayer.md).
outlayer-jolt-local:
	worker/outlayer-jolt/build.sh
	node worker/outlayer-jolt/cases.mjs
	cd worker/outlayer-host && cargo run -q --release --locked -- jolt ../outlayer-jolt/target/wasm32-wasip2/release/bookerbob-jolt-verify-outlayer.wasm ../outlayer-jolt/target/cases/*.json
# Historical: needs arbiter_threshold 1; bookerbob.testnet runs at 2 since 2026-11-14 (docs/keyless.md).
outlayer-dispute:
	node scripts/outlayer-dispute.mjs run

model-buy:
	node scripts/model-buy.mjs

# A merchant gated on the REP Eval v5 lower bound at 70: no model passes, the refusal is checked (docs/eval.md).
eval-gate:
	node scripts/eval-gate.mjs verify

verify-live:
	node scripts/verify-live.mjs

# The Jolt standing proof verified by a locked NEAR contract (docs/jolt-onchain.md), and coalition
# version 4 admitting on it. Keyless, public RPC, testnet.
keyless-check:
	node scripts/keyless-check.mjs

jolt-onchain-check:
	node scripts/jolt-onchain-check.mjs

coalition-jolt-check:
	node scripts/coalition-jolt-check.mjs

jolt-onchain-mainnet-check:
	node scripts/jolt-onchain-check.mjs --mainnet

jolt-onchain-test:
	cd coalition/v4 && cargo test --release

# What a passive observer links from public testnet data (docs/leak.md).
leak:
	node scripts/leak.mjs

# Your own GitHub account as the real fact (docs/prove-me.md). Needs the tlsn-extension
# checkout next to this repo, a GitHub token file and the testnet keys; testnet only.
ROUND ?= builder-1
mainnet-check:
	node scripts/mainnet-check.mjs

# Who sees what on the real-data mainnet purchase (offline copy; WHO_FLAGS=--live re-reads it).
who-sees-what:
	node scripts/who-sees-what.mjs $(WHO_FLAGS)

# Proven standing refuses a forged graph (the committed Jolt proof, 7 changed inputs and claims).
standing-negatives:
	node scripts/standing-negatives.mjs

# Coalitions against single agents, pre-registered (docs/coalition-prereg.md, anchored on testnet).
coalition:
	$(BOOKERBOB) coalition-sim --out fixtures/coalition/result.json
	node scripts/coalition-chart.mjs

coalition-check:
	$(BOOKERBOB) coalition-sim --out target/coalition-rerun.json
	node scripts/coalition-check.mjs --rerun target/coalition-rerun.json --anchor

# The price leak per sale (L10) for every merchant, and the bound on bucketed schedules (docs/leak-amount.md).
leak-amount:
	node scripts/leak-amount.mjs

bucketed-check:
	node scripts/bucketed-buy.mjs check

# Coalitions on testnet (docs/coalitions.md): the contract's tests, its wasm, the live run, the keyless check.
coalition-test:
	cd coalition && $(CARGO) test $(CARGO_FLAGS) --locked && $(CARGO) fmt -- --check && $(CARGO) clippy $(CARGO_FLAGS) --locked --all-targets -- -D warnings
	node --test scripts/coalition-live.test.mjs

coalition-wasm:
	cd coalition && cargo near build non-reproducible-wasm --no-abi --out-dir ../target/near

coalition-live:
	node scripts/coalition-live.mjs run && node scripts/coalition-live.mjs jobc && node scripts/coalition-live.mjs jobd && node scripts/coalition-live.mjs jobe

coalition-verify:
	node scripts/coalition-live.mjs verify

# Standing v2 (standing-v2/) on testnet, as history: the graph program was set to v2 through the
# timelock and set back to v1 after the pre-registered runs missed; this checks both moves and
# that the bazaar runs v1 today.
standing-v2-verify:
	node scripts/standing-v2.mjs verify

# Admission by the hire-edge fan-out (standing-v2/ v2, v3, v3 cut by count as v4): each attempt
# pre-registered on testnet before it ran; every one is a published FAIL (docs/coalitions.md,
# "Every registered attempt"). The -check targets re-run the sim, require the committed numbers,
# verify the anchor, and exit 1 because the registered verdict is FAIL.
coalition-v2-check:
	$(BOOKERBOB) coalition-sim --v2 --check fixtures/coalition/result-v2.json; node scripts/coalition-check-v2.mjs --anchor

coalition-v3-check:
	$(BOOKERBOB) coalition-sim --v3 --check fixtures/coalition/result-v3.json; node scripts/coalition-check-v3.mjs --anchor

coalition-v4-check:
	$(BOOKERBOB) coalition-sim --v4 --check fixtures/coalition/result-v4.json; node scripts/coalition-check-v4.mjs --anchor
# Every keyless check in one run, mainnet and testnet, for a judge (agents/verify.html). QUICK=1 skips the full testnet sweep.
verify-all:
	node scripts/verify-all.mjs
mainnet-outlayer-check:
	node scripts/mainnet-outlayer.mjs check

verify-presentation:
	cd tools/verify-presentation && cargo build --release -q
	node scripts/verify-presentations.mjs
	node scripts/verify-receipt.mjs fixtures/live/qfex/leaderboard-receipt.json

prove-me:
	node scripts/prove-me.mjs check
	node scripts/prove-me.mjs run $(ROUND)

demo-live:
	@node scripts/demo-live.mjs

# The Jolt proofs themselves, verified offline from the committed files (needs the Jolt
# build in zk/: cargo build --release). make verify checks the outputs natively instead.
zk-verify: dory-urs
	cd zk && for g in standing price referee cohort; do ./target/release/bookerbob-zk verify $$g ../fixtures/zk/$$g-input.json out/$$g || exit 1; done

# The Dory setup (URS) guard (docs/jolt.md, "The Dory setup (URS)"). dory-pcs reads its cache from
# $$LOCALAPPDATA/dory, so the zk targets point LOCALAPPDATA at a clean directory of their own that
# holds only zk/urs; the guard installs the pinned files there and fails on a mismatch or on an
# unpinned file. Run before any Jolt preprocessing or prove.
DORY_LOCALAPPDATA ?= $(HOME)/.cache/bookerbob-urs
dory-urs:
	LOCALAPPDATA=$(DORY_LOCALAPPDATA) sh scripts/dory-urs.sh

# Prove one guest at the zk/ pin with the pinned URS: make zk-prove G=standing OUT=/tmp/standing
# (needs the Jolt build in zk/); fails if the run generated an unpinned URS.
zk-prove:
	@test -n "$(G)" -a -n "$(OUT)" || { echo "usage: make zk-prove G=<standing|price|referee|cohort> OUT=<dir>"; exit 2; }
	@export LOCALAPPDATA=$(DORY_LOCALAPPDATA); stamp=$$(mktemp) && sh scripts/dory-urs.sh pre $$stamp && \
	  (cd zk && ./target/release/bookerbob-zk prove $(G) ../fixtures/zk/$(G)-input.json $(abspath $(OUT))) && \
	  sh scripts/dory-urs.sh post $$stamp

# The same proof check with the committed prebuilt verifier (macOS arm64, built from zk/ at
# jolt 997c1543e), no Jolt build needed. Both hashes in zk/bin/SHA256 are checked first.
zk-verify-prebuilt:
	sh scripts/zk-verify-prebuilt.sh

# Inputs for the Jolt guests (zk/), from the contract's own data.
zk-inputs:
	$(BOOKERBOB) zk-inputs fixtures 2>/dev/null | tail -1

# Every feature in one run on one chain, one summary line.
scenario:
	@$(BOOKERBOB) scenario fixtures 2>/dev/null

reviews:
	$(BOOKERBOB) reviews fixtures agents/reviews.json 2>/dev/null | tail -1

receipts:
	$(BOOKERBOB) verify fixtures --receipts agents/receipts.json 2>/dev/null | tail -1

swarm:
	$(BOOKERBOB) swarm agents/merchants.json fixtures/verdict-ed25519.json agents/board.json

# Agent reputation over MCP (docs/mcp.md): offline tests on a fake RPC with the real Jolt wasm
# verifier, then the same tools against NEAR testnet over public RPC (views only, no keys).
mcp:
	node --test mcp/rep-read.test.mjs mcp/reputation.test.mjs

mcp-live:
	node mcp/live-check.mjs

test: test-ucp
	$(CARGO) test $(CARGO_FLAGS) --workspace

test-ucp:
	node --test ucp/test/near-usdc.test.mjs mcp/rep-read.test.mjs x402/verdict-read.test.mjs sdk/merchant.test.mjs scripts/jmpr-rates-to-merchants.test.mjs scripts/buy-twice.test.mjs scripts/leash.test.mjs scripts/demo-live.test.mjs scripts/demo-tester.test.mjs scripts/join-merchant.test.mjs scripts/community.test.mjs scripts/round-tx.test.mjs scripts/swarm-run.test.mjs scripts/merchant-brain.test.mjs relayer/relay.test.mjs relayer/near.test.mjs relayer/serve.test.mjs scripts/mainnet-moment.test.mjs scripts/device-run.test.mjs scripts/eval-run.test.mjs scripts/status.test.mjs sdk/buy.test.mjs scripts/rep-eval.test.mjs scripts/live-pages.test.mjs scripts/prove-me.test.mjs scripts/rep-eval-v2.test.mjs scripts/nras.test.mjs scripts/leak-keys.test.mjs sdk/clearing.test.mjs scripts/anchor.test.mjs scripts/who-sees-what.test.mjs scripts/leak-amount.test.mjs scripts/coalition-live.test.mjs scripts/outlayer-buy.test.mjs scripts/outlayer-jolt.test.mjs mcp/reputation.test.mjs scripts/econ/anchor.test.mjs scripts/outlayer-eval.test.mjs

fixtures:
	$(CARGO) run $(CARGO_FLAGS) -q -p bookerbob-cli -- gen-fixtures fixtures

fixtures-check:
	$(CARGO) run $(CARGO_FLAGS) -q -p bookerbob-cli -- gen-fixtures fixtures --check

# The referee as an OutLayer component (wasm32-wasip2, worker/outlayer), run in wasmtime with a
# MOCK of OutLayer's host interfaces; its signed results go to the bazaar contract code on the
# mocked chain. Sends nothing (docs/outlayer.md). First run compiles wasmtime: a few minutes.
outlayer-local:
	JOBS=$(JOBS) worker/outlayer/build.sh
	$(BOOKERBOB) worker-input fixtures > worker/outlayer/target/fixture-input.json
	cd worker/outlayer-host && $(CARGO) run $(CARGO_FLAGS) -q --release --locked -- ../outlayer/target/wasm32-wasip2/release/bookerbob-referee-outlayer.wasm ../outlayer/target/fixture-input.json ../../fixtures/claims-cheat.json

wasm:
	cd contract && cargo near build non-reproducible-wasm --no-abi --out-dir ../target/near
	cd dusdc && cargo near build non-reproducible-wasm --no-abi --out-dir ../target/near
	cd gate && cargo near build non-reproducible-wasm --no-abi --out-dir ../target/near

# Economy anchor (docs/anchor-format.md): the BookerBob testnet economy's public events, one
# chained root per hour, on the open anchor bookerbob-outcomes.testnet (anchor-open/, anyone posts).
# anchor-check recomputes every root from the source contracts' txs and compares it with the
# anchor; anchor-rebuild rebuilds agent outcomes and the standing input from the anchor's posts
# alone and matches the bazaar's on-chain standing_root. ECON_FLAGS: --snapshot (no network but
# the standing CLI), --tamper (check: one event changed locally, must fail at its epoch),
# --rpc[=N] (check: the txs again from NEAR's public archival RPC). Posting: anchor-post (testnet).
.PHONY: anchor-check anchor-rebuild anchor-post anchor-open-test anchor-open-wasm
ECON_FLAGS ?=
anchor-check:
	node scripts/econ/anchor.mjs check $(ECON_FLAGS)

anchor-rebuild:
	node scripts/econ/anchor.mjs rebuild $(ECON_FLAGS)

# The mainnet copy (fixtures/mainnet/econ-anchor.json): the same records, posted by the implicit account.
ECON_MAINNET = ECON_ANCHOR=a145dcce5119739380e74b3295098a2ae040e1ce4679efb4a7046420cee23474 ECON_POSTER=a145dcce5119739380e74b3295098a2ae040e1ce4679efb4a7046420cee23474 ECON_ANCHOR_RPC=https://rpc.mainnet.fastnear.com ECON_ANCHOR_INDEXER=https://tx.main.fastnear.com ECON_OUT=fixtures/mainnet/econ
.PHONY: anchor-check-mainnet anchor-rebuild-mainnet
anchor-check-mainnet:
	$(ECON_MAINNET) node scripts/econ/anchor.mjs check $(ECON_FLAGS)

anchor-rebuild-mainnet:
	$(ECON_MAINNET) node scripts/econ/anchor.mjs rebuild

anchor-post:
	node scripts/econ/collect.mjs && node scripts/econ/anchor.mjs chain && node scripts/econ/anchor.mjs post

anchor-open-test:
	cd anchor-open && $(CARGO) test $(CARGO_FLAGS) --locked && $(CARGO) fmt -- --check && $(CARGO) clippy $(CARGO_FLAGS) --locked --all-targets -- -D warnings
	node --test scripts/econ/anchor.test.mjs

anchor-open-wasm:
	cd anchor-open && cargo near build non-reproducible-wasm --no-abi --out-dir ../target/near

# Arc history anchor (docs/anchor.md): a market on another chain, its round roots hash-chained on NEAR.
# arc-anchor-rebuild recomputes every root from the Arc testnet logs and checks it against NEAR
# (ANCHOR_FLAGS=--tamper changes one log locally and must fail at its round; "--snapshot --anchors"
# runs with no network from fixtures/live/anchor/). The crate is outside the workspace, with its own lock.
.PHONY: arc-anchor-rebuild arc-anchor-verify arc-anchor-test arc-anchor-wasm
.PHONY: dory-urs zk-prove
.PHONY: jolt-onchain-check coalition-jolt-check jolt-onchain-test keyless-check jolt-onchain-mainnet-check
ANCHOR_FLAGS ?=
arc-anchor-rebuild:
	node scripts/anchor.mjs rebuild $(ANCHOR_FLAGS)

arc-anchor-verify:
	node scripts/anchor.mjs verify

arc-anchor-test:
	cd anchor && $(CARGO) test $(CARGO_FLAGS) --locked && $(CARGO) fmt -- --check && $(CARGO) clippy $(CARGO_FLAGS) --locked --all-targets -- -D warnings
	node --test scripts/anchor.test.mjs

arc-anchor-wasm:
	cd anchor && cargo near build non-reproducible-wasm --no-abi --out-dir ../target/near

# The evaluator inside OutLayer's TEE (worker/outlayer-eval, docs/outlayer-eval.md). Local: the
# fixed-path wasm build (needs wasi-sdk 25, WASI_SDK=<dir>), the native tests on the committed real
# presentations, then the wasm in wasmtime with a MOCK signing host and the real submit_verdict on
# near-sdk's mocked chain. Sends nothing.
outlayer-eval-local:
	JOBS=$(JOBS) sh worker/outlayer-eval/build.sh
	cd worker/outlayer-eval && $(CARGO) test $(CARGO_FLAGS) --release --locked
	cd worker/outlayer-eval/host && $(CARGO) run $(CARGO_FLAGS) -q --release --locked -- ../target/wasm32-wasip2/release/bookerbob-eval-outlayer.wasm ../../../fixtures/live/prove-me/founder-github-owner.presentation ../../../fixtures/live/tee-notary/octocat-mpc.presentation

# The live testnet run of the evaluator, re-derived keylessly over public RPC (20 checks).
outlayer-eval-verify:
	node scripts/outlayer-eval.mjs verify

clean:
	$(CARGO) clean
