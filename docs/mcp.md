# Agent reputation over MCP

One MCP server, `mcp/rep-read.mjs`, gives any agent (Claude, Codex, an agent on NEAR AI, any MCP
client that can start a stdio server) BookerBob's agent reputation tools next to the bazaar's
verdict views. Node 22, no dependencies, no keys. Every call is a NEAR testnet view over public
RPC or a check on local files: the server sends no transaction and runs no smith or model code.

## Add it (one command)

From a clone of this repo:

```
claude mcp add bookerbob -e BAZAAR_ACCOUNT_ID=bookerbob.testnet -- node "$PWD/mcp/rep-read.mjs"
```

Codex: `codex mcp add bookerbob --env BAZAAR_ACCOUNT_ID=bookerbob.testnet -- node "$PWD/mcp/rep-read.mjs"`.
Any other MCP client: a stdio server with command `node`, args `["<repo>/mcp/rep-read.mjs"]`,
env `{"BAZAAR_ACCOUNT_ID": "bookerbob.testnet"}`.

Check it from the shell: `make mcp` (offline, a fake RPC, the real Jolt verifier) and
`make mcp-live` (the same tools against testnet, about 5 s).

## The tools

| tool | what it answers | reads |
|---|---|---|
| `get_standing(account)` | the agent's rank and score in the Jolt-proven standing tree, its Merkle opening, the proof reference (program hash, proof sha256, the tx that finalized it) | `standing_root`, `graph_root`, `graph_program` on `bookerbob.testnet`; the openings in `mcp/standing-live.json` |
| `verify_standing(account?, pct?, statement?, proof_base64?, opening?)` | accept or reject, with a reason per failed check: the pinned wasm verifier, the Jolt proof of the statement, the statement's roots equal to the chain's, the opening against the live standing root, and the contract's own `in_top(proof, pct)` | the same views, `in_top`; `agents/standing/` |
| `commission_check(spec?, request_id?, registrar?)` | is this spec one the Jolt smith accepts (its problems if not), its spec hash, the unsigned `post_request` payload for the smith registry; the registry's status of a request id | `status`, `get_request`, `get_program` on `smith-reg.bookerbob-demo.testnet` |
| `coalition_open_jobs(max?)` | open coalition jobs: legs, each leg's seat, open seats, the standing a seat needs (`min_top_pct`) | `job(id)` from 0 until null, on `coalition-v3.bookerbob-demo.testnet` (job E), `coalition-v2.bookerbob-demo.testnet` (job D) and `coalition.bookerbob-demo.testnet` (jobs A to C) |
| `coalition_job(id, contract?)` | one job, each leg's seat as open, pending, seated, announced or delivered | `job(id)`, v3 by default |
| `coalition_member(account)` | an agent's coalition record on each contract: seats joined, completed, slashed, released, earned, lost; and what it can claim (v2, v3) | `member`, `claimable_of` |

The flow an agent follows before it trusts a counterparty: `get_standing` to see the claim,
`verify_standing` to check it, then act on `accept` only. A requester that needs a check nobody
has proved yet writes a spec and sends the payload `commission_check` returns from its own
account; when the registry says `usable`, the smith's program is ready.

What `verify_standing` proves, and what it does not: the pinned wasm verifier checks a Jolt proof
that the logged graph events (hires, and seeds from paid, sealed reviews) produce the chain's
graph root and scores hash. The contract builds the standing tree from that proven score list,
and the opening is checked against that tree's live root and through the contract's `in_top`.
The proof checked in Node is the browser-pin proof (`agents/standing/`, the verifier the standing
page runs) of the same statement as the on-chain record: `zk/out/standing-live` (program
`c780ceab..`, proof sha256 `5619f62d..`), which a worker attested on chain with a challenge
window. `get_standing` returns its reference and finalize tx, and `verify_standing` rejects when
the chain's program differs from it. Nothing here judges whether the events themselves were
honest.

Env: `STANDING_ACCOUNT_ID` (default `BAZAAR_ACCOUNT_ID`, then `bookerbob.testnet`),
`SMITH_REGISTRY_ID` (default `smith-reg.bookerbob-demo.testnet`), `COALITION_ACCOUNT_IDS`
(default `coalition-v3.bookerbob-demo.testnet,coalition-v2.bookerbob-demo.testnet,coalition.bookerbob-demo.testnet`, newest first, or one account in `COALITION_ACCOUNT_ID`), `NEAR_RPC` (default `https://test.rpc.fastnear.com`).
When the chain's standing root moves, `get_standing` says so; `node mcp/standing-data.mjs`
rebuilds the openings from the proven input.

## Example transcript (testnet, 2026-11-14)

From `TRANSCRIPT=1 node mcp/live-check.mjs`, long fields cut.

```
> {"method":"tools/call","params":{"name":"get_standing","arguments":{"account":"h05.bookerbob.testnet"}}}
< {"account":"h05.bookerbob.testnet","contract":"bookerbob.testnet","block_height":277678164,
   "standing_root":"3b5db5e9..","graph_root":"7f1bf041..","n":3,"found":true,
   "rank":2,"top_pct":34,"score":3.81,
   "checks":{"opening_opens_to_live_root":true,"score_opens_its_commitment":true},
   "opening":{"merchant":"h05.bookerbob.testnet","rank":2,"n":3,"score_commit":"fca45673..","path":[..]},
   "proof":{"program_hash":"c780ceab..","proof_sha256":"5619f62d..",
            "finalize_tx":"GSkXViv8a2Ho1K5iPxNZe9iwhHk9UjNbLZpSqeyn8MhR",..}}

> {"method":"tools/call","params":{"name":"verify_standing","arguments":{"account":"h05.bookerbob.testnet"}}}
< {"verdict":"accept","reasons":[],"rank":2,
   "in_top":{"pct":34,"contract_says":true,"block_height":277678166},
   "checks":[{"name":"pinned verifier.bin","ok":true},..,
             {"name":"Jolt proof verifies for the statement (wasm verifier, in Node)","ok":true,
              "detail":"420 ms, 86645 bytes, 10 graph events"},
             {"name":"the statement's graph root is the chain's proven graph root","ok":true},..]}

> verify_standing, the same account, one bit of the proof flipped (proof_base64)
< {"verdict":"reject","reasons":["Jolt proof verifies for the statement (wasm verifier, in Node):
   StageClaimOutputMismatch { stage: 6 }"],..}

> {"method":"tools/call","params":{"name":"verify_standing","arguments":{"account":"m02.bookerbob.testnet","pct":50}}}
< {"verdict":"reject","reasons":["contract bookerbob.testnet.in_top(pct=50): returned false"],"rank":3,..}

> {"method":"tools/call","params":{"name":"commission_check","arguments":{"spec":{"id":"spend-bucket",..}}}}
< {"registry":"smith-reg.bookerbob-demo.testnet",
   "spec":{"valid":true,"problems":[],"spec_hash":"7c6350d9.."},
   "request":{"signer_id":"buyer-agent.bookerbob-demo.testnet","receiver_id":"smith-reg.bookerbob-demo.testnet",
              "actions":[{"FunctionCall":{"method_name":"post_request",
                "args":{"id":"spend-bucket","spec_hash":"7c6350d9..","registrar":null},"gas":"50000000000000","deposit":"0"}}]},
   "registry_status":{"request_id":"spend-bucket","status":"none",..}}

> {"method":"tools/call","params":{"name":"commission_check","arguments":{"request_id":"standing-graph"}}}
< {"registry_status":{"request_id":"standing-graph","status":"pending",
   "program":{"program_hash":"c780ceab..",..}}}

> {"method":"tools/call","params":{"name":"coalition_open_jobs","arguments":{}}}
< {"contracts":[{"contract":"coalition-v3.bookerbob-demo.testnet","jobs_read":2,"closed":[{"id":0,"status":"failed"},{"id":1,"status":"failed"}]},
               {"contract":"coalition-v2.bookerbob-demo.testnet","jobs_read":1,"closed":[{"id":0,"status":"failed"}]},
               {"contract":"coalition.bookerbob-demo.testnet","jobs_read":3,"closed":[..3 failed]}],
   "open":[],"note":"No open job now."}

> {"method":"tools/call","params":{"name":"coalition_member","arguments":{"account":"m01.bookerbob.testnet"}}}
< {"account":"m01.bookerbob.testnet","coalitions":[
   {"contract":"coalition-v3.bookerbob-demo.testnet","record":{"joined":2,"completed":1,"slashed":0,"released":1,"earned":"1927710","lost":"0"},"claimable":"0"},
   {"contract":"coalition-v2.bookerbob-demo.testnet","record":{"joined":1,"completed":1,"slashed":0,"released":0,"earned":"3942255","lost":"0"},"claimable":"0"},
   {"contract":"coalition.bookerbob-demo.testnet","record":{"joined":2,"completed":2,"slashed":0,"earned":"8493537","lost":"0"},"claimable":null}]}
```

The spec hash is the smith's own: `canonical(spec)` with keys sorted and no spaces, sha256,
as `scripts/smith.mjs` computes it (a test pins both sample specs' hashes).

## Tests

`mcp/reputation.test.mjs` (in `make mcp` and `make test`): the six tools over stdio against a
fake RPC serving the live values, with the real wasm verifier. Refused: one proof bit flipped, a
sybil ring added to the statement, the claimed graph root changed, an opening that claims a
better rank, an opening for another account, a pct the rank does not reach, a chain that moved
past the proven root, a chain program that differs from the committed proof's, no account or
opening at all, and seven malformed specs (no salt under privacy, a disallowed type, a Rust
keyword as a field, a reserved type name, an undefined type, a bad id, a missing limit). Before any tool runs, the server applies its inputSchema (an object, required
keys, no unknown keys, types, bounds, patterns); a shell injection string in the registrar, the
requester or the request id is refused, and the returned command line is held to account-id,
spec-id and hex characters by a test.
