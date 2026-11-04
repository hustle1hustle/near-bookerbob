# agents: merchant swarm and board

| file | what |
|---|---|
| `merchants.json` | 30 merchant agents as config: account (one sub-account each), category, persona, discount schedule |
| `board.json` | output of `make swarm`: blind bid commitments, reveal, code-computed quotes per category. Checked by `make verify` |
| `why.mjs` | live layer: each merchant writes a pitch with NEAR AI; the buyer's agent writes the "why" with fact citations; the referee checks them; every NEAR AI response signature is verified |
| `out/live-run.json` | the last live run: model, cost, pitches, claims, referee outcomes, chat ids and signatures |
| `board.html` | static board view. `python3 -m http.server -d agents`, open `/board.html` |

## Rules the code enforces

- Prices come from `bookerbob-core` inside the contract. `why.mjs` never reads a price from model output.
- Merchants see only revealed predicate names. Facts go only to the buyer's agent.
- Round 1 is blind: `sha256("bookerbob/bid/v0\0" || account || 0 || json(schedule) || salt)`. Round 2 reveals and the contract rejects a schedule that does not validate.

## JMPR (`h01`) and real hotel rates

Today the hotel base prices are config, labelled `jmpr-stub`. To use real rates: in a
session that has the JMPR MCP, call `hotel_search` for one city and dates and
`hotel_room_rate` for up to 8 hotels (read-only; never `prebook_hotel` or `book_hotel`),
save `fixtures/live/jmpr-rates.json` in the shape documented in
`scripts/jmpr-rates-to-merchants.mjs` (hotel name and USD total only), then:

```sh
node scripts/jmpr-rates-to-merchants.mjs fixtures/live/jmpr-rates.json && make swarm
```

That sets `h01..h08` base prices from the rates, keeps each discount rule, and the
board's quotes and the disclosure savings follow from the real numbers.

## Live run (2026-11-04)

`node agents/why.mjs` with `z-ai/glm-5.3-flash` (owned_by nearai): 32 calls, 32/32
responses with a valid ed25519 signature whose `sha256(request)` and `sha256(response)`
match the exact bytes on the wire, total cost about $0.005. Plain TLS to the gateway, not
E2EE v2 yet, so this does not answer the E2EE question (open check B1) on its own.

In this run the model ignored the injected product text and cited only real facts, so
both runs got a receipt. The refusal path is covered deterministically by
`fixtures/claims-cheat.json` (`F9 not in proof set`) in `make verify`.

Note: the live run predates the group unlock (2026-11-04, later the same day), so its
board prices are the pre-cohort ones. Prices never come from that file.
