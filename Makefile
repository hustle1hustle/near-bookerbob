# BookerBob. `make verify` runs fully offline on fixtures.
JOBS ?= 2
CARGO ?= cargo
CARGO_FLAGS = -j $(JOBS)

.PHONY: market-eval join-merchant secret-scan judge leak verify-live demo-tester zk-verify zk-inputs scenario reviews receipts verify demo-offline demo-live test test-ucp fixtures fixtures-check swarm wasm clean

BOOKERBOB = $(CARGO) run $(CARGO_FLAGS) -q -p bookerbob-cli --

verify:
	$(BOOKERBOB) verify fixtures --receipts agents/receipts.json --check
	$(BOOKERBOB) swarm agents/merchants.json fixtures/verdict-ed25519.json agents/board.json --check
	$(BOOKERBOB) evals fixtures/referee-evals.json fixtures/proofs.json fixtures/verdict-ed25519.json agents/merchants.json
	$(BOOKERBOB) near-ai fixtures/live/near-ai fixtures/proofs.json
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
# The fast path for judges: about a minute from a clean clone, Node only; under a second offline.
# Full-history secret scan before the repo goes public (patterns + exact values from ~/.rep-secrets).
secret-scan:
	scripts/secret-scan.sh

judge:
	node scripts/judge.mjs

# An outside merchant agent joins the open market on testnet (bond, no owner step).
join-merchant:
	node scripts/join-merchant.mjs join $(NAME) $(BASE) $(DISCOUNT)

# Disclosure regimes compared over 1,000 simulated rounds (docs/market-eval.md).
market-eval:
	node scripts/market-eval.mjs

verify-live:
	node scripts/verify-live.mjs

# What a passive observer links from public testnet data (docs/leak.md).
leak:
	node scripts/leak.mjs

demo-live:
	@node scripts/demo-live.mjs

# The Jolt proofs themselves, verified offline from the committed files (needs the Jolt
# build in zk/: cargo build --release). make verify checks the outputs natively instead.
zk-verify:
	cd zk && for g in standing price referee cohort; do ./target/release/bookerbob-zk verify $$g ../fixtures/zk/$$g-input.json out/$$g || exit 1; done

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

test: test-ucp
	$(CARGO) test $(CARGO_FLAGS) --workspace

test-ucp:
	node --test ucp/test/near-usdc.test.mjs mcp/rep-read.test.mjs x402/verdict-read.test.mjs sdk/merchant.test.mjs scripts/jmpr-rates-to-merchants.test.mjs scripts/demo-live.test.mjs scripts/demo-tester.test.mjs scripts/join-merchant.test.mjs relayer/relay.test.mjs relayer/near.test.mjs relayer/serve.test.mjs scripts/mainnet-moment.test.mjs scripts/device-run.test.mjs scripts/eval-run.test.mjs scripts/status.test.mjs

fixtures:
	$(CARGO) run $(CARGO_FLAGS) -q -p bookerbob-cli -- gen-fixtures fixtures

fixtures-check:
	$(CARGO) run $(CARGO_FLAGS) -q -p bookerbob-cli -- gen-fixtures fixtures --check

wasm:
	cd contract && cargo near build non-reproducible-wasm --no-abi --out-dir ../target/near

clean:
	$(CARGO) clean
