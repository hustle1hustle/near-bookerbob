# NEAR Agent Market: listing plan (not listed)

Status: nothing is listed yet. The founder gave his word on 2026-11-10 for a listing with no
real money; it is sent once the repository is public, so the listing does not point at a 404.

What runs today: `node scripts/agent-market.mjs list` reads the live market (API 2.0.0, no key):
656 agents on 2026-11-10, 69 of them in travel, finance or events, the kinds that could sell in
a BookerBob round. None has joined one. `node scripts/agent-market.mjs register` prints the
listing and sends nothing without `--i-have-the-founders-word`.

What the listing is: a door, not a deployment. Agent Market is mainnet only and BookerBob runs
on testnet, so the listing says where an outside agent joins the testnet market (AGENTS.md, a
bond in the open category) and that nothing there is real money. No job is posted: a job needs
an escrow in real funds.

The plan below is the earlier, larger one (it needs a mainnet bazaar) and is kept for the record.

## What we would list

| agent | what it sells | backed by |
|---|---|---|
| BookerBob referee | checks that every fact a model cites is in the proof set; signed receipt or refusal | `worker/` (referee and dispute arbiter), `docs/outlayer.md` |
| REP Read | read a verdict's status and record, per call | `mcp/rep-read.mjs` (MCP) and `x402/verdict-read.mjs` (x402 v2) |
| BookerBob merchant SDK | lets an outside merchant agent bid in a demo round | `sdk/merchant.mjs` |

## API surface we would use (from our research, 2026-10-27; recheck before use)

From `market.near.ai/openapi.json` v2.0.0 as read during research: `POST /v1/agents/register`
(token shown once), `GET /v1/agents`, `PATCH /v1/agents/{id}`, `/pricing-plans`, jobs board
`GET /v1/jobs/board`, `POST /v1/jobs/{id}/bids`, `POST /v1/jobs/competition`. Escrow on
award, payout on accept, 5% platform fee, USD (Stripe) or USDC via NEAR Intents, x402 at
`/.well-known/x402` on `near:mainnet`, and an employer MCP server. Creating and awarding
jobs in v2 was NOT CONFIRMED. docs.market.near.ai was not reviewed.

## Steps, once there is a go

1. Mainnet deploy of the bazaar (team decision; mainnet is gated).
2. Register "REP Read" with pricing per read; point it at the x402 endpoint and the MCP tool.
3. Register "BookerBob referee"; describe the signed result format (`docs/outlayer.md`).
4. Optional: post a `jobs/competition` demo round an outside agent can bid in through the SDK.
5. Record agent ids and listing URLs in the README.

## Wording

No claim of a listing until it exists. No partner claims. "Agents can read a verdict",
not "agents trust our users".
