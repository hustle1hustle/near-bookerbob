# BookerBob. `make verify` runs fully offline on fixtures.
JOBS ?= 2
CARGO ?= cargo
CARGO_FLAGS = -j $(JOBS)

.PHONY: verify test fixtures fixtures-check wasm clean

verify:
	$(CARGO) run $(CARGO_FLAGS) -q -p bookerbob-cli -- verify fixtures

test:
	$(CARGO) test $(CARGO_FLAGS) --workspace

fixtures:
	$(CARGO) run $(CARGO_FLAGS) -q -p bookerbob-cli -- gen-fixtures fixtures

fixtures-check:
	$(CARGO) run $(CARGO_FLAGS) -q -p bookerbob-cli -- gen-fixtures fixtures --check

wasm:
	cd contract && cargo near build non-reproducible-wasm --no-abi --out-dir ../target/near

clean:
	$(CARGO) clean
