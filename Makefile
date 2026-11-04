# BookerBob. `make verify` runs fully offline on fixtures.
JOBS ?= 2
CARGO ?= cargo
CARGO_FLAGS = -j $(JOBS)

.PHONY: verify test test-ucp fixtures fixtures-check swarm wasm clean

BOOKERBOB = $(CARGO) run $(CARGO_FLAGS) -q -p bookerbob-cli --

verify:
	$(BOOKERBOB) verify fixtures
	$(BOOKERBOB) swarm agents/merchants.json fixtures/verdict-ed25519.json agents/board.json --check
	$(BOOKERBOB) evals fixtures/referee-evals.json fixtures/proofs.json fixtures/verdict-ed25519.json agents/merchants.json

swarm:
	$(BOOKERBOB) swarm agents/merchants.json fixtures/verdict-ed25519.json agents/board.json

test: test-ucp
	$(CARGO) test $(CARGO_FLAGS) --workspace

test-ucp:
	node --test ucp/test/near-usdc.test.mjs

fixtures:
	$(CARGO) run $(CARGO_FLAGS) -q -p bookerbob-cli -- gen-fixtures fixtures

fixtures-check:
	$(CARGO) run $(CARGO_FLAGS) -q -p bookerbob-cli -- gen-fixtures fixtures --check

wasm:
	cd contract && cargo near build non-reproducible-wasm --no-abi --out-dir ../target/near

clean:
	$(CARGO) clean
