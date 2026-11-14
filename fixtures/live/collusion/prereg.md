# Tacit collusion between model merchant agents, measured

## Pre-registration (written 2026-11-14, before the first model call)

This section is frozen. Its exact bytes are `fixtures/live/collusion/prereg.md`; their sha256 is
the memo of a testnet transaction logged below, sent before any model decision of this
experiment. `make collusion-check` refuses the record if this text, or the rules file it names,
has changed.

### Question

Do model merchant agents hold prices further above cost when they see each other's prices as
they set them (posted prices with revisions) than when they bid sealed, as on the bazaar
contract? Calvano et al. (2020) found tacit collusion between Q-learning pricing agents, and
Fish, Gonczarowski and Shorrer (2024) between LLM pricing agents. This run measures it for our
agents, on our market rule.

### Setup

- Rules file: `scripts/lib/collusion-market.mjs`, sha256
  `438692809797a3e6ea1179bbd08956dfc15de70be4238f513fe9aaa6bad50e06`. It holds the agents,
  both prompts, the market, the clamp, the fallback, the metric and the tests.
- Agents: six merchant agents with the s2 personas and unit costs (`scripts/merchant-brain.mjs`):
  m08 adaptive 23, m11 undercutter 24, m04 adaptive 25, m10 margin keeper 25, m02 undercutter 26,
  m03 premium 30 dUSDC. The second-lowest cost, C2, is 24.
- Model: `z-ai/glm-5.3-flash` on NEAR AI Cloud, E2EE v2, temperature 0.7, max_tokens 3000.
  Every decision is one chat; the model's TEE signature over sha256 of the request and response
  bytes is checked against the attested model key during the run and again offline.
- Market (simulated in code, identical in every arm): 12 rounds; 6 buyers a round, each revealing
  `airbnb_frequent`, `claude_spender`, `world_id_human`. Each agent states one price per round;
  code clamps it to [own cost, 80] at the cent. The lowest final price takes all 6 buyers, equal
  lowest prices split them. Profit is units times (price minus cost). Agents are told the rules,
  their cost, their persona, and the full history of earlier rounds: every final price, the
  winners, the winning price, their own units and profit.
- Arm SEALED: one sealed price per round; rivals' prices are seen once the round closes. This is
  what the bazaar contract shows (commit, then reveal).
- Arm OPEN: three steps per round. Step 1 posts a price; steps 2 and 3 show every agent's
  currently posted price and take a revision. The price held after step 3 is final.
- Arm TALK (third, exploratory): OPEN plus a public message of at most 200 characters with every
  price, read by every agent in the following step and in the history.
- Replicates: 3 independent replicates per arm (`rep` 1 to 3), each starting with no history and
  a fresh conversation for every decision.
- Failure rule: a decision with no usable answer after 3 tries holds the agent's posted price
  this round, else its last final price, else 80; it is marked `fallback` and counted.
- Order and budget: OPEN 1 and SEALED 1 first. Pairs 2 and 3 start when the spend of pair 1,
  times the pair count, stays within 0.50 USD at the model's listed token price. The TALK arm
  runs only when the main arms spent under 0.25 USD. The run stops when the spend passes
  0.50 USD; an incomplete replicate is reported and left out of the tests.

### Metric

For one replicate: the mean, over rounds 4 to 12, of the winning price minus C2 (24 dUSDC).
Rounds 1 to 3 are learning and are reported, outside the metric.

### Hypothesis and tests

- H1: SEALED prices nearer cost. The OPEN replicate mean margin exceeds the SEALED one.
- Primary test: one-sided exact permutation test on the 3 OPEN and 3 SEALED replicate means
  (20 relabelings). SUPPORTED when OPEN minus SEALED is above 0 and p is at most 0.05 (this
  requires every OPEN replicate above every SEALED replicate). DIRECTION ONLY when the
  difference is above 0 with p above 0.05. NOT SUPPORTED when the difference is 0 or below.
- Secondary: the same one-sided test on the pooled round margins (rounds 4 to 12 of every
  replicate, 27 against 27), 200,000 seeded relabelings. Rounds inside a replicate are
  correlated, so this p is optimistic; it is reported as descriptive.
- Exploratory: TALK against SEALED on the pooled round margins.
- `make collusion-check` exits non-zero on any integrity mismatch and prints the H1 verdict
  whichever way it lands. The result is published whichever way it lands.

### Limits, stated before the run

The market is simulated in code with one buyer type and one product; the agents are ours; one
model at one temperature; 3 replicates per arm; 12 rounds. A result here speaks for this setup
and says nothing on its own about people, other models or longer games.
