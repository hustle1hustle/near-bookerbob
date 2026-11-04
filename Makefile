# BookerBob. `make verify` runs fully offline on fixtures.
JOBS ?= 2
CARGO ?= cargo
CARGO_FLAGS = -j $(JOBS)

.PHONY: receipts verify demo-offline test test-ucp test-stellar fixtures fixtures-check swarm wasm clean

BOOKERBOB = $(CARGO) run $(CARGO_FLAGS) -q -p bookerbob-cli --

verify:
	$(BOOKERBOB) verify fixtures --receipts agents/receipts.json --check
	$(BOOKERBOB) swarm agents/merchants.json fixtures/verdict-ed25519.json agents/board.json --check
	$(BOOKERBOB) evals fixtures/referee-evals.json fixtures/proofs.json fixtures/verdict-ed25519.json agents/merchants.json

# The story in one screen: contract logs (stderr) hidden, PASS/FAIL lines only.
demo-offline:
	@echo "bookerbob. merchants compete for you. none of them learns who you are."
	@echo
	@$(BOOKERBOB) swarm agents/merchants.json fixtures/verdict-ed25519.json agents/board.json --check 2>/dev/null | head -14
	@echo
	@$(BOOKERBOB) verify fixtures 2>/dev/null | sed -n '1p;10,$$p'

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
	node --test ucp/test/near-usdc.test.mjs mcp/rep-read.test.mjs x402/verdict-read.test.mjs

fixtures:
	$(CARGO) run $(CARGO_FLAGS) -q -p bookerbob-cli -- gen-fixtures fixtures

fixtures-check:
	$(CARGO) run $(CARGO_FLAGS) -q -p bookerbob-cli -- gen-fixtures fixtures --check

wasm:
	cd contract && cargo near build non-reproducible-wasm --no-abi --out-dir ../target/near

clean:
	$(CARGO) clean
