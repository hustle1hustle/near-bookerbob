# BookerBob. `make verify` runs fully offline on fixtures.
JOBS ?= 2
CARGO ?= cargo
CARGO_FLAGS = -j $(JOBS)

.PHONY: reviews receipts verify demo-offline demo-live test test-ucp test-stellar fixtures fixtures-check swarm wasm clean

BOOKERBOB = $(CARGO) run $(CARGO_FLAGS) -q -p bookerbob-cli --

verify:
	$(BOOKERBOB) verify fixtures --receipts agents/receipts.json --check
	$(BOOKERBOB) swarm agents/merchants.json fixtures/verdict-ed25519.json agents/board.json --check
	$(BOOKERBOB) evals fixtures/referee-evals.json fixtures/proofs.json fixtures/verdict-ed25519.json agents/merchants.json
	$(BOOKERBOB) near-ai fixtures/live/near-ai fixtures/proofs.json
	$(BOOKERBOB) reviews fixtures agents/reviews.json --check

# The story in one screen: contract logs (stderr) hidden, PASS/FAIL lines only.
demo-offline:
	@echo "bookerbob. merchants compete for you. none of them learns who you are."
	@echo
	@$(BOOKERBOB) swarm agents/merchants.json fixtures/verdict-ed25519.json agents/board.json --check 2>/dev/null | head -14
	@echo
	@$(BOOKERBOB) verify fixtures 2>/dev/null | sed -n '1p;6p;13p;17,$$p'

# The same story against a deployed testnet bazaar, driven by env (.env.example).
# Refuses mainnet. DRY_RUN=1 prints every step and which ones need tools.
demo-live:
	@node scripts/demo-live.mjs

reviews:
	$(BOOKERBOB) reviews fixtures agents/reviews.json 2>/dev/null | tail -1

receipts:
	$(BOOKERBOB) verify fixtures --receipts agents/receipts.json 2>/dev/null | tail -1

swarm:
	$(BOOKERBOB) swarm agents/merchants.json fixtures/verdict-ed25519.json agents/board.json

test: test-ucp
	$(CARGO) test $(CARGO_FLAGS) --workspace

# Soroban contract for the Stellar leg (own workspace). Wasm: `cd stellar && stellar contract build`.
test-stellar:
	cd stellar && $(CARGO) test $(CARGO_FLAGS)

test-ucp:
	node --test ucp/test/near-usdc.test.mjs mcp/rep-read.test.mjs x402/verdict-read.test.mjs sdk/merchant.test.mjs scripts/jmpr-rates-to-merchants.test.mjs scripts/demo-live.test.mjs relayer/relay.test.mjs

fixtures:
	$(CARGO) run $(CARGO_FLAGS) -q -p bookerbob-cli -- gen-fixtures fixtures

fixtures-check:
	$(CARGO) run $(CARGO_FLAGS) -q -p bookerbob-cli -- gen-fixtures fixtures --check

wasm:
	cd contract && cargo near build non-reproducible-wasm --no-abi --out-dir ../target/near

clean:
	$(CARGO) clean
