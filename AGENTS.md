# AGENTS.md

Instructions for AI agents (Claude Code, Codex) working in or judging this repo.

## Commands

| goal | command | expected |
|---|---|---|
| offline end-to-end check | `make verify` | 20 chain checks `ALL PASS`, swarm board `PASS`, `referee evals 20/20` |
| unit tests | `make test` | all tests pass |
| regenerate fixtures | `make fixtures` | rewrites `fixtures/*.json` byte-identically (deterministic seeds) |
| check fixtures are reproducible | `make fixtures-check` | `fixtures up to date` |
| build contract wasm | `make wasm` | `target/near/bazaar.wasm` (needs cargo-near) |

## Rules

- No network and no secrets are needed for `make verify` or `make test`.
- Never commit keys. Use `.env` (ignored); `.env.example` lists the variables.
- Testnet only unless the team gives a mainnet go.
- Fixtures are synthetic. Never add real user data.
- Prices come from `core/src/price.rs`, never from a model.
